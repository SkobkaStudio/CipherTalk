use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

pub const KIND_PRIVATE: &str = "private";
pub const KIND_GROUP: &str = "group";

pub const ROLE_OWNER: &str = "owner";
pub const ROLE_ADMIN: &str = "admin";

#[derive(Debug, Clone, Serialize)]
pub struct ChatPeer {
    pub id: i64,
    pub username: String,
    pub display_name: String,
    pub avatar_url: Option<String>,
    pub last_seen_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, Serialize)]
pub struct LastMessagePreview {
    pub id: i64,
    pub content: String,
    pub sender_name: Option<String>,
    pub attachment_kind: Option<String>,
    pub created_at: DateTime<Utc>,
    pub is_deleted: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct ChatSummary {
    pub id: i64,
    pub kind: String,
    /// Group title. For private chats the client uses `peer.display_name`.
    pub title: Option<String>,
    pub description: String,
    pub avatar_url: Option<String>,
    pub created_at: DateTime<Utc>,
    pub last_message_at: DateTime<Utc>,
    pub last_message: Option<LastMessagePreview>,
    pub unread_count: i64,
    pub member_count: i64,
    pub my_role: String,
    pub last_read_message_id: Option<i64>,
    pub peer: Option<ChatPeer>,
}

#[derive(Debug, Serialize)]
pub struct ChatListResponse {
    pub items: Vec<ChatSummary>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ChatMember {
    pub user: ChatPeer,
    pub role: String,
    pub joined_at: DateTime<Utc>,
    pub last_read_message_id: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ChatDetails {
    pub id: i64,
    pub kind: String,
    pub title: Option<String>,
    pub description: String,
    pub avatar_url: Option<String>,
    pub created_at: DateTime<Utc>,
    pub my_role: String,
    pub peer: Option<ChatPeer>,
    pub members: Vec<ChatMember>,
    pub last_read_message_id: Option<i64>,
}

#[derive(Debug, Deserialize)]
pub struct CreatePrivateChatRequest {
    pub user_id: i64,
}

#[derive(Debug, Deserialize)]
pub struct CreateGroupChatRequest {
    pub title: String,
    pub member_ids: Vec<i64>,
}

#[derive(Debug, Deserialize)]
pub struct AddMembersRequest {
    pub user_ids: Vec<i64>,
}

#[derive(Debug, Deserialize)]
pub struct ListChatsQuery {
    pub limit: Option<i64>,
    pub offset: Option<i64>,
}
