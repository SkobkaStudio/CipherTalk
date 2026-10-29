//! Модель чата.
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize)]
pub struct Chat {
    pub id: i64,
    pub name: String,
    pub owner_id: i64,
    pub created_at: i64,
}

/// Тело запроса создания чата.
#[derive(Debug, Deserialize)]
pub struct CreateChatRequest {
    pub name: String,
}
