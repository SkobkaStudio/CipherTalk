//! Модель чата и DTO для его создания.

use serde::{Deserialize, Serialize};

/// Чат из таблицы `chats`.
///
/// `member_count` вычисляется в SELECT и нужен только для интерфейса.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Chat {
    pub id: i64,
    pub name: String,
    pub owner_id: i64,
    pub created_at: i64,
    #[serde(default)]
    pub member_count: i64,
}

/// Тело `POST /api/chats`.
#[derive(Debug, Deserialize)]
pub struct CreateChatRequest {
    pub name: String,
}
