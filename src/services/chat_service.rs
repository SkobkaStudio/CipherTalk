//! Операции с чатами и сообщениями.

use crate::db::Db;
use crate::models::chat::Chat;
use crate::models::message::Message;
use crate::utils::error::{AppError, AppResult};
use serde_json::json;
use std::time::{SystemTime, UNIX_EPOCH};

fn now_ts() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0)
}

/// Список чатов, где пользователь состоит в chat_members.
pub async fn list_chats(db: &Db, user_id: i64) -> AppResult<Vec<Chat>> {
    let rows = db
        .query_rows(
            "SELECT c.id, c.name, c.owner_id, c.created_at FROM chats c \
             JOIN chat_members m ON m.chat_id = c.id WHERE m.user_id = ? ORDER BY c.id",
            &[json!(user_id)],
        )
        .await?;
    Ok(rows.iter().map(row_to_chat).collect())
}

fn row_to_chat(r: &serde_json::Value) -> Chat {
    Chat {
        id: r.get("id").and_then(|v| v.as_i64()).unwrap_or(0),
        name: r.get("name").and_then(|v| v.as_str()).unwrap_or_default().to_string(),
        owner_id: r.get("owner_id").and_then(|v| v.as_i64()).unwrap_or(0),
        created_at: r.get("created_at").and_then(|v| v.as_i64()).unwrap_or(0),
    }
}

/// Создание чата: INSERT + SELECT id по (name, owner_id), затем добавление создателя в members.
pub async fn create_chat(db: &Db, name: &str, owner_id: i64) -> AppResult<i64> {
    let name = name.trim();
    if name.is_empty() || name.len() > 100 {
        return Err(AppError::BadRequest("Название чата: 1..100 символов".into()));
    }
    let ts = now_ts();
    db.exec_params(
        "INSERT INTO chats (name, owner_id, created_at) VALUES (?, ?, ?)",
        &[json!(name), json!(owner_id), json!(ts)],
    )
    .await?;
    // rqlite не отдаёт last_insert_rowid — ищем по уникальной паре (name, owner_id): самый свежий
    let rows = db
        .query_rows(
            "SELECT id FROM chats WHERE name = ? AND owner_id = ? ORDER BY created_at DESC, id DESC LIMIT 1",
            &[json!(name), json!(owner_id)],
        )
        .await?;
    let chat_id = rows
        .first()
        .and_then(|r| r.get("id").and_then(|v| v.as_i64()))
        .ok_or_else(|| AppError::Internal("Не удалось получить id чата после INSERT".into()))?;
    // Создатель сразу становится участником
    db.exec_params(
        "INSERT OR IGNORE INTO chat_members (chat_id, user_id) VALUES (?, ?)",
        &[json!(chat_id), json!(owner_id)],
    )
    .await?;
    Ok(chat_id)
}

/// Вступление в чат (публичные комнаты: любой аутентифицированный может join).
pub async fn join_chat(db: &Db, chat_id: i64, user_id: i64) -> AppResult<()> {
    let rows = db.query_rows("SELECT id FROM chats WHERE id = ?", &[json!(chat_id)]).await?;
    if rows.is_empty() {
        return Err(AppError::NotFound("Чат не найден".into()));
    }
    db.exec_params(
        "INSERT OR IGNORE INTO chat_members (chat_id, user_id) VALUES (?, ?)",
        &[json!(chat_id), json!(user_id)],
    )
    .await?;
    Ok(())
}

/// Проверка участия пользователя в чате (403 если нет).
pub async fn is_member(db: &Db, chat_id: i64, user_id: i64) -> AppResult<bool> {
    let rows = db
        .query_rows(
            "SELECT 1 AS ok FROM chat_members WHERE chat_id = ? AND user_id = ?",
            &[json!(chat_id), json!(user_id)],
        )
        .await?;
    Ok(!rows.is_empty())
}

/// Последние N сообщений чата, возвращаются по возрастанию id.
pub async fn recent_messages(db: &Db, chat_id: i64, limit: i64) -> AppResult<Vec<Message>> {
    let limit = limit.clamp(1, 200);
    let rows = db
        .query_rows(
            "SELECT m.id, m.chat_id, m.user_id, u.username, m.body, m.created_at \
             FROM (SELECT * FROM messages WHERE chat_id = ? ORDER BY id DESC LIMIT ?) m \
             JOIN users u ON u.id = m.user_id ORDER BY m.id ASC",
            &[json!(chat_id), json!(limit)],
        )
        .await?;
    Ok(rows.iter().map(row_to_message).collect())
}

fn row_to_message(r: &serde_json::Value) -> Message {
    Message {
        id: r.get("id").and_then(|v| v.as_i64()).unwrap_or(0),
        chat_id: r.get("chat_id").and_then(|v| v.as_i64()).unwrap_or(0),
        user_id: r.get("user_id").and_then(|v| v.as_i64()).unwrap_or(0),
        username: r.get("username").and_then(|v| v.as_str()).unwrap_or_default().to_string(),
        body: r.get("body").and_then(|v| v.as_str()).unwrap_or_default().to_string(),
        created_at: r.get("created_at").and_then(|v| v.as_i64()).unwrap_or(0),
    }
}

/// Сохранение сообщения; id вычисляется как MAX(id)+1 (rqlite не поддерживает RETURNING),
/// затем читаем строку целиком для ответа клиенту и публикации в WS.
pub async fn save_message(db: &Db, chat_id: i64, user_id: i64, body: &str) -> AppResult<Message> {
    let body = body.trim();
    if body.is_empty() {
        return Err(AppError::BadRequest("Пустое сообщение".into()));
    }
    if body.len() > 4000 {
        return Err(AppError::BadRequest("Сообщение слишком длинное (макс. 4000)".into()));
    }
    // Вычисляем новый id: максимум существующего + 1
    let rows = db.query_rows("SELECT COALESCE(MAX(id), 0) AS mx FROM messages", &[]).await?;
    let next_id = rows.first().and_then(|r| r.get("mx").and_then(|v| v.as_i64())).unwrap_or(0) + 1;
    let ts = now_ts();
    db.exec_params(
        "INSERT INTO messages (id, chat_id, user_id, body, created_at) VALUES (?, ?, ?, ?, ?)",
        &[json!(next_id), json!(chat_id), json!(user_id), json!(body), json!(ts)],
    )
    .await?;
    let rows = db
        .query_rows(
            "SELECT m.id, m.chat_id, m.user_id, u.username, m.body, m.created_at \
             FROM messages m JOIN users u ON u.id = m.user_id WHERE m.id = ?",
            &[json!(next_id)],
        )
        .await?;
    rows.first()
        .map(row_to_message)
        .ok_or_else(|| AppError::Internal("Сообщение не найдено после INSERT".into()))
}
