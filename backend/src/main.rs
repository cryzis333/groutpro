mod config;
mod db;
mod error;
mod handlers;
mod middleware;
mod models;
mod services;
mod state;

use crate::state::AppState;
use axum::http::{HeaderName, HeaderValue, Method};
use axum::{
    extract::DefaultBodyLimit,
    routing::{delete, get, post},
    Router,
};
use tokio::net::TcpListener;
use tower_http::{
    cors::{Any, CorsLayer},
    services::ServeDir,
    set_header::SetResponseHeaderLayer,
};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt::init();
    let cfg = config::Config::from_env()?;
    let pool = db::init(&cfg.database_url).await?;

    let upload_dir = cfg.upload_dir.clone();
    tokio::fs::create_dir_all(&upload_dir).await?;

    let state = AppState {
        pool: pool.clone(),
        config: cfg.clone(),
        upload_dir: upload_dir.clone(),
    };

    let admin_routes = Router::new()
        .route(
            "/api/admin/analytics",
            get(handlers::analytics::get_analytics),
        )
        .route(
            "/api/admin/products",
            post(handlers::products::create_product),
        )
        .route(
            "/api/admin/products/:id",
            delete(handlers::products::delete_product),
        )
        .route("/api/admin/orders", get(handlers::orders::list_orders))
        .route_layer(axum::middleware::from_fn_with_state(
            state.clone(),
            middleware::auth::auth_middleware,
        ));

    let origin: HeaderValue = cfg.site_url.parse()?;
    let cors = CorsLayer::new()
        .allow_origin(origin)
        .allow_methods([Method::GET, Method::POST, Method::DELETE])
        .allow_headers(Any);
    let app = Router::new()
        .route("/health", get(|| async { "ok" }))
        .route("/api/products", get(handlers::products::list_products))
        .route("/api/products/:id", get(handlers::products::get_product))
        .route("/api/orders", post(handlers::orders::create_order))
        .route(
            "/api/payments/create",
            post(handlers::payments::create_payment),
        )
        .route(
            "/api/payments/webhook",
            post(handlers::payments::yookassa_webhook),
        )
        .route("/api/admin/login", post(handlers::auth::login))
        .merge(admin_routes)
        .layer(DefaultBodyLimit::max(12 * 1024 * 1024))
        .layer(cors)
        .layer(SetResponseHeaderLayer::if_not_present(
            HeaderName::from_static("x-content-type-options"),
            HeaderValue::from_static("nosniff"),
        ))
        .layer(SetResponseHeaderLayer::if_not_present(
            HeaderName::from_static("referrer-policy"),
            HeaderValue::from_static("strict-origin-when-cross-origin"),
        ))
        .nest_service("/uploads", ServeDir::new(&upload_dir))
        .nest_service("/", ServeDir::new("frontend"))
        .with_state(state);

    let listener = TcpListener::bind(format!("{}:{}", cfg.server_host, cfg.server_port)).await?;
    tracing::info!("Server running on port {}", cfg.server_port);
    axum::serve(listener, app).await?;
    Ok(())
}
