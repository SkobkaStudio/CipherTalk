//! Контроллер сообщений: история чата и отправка.
//!
//! После успешного INSERT сообщение публикуется в broadcast-канал, откуда его
//! получают все WebSocket-подписчики чата.

use crate::controllers::json_body;
use crate::models::message::{Message, SendMessageRequest};
use crate::services::chat_service;
use crate::utils::error::{AppError, AppResult};
use crate::utils::jwt::Claims;
use crate::ws::AppState;
use axum::extract::rejection::JsonRejection;
use axum::extract::{Path, Query, State};
use axum::{Extension, Json};
use serde::Deserialize;

/// Query-параметр `?limit=50`.
#[derive(Debug, Deserialize)]
pub struct LimitQuery {
    limit: Option<i64>,
}

/// GET /api/chats/:id/messages?limit=50 — последние N сообщений по возрастанию.
pub async fn list(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path(chat_id): Path<i64>,
    Query(query): Query<LimitQuery>,
) -> AppResult<Json<Vec<Message>>> {
    ensure_chat_access(&state, chat_id, claims.sub).await?;

    let limit = query.limit.unwrap_or(50);
    let messages = chat_service::recent_messages(&state.db, chat_id, limit).await?;
    Ok(Json(messages))
}

/// POST /api/chats/:id/messages {body} — сохранить и разослать сообщение.
pub async fn send(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path(chat_id): Path<i64>,
    payload: Result<Json<SendMessageRequest>, JsonRejection>,
) -> AppResult<Json<Message>> {
    let request = json_body(payload)?;
    ensure_chat_access(&state, chat_id, claims.sub).await?;

    let message = chat_service::save_message(&state.db, chat_id, claims.sub, &request.body).await?;

    // Ошибка отправки означает лишь отсутствие подписчиков — это нормально.
    let _ = state.tx.send(message.clone());

    Ok(Json(message))
}

/// Проверяет, что чат существует и пользователь состоит в нём.
async fn ensure_chat_access(state: &AppState, chat_id: i64, user_id: i64) -> AppResult<()> {
    if !chat_service::chat_exists(&state.db, chat_id).await? {
        return Err(AppError::NotFound("Чат не найден".into()));
    }
    if !chat_service::is_member(&state.db, chat_id, user_id).await? {
        return Err(AppError::Forbidden("Вы не состоите в этом чате".into()));
    }
    Ok(())
}
