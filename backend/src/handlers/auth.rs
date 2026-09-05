use crate::{
    error::AppError,
    models::{Claims, LoginRequest},
    state::AppState,
};
use axum::{
    extract::State,
    http::{header::SET_COOKIE, HeaderMap, HeaderValue},
    response::IntoResponse,
    Json,
};
use bcrypt::verify;
use jsonwebtoken::{encode, EncodingKey, Header};

pub async fn login(
    State(state): State<AppState>,
    Json(req): Json<LoginRequest>,
) -> Result<impl IntoResponse, AppError> {
    if req.username != state.config.admin_username
        || !verify(&req.password, &state.config.admin_password_hash).map_err(AppError::internal)?
    {
        return Err(AppError::Unauthorized);
    }
    let claims = Claims {
        sub: req.username,
        exp: chrono::Utc::now().timestamp() as usize + 8 * 3600,
    };
    let token = encode(
        &Header::default(),
        &claims,
        &EncodingKey::from_secret(state.config.jwt_secret.as_bytes()),
    )
    .map_err(AppError::internal)?;
    let mut headers = HeaderMap::new();
    headers.insert(SET_COOKIE, HeaderValue::from_str(&format!("admin_session={token}; Path=/api/admin; Max-Age=28800; HttpOnly; Secure; SameSite=Strict"))
        .map_err(AppError::internal)?);
    Ok((headers, Json(serde_json::json!({"success": true}))))
}
