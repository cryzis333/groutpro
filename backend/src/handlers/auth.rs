use crate::{
    error::AppError,
    extract::AppJson,
    models::{Claims, LoginRequest, LoginResponse},
    state::AppState,
};
use axum::{extract::State, Json};
use bcrypt::verify;
use jsonwebtoken::{encode, EncodingKey, Header};

pub async fn login(
    State(state): State<AppState>,
    AppJson(req): AppJson<LoginRequest>,
) -> Result<Json<LoginResponse>, AppError> {
    let LoginRequest { username, password } = req;
    let hash = state.config.admin_password_hash.clone();
    // bcrypt costs ~100 ms of CPU, so it runs on the blocking pool instead of an
    // async worker. It also runs for a wrong username: the response time must not
    // tell whether the name was right.
    let password_ok = tokio::task::spawn_blocking(move || verify(password, &hash))
        .await
        .map_err(|e| AppError::Internal(e.to_string()))?
        .map_err(|e| AppError::Internal(e.to_string()))?;
    if username != state.config.admin_username || !password_ok {
        return Err(AppError::Unauthorized);
    }
    let exp = chrono::Utc::now().timestamp() as usize + 86400;
    let claims = Claims { sub: username, exp };
    let token = encode(
        &Header::default(),
        &claims,
        &EncodingKey::from_secret(state.config.jwt_secret.as_bytes()),
    )
    .map_err(|e| AppError::Internal(e.to_string()))?;
    Ok(Json(LoginResponse { token }))
}
