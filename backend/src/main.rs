mod config;
mod db;
mod error;
mod extract;
mod handlers;
mod middleware;
mod models;
mod services;
mod state;

use crate::state::AppState;
use axum::{
    extract::DefaultBodyLimit,
    http::{HeaderName, HeaderValue, Method},
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
    if std::env::args().nth(1).as_deref() == Some("notify-test") {
        return services::notify::cli_self_test().await;
    }
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
            "/api/admin/analytics/views",
            get(handlers::analytics::get_view_stats),
        )
        .route(
            "/api/admin/products",
            get(handlers::products::list_admin_products).post(handlers::products::create_product),
        )
        .route(
            "/api/admin/products/:id",
            axum::routing::put(handlers::products::update_product)
                .delete(handlers::products::delete_product),
        )
        .route(
            "/api/admin/products/:id/images",
            post(handlers::products::replace_product_images),
        )
        .route(
            "/api/admin/discounts",
            get(handlers::discounts::list_discounts).post(handlers::discounts::create_discount),
        )
        .route(
            "/api/admin/discounts/:id",
            delete(handlers::discounts::delete_discount),
        )
        .route("/api/admin/orders", get(handlers::orders::list_orders))
        .route(
            "/api/admin/contact-requests",
            get(handlers::contacts::list_contact_requests),
        )
        .route(
            "/api/admin/contact-requests/:id/order",
            post(handlers::contacts::create_order_from_lead),
        )
        .route("/api/admin/reviews", get(handlers::reviews::list_reviews))
        .route(
            "/api/admin/reviews/:id",
            axum::routing::patch(handlers::reviews::update_review_status),
        )
        .route(
            "/api/admin/contact-requests/:id",
            axum::routing::patch(handlers::contacts::update_contact_request_status),
        )
        .route_layer(axum::middleware::from_fn_with_state(
            state.clone(),
            middleware::auth::auth_middleware,
        ))
        // Large bodies only for the admin (product photos); public endpoints keep
        // axum's default 2 MB so nobody can make the server buffer 50 MB of JSON.
        .layer(DefaultBodyLimit::max(50 * 1024 * 1024));

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
        .route(
            "/api/auth/register",
            post(handlers::customer_auth::register),
        )
        .route("/api/auth/login", post(handlers::customer_auth::login))
        .route("/api/auth/logout", post(handlers::customer_auth::logout))
        .route("/api/auth/me", get(handlers::customer_auth::me))
        .route(
            "/api/account/orders",
            get(handlers::customer_auth::list_my_orders),
        )
        .route(
            "/api/account/profile",
            axum::routing::patch(handlers::customer_auth::update_profile),
        )
        .route("/api/analytics/view", post(handlers::analytics::track_view))
        .route(
            "/api/contact",
            post(handlers::contacts::create_contact_request),
        )
        .route(
            "/api/reviews",
            get(handlers::reviews::list_published_reviews).post(handlers::reviews::create_review),
        )
        .route("/api/stats", get(handlers::reviews::public_stats))
        .route(
            "/api/orders/invoice",
            post(handlers::payments::create_invoice_order),
        )
        .merge(admin_routes)
        .layer(
            CorsLayer::new()
                .allow_origin(
                    cfg.site_url
                        .as_deref()
                        .and_then(|origin| origin.parse::<HeaderValue>().ok())
                        .unwrap_or_else(|| HeaderValue::from_static("http://localhost:3000")),
                )
                .allow_methods([
                    Method::GET,
                    Method::POST,
                    Method::PUT,
                    Method::PATCH,
                    Method::DELETE,
                ])
                .allow_headers(Any),
        )
        .layer(SetResponseHeaderLayer::overriding(
            HeaderName::from_static("cache-control"),
            HeaderValue::from_static("no-cache"),
        ))
        .nest_service("/uploads", ServeDir::new(&upload_dir))
        .nest_service("/", ServeDir::new("frontend"))
        // Added last so they cover the API, uploads and static pages alike.
        .layer(SetResponseHeaderLayer::if_not_present(
            HeaderName::from_static("x-content-type-options"),
            HeaderValue::from_static("nosniff"),
        ))
        .layer(SetResponseHeaderLayer::if_not_present(
            HeaderName::from_static("referrer-policy"),
            HeaderValue::from_static("strict-origin-when-cross-origin"),
        ))
        .with_state(state);

    // Default 127.0.0.1: only nginx on this host talks to the backend. A container
    // sets SERVER_HOST=0.0.0.0.
    let listener = TcpListener::bind((cfg.server_host.as_str(), cfg.server_port)).await?;
    tracing::info!("Server listening on {}", listener.local_addr()?);
    axum::serve(listener, app).await?;
    Ok(())
}
