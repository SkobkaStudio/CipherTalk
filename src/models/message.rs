//! Модель сообщения (в т.ч. формат WebSocket-события).
use serde::{Deserialize, Serialize};

/// Сообщение с именем автора — то, что отдаём клиентам.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Message {
    pub id: i64,
    pub chat_id: i64,
    pub user_id: i64,
    pub username: String,
    pub body: String,
    pub created_at: i64,
}

/// Тело POST /api/chats/:id/messages
#[derive(Debug, Deserialize)]
pub struct SendMessageRequest {
    pub body: String,
}
