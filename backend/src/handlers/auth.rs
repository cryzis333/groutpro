use crate::{
    error::AppError,
    models::{Claims, LoginRequest, LoginResponse},
    state::AppState,
};
use axum::{extract::State, Json};
use bcrypt::verify;
use jsonwebtoken::{encode, EncodingKey, Header};

pub async fn login(
    State(state): State<AppState>,
    Json(req): Json<LoginRequest>,
) -> Result<Json<LoginResponse>, AppError> {
    if req.username != state.config.admin_username {
        return Err(AppError::Unauthorized);
    }
    if !verify(&req.password, &state.config.admin_password_hash)
        .map_err(|e| AppError::Internal(e.to_string()))?
    {
        return Err(AppError::Unauthorized);
    }
    let exp = chrono::Utc::now().timestamp() as usize + 86400;
    let claims = Claims {
        sub: req.username,
        exp,
    };
    let token = encode(
        &Header::default(),
        &claims,
        &EncodingKey::from_secret(state.config.jwt_secret.as_bytes()),
    )
    .map_err(|e| AppError::Internal(e.to_string()))?;
    Ok(Json(LoginResponse { token }))
}
