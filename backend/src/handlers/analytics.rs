use crate::{
    error::AppError,
    extract::AppJson,
    models::{
        CategoryViewCount, DailyAnalytics, DailyViewCount, PageViewCount, TrackViewRequest,
        ViewStats,
    },
    state::AppState,
};
use axum::{extract::State, http::StatusCode, Json};

pub async fn get_analytics(
    State(state): State<AppState>,
) -> Result<Json<Vec<DailyAnalytics>>, AppError> {
    let data = sqlx::query_as::<_, DailyAnalytics>(
        // SUM(BIGINT) is NUMERIC in Postgres; sqlx needs BIGINT for the i64 field.
        "SELECT DATE_TRUNC('day', created_at) AS date, SUM(total_amount)::BIGINT AS revenue,
                COUNT(*) AS orders_count
         FROM orders
         WHERE status = 'paid'
         GROUP BY DATE_TRUNC('day', created_at)
         ORDER BY date DESC
         LIMIT 30",
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
        return Err(AppError::BadRequest(
            "Некорректный адрес страницы".to_string(),
        ));
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

    let daily = sqlx::query_as::<_, DailyViewCount>(
        "SELECT TO_CHAR(day, 'YYYY-MM-DD') AS date, COUNT(v.id) AS views
         FROM generate_series(CURRENT_DATE - 29, CURRENT_DATE, INTERVAL '1 day') AS day
         LEFT JOIN page_views v ON v.created_at >= day AND v.created_at < day + INTERVAL '1 day'
         GROUP BY day
         ORDER BY day",
    )
    .fetch_all(&state.pool)
    .await?;

    let pages = sqlx::query_as::<_, PageViewCount>(
        "SELECT path, COUNT(*) AS views FROM page_views
         WHERE created_at > NOW() - INTERVAL '30 days'
         GROUP BY path
         ORDER BY views DESC, path
         LIMIT 10",
    )
    .fetch_all(&state.pool)
    .await?;

    Ok(Json(ViewStats {
        total_views,
        categories,
        daily,
        pages,
    }))
}
