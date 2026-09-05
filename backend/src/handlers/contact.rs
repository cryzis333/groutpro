use crate::{error::AppError, services::email::EmailService, state::AppState};
use axum::{extract::State, Json};
use serde::{Deserialize, Serialize};

#[derive(Deserialize)]
pub struct ContactRequest {
    name: String,
    phone: String,
    email: Option<String>,
    message: String,
    #[serde(default)]
    website: String,
}

#[derive(Serialize)]
pub struct ContactResponse {
    success: bool,
}

pub async fn create_contact(
    State(state): State<AppState>,
    Json(mut request): Json<ContactRequest>,
) -> Result<Json<ContactResponse>, AppError> {
    if !request.website.trim().is_empty() {
        return Ok(Json(ContactResponse { success: true }));
    }
    request.name = clean(request.name, 120);
    request.phone = clean(request.phone, 32);
    request.message = clean(request.message, 3000);
    request.email = request
        .email
        .map(|value| clean(value, 254))
        .filter(|value| !value.is_empty());
    if request.name.is_empty() || request.phone.len() < 5 || request.message.is_empty() {
        return Err(AppError::Validation(
            "Заполните имя, телефон и описание задачи".into(),
        ));
    }
    if request
        .email
        .as_deref()
        .is_some_and(|email| !email.contains('@'))
    {
        return Err(AppError::Validation("Укажите корректный email".into()));
    }
    let id: uuid::Uuid = sqlx::query_scalar(
        "INSERT INTO contact_requests (name,phone,email,message) VALUES ($1,$2,$3,$4) RETURNING id",
    )
    .bind(&request.name)
    .bind(&request.phone)
    .bind(&request.email)
    .bind(&request.message)
    .fetch_one(&state.pool)
    .await?;
    let email = EmailService::new(&state.config);
    if let Err(error) = email
        .send_contact(
            id,
            &request.name,
            &request.phone,
            request.email.as_deref(),
            &request.message,
        )
        .await
    {
        tracing::error!(?error, contact_id=%id, "contact email failed");
    }
    Ok(Json(ContactResponse { success: true }))
}

fn clean(value: String, limit: usize) -> String {
    value.trim().chars().take(limit).collect()
}
