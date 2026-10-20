use axum::{
    async_trait,
    extract::{rejection::JsonRejection, FromRequest, Request},
    Json,
};

use crate::error::AppError;

/// `axum::Json` whose rejection (malformed JSON, a missing field, a wrong
/// Content-Type) is answered like every other API error — `{ "error": "…" }` in
/// Russian — instead of axum's plain-text English message the frontend can't parse.
pub struct AppJson<T>(pub T);

#[async_trait]
impl<T, S> FromRequest<S> for AppJson<T>
where
    Json<T>: FromRequest<S, Rejection = JsonRejection>,
    S: Send + Sync,
{
    type Rejection = AppError;

    async fn from_request(req: Request, state: &S) -> Result<Self, Self::Rejection> {
        match Json::<T>::from_request(req, state).await {
            Ok(Json(value)) => Ok(Self(value)),
            Err(rejection) => {
                tracing::debug!(error = %rejection, "rejected JSON request body");
                Err(AppError::BadRequest(
                    "Некорректные данные запроса".to_string(),
                ))
            }
        }
    }
}
