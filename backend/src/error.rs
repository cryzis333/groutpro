use axum::{
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use serde_json::json;
use thiserror::Error;

#[derive(Error, Debug)]
pub enum AppError {
    #[error("Database error")]
    Database(#[from] sqlx::Error),
    #[error("Validation error: {0}")]
    Validation(String),
    #[error("Not found")]
    NotFound,
    #[error("Unauthorized")]
    Unauthorized,
    #[error("Internal error")]
    Internal(#[source] anyhow::Error),
    #[error("Bad request: {0}")]
    BadRequest(String),
}

impl AppError {
    pub fn internal(error: impl Into<anyhow::Error>) -> Self {
        Self::Internal(error.into())
    }
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        let status = match self {
            Self::Database(_) | Self::Internal(_) => StatusCode::INTERNAL_SERVER_ERROR,
            Self::Validation(_) | Self::BadRequest(_) => StatusCode::BAD_REQUEST,
            Self::NotFound => StatusCode::NOT_FOUND,
            Self::Unauthorized => StatusCode::UNAUTHORIZED,
        };
        if status.is_server_error() {
            tracing::error!(error = ?self, "request failed");
        }
        let message = match &self {
            Self::Validation(message) | Self::BadRequest(message) => message.as_str(),
            Self::NotFound => "Ресурс не найден",
            Self::Unauthorized => "Требуется авторизация",
            _ => "Внутренняя ошибка сервера",
        };
        (status, Json(json!({ "error": message }))).into_response()
    }
}
