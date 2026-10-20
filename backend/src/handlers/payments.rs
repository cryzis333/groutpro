use crate::{
    error::AppError,
    models::*,
    services::{
        checkout::create_pending_order,
        notify::{Notification, Notifier},
        yookassa::{is_valid_payment_id, YookassaService},
    },
    state::AppState,
};
use axum::{extract::State, http::HeaderMap, Json};
use serde_json::{json, Value};

const PAYMENT_UNAVAILABLE: &str = "Онлайн-оплата сейчас недоступна. Оформите заказ по счёту, \
     оставьте заявку на главной странице или позвоните нам — оформим заказ вручную.";
const INVALID_WEBHOOK: &str = "Некорректное уведомление о платеже";
const VERIFICATION_FAILED: &str = "Не удалось подтвердить платёж";

pub async fn create_payment(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(mut req): Json<CreateOrderRequest>,
) -> Result<Json<Value>, AppError> {
    // Checked before the order is created: without YooKassa credentials, or without
    // SITE_URL for the return address, the order could never be paid.
    let site_url = match state.config.site_url.as_deref() {
        Some(site_url) if state.config.payments_enabled() => site_url.to_string(),
        _ => {
            tracing::warn!("online payment requested, but YooKassa or SITE_URL is not configured");
            return Err(AppError::Validation(PAYMENT_UNAVAILABLE.to_string()));
        }
    };
    if let Ok(user) = crate::handlers::customer_auth::current_customer(&state, &headers).await {
        req.customer_id = Some(user.id);
    }
    let order = create_pending_order(&state, &req, "sbp").await?;
    let yookassa = YookassaService::new(&state.config);
    let return_url = format!(
        "{site_url}/cart.html?success=1&order={}",
        order.public_number
    );
    let payment = yookassa
        .create_payment(
            order.total_amount,
            &order.id.to_string(),
            &format!("Заказ {}", order.public_number),
            &return_url,
        )
        .await;
    let payment_id = match &payment {
        Ok(p) => p.get("id").and_then(Value::as_str).map(str::to_string),
        Err(error) => {
            tracing::error!(error = %format!("{error:#}"), order = %order.public_number, "yookassa create_payment failed");
            None
        }
    };
    let Some(pid) = payment_id else {
        // No payment was created, so this order can never be paid — don't leave it hanging.
        sqlx::query("UPDATE orders SET status = 'cancelled', updated_at = NOW() WHERE id = $1 AND status = 'pending_payment'")
            .bind(order.id)
            .execute(&state.pool)
            .await?;
        return Err(AppError::Validation(PAYMENT_UNAVAILABLE.to_string()));
    };
    let payment = payment.expect("payment id implies a successful response");
    sqlx::query("UPDATE orders SET payment_id = $1 WHERE id = $2 AND status = 'pending_payment'")
        .bind(&pid)
        .bind(order.id)
        .execute(&state.pool)
        .await?;

    Ok(Json(json!({
        "payment": payment,
        "order": order.public_number
    })))
}

pub async fn yookassa_webhook(
    State(state): State<AppState>,
    Json(payload): Json<Value>,
) -> Result<Json<Value>, AppError> {
    if payload.get("event").and_then(Value::as_str) != Some("payment.succeeded") {
        return Ok(Json(json!({ "status": "ignored" })));
    }
    if !state.config.payments_enabled() {
        return Err(AppError::BadRequest(VERIFICATION_FAILED.to_string()));
    }
    // The id goes into the YooKassa API URL, so anything but a well-formed id is rejected.
    let payment_id = payload
        .get("object")
        .and_then(|object| object.get("id"))
        .and_then(Value::as_str)
        .filter(|id| is_valid_payment_id(id))
        .ok_or_else(|| AppError::BadRequest(INVALID_WEBHOOK.to_string()))?;

    // Webhook data is not trusted. Re-fetch the payment from YooKassa before changing an order.
    let verified_payment = YookassaService::new(&state.config)
        .get_payment(payment_id)
        .await
        .map_err(|error| {
            tracing::warn!(error = %format!("{error:#}"), "yookassa get_payment failed");
            AppError::BadRequest(VERIFICATION_FAILED.to_string())
        })?;
    let order_uuid = verified_payment
        .get("metadata")
        .and_then(|m| m.get("order_id"))
        .and_then(Value::as_str)
        .and_then(|order_id| order_id.parse::<uuid::Uuid>().ok())
        .ok_or_else(|| AppError::BadRequest(VERIFICATION_FAILED.to_string()))?;

    let order =
        sqlx::query_as::<_, Order>("SELECT * FROM orders WHERE id = $1 AND payment_id = $2")
            .bind(order_uuid)
            .bind(payment_id)
            .fetch_optional(&state.pool)
            .await?
            .ok_or(AppError::NotFound)?;

    if order.status == "paid" {
        return Ok(Json(json!({ "status": "ok" })));
    }

    let amount = verified_payment
        .get("amount")
        .and_then(|a| a.get("value"))
        .and_then(Value::as_str)
        .and_then(|v| v.parse::<f64>().ok())
        .map(|v| (v * 100.0).round() as i64);
    let currency = verified_payment
        .get("amount")
        .and_then(|a| a.get("currency"))
        .and_then(Value::as_str);
    if verified_payment.get("status").and_then(Value::as_str) != Some("succeeded")
        || currency != Some("RUB")
        || amount != Some(order.total_amount)
    {
        return Err(AppError::BadRequest(VERIFICATION_FAILED.to_string()));
    }

    // Stock is written off exactly once, together with the status change: nothing is
    // reserved while an item sits in a cart or on the payment page, so a buyer can
    // never block the last unit for themselves (or others) with an abandoned attempt.
    let mut tx = state.pool.begin().await?;
    let updated = sqlx::query("UPDATE orders SET status = 'paid', paid_at = NOW(), updated_at = NOW() WHERE id = $1 AND status = 'pending_payment'")
        .bind(order.id)
        .execute(&mut *tx)
        .await?;
    if updated.rows_affected() == 0 {
        return Ok(Json(json!({ "status": "ok" })));
    }
    let items = sqlx::query_as::<_, OrderItem>("SELECT * FROM order_items WHERE order_id = $1")
        .bind(order.id)
        .fetch_all(&mut *tx)
        .await?;
    let mut per_product: Vec<(uuid::Uuid, String, i64)> = Vec::new();
    for item in &items {
        match per_product
            .iter_mut()
            .find(|(id, _, _)| *id == item.product_id)
        {
            Some(entry) => entry.2 += item.quantity as i64,
            None => per_product.push((
                item.product_id,
                item.product_title.clone(),
                item.quantity as i64,
            )),
        }
    }
    // Two buyers can pay for the last unit at nearly the same time; the money is
    // already taken, so the order stays paid and the notification flags the shortage.
    let mut shortages = Vec::new();
    for (product_id, title, quantity) in &per_product {
        let stock: Option<i32> =
            sqlx::query_scalar("SELECT stock FROM products WHERE id = $1 FOR UPDATE")
                .bind(product_id)
                .fetch_optional(&mut *tx)
                .await?;
        if let Some(stock) = stock {
            if (stock as i64) < *quantity {
                shortages.push(format!(
                    "— {title}: на складе было {stock}, оплачено {quantity}"
                ));
            }
            sqlx::query("UPDATE products SET stock = GREATEST(stock - $2, 0), updated_at = NOW() WHERE id = $1")
                .bind(product_id)
                .bind(quantity)
                .execute(&mut *tx)
                .await?;
        }
    }
    tx.commit().await?;
    if !shortages.is_empty() {
        tracing::warn!(order = %order.public_number, "paid order exceeds stock");
    }
    let items_str = items
        .iter()
        .map(|item| {
            format!(
                "— {} × {} ({:.2} ₽)",
                item.product_title,
                item.quantity,
                item.final_unit_price as f64 / 100.0
            )
        })
        .collect::<Vec<_>>()
        .join("\n");
    let mut fields = vec![
        ("Клиент", order.customer_name.clone()),
        ("Телефон", order.customer_phone.clone()),
    ];
    if let Some(email) = &order.customer_email {
        fields.push(("Email", email.clone()));
    }
    if let Some(address) = &order.customer_address {
        fields.push(("Адрес", address.clone()));
    }
    fields.push((
        "Сумма",
        format!("{:.2} ₽", order.total_amount as f64 / 100.0),
    ));
    fields.push(("Товары", format!("{items_str}\n")));
    let title = if shortages.is_empty() {
        format!("🛒 Оплачен заказ {}", order.public_number)
    } else {
        fields.push((
            "⚠️ Не хватает на складе",
            format!(
                "{}\nСвяжитесь с клиентом: замена, ожидание или возврат.\n",
                shortages.join("\n")
            ),
        ));
        format!(
            "⚠️ Оплачен заказ {} — не хватает товара на складе",
            order.public_number
        )
    };
    Notifier::spawn(
        &state.config,
        Notification {
            title,
            fields,
            link: state
                .config
                .site_url
                .as_deref()
                .map(|s| format!("{s}/admin#orders")),
            reply_to: order.customer_email.clone(),
        },
    );

    Ok(Json(json!({ "status": "ok" })))
}

/// Заказ по счёту для юрлиц: онлайн-оплаты нет, счёт выставляется вручную.
/// Склад не списывается — это произойдёт, когда оплата подтвердится.
pub async fn create_invoice_order(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(mut req): Json<CreateOrderRequest>,
) -> Result<Json<Value>, AppError> {
    if let Ok(user) = crate::handlers::customer_auth::current_customer(&state, &headers).await {
        req.customer_id = Some(user.id);
    }
    let company = req
        .company_name
        .as_deref()
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .ok_or_else(|| AppError::Validation("Укажите название организации".to_string()))?;
    if !(2..=200).contains(&company.chars().count()) {
        return Err(AppError::Validation(
            "Проверьте название организации".to_string(),
        ));
    }
    let inn = req
        .company_inn
        .as_deref()
        .map(str::trim)
        .unwrap_or_default()
        .to_string();
    if !(inn.chars().all(|c| c.is_ascii_digit()) && (inn.len() == 10 || inn.len() == 12)) {
        return Err(AppError::Validation(
            "ИНН должен состоять из 10 цифр (организация) или 12 (ИП)".to_string(),
        ));
    }

    let order = create_pending_order(&state, &req, "invoice").await?;
    let items = sqlx::query_as::<_, OrderItem>("SELECT * FROM order_items WHERE order_id = $1")
        .bind(order.id)
        .fetch_all(&state.pool)
        .await?;
    let items_str = items
        .iter()
        .map(|item| {
            format!(
                "— {} × {} ({:.2} ₽)",
                item.product_title,
                item.quantity,
                item.final_unit_price as f64 / 100.0
            )
        })
        .collect::<Vec<_>>()
        .join("\n");
    let mut fields = vec![
        ("Организация", company.to_string()),
        ("ИНН", inn),
        ("Контактное лицо", order.customer_name.clone()),
        ("Телефон", order.customer_phone.clone()),
    ];
    if let Some(email) = &order.customer_email {
        fields.push(("Email", email.clone()));
    }
    fields.push((
        "Сумма",
        format!("{:.2} ₽", order.total_amount as f64 / 100.0),
    ));
    fields.push(("Товары", format!("{items_str}\n")));
    Notifier::spawn(
        &state.config,
        Notification {
            title: format!("🧾 Запрос счёта {} (юрлицо)", order.public_number),
            fields,
            link: state
                .config
                .site_url
                .as_deref()
                .map(|s| format!("{s}/admin#orders")),
            reply_to: order.customer_email.clone(),
        },
    );

    Ok(Json(json!({ "order": order.public_number })))
}
