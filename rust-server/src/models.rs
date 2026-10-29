//! Общие модели данных CipherTalk.
//!
//! Все внешние JSON-структуры используют `camelCase` (как ожидает фронтенд
//! `ciphertalk-server/public/app.js`), внутреннее представление — snake_case.

use serde::{Deserialize, Serialize};

/// Пользователь (без секретов).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PublicUser {
    pub id: String,
    pub username: String,
    pub display_name: String,
    pub phone: String,
    pub avatar: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub public_key: Option<String>,
    pub created_at: i64,
}

/// Запись пользователя в БД (включая хэш пароля).
#[derive(Debug, Clone)]
pub struct UserRecord {
    pub id: String,
    pub username: String,
    pub display_name: String,
    pub phone: String,
    pub password_hash: String,
    pub salt: String,
    pub avatar: Option<String>,
    pub public_key: Option<String>,
    pub is_bot: bool,
    pub created_at: i64,
}

impl UserRecord {
    pub fn to_public(&self) -> PublicUser {
        PublicUser {
            id: self.id.clone(),
            username: self.username.clone(),
            display_name: self.display_name.clone(),
            phone: self.phone.clone(),
            avatar: self.avatar.clone(),
            public_key: self.public_key.clone(),
            created_at: self.created_at,
        }
    }
}

/// Чат (личный или групповой).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Chat {
    pub id: String,
    pub chat_type: String,
    pub name: String,
    pub member_ids: Vec<String>,
    /// Собеседник для личного чата (для фронта).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub partner: Option<PublicUser>,
    pub created_at: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_message: Option<ChatMessage>,
}

/// Сообщение чата. Контент зашифрован на клиенте (E2EE):
/// сервер хранит только ciphertext (`content`) и параметры дешифрования (`iv`, `header`).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatMessage {
    pub id: String,
    pub chat_id: String,
    pub sender_id: String,
    pub content: String,
    pub iv: String,
    pub header: String,
    pub msg_type: String,
    pub created_at: i64,
}

/// Типизированное WebSocket-сообщение клиента (старый протокол фронтенда).
#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ClientWsMsg {
    Auth {
        token: String,
    },
    GetMessages {
        #[serde(rename = "chatId")]
        chat_id: String,
        #[serde(default)]
        before_id: Option<String>,
        #[serde(default)]
        limit: Option<i64>,
    },
    SendMessage {
        #[serde(rename = "chatId")]
        chat_id: String,
        #[serde(default)]
        content: String,
        #[serde(default)]
        iv: String,
        #[serde(default)]
        header: String,
        /// Дополнительный подтип сообщения (text/image/...); пустая строка = text.
        #[serde(default)]
        msg_type: String,
    },
    StartChat {
        #[serde(rename = "userId")]
        user_id: String,
    },
    Typing {
        #[serde(rename = "chatId")]
        chat_id: String,
    },
    Ping,
}

/// Ответ сервера на `start_chat`.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StartChatResult {
    pub chat_id: String,
    pub partner: PublicUser,
}

/// Конвертация полного Chat в компактный ответ start_chat (только chatId + partner).
impl Chat {
    pub fn to_start_result(&self) -> Option<StartChatResult> {
        self.partner.clone().map(|partner| StartChatResult {
            chat_id: self.id.clone(),
            partner,
        })
    }
}

/// Публичный профиль пользователя с флагом онлайн-присутствия.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OnlineUser {
    #[serde(flatten)]
    pub user: PublicUser,
    pub online: bool,
}

impl PublicUser {
    /// Помечает профиль флагом присутствия (используется в REST-списках).
    pub fn with_online(self, online: bool) -> OnlineUser {
        OnlineUser { user: self, online }
    }
}

/// POST /api/send-code
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SendCodeRequest {
    pub phone: String,
}

/// POST /api/verify-code
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VerifyCodeRequest {
    pub phone: String,
    pub code: String,
}

/// POST /api/register
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RegisterRequest {
    pub phone: String,
    pub username: String,
    pub password: String,
    #[serde(default)]
    pub display_name: Option<String>,
    /// Короткоживущий токен, выданный после успешного verify-code.
    #[serde(rename = "verifyToken")]
    pub verify_token: String,
    #[serde(default)]
    pub public_key: Option<String>,
}

/// POST /api/login (парольный вход)
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoginRequest {
    pub username: String,
    pub password: String,
}

/// POST /api/login-code (вход по OTP без регистрации)
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoginCodeRequest {
    pub phone: String,
    pub code: String,
}

/// POST /api/chats
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateChatRequest {
    pub target_user_id: String,
}

/// POST /api/bots
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateBotRequest {
    pub name: String,
    #[serde(default)]
    pub description: Option<String>,
}

/// Ответ с токеном.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthResponse {
    pub token: String,
    pub user: PublicUser,
}
