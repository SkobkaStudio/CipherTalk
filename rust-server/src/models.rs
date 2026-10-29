//! Общие модели CipherTalk (Rust-бэкенд, rqlite поверх HTTP).

use serde::{Deserialize, Serialize};

/// Пользователь. Поля в snake_case — как их ожидает фронтенд (`app.js`).
#[derive(Debug, Clone, Serialize)]
pub struct User {
    pub id: i64,
    pub public_id: String,
    pub phone: String,
    pub email: String,
    pub first_name: String,
    pub last_name: String,
    pub name: String,
    pub username: String,
    pub avatar: String,
    pub bio: String,
    pub public_key: String,
    pub online: i64,
    pub last_seen: i64,
    pub hide_online: i64,
    pub crown_level: String,
    pub is_owner: i64,
    pub created_at: i64,
}

impl User {
    /// Публичный 8-значный id пользователя («00000001»).
    pub fn format_public_id(id: i64) -> String {
        format!("{id:08}")
    }

    pub fn from_row(row: &serde_json::Value) -> Option<User> {
        let get_i64 = |k: &str| -> i64 {
            row.get(k)
                .and_then(|v| v.as_i64().or_else(|| v.as_str().and_then(|s| s.parse().ok())))
                .unwrap_or(0)
        };
        let get_str = |k: &str| -> String {
            row.get(k)
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string()
        };
        let id = get_i64("id");
        if id == 0 {
            return None;
        }
        let first_name = get_str("first_name");
        let last_name = get_str("last_name");
        let name = {
            let n = get_str("name");
            if !n.is_empty() {
                n
            } else {
                format!("{first_name} {last_name}").trim().to_string()
            }
        };
        let public_id = {
            let p = get_str("public_id");
            if p.is_empty() {
                User::format_public_id(id)
            } else {
                p
            }
        };
        Some(User {
            id,
            public_id,
            phone: get_str("phone"),
            email: get_str("email"),
            first_name,
            last_name,
            name,
            username: get_str("username"),
            avatar: get_str("avatar"),
            bio: get_str("bio"),
            public_key: get_str("public_key"),
            online: get_i64("online"),
            last_seen: get_i64("last_seen"),
            hide_online: get_i64("hide_online"),
            crown_level: "none".to_string(),
            is_owner: 0,
            created_at: get_i64("created_at"),
        })
    }
}

/// Чат (private / saved / group / channel).
#[derive(Debug, Clone, Serialize)]
pub struct Chat {
    pub id: i64,
    #[serde(rename = "type")]
    pub chat_type: String,
    pub name: String,
    pub avatar: String,
    pub public_id: String,
    pub owner_id: Option<i64>,
    pub members: Vec<serde_json::Value>,
    pub other_user: Option<serde_json::Value>,
    pub role: String,
    pub last_message: String,
    pub last_message_iv: String,
    pub last_message_header: String,
    pub last_message_type: Option<String>,
    pub last_message_time: i64,
    pub last_sender_id: i64,
    pub last_read_by: serde_json::Value,
}

/// Сообщение. Отдаётся фронту в camelCase (см. `serialize_message_ws`).
#[derive(Debug, Clone, Serialize)]
pub struct Message {
    pub id: i64,
    pub chat_id: i64,
    pub sender_id: i64,
    pub encrypted_content: String,
    pub iv: String,
    pub header: String,
    #[serde(rename = "type")]
    pub msg_type: String,
    pub reply_to: Option<i64>,
    pub forwarded_from: Option<i64>,
    pub edited: i64,
    pub deleted_for_all: i64,
    pub expires_at: Option<i64>,
    pub created_at: i64,
}

impl Message {
    pub fn from_row(row: &serde_json::Value) -> Option<Message> {
        let get_i64 = |k: &str| -> i64 {
            row.get(k)
                .and_then(|v| v.as_i64().or_else(|| v.as_str().and_then(|s| s.parse().ok())))
                .unwrap_or(0)
        };
        let get_opt = |k: &str| -> Option<i64> {
            row.get(k).and_then(|v| match v {
                serde_json::Value::Null => None,
                _ => v.as_i64().or_else(|| v.as_str().and_then(|s| s.parse().ok())),
            })
        };
        let get_str = |k: &str| -> String {
            row.get(k)
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string()
        };
        let id = get_i64("id");
        if id == 0 {
            return None;
        }
        Some(Message {
            id,
            chat_id: get_i64("chat_id"),
            sender_id: get_i64("sender_id"),
            encrypted_content: get_str("encrypted_content"),
            iv: get_str("iv"),
            header: get_str("header"),
            msg_type: {
                let t = get_str("msg_type");
                if t.is_empty() { "text".to_string() } else { t }
            },
            reply_to: get_opt("reply_to"),
            forwarded_from: get_opt("forwarded_from"),
            edited: get_i64("edited"),
            deleted_for_all: get_i64("deleted_for_all"),
            expires_at: get_opt("expires_at"),
            created_at: get_i64("created_at"),
        })
    }

    /// Сериализация для WebSocket (старый протокол фронтенда): camelCase,
    /// шифротекст отдаётся как есть — сервер его не расшифровывает (E2EE).
    pub fn to_ws_json(&self, sender_name: &str, sender_avatar: &str) -> serde_json::Value {
        serde_json::json!({
            "id": self.id,
            "chatId": self.chat_id,
            "senderId": self.sender_id,
            "senderName": sender_name,
            "senderAvatar": sender_avatar,
            "content": self.encrypted_content,
            "ciphertext": self.encrypted_content,
            "iv": self.iv,
            "header": self.header,
            "type": self.msg_type,
            "replyTo": self.reply_to,
            "forwardedFrom": self.forwarded_from,
            "edited": self.edited,
            "deletedForAll": self.deleted_for_all,
            "expiresAt": self.expires_at,
            "createdAt": self.created_at,
        })
    }
}

/// Тело `POST /api/send-code`.
#[derive(Debug, Deserialize)]
pub struct SendCodeRequest {
    #[serde(rename = "phone", default)]
    pub phone: String,
}

/// Тело `POST /api/verify-code`.
#[derive(Debug, Deserialize)]
pub struct VerifyCodeRequest {
    #[serde(default)]
    pub phone: String,
    #[serde(default)]
    pub code: String,
}

/// Тело `POST /api/register`.
#[derive(Debug, Deserialize)]
pub struct RegisterRequest {
    #[serde(default)]
    pub phone: String,
    #[serde(rename = "firstName", default)]
    pub first_name: String,
    #[serde(rename = "lastName", default)]
    pub last_name: String,
    #[serde(default)]
    pub username: String,
    #[serde(default)]
    pub password: String,
    #[serde(rename = "publicKey", default)]
    pub public_key: String,
    #[serde(rename = "verifyToken", default)]
    pub verify_token: String,
    #[serde(default)]
    pub email: Option<String>,
}

/// Тело `POST /api/login` и `POST /api/login-code`.
#[derive(Debug, Deserialize)]
pub struct LoginRequest {
    #[serde(default)]
    pub phone: String,
    #[serde(default)]
    pub password: String,
    #[serde(rename = "publicKey", default)]
    pub public_key: String,
    #[serde(rename = "loginToken", default)]
    pub login_token: String,
}

/// Тело `POST /api/chats` — создание личного чата.
#[derive(Debug, Deserialize)]
pub struct CreateChatRequest {
    #[serde(rename = "targetUserId", alias = "userId", default)]
    pub target_user_id: serde_json::Value,
}

/// Тело `POST /api/bots` — создание бота.
#[derive(Debug, Deserialize)]
pub struct CreateBotRequest {
    #[serde(default)]
    pub name: String,
}

/// JWT-claims пользователя.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Claims {
    pub sub: String,
    pub typ: String,
    pub jti: String,
    pub exp: usize,
    pub iat: usize,
}
