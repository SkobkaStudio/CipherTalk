//! Модель пользователя и DTO для авторизации.

use serde::{Deserialize, Serialize};

/// Пользователь из таблицы `users`.
///
/// `password_hash` никогда не сериализуется в JSON-ответы.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct User {
    pub id: i64,
    pub username: String,
    #[serde(skip_serializing)]
    pub password_hash: String,
    pub created_at: i64,
}

/// Тело `POST /api/register` и `POST /api/login`.
#[derive(Debug, Deserialize)]
pub struct AuthRequest {
    pub username: String,
    pub password: String,
}

/// Ответ успешной регистрации/входа.
#[derive(Debug, Serialize)]
pub struct AuthResponse {
    pub token: String,
    pub user_id: i64,
    pub username: String,
}
