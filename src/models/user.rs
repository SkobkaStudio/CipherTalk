//! Модель пользователя.
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct User {
    pub id: i64,
    pub username: String,
    pub created_at: i64,
}

/// Тело запроса регистрации/логина.
#[derive(Debug, Deserialize)]
pub struct AuthRequest {
    pub username: String,
    pub password: String,
}

/// Ответ авторизации.
#[derive(Debug, Serialize)]
pub struct AuthResponse {
    pub token: String,
    pub user_id: i64,
}
