use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use crate::models::media::AttachmentDto;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SenderInfo {
    pub id: i64,
    pub username: String,
    pub display_name: String,
    pub avatar_url: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReplyPreview {
    pub id: i64,
    pub sender_name: Option<String>,
    pub content: String,
    pub is_deleted: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MessageDto {
    pub id: i64,
    pub chat_id: i64,
    pub sender: Option<SenderInfo>,
    pub content: String,
    pub attachment: Option<AttachmentDto>,
    pub reply_to: Option<ReplyPreview>,
    pub created_at: DateTime<Utc>,
    pub edited_at: Option<DateTime<Utc>>,
    pub deleted_at: Option<DateTime<Utc>>,
    pub is_deleted: bool,
}

#[derive(Debug, Serialize)]
pub struct MessagePage {
    pub items: Vec<MessageDto>,
    pub has_more: bool,
    /// Cursor for loading older messages.
    pub next_before_id: Option<i64>,
    /// Cursor for catching up after a reconnect.
    pub next_after_id: Option<i64>,
}

#[derive(Debug, Deserialize)]
pub struct SendMessageRequest {
    #[serde(default)]
    pub content: String,
    pub reply_to_id: Option<i64>,
    pub attachment_id: Option<i64>,
}

#[derive(Debug, Deserialize)]
pub struct EditMessageRequest {
    pub content: String,
}

#[derive(Debug, Deserialize)]
pub struct MarkReadRequest {
    pub message_id: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct ReadState {
    pub chat_id: i64,
    pub user_id: i64,
    pub message_id: i64,
}
