//! Контроллер сообщений: история и отправка + публикация в WS-брокер.

use crate::middleware::Authed;
use crate::models::message::{Message, SendMessageRequest};
use crate::services::chat_service;
use crate::utils::error::{AppError, AppResult};
use crate::ws::AppState;
use axum::extract::{Path, Query, Request, State};
use axum::Json;
use serde::Deserialize;
use std::sync::Arc;

#[derive(Deserialize)]
pub struct LimitQuery {
    limit: Option<i64>,
}

/// GET /api/chats/:id/messages?limit=50 — последние N сообщений по возрастанию.
/// Доступ только участникам чата (403 иначе).
pub async fn list(
    State(state): State<Arc<AppState>>,
    req: Request,
    Path(id): Path<i64>,
    Query(q): Query<LimitQuery>,
) -> AppResult<Json<Vec<Message>>> {
    let Authed(claims) = Authed::from_request(&req)?;
    if !chat_service::is_member(&state.db, id, claims.sub).await? {
        return Err(AppError::Forbidden("Вы не состоите в этом чате".into()));
    }
    let limit = q.limit.unwrap_or(50);
    let msgs = chat_service::recent_messages(&state.db, id, limit).await?;
    Ok(Json(msgs))
}

/// POST /api/chats/:id/messages {body} — сохраняет сообщение и публикует событие
/// в broadcast-канал, откуда его получат все WS-подписчики этого чата.
pub async fn send(
    State(state): State<Arc<AppState>>,
    req: Request,
    Path(id): Path<i64>,
    Json(body): Json<SendMessageRequest>,
) -> AppResult<Json<Message>> {
    let Authed(claims) = Authed::from_request(&req)?;
    if !chat_service::is_member(&state.db, id, claims.sub).await? {
        return Err(AppError::Forbidden("Вы не состоите в этом чате".into()));
    }
    // Имя автора берём из claims JWT — оно подтверждено подписью токена
    let msg = chat_service::save_message(&state.db, id, claims.sub, &body.body).await?;
    let _ = state.tx.send(msg.clone()); // публикация всем WS-коннектам
    Ok(Json(msg))
}
