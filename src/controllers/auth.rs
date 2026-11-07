//! Контроллер авторизации: регистрация и вход.
//!
//! Только HTTP-обвязка: валидация, argon2 и SQL живут в `auth_service`.

use crate::controllers::json_body;
use crate::models::user::{AuthRequest, AuthResponse};
use crate::services::auth_service;
use crate::utils::error::AppResult;
use crate::ws::AppState;
use axum::extract::rejection::JsonRejection;
use axum::extract::State;
use axum::http::StatusCode;
use axum::Json;

/// POST /api/register — создать пользователя и выдать JWT.
pub async fn register(
    State(state): State<AppState>,
    payload: Result<Json<AuthRequest>, JsonRejection>,
) -> AppResult<(StatusCode, Json<AuthResponse>)> {
    let request = json_body(payload)?;
    let response = auth_service::register(&state.db, state.jwt_secret.as_str(), request).await?;
    Ok((StatusCode::CREATED, Json(response)))
}

/// POST /api/login — проверить пароль и выдать JWT.
pub async fn login(
    State(state): State<AppState>,
    payload: Result<Json<AuthRequest>, JsonRejection>,
) -> AppResult<Json<AuthResponse>> {
    let request = json_body(payload)?;
    let response = auth_service::login(&state.db, state.jwt_secret.as_str(), request).await?;
    Ok(Json(response))
}
