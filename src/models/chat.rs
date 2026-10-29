//! Модель чата и DTO создания чатов (v2: server_id + kind).
use serde::{Deserialize, Serialize};

/// Чат: dm / group / channel / saved («Избранное»).
#[derive(Debug, Clone, Serialize)]
pub struct Chat {
    pub id: i64,
    pub server_id: String,
    pub kind: String,
    pub title: Option<String>,
    pub owner_id: Option<i64>,
    pub created_at: i64,
}

/// Создание группы или канала: POST /api/chats/group.
#[derive(Debug, Deserialize)]
pub struct CreateGroupRequest {
    pub kind: String, // "group" | "channel"
    pub title: String,
    pub member_ids: Option<Vec<i64>>,
}

/// Открытие/создание диалога: POST /api/chats/dm.
/// Если user_id == свой id — вернётся saved-чат.
#[derive(Debug, Deserialize)]
pub struct CreateDmRequest {
    pub user_id: i64,
}

/// Обратная совместимость старого POST /api/chats {name}.
#[derive(Debug, Deserialize)]
pub struct CreateChatRequestShim {
    pub name: String,
}
