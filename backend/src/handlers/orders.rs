use crate::{
    error::AppError, extract::AppJson, models::*, services::checkout::create_pending_order,
    state::AppState,
};
use axum::{extract::State, Json};

pub async fn create_order(
    State(state): State<AppState>,
    headers: axum::http::HeaderMap,
    AppJson(mut req): AppJson<CreateOrderRequest>,
) -> Result<Json<Order>, AppError> {
    if let Ok(user) = crate::handlers::customer_auth::current_customer(&state, &headers).await {
        req.customer_id = Some(user.id);
    }
    Ok(Json(create_pending_order(&state, &req, "sbp").await?))
}

pub async fn list_orders(State(state): State<AppState>) -> Result<Json<Vec<Order>>, AppError> {
    let orders = sqlx::query_as::<_, Order>("SELECT * FROM orders ORDER BY created_at DESC")
        .fetch_all(&state.pool)
        .await?;
    Ok(Json(orders))
}
