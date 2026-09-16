use argon2::{Argon2, PasswordHash, PasswordHasher, PasswordVerifier};
use axum::{
    extract::State,
    http::{header, HeaderValue, StatusCode},
    response::IntoResponse,
    Json,
};
use rand_core::{OsRng, RngCore};
use sha2::{Digest, Sha256};
use sqlx::FromRow;
use uuid::Uuid;

use crate::{
    error::AppError,
    models::{CustomerLoginRequest, CustomerOrder, CustomerProfile, CustomerRegisterRequest},
    state::AppState,
};

const SESSION_COOKIE: &str = "groutpro_session";
const SESSION_LIFETIME_SECONDS: i64 = 60 * 60 * 24 * 14;

#[derive(FromRow)]
struct StoredUser {
    id: Uuid,
    email: String,
    display_name: String,
    password_hash: String,
    role: String,
}

pub async fn register(
    State(state): State<AppState>,
    Json(req): Json<CustomerRegisterRequest>,
) -> Result<impl IntoResponse, AppError> {
    let name = req.name.trim();
    let email = req.email.trim().to_lowercase();
    if name.len() < 2
        || name.len() > 120
        || !is_valid_email(&email)
        || req.password.len() < 10
        || req.password.len() > 128
    {
        return Err(AppError::Validation(
            "Проверьте имя, email и пароль (минимум 10 символов)".to_string(),
        ));
    }

    let salt = argon2::password_hash::SaltString::generate(&mut OsRng);
    let password_hash = Argon2::default()
        .hash_password(req.password.as_bytes(), &salt)
        .map_err(|_| AppError::Internal("Не удалось создать аккаунт".to_string()))?
        .to_string();
    let user = sqlx::query_as::<_, CustomerProfile>(
        "INSERT INTO users (email, password_hash, display_name)
         VALUES ($1, $2, $3)
         RETURNING id, email, display_name",
    )
    .bind(&email)
    .bind(password_hash)
    .bind(name)
    .fetch_one(&state.pool)
    .await
    .map_err(|error| match error {
        sqlx::Error::Database(db) if db.is_unique_violation() => {
            AppError::Validation("Этот email уже зарегистрирован".to_string())
        }
        other => AppError::Database(other),
    })?;

    session_response(&state, user).await
}

pub async fn login(
    State(state): State<AppState>,
    Json(req): Json<CustomerLoginRequest>,
) -> Result<impl IntoResponse, AppError> {
    let email = req.email.trim().to_lowercase();
    let user = sqlx::query_as::<_, StoredUser>(
        "SELECT id, email, display_name, password_hash, role FROM users WHERE LOWER(email) = LOWER($1)",
    )
    .bind(&email)
    .fetch_optional(&state.pool)
    .await?
    .ok_or(AppError::Unauthorized)?;

    let hash = PasswordHash::new(&user.password_hash).map_err(|_| AppError::Unauthorized)?;
    if user.role != "customer"
        || Argon2::default()
            .verify_password(req.password.as_bytes(), &hash)
            .is_err()
    {
        return Err(AppError::Unauthorized);
    }

    session_response(
        &state,
        CustomerProfile {
            id: user.id,
            email: user.email,
            display_name: user.display_name,
        },
    )
    .await
}

pub async fn logout(
    State(state): State<AppState>,
    headers: axum::http::HeaderMap,
) -> impl IntoResponse {
    if let Some(token) = session_token(&headers) {
        let _ = sqlx::query("UPDATE user_sessions SET revoked_at = NOW() WHERE token_hash = $1")
            .bind(token_hash(&token))
            .execute(&state.pool)
            .await;
    }
    let mut response = StatusCode::NO_CONTENT.into_response();
    response.headers_mut().append(
        header::SET_COOKIE,
        HeaderValue::from_static("groutpro_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0"),
    );
    response
}

pub async fn me(
    State(state): State<AppState>,
    headers: axum::http::HeaderMap,
) -> Result<Json<CustomerProfile>, AppError> {
    Ok(Json(current_customer(&state, &headers).await?))
}

pub async fn list_my_orders(
    State(state): State<AppState>,
    headers: axum::http::HeaderMap,
) -> Result<Json<Vec<CustomerOrder>>, AppError> {
    let user = current_customer(&state, &headers).await?;
    let orders = sqlx::query_as::<_, CustomerOrder>(
        "SELECT public_number, total_amount, status, created_at
         FROM orders WHERE customer_id = $1 ORDER BY created_at DESC",
    )
    .bind(user.id)
    .fetch_all(&state.pool)
    .await?;
    Ok(Json(orders))
}

pub async fn current_customer(
    state: &AppState,
    headers: &axum::http::HeaderMap,
) -> Result<CustomerProfile, AppError> {
    let token = session_token(headers).ok_or(AppError::Unauthorized)?;
    let user = sqlx::query_as::<_, CustomerProfile>(
        "SELECT u.id, u.email, u.display_name FROM user_sessions s
         JOIN users u ON u.id = s.user_id
         WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > NOW() AND u.role = 'customer'",
    )
    .bind(token_hash(&token))
    .fetch_optional(&state.pool)
    .await?
    .ok_or(AppError::Unauthorized)?;
    Ok(user)
}

async fn session_response(
    state: &AppState,
    user: CustomerProfile,
) -> Result<axum::response::Response, AppError> {
    let token = create_token();
    sqlx::query("INSERT INTO user_sessions (user_id, token_hash, expires_at) VALUES ($1, $2, NOW() + INTERVAL '14 days')")
        .bind(user.id)
        .bind(token_hash(&token))
        .execute(&state.pool)
        .await?;
    let mut response = Json(user).into_response();
    let cookie = format!("{SESSION_COOKIE}={token}; Path=/; HttpOnly; SameSite=Lax; Max-Age={SESSION_LIFETIME_SECONDS}");
    response.headers_mut().append(
        header::SET_COOKIE,
        HeaderValue::from_str(&cookie)
            .map_err(|_| AppError::Internal("Не удалось создать сессию".to_string()))?,
    );
    Ok(response)
}

fn session_token(headers: &axum::http::HeaderMap) -> Option<String> {
    headers
        .get(header::COOKIE)?
        .to_str()
        .ok()?
        .split(';')
        .find_map(|part| {
            let (key, value) = part.trim().split_once('=')?;
            (key == SESSION_COOKIE).then(|| value.to_string())
        })
}

fn create_token() -> String {
    let mut bytes = [0_u8; 32];
    OsRng.fill_bytes(&mut bytes);
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn token_hash(token: &str) -> String {
    format!("{:x}", Sha256::digest(token.as_bytes()))
}

fn is_valid_email(email: &str) -> bool {
    email.len() <= 254
        && email.contains('@')
        && email
            .rsplit_once('@')
            .is_some_and(|(_, domain)| domain.contains('.'))
}
