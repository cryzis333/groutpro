use crate::{
    error::AppError,
    extract::AppJson,
    models::{CategoryViewCount, DailyAnalytics, TrackViewRequest, ViewStats},
    state::AppState,
};
use axum::{extract::State, http::StatusCode, Json};

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

pub async fn track_view(
    State(state): State<AppState>,
    AppJson(req): AppJson<TrackViewRequest>,
) -> Result<StatusCode, AppError> {
    let path = req.path.trim();
    if path.is_empty() || path.len() > 512 {
        return Err(AppError::BadRequest("Invalid path".into()));
    }
    let category = req
        .category
        .as_deref()
        .map(str::trim)
        .filter(|c| !c.is_empty() && c.len() <= 128)
        .map(str::to_string);

    sqlx::query("INSERT INTO page_views (path, category) VALUES ($1, $2)")
        .bind(path)
        .bind(category)
        .execute(&state.pool)
        .await?;

    Ok(StatusCode::NO_CONTENT)
}

pub async fn get_view_stats(State(state): State<AppState>) -> Result<Json<ViewStats>, AppError> {
    let total_views: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM page_views WHERE created_at > NOW() - INTERVAL '30 days'",
    )
    .fetch_one(&state.pool)
    .await?;

    let categories = sqlx::query_as::<_, CategoryViewCount>(
        "SELECT category, COUNT(*) as views FROM page_views
         WHERE category IS NOT NULL AND created_at > NOW() - INTERVAL '30 days'
         GROUP BY category
         ORDER BY views DESC
         LIMIT 10",
    )
    .fetch_all(&state.pool)
    .await?;

    Ok(Json(ViewStats {
        total_views,
        categories,
    }))
}
