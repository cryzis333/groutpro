use crate::{
    error::AppError, models::*, services::checkout::create_pending_order, state::AppState,
};
use axum::{extract::State, Json};

pub async fn create_order(
    State(state): State<AppState>,
    headers: axum::http::HeaderMap,
    Json(mut req): Json<CreateOrderRequest>,
) -> Result<Json<Order>, AppError> {
    if let Ok(user) = crate::handlers::customer_auth::current_customer(&state, &headers).await {
        req.customer_id = Some(user.id);
    }
    Ok(Json(create_pending_order(&state, &req).await?))
}

pub async fn list_orders(State(state): State<AppState>) -> Result<Json<Vec<Order>>, AppError> {
    Ok(Json(
        sqlx::query_as::<_, Order>("SELECT * FROM orders ORDER BY created_at DESC LIMIT 500")
            .fetch_all(&state.pool)
            .await?,
    ))
}
