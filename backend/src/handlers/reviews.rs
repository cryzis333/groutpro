use crate::{
    error::AppError,
    models::{CreateReviewRequest, PublicReview, Review, UpdateReviewStatusRequest},
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

const COLUMNS: &str = "id, kind, author_name, rating, message, contact, status, created_at";

pub async fn create_review(
    State(state): State<AppState>,
    Json(req): Json<CreateReviewRequest>,
) -> Result<(StatusCode, Json<Value>), AppError> {
    // Honeypot filled in — answer like success so bots don't adapt.
    if req.website.as_deref().is_some_and(|v| !v.trim().is_empty()) {
        return Ok((StatusCode::CREATED, Json(json!({ "status": "ok" }))));
    }
    if !req.consent {
        return Err(AppError::Validation(
            "Подтвердите согласие с политикой конфиденциальности".to_string(),
        ));
    }
    let kind = if req.kind.as_deref() == Some("suggestion") {
        "suggestion"
    } else {
        "review"
    };
    let name = req.author_name.trim();
    if !(2..=120).contains(&name.chars().count()) {
        return Err(AppError::Validation("Укажите имя".to_string()));
    }
    let message = req.message.trim();
    if !(5..=3000).contains(&message.chars().count()) {
        return Err(AppError::Validation(
            "Напишите от 5 до 3000 символов".to_string(),
        ));
    }
    let rating = req.rating.filter(|_| kind == "review");
    if rating.is_some_and(|r| !(1..=5).contains(&r)) {
        return Err(AppError::Validation("Оценка от 1 до 5".to_string()));
    }
    let contact = req
        .contact
        .as_deref()
        .map(str::trim)
        .filter(|v| !v.is_empty());
    if contact.is_some_and(|v| v.chars().count() > 254) {
        return Err(AppError::Validation("Слишком длинный контакт".to_string()));
    }

    // Same spam brake as the contact form: a burst can't flood moderation.
    let recent: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM reviews WHERE created_at > NOW() - INTERVAL '1 hour'",
    )
    .fetch_one(&state.pool)
    .await?;
    if recent >= 30 {
        return Err(AppError::Validation(
            "Слишком много сообщений, попробуйте позже".to_string(),
        ));
    }

    let saved = sqlx::query_as::<_, Review>(&format!(
        "INSERT INTO reviews (kind, author_name, rating, message, contact)
         VALUES ($1, $2, $3, $4, $5) RETURNING {COLUMNS}"
    ))
    .bind(kind)
    .bind(name)
    .bind(rating)
    .bind(message)
    .bind(contact)
    .fetch_one(&state.pool)
    .await?;

    let title = if kind == "suggestion" {
        "💡 Новое предложение с сайта"
    } else {
        "⭐ Новый отзыв с сайта"
    };
    let mut fields = vec![("Имя", saved.author_name.clone())];
    if let Some(rating) = saved.rating {
        fields.push(("Оценка", format!("{rating} из 5")));
    }
    if let Some(contact) = &saved.contact {
        fields.push(("Контакт", contact.clone()));
    }
    fields.push(("Текст", saved.message.clone()));
    Notifier::spawn(
        &state.config,
        Notification {
            title: title.to_string(),
            fields,
            link: state
                .config
                .site_url
                .as_deref()
                .map(|s| format!("{s}/admin#reviews")),
            reply_to: None,
        },
    );

    Ok((StatusCode::CREATED, Json(json!({ "status": "ok" }))))
}

/// Public list — only what the admin approved.
pub async fn list_published_reviews(
    State(state): State<AppState>,
) -> Result<Json<Vec<PublicReview>>, AppError> {
    let reviews = sqlx::query_as::<_, PublicReview>(
        "SELECT author_name, rating, message, created_at FROM reviews
         WHERE status = 'published' AND kind = 'review'
         ORDER BY created_at DESC LIMIT 12",
    )
    .fetch_all(&state.pool)
    .await?;
    Ok(Json(reviews))
}

pub async fn list_reviews(State(state): State<AppState>) -> Result<Json<Vec<Review>>, AppError> {
    let reviews = sqlx::query_as::<_, Review>(&format!(
        "SELECT {COLUMNS} FROM reviews ORDER BY created_at DESC LIMIT 300"
    ))
    .fetch_all(&state.pool)
    .await?;
    Ok(Json(reviews))
}

pub async fn update_review_status(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
    Json(req): Json<UpdateReviewStatusRequest>,
) -> Result<Json<Review>, AppError> {
    if !["new", "published", "rejected"].contains(&req.status.as_str()) {
        return Err(AppError::Validation("Неизвестный статус".to_string()));
    }
    let updated = sqlx::query_as::<_, Review>(&format!(
        "UPDATE reviews SET status = $1 WHERE id = $2 RETURNING {COLUMNS}"
    ))
    .bind(&req.status)
    .bind(id)
    .fetch_optional(&state.pool)
    .await?
    .ok_or(AppError::NotFound)?;
    Ok(Json(updated))
}

/// Numbers shown on the landing page: real completed work, not a made-up figure.
pub async fn public_stats(State(state): State<AppState>) -> Result<Json<Value>, AppError> {
    let done: i64 = sqlx::query_scalar(
        "SELECT (SELECT COUNT(*) FROM contact_requests WHERE status = 'processed')
              + (SELECT COUNT(*) FROM orders WHERE status = 'paid')",
    )
    .fetch_one(&state.pool)
    .await?;
    Ok(Json(json!({
        "objects": state.config.stats_objects_base + done,
    })))
}
