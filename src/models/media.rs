use serde::{Deserialize, Serialize};

/// Client-facing description of an uploaded attachment. URLs are relative;
/// media requests authenticate with the HttpOnly `ct_media` cookie.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AttachmentDto {
    pub id: i64,
    pub kind: String,
    pub file_name: String,
    pub mime_type: String,
    pub size_bytes: i64,
    pub width: Option<i32>,
    pub height: Option<i32>,
    pub duration_ms: Option<i32>,
    pub content_url: String,
    pub thumbnail_url: Option<String>,
}
