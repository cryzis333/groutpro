use crate::{
    error::AppError,
    models::{ContactRequest, CreateContactRequest, UpdateContactStatusRequest},
    services::notify::{Notification, Notifier},
    state::AppState,
};
use axum::{
    extract::{Path, State},
    http::StatusCode,
    Json,
};
use serde_json::{json, Value};
use uuid::Uuid;

const CONTACT_COLUMNS: &str =
    "id, name, phone, email, message, status, created_at, source, estimate_items, estimate_total";

/// Смета пересчитывается по нашим ценам: из браузера приходят только id и количество.
async fn resolve_estimate(
    state: &AppState,
    req: &CreateContactRequest,
) -> Result<Option<(String, i64, String)>, AppError> {
    let Some(items) = req.estimate.as_ref().filter(|items| !items.is_empty()) else {
        return Ok(None);
    };
    if items.len() > 20 {
        return Err(AppError::Validation("Слишком много позиций".to_string()));
    }
    let mut rows = Vec::new();
    let mut lines = Vec::new();
    let mut total = 0_i64;
    for item in items {
        let quantity = item.quantity.clamp(1, 99);
        let product = sqlx::query_as::<_, (String, i64)>(
            "SELECT title, price FROM products
             WHERE id = $1 AND archived_at IS NULL AND is_published = TRUE",
        )
        .bind(item.product_id)
        .fetch_optional(&state.pool)
        .await?;
        let Some((title, price)) = product else {
            continue;
        };
        let sum = price.saturating_mul(quantity as i64);
        total = total.saturating_add(sum);
        rows.push(serde_json::json!({
            "product_id": item.product_id,
            "title": title,
            "quantity": quantity,
            "unit_price": price,
            "sum": sum,
        }));
        lines.push(format!(
            "— {} × {} = {:.2} ₽",
            title,
            quantity,
            sum as f64 / 100.0
        ));
    }
    if rows.is_empty() {
        return Ok(None);
    }
    Ok(Some((
        serde_json::Value::Array(rows).to_string(),
        total,
        lines.join("\n"),
    )))
}

pub async fn create_contact_request(
    State(state): State<AppState>,
    Json(req): Json<CreateContactRequest>,
) -> Result<(StatusCode, Json<Value>), AppError> {
    // Honeypot filled in — answer like a success so bots don't adapt.
    if req.website.as_deref().is_some_and(|v| !v.trim().is_empty()) {
        return Ok((StatusCode::CREATED, Json(json!({ "status": "ok" }))));
    }
    if !req.consent {
        return Err(AppError::Validation(
            "Подтвердите согласие с политикой конфиденциальности".to_string(),
        ));
    }

    let name = req.name.trim();
    if !(2..=120).contains(&name.chars().count()) {
        return Err(AppError::Validation("Укажите имя".to_string()));
    }
    let phone = req.phone.trim();
    let digits = phone.chars().filter(char::is_ascii_digit).count();
    if !(10..=15).contains(&digits) || phone.chars().count() > 32 {
        return Err(AppError::Validation(
            "Проверьте номер телефона".to_string(),
        ));
    }
    let email = req
        .email
        .as_deref()
        .map(str::trim)
        .filter(|v| !v.is_empty());
    if email.is_some_and(|v| {
        v.len() > 254 || !v.rsplit_once('@').is_some_and(|(user, domain)| !user.is_empty() && domain.contains('.'))
    }) {
        return Err(AppError::Validation("Проверьте email".to_string()));
    }
    let message = req.message.as_deref().map(str::trim).unwrap_or_default();
    if message.chars().count() > 3000 {
        return Err(AppError::Validation(
            "Описание слишком длинное (до 3000 символов)".to_string(),
        ));
    }
    let message = if message.is_empty() { "(без описания)" } else { message };
    let estimate = resolve_estimate(&state, &req).await?;
    let source = if estimate.is_some() { "estimate" } else { "contact" };

    // Spam brakes: the same phone at most 3 times per 10 minutes, and a global
    // hourly cap so a bot can't flood the Telegram chat.
    let (same_phone, last_hour): (i64, i64) = sqlx::query_as(
        "SELECT COUNT(*) FILTER (WHERE phone = $1 AND created_at > NOW() - INTERVAL '10 minutes'),
                COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '1 hour')
         FROM contact_requests WHERE created_at > NOW() - INTERVAL '1 hour'",
    )
    .bind(phone)
    .fetch_one(&state.pool)
    .await?;
    if same_phone >= 3 {
        return Err(AppError::Validation(
            "Заявка уже отправлена — мы скоро с вами свяжемся".to_string(),
        ));
    }
    if last_hour >= 60 {
        return Err(AppError::Validation(
            "Сейчас слишком много заявок, пожалуйста, позвоните нам".to_string(),
        ));
    }

    let saved = sqlx::query_as::<_, ContactRequest>(&format!(
        "INSERT INTO contact_requests (name, phone, email, message, source, estimate_items, estimate_total)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING {CONTACT_COLUMNS}"
    ))
    .bind(name)
    .bind(phone)
    .bind(email)
    .bind(message)
    .bind(source)
    .bind(estimate.as_ref().map(|(json, _, _)| json.as_str()))
    .bind(estimate.as_ref().map(|(_, total, _)| *total))
    .fetch_one(&state.pool)
    .await?;

    let mut fields = vec![("Имя", saved.name.clone()), ("Телефон", saved.phone.clone())];
    if let Some(email) = &saved.email {
        fields.push(("Email", email.clone()));
    }
    fields.push(("Задача", saved.message.clone()));
    let title = match &estimate {
        Some((_, total, lines)) => {
            fields.push(("Смета", format!("{lines}\n")));
            fields.push((
                "Ориентировочно",
                format!("{:.2} ₽ (без выезда — он бесплатный)", *total as f64 / 100.0),
            ));
            "📐 Заявка на замер по смете"
        }
        None => "📩 Новая заявка с сайта",
    };
    Notifier::spawn(
        &state.config,
        Notification {
            title: title.to_string(),
            fields,
            link: state.config.site_url.as_deref().map(|s| format!("{s}/admin#leads")),
            reply_to: saved.email.clone(),
        },
    );

    Ok((StatusCode::CREATED, Json(json!({ "status": "ok" }))))
}

pub async fn list_contact_requests(
    State(state): State<AppState>,
) -> Result<Json<Vec<ContactRequest>>, AppError> {
    let requests = sqlx::query_as::<_, ContactRequest>(&format!(
        "SELECT {CONTACT_COLUMNS} FROM contact_requests ORDER BY created_at DESC LIMIT 300"
    ))
    .fetch_all(&state.pool)
    .await?;
    Ok(Json(requests))
}

pub async fn update_contact_request_status(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
    Json(req): Json<UpdateContactStatusRequest>,
) -> Result<Json<ContactRequest>, AppError> {
    if !["new", "in_progress", "processed", "spam"].contains(&req.status.as_str()) {
        return Err(AppError::Validation("Неизвестный статус".to_string()));
    }
    let updated = sqlx::query_as::<_, ContactRequest>(&format!(
        "UPDATE contact_requests SET status = $1 WHERE id = $2 RETURNING {CONTACT_COLUMNS}"
    ))
    .bind(&req.status)
    .bind(id)
    .fetch_optional(&state.pool)
    .await?
    .ok_or(AppError::NotFound)?;
    Ok(Json(updated))
}

/// Превращает смету из заявки в заказ: контакты берём из заявки, позиции — из сметы,
/// цены пересчитывает checkout по текущему прайсу. Оплата выставляется вручную,
/// поэтому способ — счёт; склад спишется только после подтверждённой оплаты.
pub async fn create_order_from_lead(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>, AppError> {
    let lead = sqlx::query_as::<_, ContactRequest>(&format!(
        "SELECT {CONTACT_COLUMNS} FROM contact_requests WHERE id = $1"
    ))
    .bind(id)
    .fetch_optional(&state.pool)
    .await?
    .ok_or(AppError::NotFound)?;

    let items_json = lead
        .estimate_items
        .as_deref()
        .ok_or_else(|| AppError::Validation("В заявке нет сметы".to_string()))?;
    let parsed: Vec<Value> = serde_json::from_str(items_json)
        .map_err(|_| AppError::Internal("Не удалось прочитать смету".to_string()))?;

    let mut items = Vec::new();
    for entry in &parsed {
        let product_id = entry
            .get("product_id")
            .and_then(Value::as_str)
            .and_then(|v| v.parse::<Uuid>().ok());
        let quantity = entry.get("quantity").and_then(Value::as_i64).unwrap_or(1) as i32;
        match product_id {
            Some(product_id) => items.push(crate::models::OrderItemRequest {
                product_id,
                quantity: quantity.max(1),
            }),
            // Старые заявки хранились без id товара — находим по названию.
            None => {
                let title = entry.get("title").and_then(Value::as_str).unwrap_or_default();
                let found: Option<(Uuid,)> = sqlx::query_as(
                    "SELECT id FROM products WHERE title = $1 AND archived_at IS NULL AND is_published = TRUE LIMIT 1",
                )
                .bind(title)
                .fetch_optional(&state.pool)
                .await?;
                if let Some((product_id,)) = found {
                    items.push(crate::models::OrderItemRequest {
                        product_id,
                        quantity: quantity.max(1),
                    });
                }
            }
        }
    }
    if items.is_empty() {
        return Err(AppError::Validation(
            "Позиции сметы больше не продаются — соберите заказ вручную".to_string(),
        ));
    }

    let request = crate::models::CreateOrderRequest {
        customer_id: None,
        customer_name: lead.name.clone(),
        customer_phone: lead.phone.clone(),
        customer_email: lead.email.clone(),
        customer_address: None,
        items,
        company_name: None,
        company_inn: None,
        consent: true,
        not_robot: true,
        website: None,
    };
    let order = crate::services::checkout::create_pending_order(&state, &request, "invoice").await?;

    sqlx::query("UPDATE contact_requests SET status = 'in_progress' WHERE id = $1 AND status = 'new'")
        .bind(id)
        .execute(&state.pool)
        .await?;

    Ok(Json(json!({
        "order": order.public_number,
        "total": order.total_amount,
    })))
}
