//! Контроллер чатов: список, создание и вход по id.
//!
//! SQL и проверки — в `chat_service`; здесь только извлечение JWT-claims,
//! параметров пути и формирование JSON-ответов.

use crate::controllers::json_body;
use crate::models::chat::{Chat, CreateChatRequest};
use crate::services::chat_service;
use crate::utils::error::AppResult;
use crate::utils::jwt::Claims;
use crate::ws::AppState;
use axum::extract::rejection::JsonRejection;
use axum::extract::{Path, State};
use axum::{Extension, Json};
use serde_json::{json, Value};

/// GET /api/chats — чаты текущего пользователя (Bearer JWT).
pub async fn list(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
) -> AppResult<Json<Vec<Chat>>> {
    let chats = chat_service::list_chats(&state.db, claims.sub).await?;
    Ok(Json(chats))
}

/// POST /api/chats {name} — создать чат; создатель сразу становится участником.
pub async fn create(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    payload: Result<Json<CreateChatRequest>, JsonRejection>,
) -> AppResult<Json<Value>> {
    let request = json_body(payload)?;
    let chat_id = chat_service::create_chat(&state.db, &request.name, claims.sub).await?;
    Ok(Json(json!({ "chat_id": chat_id })))
}

/// POST /api/chats/:id/join — войти в публичный чат по id.
pub async fn join(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path(chat_id): Path<i64>,
) -> AppResult<Json<Value>> {
    chat_service::join_chat(&state.db, chat_id, claims.sub).await?;
    Ok(Json(json!({ "ok": true })))
}
