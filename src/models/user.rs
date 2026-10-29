//! Модель пользователя и DTO авторизации (v2: телефон + server_id).
use serde::{Deserialize, Serialize};

/// Пользователь — профиль, который отдаём клиентам.
#[derive(Debug, Clone, Serialize)]
pub struct User {
    pub id: i64,
    pub server_id: String,
    pub phone: String,
    pub username: Option<String>,
    pub first_name: Option<String>,
    pub last_name: Option<String>,
    pub created_at: i64,
    pub avatar_color: String,
}

/// Шаг 1: старт авторизации по номеру телефона.
#[derive(Debug, Deserialize)]
pub struct StartAuthRequest {
    pub phone: String,
}

/// Ответ на start: зарегистрирован ли номер, нужен ли код.
#[derive(Debug, Serialize)]
pub struct StartAuthResponse {
    pub registered: bool,
    pub needs_code: bool,
}

/// Шаг 2: подтверждение 6-значного кода.
#[derive(Debug, Deserialize)]
pub struct VerifyCodeRequest {
    pub phone: String,
    pub code: String,
}

/// Шаг 3–5: завершение регистрации (профиль + username + пароль).
#[derive(Debug, Deserialize)]
pub struct FinishRegisterRequest {
    pub phone: String,
    pub code: String,
    pub first_name: String,
    pub last_name: Option<String>,
    pub username: String,
    pub password: String,
    pub password_repeat: String,
}

/// Логин по телефону и паролю (зарегистрированные пользователи).
#[derive(Debug, Deserialize)]
pub struct LoginRequest {
    pub phone: String,
    pub password: String,
}

/// Результат проверки занятости @username (endpoint с debounce на фронте).
#[derive(Debug, Serialize)]
pub struct UsernameCheckResponse {
    pub available: bool,
    pub reason: Option<String>,
}

/// Ответ авторизации: JWT + полный профиль пользователя.
#[derive(Debug, Serialize)]
pub struct AuthResponse {
    pub token: String,
    pub user: User,
}
