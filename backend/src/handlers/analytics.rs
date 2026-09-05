use crate::{error::AppError, models::DailyAnalytics, state::AppState};
use axum::{extract::State, Json};

pub async fn get_analytics(
    State(state): State<AppState>,
) -> Result<Json<Vec<DailyAnalytics>>, AppError> {
    let data = sqlx::query_as::<_, DailyAnalytics>(
        "SELECT DATE_TRUNC('day', created_at) as date, SUM(total_amount) as revenue, COUNT(*) as orders_count
         FROM orders
         WHERE status = 'paid'
         GROUP BY DATE_TRUNC('day', created_at)
         ORDER BY date DESC
         LIMIT 30"
    )
    .fetch_all(&state.pool)
    .await?;
    Ok(Json(data))
}
