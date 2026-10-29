//! Чаты и сообщения: список, dm/saved, группы/каналы, история, сохранение.
//! Весь SQL здесь; про HTTP сервис ничего не знает.

use serde_json::json;
use std::time::{SystemTime, UNIX_EPOCH};

use crate::db::Db;
use crate::models::chat::{Chat, CreateGroupRequest};
use crate::models::message::Message;
use crate::models::user::User;
use crate::utils::error::{AppError, AppResult};
use crate::utils::server_id;

fn now_ts() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0)
}

const CHAT_COLS: &str = "id, server_id, kind, title, owner_id, created_at";

/// Строка результата SELECT chats -> модель Chat (title/owner могут быть NULL).
fn row_to_chat(r: &serde_json::Value) -> Chat {
    Chat {
        id: r.get("id").and_then(|v| v.as_i64()).unwrap_or(0),
        server_id: r.get("server_id").and_then(|v| v.as_str()).unwrap_or_default().to_string(),
        kind: r.get("kind").and_then(|v| v.as_str()).unwrap_or_default().to_string(),
        title: r.get("title").and_then(|v| v.as_str()).map(|s| s.to_string()),
        owner_id: r.get("owner_id").and_then(|v| v.as_i64()),
        created_at: r.get("created_at").and_then(|v| v.as_i64()).unwrap_or(0),
    }
}

fn row_to_user_public(r: &serde_json::Value) -> User {
    let opt = |k: &str| r.get(k).and_then(|v| v.as_str()).map(|s| s.to_string());
    User {
        id: r.get("id").and_then(|v| v.as_i64()).unwrap_or(0),
        server_id: opt("server_id").unwrap_or_default(),
        phone: String::new(), // публичная карточка: телефон не отдаём
        username: opt("username"),
        first_name: opt("first_name"),
        last_name: opt("last_name"),
        created_at: r.get("created_at").and_then(|v| v.as_i64()).unwrap_or(0),
        avatar_color: opt("avatar_color").unwrap_or_else(|| "#89b4fa".to_string()),
    }
}

/// Список чатов пользователя (включая saved «Избранное»).
pub async fn list_chats(db: &Db, user_id: i64) -> AppResult<Vec<Chat>> {
    let rows = db
        .query_rows(
            &format!(
                "SELECT {CHAT_COLS} FROM chats c \
                 JOIN chat_members m ON m.chat_id = c.id \
                 WHERE m.user_id = ? ORDER BY c.id"
            ),
            &[json!(user_id)],
        )
        .await?;
    Ok(rows.iter().map(row_to_chat).collect())
}

/// Чат по его человекочитаемому server_id (для ссылок /-00000000000001).
pub async fn get_chat_by_server_id(db: &Db, sid: &str) -> AppResult<Chat> {
    let rows = db
        .query_rows(&format!("SELECT {CHAT_COLS} FROM chats WHERE server_id = ?"), &[json!(sid)])
        .await?;
    rows.first()
        .map(row_to_chat)
        .ok_or_else(|| AppError::NotFound("Чат не найден".into()))
}

/// Публичная карточка пользователя по server_id (для ссылок /00000002):
/// без phone и password_hash.
pub async fn get_user_by_server_id(db: &Db, sid: &str) -> AppResult<User> {
    let rows = db
        .query_rows(
            "SELECT id, server_id, username, first_name, last_name, created_at, avatar_color \
             FROM users WHERE server_id = ?",
            &[json!(sid)],
        )
        .await?;
    rows.first()
        .map(row_to_user_public)
        .ok_or_else(|| AppError::NotFound("Пользователь не найден".into()))
}

/// Внутренний id чата по server_id (нужен для join/истории по ссылкам).
pub async fn chat_internal_id(db: &Db, sid: &str) -> AppResult<i64> {
    let rows = db.query_rows("SELECT id FROM chats WHERE server_id = ?", &[json!(sid)]).await?;
    rows.first()
        .and_then(|r| r.get("id"))
        .and_then(|v| v.as_i64())
        .ok_or_else(|| AppError::NotFound("Чат не найден".into()))
}

/// Получить или создать диалог между user_id и other_user_id.
/// Ссылка на самого себя -> возвращаем saved-чат («Избранное»).
pub async fn get_or_create_dm(db: &Db, user_id: i64, other_user_id: i64) -> AppResult<Chat> {
    if user_id == other_user_id {
        // Saved-чат создаётся при регистрации; ищем его
        let rows = db
            .query_rows(
                &format!(
                    "SELECT {CHAT_COLS} FROM chats c \
                     JOIN chat_members m ON m.chat_id = c.id \
                     WHERE m.user_id = ? AND c.kind = 'saved' LIMIT 1"
                ),
                &[json!(user_id)],
            )
            .await?;
        return rows
            .first()
            .map(row_to_chat)
            .ok_or_else(|| AppError::NotFound("Saved-чат не найден".into()));
    }
    // Существующий dm с обоими участниками?
    let rows = db
        .query_rows(
            "SELECT c.id, c.server_id, c.kind, c.title, c.owner_id, c.created_at FROM chats c \
             JOIN chat_members m1 ON m1.chat_id = c.id AND m1.user_id = ? \
             JOIN chat_members m2 ON m2.chat_id = c.id AND m2.user_id = ? \
             WHERE c.kind = 'dm' LIMIT 1",
            &[json!(user_id), json!(other_user_id)],
        )
        .await?;
    if let Some(r) = rows.first() {
        return Ok(row_to_chat(r));
    }
    // Новый dm: server_id из 8-значной шкалы таблицы chats
    let sid = server_id::next_chat_server_id(db, "dm").await?;
    let ts = now_ts();
    db.exec_params(
        "INSERT INTO chats (server_id, kind, title, owner_id, created_at) VALUES (?, 'dm', NULL, NULL, ?)",
        &[json!(&sid), json!(ts)],
    )
    .await?;
    // rqlite не отдаёт last_insert_rowid — читаем id по уникальному server_id
    let rows = db.query_rows("SELECT id FROM chats WHERE server_id = ?", &[json!(&sid)]).await?;
    let chat_id = rows
        .first()
        .and_then(|r| r.get("id"))
        .and_then(|v| v.as_i64())
        .ok_or_else(|| AppError::Internal("Не удалось получить id чата после INSERT".into()))?;
    for uid in [user_id, other_user_id] {
        db.exec_params(
            "INSERT OR IGNORE INTO chat_members (chat_id, user_id) VALUES (?, ?)",
            &[json!(chat_id), json!(uid)],
        )
        .await?;
    }
    get_chat_by_server_id(db, &sid).await
}

/// Создание группы/канала: kind group|channel, title 1..=128,
/// владелец — создатель, участники — owner + member_ids.
pub async fn create_group(db: &Db, owner_id: i64, req: &CreateGroupRequest) -> AppResult<Chat> {
    if req.kind != "group" && req.kind != "channel" {
        return Err(AppError::BadRequest("kind должен быть group или channel".into()));
    }
    let title = req.title.trim();
    if title.is_empty() || title.chars().count() > 128 {
        return Err(AppError::BadRequest("Название: 1–128 символов".into()));
    }
    let sid = server_id::next_chat_server_id(db, &req.kind).await?;
    let ts = now_ts();
    db.exec_params(
        "INSERT INTO chats (server_id, kind, title, owner_id, created_at) VALUES (?, ?, ?, ?, ?)",
        &[json!(&sid), json!(&req.kind), json!(title), json!(owner_id), json!(ts)],
    )
    .await?;
    let chat_id = chat_internal_id(db, &sid).await?;
    // Владелец + переданные участники (только существующие пользователи)
    let mut ids: Vec<i64> = vec![owner_id];
    ids.extend(req.member_ids.clone().unwrap_or_default());
    for uid in ids {
        let exists = db.query_rows("SELECT 1 AS ok FROM users WHERE id = ?", &[json!(uid)]).await?;
        if !exists.is_empty() {
            db.exec_params(
                "INSERT OR IGNORE INTO chat_members (chat_id, user_id) VALUES (?, ?)",
                &[json!(chat_id), json!(uid)],
            )
            .await?;
        }
    }
    get_chat_by_server_id(db, &sid).await
}

/// Создание чата по имени (обратная совместимость POST /api/chats):
/// трактуем как группу с указанным названием.
pub async fn create_chat_named(db: &Db, name: &str, owner_id: i64) -> AppResult<i64> {
    let req = CreateGroupRequest { kind: "group".into(), title: name.into(), member_ids: None };
    let chat = create_group(db, owner_id, &req).await?;
    Ok(chat.id)
}

/// Вступление в чат по внутреннему id (идемпотентно).
/// Разрешено только в публичные типы: group/channel (dm/saved — по назначению).
pub async fn join_chat(db: &Db, chat_id: i64, user_id: i64) -> AppResult<()> {
    let rows = db.query_rows("SELECT kind FROM chats WHERE id = ?", &[json!(chat_id)]).await?;
    let kind = rows.first().and_then(|r| r.get("kind")).and_then(|v| v.as_str());
    match kind {
        Some("group") | Some("channel") => {}
        Some(_) => return Err(AppError::Forbidden("В этот чат нельзя вступить напрямую".into())),
        None => return Err(AppError::NotFound("Чат не найден".into())),
    }
    db.exec_params(
        "INSERT OR IGNORE INTO chat_members (chat_id, user_id) VALUES (?, ?)",
        &[json!(chat_id), json!(user_id)],
    )
    .await?;
    Ok(())
}

/// Проверка участия пользователя в чате (403 иначе).
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
            "SELECT m.id, m.chat_id, m.user_id, u.username, u.first_name, m.body, m.created_at \
             FROM (SELECT * FROM messages WHERE chat_id = ? ORDER BY id DESC LIMIT ?) m \
             JOIN users u ON u.id = m.user_id ORDER BY m.id ASC",
            &[json!(chat_id), json!(limit)],
        )
        .await?;
    Ok(rows.iter().map(row_to_message).collect())
}

/// Имя автора для ленты: first_name, иначе @username, иначе server_id.
fn display_name(r: &serde_json::Value) -> String {
    if let Some(f) = r.get("first_name").and_then(|v| v.as_str()) {
        if !f.is_empty() {
            return f.to_string();
        }
    }
    if let Some(u) = r.get("username").and_then(|v| v.as_str()) {
        if !u.is_empty() {
            return format!("@{u}");
        }
    }
    "?".to_string()
}

fn row_to_message(r: &serde_json::Value) -> Message {
    Message {
        id: r.get("id").and_then(|v| v.as_i64()).unwrap_or(0),
        chat_id: r.get("chat_id").and_then(|v| v.as_i64()).unwrap_or(0),
        user_id: r.get("user_id").and_then(|v| v.as_i64()).unwrap_or(0),
        username: display_name(r),
        body: r.get("body").and_then(|v| v.as_str()).unwrap_or_default().to_string(),
        created_at: r.get("created_at").and_then(|v| v.as_i64()).unwrap_or(0),
    }
}

/// Сохранение сообщения: id даёт AUTOINCREMENT (никакого MAX(id)+1!),
/// после INSERT читаем строку по уникальной комбинации (chat_id, user_id,
/// created_at, body) — самый свежий ряд (ORDER BY id DESC LIMIT 1).
pub async fn save_message(db: &Db, chat_id: i64, user_id: i64, body: &str) -> AppResult<Message> {
    let body = body.trim();
    if body.is_empty() {
        return Err(AppError::BadRequest("Пустое сообщение".into()));
    }
    if body.len() > 4000 {
        return Err(AppError::BadRequest("Сообщение слишком длинное (макс. 4000)".into()));
    }
    let ts = now_ts();
    db.exec_params(
        "INSERT INTO messages (chat_id, user_id, body, created_at) VALUES (?, ?, ?, ?)",
        &[json!(chat_id), json!(user_id), json!(body), json!(ts)],
    )
    .await?;
    let rows = db
        .query_rows(
            "SELECT m.id, m.chat_id, m.user_id, u.username, u.first_name, m.body, m.created_at \
             FROM messages m JOIN users u ON u.id = m.user_id \
             WHERE m.chat_id = ? AND m.user_id = ? AND m.created_at = ? AND m.body = ? \
             ORDER BY m.id DESC LIMIT 1",
            &[json!(chat_id), json!(user_id), json!(ts), json!(body)],
        )
        .await?;
    rows.first()
        .map(row_to_message)
        .ok_or_else(|| AppError::Internal("Сообщение не найдено после INSERT".into()))
}
