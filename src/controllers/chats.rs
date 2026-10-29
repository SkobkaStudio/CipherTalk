//! Контроллер чатов: список, создание, вступление.
//! Только HTTP-хендлеры: SQL и бизнес-логика — в services::chat_service.

use crate::models::chat::{Chat, CreateChatRequest};
use crate::services::chat_service;
use crate::utils::error::AppResult;
use crate::utils::jwt::Claims;
use crate::ws::AppState;
use axum::extract::{Path, State};
use axum::Extension;
use axum::Json;
use serde_json::json;
use std::sync::Arc;

/// GET /api/chats — чаты пользователя (Bearer JWT).
pub async fn list(
    State(state): State<Arc<AppState>>,
    Extension(claims): Extension<Claims>,
) -> AppResult<Json<Vec<Chat>>> {
    let chats = chat_service::list_chats(&state.db, claims.sub).await?;
    Ok(Json(chats))
}

/// POST /api/chats {name} -> {chat_id}; создатель сразу добавляется в участники.
pub async fn create(
    State(state): State<Arc<AppState>>,
    Extension(claims): Extension<Claims>,
    Json(body): Json<CreateChatRequest>,
) -> AppResult<Json<serde_json::Value>> {
    let chat_id = chat_service::create_chat(&state.db, &body.name, claims.sub).await?;
    Ok(Json(json!({ "chat_id": chat_id })))
}

/// POST /api/chats/:id/join -> {ok:true}
pub async fn join(
    State(state): State<Arc<AppState>>,
    Extension(claims): Extension<Claims>,
    Path(id): Path<i64>,
) -> AppResult<Json<serde_json::Value>> {
    chat_service::join_chat(&state.db, id, claims.sub).await?;
    Ok(Json(json!({ "ok": true })))
}
