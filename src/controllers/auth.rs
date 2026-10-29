//! Контроллер авторизации: POST /api/register, POST /api/login.

use crate::models::user::AuthRequest;
use crate::services::auth_service;
use crate::utils::error::{AppError, AppResult};
use crate::ws::AppState;
use axum::extract::State;
use axum::http::StatusCode;
use axum::Json;
use std::sync::Arc;

/// Общий разбор тела и извлечение username/password.
fn validate(req: &AuthRequest) -> AppResult<(String, String)> {
    if req.username.trim().is_empty() || req.password.is_empty() {
        return Err(AppError::BadRequest("Укажите username и password".into()));
    }
    Ok((req.username.clone(), req.password.clone()))
}

/// POST /api/register — регистрация, возвращает {token, user_id}.
pub async fn register(
    State(state): State<Arc<AppState>>,
    Json(body): Json<AuthRequest>,
) -> AppResult<(StatusCode, Json<crate::models::user::AuthResponse>)> {
    let (username, password) = validate(&body)?;
    let resp = auth_service::register(&state.db, &state.jwt_secret, &username, &password).await?;
    Ok((StatusCode::CREATED, Json(resp)))
}

/// POST /api/login — вход, возвращает {token, user_id}.
pub async fn login(
    State(state): State<Arc<AppState>>,
    Json(body): Json<AuthRequest>,
) -> AppResult<Json<crate::models::user::AuthResponse>> {
    let (username, password) = validate(&body)?;
    let resp = auth_service::login(&state.db, &state.jwt_secret, &username, &password).await?;
    Ok(Json(resp))
}
