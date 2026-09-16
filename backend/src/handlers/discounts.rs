use axum::{
    extract::{Path, State},
    Json,
};
use serde::{Deserialize, Serialize};
use sqlx::FromRow;
use uuid::Uuid;

use crate::{error::AppError, state::AppState};

#[derive(Debug, Serialize, FromRow)]
pub struct Discount {
    pub id: Uuid,
    pub product_id: Option<Uuid>,
    pub category: Option<String>,
    pub percent_bps: i32,
    pub is_registered_only: bool,
    pub starts_at: Option<chrono::DateTime<chrono::Utc>>,
    pub ends_at: Option<chrono::DateTime<chrono::Utc>>,
    pub is_active: bool,
}

#[derive(Debug, Deserialize)]
pub struct CreateDiscountRequest {
    pub product_id: Option<Uuid>,
    pub category: Option<String>,
    pub percent: f64,
    pub is_registered_only: Option<bool>,
}

pub async fn list_discounts(
    State(state): State<AppState>,
) -> Result<Json<Vec<Discount>>, AppError> {
    let discounts = sqlx::query_as::<_, Discount>(
        "SELECT id, product_id, category, percent_bps, is_registered_only, starts_at, ends_at, is_active
         FROM discounts ORDER BY created_at DESC",
    )
    .fetch_all(&state.pool)
    .await?;
    Ok(Json(discounts))
}

pub async fn create_discount(
    State(state): State<AppState>,
    Json(req): Json<CreateDiscountRequest>,
) -> Result<Json<Discount>, AppError> {
    let category = req
        .category
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    if req.product_id.is_some() == category.is_some()
        || !req.percent.is_finite()
        || req.percent <= 0.0
        || req.percent >= 100.0
    {
        return Err(AppError::Validation(
            "Укажите товар или категорию и скидку от 0 до 100%".to_string(),
        ));
    }
    let percent_bps = (req.percent * 100.0).round() as i32;
    let discount = sqlx::query_as::<_, Discount>(
        "INSERT INTO discounts (product_id, category, percent_bps, is_registered_only)
         VALUES ($1, $2, $3, $4)
         RETURNING id, product_id, category, percent_bps, is_registered_only, starts_at, ends_at, is_active",
    )
    .bind(req.product_id)
    .bind(category)
    .bind(percent_bps)
    .bind(req.is_registered_only.unwrap_or(true))
    .fetch_one(&state.pool)
    .await?;
    Ok(Json(discount))
}

pub async fn delete_discount(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
) -> Result<Json<serde_json::Value>, AppError> {
    let result =
        sqlx::query("UPDATE discounts SET is_active = FALSE, updated_at = NOW() WHERE id = $1")
            .bind(id)
            .execute(&state.pool)
            .await?;
    if result.rows_affected() == 0 {
        return Err(AppError::NotFound);
    }
    Ok(Json(serde_json::json!({ "success": true })))
}
