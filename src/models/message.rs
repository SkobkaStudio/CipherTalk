//! Модель сообщения и DTO для отправки.

use serde::{Deserialize, Serialize};

/// Сообщение, готовое к отправке клиенту (HTTP и WebSocket).
///
/// `username` подтягивается JOIN-ом из `users`, чтобы фронтенду не нужно было
/// делать отдельные запросы.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Message {
    pub id: i64,
    pub chat_id: i64,
    pub user_id: i64,
    pub username: String,
    pub body: String,
    pub created_at: i64,
}

/// Тело `POST /api/chats/:id/messages`.
#[derive(Debug, Deserialize)]
pub struct SendMessageRequest {
    pub body: String,
}
