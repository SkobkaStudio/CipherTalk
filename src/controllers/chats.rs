//! Контроллер чатов: список, dm/saved, группы, вступление, поиск по server_id.
//! Только HTTP-хендлеры: SQL и бизнес-логика — в services::chat_service.

use crate::models::chat::{Chat, CreateChatRequestShim, CreateDmRequest, CreateGroupRequest};
use crate::services::chat_service;
use crate::utils::error::AppResult;
use crate::utils::jwt::Claims;
use crate::ws::AppState;
use axum::extract::{Path, State};
use axum::Extension;
use axum::Json;
use serde_json::json;
use std::sync::Arc;

/// GET /api/chats — чаты пользователя (Bearer JWT), включая saved.
pub async fn list(
    State(state): State<Arc<AppState>>,
    Extension(claims): Extension<Claims>,
) -> AppResult<Json<Vec<Chat>>> {
    let chats = chat_service::list_chats(&state.db, claims.sub).await?;
    Ok(Json(chats))
}

/// POST /api/chats {name} -> {chat_id} — обратная совместимость: создаёт группу.
pub async fn create(
    State(state): State<Arc<AppState>>,
    Extension(claims): Extension<Claims>,
    Json(body): Json<CreateChatRequestShim>,
) -> AppResult<Json<serde_json::Value>> {
    let chat_id = chat_service::create_chat_named(&state.db, &body.name, claims.sub).await?;
    Ok(Json(json!({ "chat_id": chat_id })))
}

/// POST /api/chats/dm {user_id} -> Chat.
/// Свой id -> saved-чат, чужой -> диалог (создаётся при первом вызове).
pub async fn dm(
    State(state): State<Arc<AppState>>,
    Extension(claims): Extension<Claims>,
    Json(body): Json<CreateDmRequest>,
) -> AppResult<Json<Chat>> {
    let chat = chat_service::get_or_create_dm(&state.db, claims.sub, body.user_id).await?;
    Ok(Json(chat))
}

/// POST /api/chats/group {kind,title,member_ids} -> Chat (group|channel).
pub async fn group(
    State(state): State<Arc<AppState>>,
    Extension(claims): Extension<Claims>,
    Json(body): Json<CreateGroupRequest>,
) -> AppResult<Json<Chat>> {
    let chat = chat_service::create_group(&state.db, claims.sub, &body).await?;
    Ok(Json(chat))
}

/// GET /api/chats/by-id/:server_id -> Chat (по публичной ссылке вида -00000000000001).
pub async fn by_server_id(
    State(state): State<Arc<AppState>>,
    Extension(_claims): Extension<Claims>,
    Path(sid): Path<String>,
) -> AppResult<Json<Chat>> {
    let chat = chat_service::get_chat_by_server_id(&state.db, &sid).await?;
    Ok(Json(chat))
}

/// GET /api/users/:server_id -> User (публичная карточка без телефона).
pub async fn user_by_server_id(
    State(state): State<Arc<AppState>>,
    Extension(_claims): Extension<Claims>,
    Path(sid): Path<String>,
) -> AppResult<Json<crate::models::user::User>> {
    let user = chat_service::get_user_by_server_id(&state.db, &sid).await?;
    Ok(Json(user))
}

/// POST /api/chats/:id/join -> {ok:true} (:id — внутренний i64).
pub async fn join(
    State(state): State<Arc<AppState>>,
    Extension(claims): Extension<Claims>,
    Path(id): Path<i64>,
) -> AppResult<Json<serde_json::Value>> {
    chat_service::join_chat(&state.db, id, claims.sub).await?;
    Ok(Json(json!({ "ok": true })))
}
