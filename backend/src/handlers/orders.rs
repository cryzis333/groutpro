use crate::{error::AppError, models::*, state::AppState};
use axum::{extract::State, Json};

/// Orders are created only together with a payment method: `/api/payments/create`
/// (СБП) or `/api/orders/invoice` (счёт). This old endpoint let anyone fill the
/// admin list with unpaid orders, so it now only explains where to go.
pub async fn create_order() -> AppError {
    AppError::Validation(
        "Заказ оформляется в корзине: выберите оплату по СБП или счёт для организаций.".to_string(),
    )
}

pub async fn list_orders(State(state): State<AppState>) -> Result<Json<Vec<Order>>, AppError> {
    let orders =
        sqlx::query_as::<_, Order>("SELECT * FROM orders ORDER BY created_at DESC LIMIT 500")
            .fetch_all(&state.pool)
            .await?;
    Ok(Json(orders))
}
