use crate::{
    error::AppError,
    handlers::orders::persist_order,
    models::*,
    services::{email::EmailService, telegram::TelegramService, yookassa::YookassaService},
    state::AppState,
};
use axum::{extract::State, Json};
use serde_json::Value;

pub async fn create_payment(
    State(state): State<AppState>,
    Json(req): Json<CreateOrderRequest>,
) -> Result<Json<Value>, AppError> {
    if !state.config.payments_enabled() {
        return Err(AppError::Validation(
            "Онлайн-оплата пока не настроена".into(),
        ));
    }
    let order = persist_order(&state, &req).await?;
    let yookassa = YookassaService::new(&state.config);
    let payment = yookassa
        .create_payment(
            order.total_amount,
            &order.id.to_string(),
            &format!("Заказ {}", order.id),
            &format!("{}/cart?success=1", state.config.site_url),
        )
        .await
        .map_err(AppError::internal)?;
    let payment_id = payment.get("id").and_then(Value::as_str).ok_or_else(|| {
        AppError::internal(anyhow::anyhow!("YooKassa response has no payment id"))
    })?;
    sqlx::query("UPDATE orders SET payment_id = $1, updated_at = NOW() WHERE id = $2")
        .bind(payment_id)
        .bind(order.id)
        .execute(&state.pool)
        .await?;
    Ok(Json(payment))
}

pub async fn yookassa_webhook(
    State(state): State<AppState>,
    Json(payload): Json<Value>,
) -> Result<Json<Value>, AppError> {
    let payment_id = payload
        .get("object")
        .and_then(|v| v.get("id"))
        .and_then(Value::as_str)
        .ok_or_else(|| AppError::BadRequest("Некорректное уведомление".into()))?;
    if !state.config.payments_enabled() {
        return Err(AppError::Unauthorized);
    }

    // YooKassa does not sign webhook payloads. Never trust it directly: fetch the
    // payment from the authenticated API and compare its immutable metadata.
    let verified = YookassaService::new(&state.config)
        .get_payment(payment_id)
        .await
        .map_err(AppError::internal)?;
    if verified.get("status").and_then(Value::as_str) != Some("succeeded") {
        return Ok(Json(serde_json::json!({"status":"ignored"})));
    }
    let order_id = verified
        .get("metadata")
        .and_then(|v| v.get("order_id"))
        .and_then(Value::as_str)
        .and_then(|v| uuid::Uuid::parse_str(v).ok())
        .ok_or_else(|| AppError::BadRequest("Некорректный идентификатор заказа".into()))?;

    let mut tx = state.pool.begin().await?;
    let order = sqlx::query_as::<_, Order>(
        "SELECT * FROM orders WHERE id = $1 AND payment_id = $2 FOR UPDATE",
    )
    .bind(order_id)
    .bind(payment_id)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or(AppError::NotFound)?;
    if order.status == "paid" {
        tx.rollback().await?;
        return Ok(Json(serde_json::json!({"status":"ok"})));
    }
    let expected = format!("{:.2}", order.total_amount as f64 / 100.0);
    let actual = verified
        .get("amount")
        .and_then(|v| v.get("value"))
        .and_then(Value::as_str)
        .unwrap_or_default();
    let currency = verified
        .get("amount")
        .and_then(|v| v.get("currency"))
        .and_then(Value::as_str);
    if actual != expected || currency != Some("RUB") {
        return Err(AppError::Unauthorized);
    }
    let items =
        sqlx::query_as::<_, OrderItem>("SELECT * FROM order_items WHERE order_id=$1 FOR UPDATE")
            .bind(order.id)
            .fetch_all(&mut *tx)
            .await?;
    for item in &items {
        let changed = sqlx::query(
            "UPDATE products SET stock=stock-$1, updated_at=NOW() WHERE id=$2 AND stock >= $1",
        )
        .bind(item.quantity)
        .bind(item.product_id)
        .execute(&mut *tx)
        .await?;
        if changed.rows_affected() != 1 {
            return Err(AppError::Validation(
                "Товар закончился, заказ отменён".into(),
            ));
        }
    }
    sqlx::query("UPDATE orders SET status='paid', paid_at=NOW(), notified_at=NOW(), updated_at=NOW() WHERE id=$1")
        .bind(order.id).execute(&mut *tx).await?;
    let items = sqlx::query_as::<_, OrderItem>("SELECT * FROM order_items WHERE order_id=$1")
        .bind(order.id)
        .fetch_all(&mut *tx)
        .await?;
    tx.commit().await?;

    let mut text = String::new();
    let mut html = String::new();
    for item in items {
        text.push_str(&format!(
            "- {} x{} ({:.2} ₽)\n",
            escape_html(&item.product_title),
            item.quantity,
            item.price as f64 / 100.0
        ));
        html.push_str(&format!(
            "<li>{} x{} — {:.2} ₽</li>",
            escape_html(&item.product_title),
            item.quantity,
            item.price as f64 / 100.0
        ));
    }
    if let Err(error) = TelegramService::new(&state.config)
        .send_order_notification(&order, &text)
        .await
    {
        tracing::error!(?error, "telegram notification failed");
    }
    if let Err(error) = EmailService::new(&state.config)
        .send_order_confirmation(&order, &html)
        .await
    {
        tracing::error!(?error, "email notification failed");
    }
    Ok(Json(serde_json::json!({"status":"ok"})))
}

fn escape_html(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}
