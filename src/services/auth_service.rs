//! Сервис авторизации: регистрация и вход.
//!
//! Слой не зависит от axum: принимает `Db`, секрет и DTO, возвращает модель
//! или `AppError`. Пароли хешируются argon2id в `spawn_blocking`, чтобы не
//! блокировать async-рантайм на время вычислений.

use crate::db::{Db, Row};
use crate::models::user::{AuthRequest, AuthResponse, User};
use crate::utils::error::{AppError, AppResult};
use crate::utils::jwt::{create_token, now_ts};
use crate::utils::password;
use serde_json::json;

/// Минимальная длина пароля.
const MIN_PASSWORD_LEN: usize = 6;
/// Максимальная длина пароля (ограничение argon2 и здравого смысла).
const MAX_PASSWORD_LEN: usize = 128;

/// Регистрирует нового пользователя и сразу выдаёт JWT.
pub async fn register(db: &Db, secret: &str, request: AuthRequest) -> AppResult<AuthResponse> {
    let (username, password_value) = validate_credentials(&request.username, &request.password)?;

    // UNIQUE-поле username: сначала понятная проверка, затем страховка на гонку.
    let existing = db
        .query_one(
            "SELECT id FROM users WHERE username = ?",
            &[json!(&username)],
        )
        .await?;
    if existing.is_some() {
        return Err(AppError::Conflict("Имя пользователя уже занято".into()));
    }

    // argon2 — CPU-ёмкая операция; уводим её с async-воркеров.
    let password_for_hash = password_value.clone();
    let password_hash =
        tokio::task::spawn_blocking(move || password::hash_password(&password_for_hash))
            .await
            .map_err(|error| AppError::Internal(format!("задача хеширования упала: {error}")))??;

    let created_at = now_ts();
    let insert = db
        .execute(
            "INSERT INTO users (username, password_hash, created_at) VALUES (?, ?, ?)",
            &[json!(&username), json!(password_hash), json!(created_at)],
        )
        .await;

    if let Err(error) = insert {
        // На случай параллельной регистрации того же имени.
        let message = error.to_string();
        if message.contains("UNIQUE") || message.contains("unique") {
            return Err(AppError::Conflict("Имя пользователя уже занято".into()));
        }
        return Err(error);
    }

    // rqlite не поддерживает RETURNING — читаем по уникальному username.
    let row = db
        .query_one(
            "SELECT id, username, password_hash, created_at FROM users WHERE username = ?",
            &[json!(&username)],
        )
        .await?
        .ok_or_else(|| AppError::Internal("пользователь не найден после INSERT".into()))?;

    let user = row_to_user(&row)?;
    let token = create_token(user.id, &user.username, secret)?;

    Ok(AuthResponse {
        token,
        user_id: user.id,
        username: user.username,
    })
}

/// Проверяет логин и пароль, возвращая JWT.
pub async fn login(db: &Db, secret: &str, request: AuthRequest) -> AppResult<AuthResponse> {
    let username = request.username.trim();
    if username.is_empty() || request.password.is_empty() {
        return Err(AppError::BadRequest(
            "Укажите имя пользователя и пароль".into(),
        ));
    }

    let row = db
        .query_one(
            "SELECT id, username, password_hash, created_at FROM users WHERE username = ?",
            &[json!(username)],
        )
        .await?;

    let Some(row) = row else {
        return Err(AppError::Unauthorized(
            "Неверное имя пользователя или пароль".into(),
        ));
    };

    let user = row_to_user(&row)?;
    let password_value = request.password;
    let hash = user.password_hash.clone();

    let valid =
        tokio::task::spawn_blocking(move || password::verify_password(&password_value, &hash))
            .await
            .map_err(|error| {
                AppError::Internal(format!("задача проверки пароля упала: {error}"))
            })?;

    if !valid {
        return Err(AppError::Unauthorized(
            "Неверное имя пользователя или пароль".into(),
        ));
    }

    let token = create_token(user.id, &user.username, secret)?;

    Ok(AuthResponse {
        token,
        user_id: user.id,
        username: user.username,
    })
}

/// Тримит и валидирует учётные данные.
fn validate_credentials(raw_username: &str, password: &str) -> AppResult<(String, String)> {
    let username = raw_username.trim();

    let username_len = username.chars().count();
    if !(3..=32).contains(&username_len) {
        return Err(AppError::BadRequest(
            "Имя пользователя должно быть от 3 до 32 символов".into(),
        ));
    }
    if !username
        .chars()
        .all(|character| character.is_alphanumeric() || matches!(character, '_' | '-' | '.'))
    {
        return Err(AppError::BadRequest(
            "Имя пользователя может содержать буквы, цифры, '_', '-' и '.'".into(),
        ));
    }

    let password_len = password.chars().count();
    if password_len < MIN_PASSWORD_LEN {
        return Err(AppError::BadRequest(format!(
            "Пароль должен быть не короче {MIN_PASSWORD_LEN} символов"
        )));
    }
    if password_len > MAX_PASSWORD_LEN {
        return Err(AppError::BadRequest(format!(
            "Пароль должен быть не длиннее {MAX_PASSWORD_LEN} символов"
        )));
    }

    Ok((username.to_string(), password.to_string()))
}

/// Преобразует строку БД в модель пользователя.
fn row_to_user(row: &Row) -> AppResult<User> {
    Ok(User {
        id: row
            .i64("id")
            .ok_or_else(|| AppError::Internal("в строке users нет id".into()))?,
        username: row
            .string("username")
            .ok_or_else(|| AppError::Internal("в строке users нет username".into()))?,
        password_hash: row
            .string("password_hash")
            .ok_or_else(|| AppError::Internal("в строке users нет password_hash".into()))?,
        created_at: row
            .i64("created_at")
            .ok_or_else(|| AppError::Internal("в строке users нет created_at".into()))?,
    })
}
