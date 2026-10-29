//! Регистрация, логин, выдача JWT.

use crate::db::Db;
use crate::models::user::{AuthResponse, User};
use crate::utils::error::{AppError, AppResult};
use crate::utils::{jwt, password};
use serde_json::json;
use std::time::{SystemTime, UNIX_EPOCH};

fn now_ts() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0)
}

/// Регистрация нового пользователя: валидация, argon2-хеш, INSERT, SELECT id по username.
pub async fn register(db: &Db, secret: &str, username: &str, pwd: &str) -> AppResult<AuthResponse> {
    let username = username.trim();
    if username.len() < 3 || username.len() > 32 {
        return Err(AppError::BadRequest("Имя пользователя должно быть 3..32 символа".into()));
    }
    if !username.chars().all(|c| c.is_alphanumeric() || c == '_' || c == '-') {
        return Err(AppError::BadRequest("Разрешены буквы, цифры, _ и -".into()));
    }
    if pwd.len() < 6 {
        return Err(AppError::BadRequest("Пароль должен быть не короче 6 символов".into()));
    }
    // Проверка занятости имени
    let rows = db.query_rows("SELECT id FROM users WHERE username = ?", &[json!(username)]).await?;
    if !rows.is_empty() {
        return Err(AppError::Conflict("Имя пользователя уже занято".into()));
    }
    let hash = password::hash_password(pwd)?;
    db.exec_params(
        "INSERT INTO users (username, password_hash, created_at) VALUES (?, ?, ?)",
        &[json!(username), json!(hash), json!(now_ts())],
    )
    .await?;
    // rqlite не поддерживает RETURNING — читаем id по уникальному полю
    let rows = db.query_rows("SELECT id FROM users WHERE username = ?", &[json!(username)]).await?;
    let user_id = rows
        .first()
        .and_then(|r| r.get("id").and_then(|v| v.as_i64()))
        .ok_or_else(|| AppError::Internal("Не удалось получить id пользователя после INSERT".into()))?;
    let token = jwt::issue_token(secret, user_id, username)?;
    Ok(AuthResponse { token, user_id })
}

/// Логин: проверка пароля по хешу, выдача токена.
pub async fn login(db: &Db, secret: &str, username: &str, pwd: &str) -> AppResult<AuthResponse> {
    let rows = db
        .query_rows(
            "SELECT id, username, password_hash, created_at FROM users WHERE username = ?",
            &[json!(username)],
        )
        .await?;
    let row = rows.first().ok_or_else(|| AppError::Unauthorized("Неверное имя или пароль".into()))?;
    let hash = row.get("password_hash").and_then(|v| v.as_str()).unwrap_or_default();
    if !password::verify_password(pwd, hash) {
        return Err(AppError::Unauthorized("Неверное имя или пароль".into()));
    }
    let user_id = row.get("id").and_then(|v| v.as_i64()).unwrap_or(0);
    let name = row.get("username").and_then(|v| v.as_str()).unwrap_or(username).to_string();
    let token = jwt::issue_token(secret, user_id, &name)?;
    Ok(AuthResponse { token, user_id })
}

/// Получение пользователя по id (для проверки существования).
pub async fn get_user(db: &Db, user_id: i64) -> AppResult<User> {
    let rows = db
        .query_rows("SELECT id, username, created_at FROM users WHERE id = ?", &[json!(user_id)])
        .await?;
    let row = rows.first().ok_or_else(|| AppError::NotFound("Пользователь не найден".into()))?;
    Ok(User {
        id: row.get("id").and_then(|v| v.as_i64()).unwrap_or(user_id),
        username: row.get("username").and_then(|v| v.as_str()).unwrap_or_default().to_string(),
        created_at: row.get("created_at").and_then(|v| v.as_i64()).unwrap_or(0),
    })
}
