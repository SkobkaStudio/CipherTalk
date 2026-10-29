//! Контроллер авторизации v2: телефон -> код -> профиль -> пароль.
//! Только HTTP-обвязка: вся логика и SQL — в services::auth_service.

use crate::models::user::{
    AuthResponse, FinishRegisterRequest, LoginRequest, StartAuthRequest, StartAuthResponse,
    UsernameCheckResponse, User,
};
use crate::services::auth_service;
use crate::utils::error::{AppError, AppResult};
use crate::utils::jwt::Claims;
use crate::ws::AppState;
use axum::extract::{Query, State};
use axum::http::StatusCode;
use axum::{Extension, Json};
use serde::Deserialize;
use serde_json::json;
use std::sync::Arc;

#[derive(Deserialize)]
pub struct UsernameQuery {
    username: String,
}

/// POST /api/auth/start {phone} -> {registered, needs_code}
pub async fn start(
    State(state): State<Arc<AppState>>,
    Json(body): Json<StartAuthRequest>,
) -> AppResult<Json<StartAuthResponse>> {
    let resp = auth_service::start_auth(&state.db, &body.phone).await?;
    Ok(Json(resp))
}

/// POST /api/auth/verify {phone, code} -> {ok:true}
pub async fn verify(
    State(state): State<Arc<AppState>>,
    Json(body): Json<crate::models::user::VerifyCodeRequest>,
) -> AppResult<Json<serde_json::Value>> {
    auth_service::verify_code(&state.db, &body.phone, &body.code).await?;
    Ok(Json(json!({ "ok": true })))
}

/// POST /api/auth/finish — завершение регистрации, выдаёт JWT и профиль.
pub async fn finish(
    State(state): State<Arc<AppState>>,
    Json(body): Json<FinishRegisterRequest>,
) -> AppResult<(StatusCode, Json<AuthResponse>)> {
    let resp = auth_service::finish_register(&state.db, &state.jwt_secret, &body).await?;
    Ok((StatusCode::CREATED, Json(resp)))
}

/// POST /api/auth/login {phone, password} -> {token, user}
pub async fn login(
    State(state): State<Arc<AppState>>,
    Json(body): Json<LoginRequest>,
) -> AppResult<Json<AuthResponse>> {
    let resp = auth_service::login(&state.db, &state.jwt_secret, &body).await?;
    Ok(Json(resp))
}

/// GET /api/auth/check-username?username=xxx -> {available, reason}
pub async fn check_username(
    State(state): State<Arc<AppState>>,
    Query(q): Query<UsernameQuery>,
) -> AppResult<Json<UsernameCheckResponse>> {
    let resp = auth_service::check_username(&state.db, &q.username).await?;
    Ok(Json(resp))
}

/// GET /api/me (Bearer JWT) -> {user: User} — текущий профиль.
pub async fn me(
    State(state): State<Arc<AppState>>,
    Extension(claims): Extension<Claims>,
) -> AppResult<Json<serde_json::Value>> {
    let user: User = auth_service::get_user_by_id(&state.db, claims.sub).await?;
    // Если пользователь вдруг удалён, но токен жив — 401, чтобы фронт разлогинился
    if user.id == 0 {
        return Err(AppError::Unauthorized("Сессия недействительна".into()));
    }
    Ok(Json(json!({ "user": user })))
}
