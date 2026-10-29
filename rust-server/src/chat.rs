//! Чаты и сообщения: REST-эндпоинты поверх rqlite.
//!
//! * `POST /api/chats`               — создать/найти личный чат (идемпотентно).
//! * `GET  /api/chats`               — список чатов пользователя.
//! * `GET  /api/chats/:id/messages`  — история сообщений (только для участников).

use axum::extract::{Path, Query, State};
use axum::Json;
use serde::{Deserialize, Serialize};

use crate::auth::{ApiError, AuthUser};
use crate::db::Db;
use crate::models::{Chat, ChatMessage, CreateChatRequest, OnlineUser, PublicUser, UserRecord};

#[derive(Debug, Deserialize)]
pub struct MessagesQuery {
    #[serde(rename = "beforeId")]
    pub before_id: Option<String>,
    pub limit: Option<i64>,
}

/// Собирает публичный объект чата: для личных чатов подставляет собеседника.
pub async fn build_chat(
    db: &Db,
    chat_id: &str,
    chat_type: &str,
    name: &str,
    created_at: i64,
    viewer_id: &str,
) -> Result<Chat, ApiError> {
    let member_ids = db.get_chat_members(chat_id).await?;
    let mut partner: Option<PublicUser> = None;
    if chat_type == "private" {
        for mid in &member_ids {
            if mid != viewer_id {
                if let Some(u) = db.find_user_by_id(mid).await? {
                    partner = Some(u.to_public());
                }
                break;
            }
        }
    }
    let last_message = db.last_message_in_chat(chat_id).await?;
    Ok(Chat {
        id: chat_id.to_string(),
        chat_type: chat_type.to_string(),
        name: name.to_string(),
        member_ids,
        partner,
        created_at,
        last_message,
    })
}

/// POST /api/chats
pub async fn create_chat(
    State(state): State<crate::ws::WsState>,
    headers: axum::http::HeaderMap,
    Json(body): Json<CreateChatRequest>,
) -> Result<Json<Chat>, ApiError> {
    let db = &state.db;
    let auth = AuthUser::from_headers(&headers)?;
    let me = crate::ws::load_user(db, &auth.user_id).await?;
    if body.target_user_id.trim().is_empty() {
        return Err(ApiError::bad_request("targetUserId is required"));
    }
    if body.target_user_id == me.id {
        return Err(ApiError::bad_request("cannot create a chat with yourself"));
    }
    let target = db
        .find_user_by_id(body.target_user_id.trim())
        .await?
        .ok_or_else(|| ApiError::new(axum::http::StatusCode::NOT_FOUND, "target user not found"))?;

    // Идемпотентность: если личный чат уже существует — возвращаем его.
    let chat_id = match db.find_private_chat(&me.id, &target.id).await? {
        Some(id) => id,
        None => {
            let name = format!("{}, {}", me.display_name, target.display_name);
            let members = vec![me.id.clone(), target.id.clone()];
            db.create_chat("private", &name, &members).await?
        }
    };
    // Гарантируем членство обоих участников (идемпотентно: INSERT OR IGNORE).
    db.add_member(&chat_id, &me.id).await?;
    db.add_member(&chat_id, &target.id).await?;
    let (chat_type, name, created_ms) = db
        .get_chat_meta(&chat_id)
        .await?
        .ok_or_else(|| ApiError::internal("chat row missing"))?;
    let chat = build_chat(db, &chat_id, &chat_type, &name, created_ms, &me.id).await?;
    Ok(Json(chat))
}

/// GET /api/chats
pub async fn list_chats(
    State(state): State<crate::ws::WsState>,
    headers: axum::http::HeaderMap,
) -> Result<Json<Vec<Chat>>, ApiError> {
    let db = &state.db;
    let auth = AuthUser::from_headers(&headers)?;
    let rows = db.get_user_chats(&auth.user_id).await?;
    let mut out = Vec::with_capacity(rows.len());
    for (id, chat_type, name, created_at) in rows {
        out.push(build_chat(db, &id, &chat_type, &name, created_at, &auth.user_id).await?);
    }
    Ok(Json(out))
}

/// GET /api/chats/:id/messages
pub async fn chat_messages(
    State(state): State<crate::ws::WsState>,
    headers: axum::http::HeaderMap,
    Path(chat_id): Path<String>,
    Query(q): Query<MessagesQuery>,
) -> Result<Json<Vec<ChatMessage>>, ApiError> {
    let db = &state.db;
    let auth = AuthUser::from_headers(&headers)?;
    if !db.is_chat_member(&chat_id, &auth.user_id).await? {
        return Err(ApiError::forbidden("not a member of this chat"));
    }
    let limit = q.limit.unwrap_or(50).clamp(1, 100);
    let msgs = db
        .get_chat_messages(&chat_id, q.before_id.as_deref(), limit)
        .await?;
    Ok(Json(msgs))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UserInfoResponse {
    pub user: PublicUser,
}

/// GET /api/users/:id — публичная карточка пользователя (для начала чата с фронта).
pub async fn get_user(
    State(state): State<crate::ws::WsState>,
    _headers: axum::http::HeaderMap,
    Path(user_id): Path<String>,
) -> Result<Json<UserInfoResponse>, ApiError> {
    let db = &state.db;
    let u: UserRecord = db
        .find_user_by_id(&user_id)
        .await?
        .ok_or_else(|| ApiError::new(axum::http::StatusCode::NOT_FOUND, "user not found"))?;
    Ok(Json(UserInfoResponse { user: u.to_public() }))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchUsersQuery {
    pub q: String,
}

/// GET /api/users/search?q=... — поиск по username/displayName (минимум 2 символа).
/// Ответ содержит флаг `online`, рассчитанный по активным WS-соединениям.
pub async fn search_users(
    State(state): State<crate::ws::WsState>,
    _headers: axum::http::HeaderMap,
    Query(q): Query<SearchUsersQuery>,
) -> Result<Json<Vec<OnlineUser>>, ApiError> {
    let db = &state.db;
    let registry = &state.registry;
    let term = q.q.trim();
    if term.len() < 2 || term.len() > 64 {
        return Err(ApiError::bad_request("search query must be 2..64 chars"));
    }
    let users = db.search_users(term).await?;
    let online = registry.online_user_ids().await;
    Ok(Json(
        users
            .into_iter()
            .map(|u| u.to_public())
            .map(|p| {
                let is_on = online.iter().any(|id| id == &p.id);
                p.with_online(is_on)
            })
            .collect(),
    ))
}
