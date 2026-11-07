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

/// Максимальная длина сообщения — в СИМВОЛАХ (не в байтах: для кириллицы
/// байтовый лимит молча урезал бы текст вдвое).
const MAX_MESSAGE_CHARS: usize = 4000;

/// Ключ уникальности диалога: «меньший_id:больший_id». NULL у групп,
/// каналов и «Избранного» — уникальный индекс по dm_key их не трогает.
pub fn dm_key(a: i64, b: i64) -> String {
    format!("{}:{}", a.min(b), a.max(b))
}

/// Диалог по ключу пары пользователей (None, если его ещё нет).
async fn find_dm_by_key(db: &Db, key: &str) -> AppResult<Option<Chat>> {
    let rows = db
        .query_rows(
            &format!("SELECT {CHAT_COLS} FROM chats WHERE dm_key = ? LIMIT 1"),
            &[json!(key)],
        )
        .await?;
    Ok(rows.first().map(row_to_chat))
}

/// «Избранное» пользователя (None, если ещё не создано).
async fn find_saved_chat(db: &Db, user_id: i64) -> AppResult<Option<Chat>> {
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
    Ok(rows.first().map(row_to_chat))
}

/// Возвращает «Избранное», создавая его при необходимости.
///
/// server_id берётся из общей нумерации чатов (а не из server_id пользователя,
/// как было раньше): иначе saved-чат нового пользователя мог совпасть с уже
/// существующим dm и регистрация падала на UNIQUE(chats.server_id).
pub async fn ensure_saved_chat(db: &Db, user_id: i64) -> AppResult<Chat> {
    if let Some(chat) = find_saved_chat(db, user_id).await? {
        return Ok(chat);
    }
    for _ in 0..5 {
        let sid = server_id::next_chat_server_id(db, "saved").await?;
        let ts = now_ts();
        let affected = db
            .exec_params_affected(
                "INSERT INTO chats (server_id, kind, title, owner_id, created_at, dm_key) \
                 VALUES (?, 'saved', NULL, ?, ?, NULL) ON CONFLICT DO NOTHING",
                &[json!(&sid), json!(user_id), json!(ts)],
            )
            .await?;
        if affected == 0 {
            // Либо server_id заняли, либо чат уже создали параллельно
            if let Some(chat) = find_saved_chat(db, user_id).await? {
                return Ok(chat);
            }
            continue;
        }
        let chat = get_chat_by_server_id(db, &sid).await?;
        db.exec_params(
            "INSERT OR IGNORE INTO chat_members (chat_id, user_id) VALUES (?, ?)",
            &[json!(chat.id), json!(user_id)],
        )
        .await?;
        return Ok(chat);
    }
    Err(AppError::Internal("Не удалось создать «Избранное»".into()))
}

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
        // «Избранное» обычно создаётся при регистрации; если его нет — создаём
        return ensure_saved_chat(db, user_id).await;
    }
    // Существующий диалог на эту пару (dm_key + уникальный индекс)
    let key = dm_key(user_id, other_user_id);
    if let Some(chat) = find_dm_by_key(db, &key).await? {
        return Ok(chat);
    }

    // Новый dm: server_id из 8-значной шкалы таблицы chats.
    // ON CONFLICT DO NOTHING закрывает гонку: два одновременных запроса на одну
    // пару создадут ровно один чат, второй возьмёт уже существующий.
    for _ in 0..5 {
        let sid = server_id::next_chat_server_id(db, "dm").await?;
        let ts = now_ts();
        let affected = db
            .exec_params_affected(
                "INSERT INTO chats (server_id, kind, title, owner_id, created_at, dm_key) \
                 VALUES (?, 'dm', NULL, NULL, ?, ?) ON CONFLICT DO NOTHING",
                &[json!(&sid), json!(ts), json!(&key)],
            )
            .await?;
        if affected == 0 {
            // Либо server_id заняли, либо чат на пару уже создан конкурентом
            if let Some(chat) = find_dm_by_key(db, &key).await? {
                return Ok(chat);
            }
            continue;
        }
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
        return get_chat_by_server_id(db, &sid).await;
    }
    Err(AppError::Internal("Не удалось создать диалог".into()))
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
    let ts = now_ts();
    // Гонка двух одновременных созданий: server_id вычисляется из MAX(id),
    // поэтому вставляем с ON CONFLICT DO NOTHING и при конфликте пробуем снова.
    let mut chat_id = 0i64;
    let mut created_sid = String::new();
    for _ in 0..5 {
        let sid = server_id::next_chat_server_id(db, &req.kind).await?;
        let affected = db
            .exec_params_affected(
                "INSERT INTO chats (server_id, kind, title, owner_id, created_at, dm_key) \
                 VALUES (?, ?, ?, ?, ?, NULL) ON CONFLICT DO NOTHING",
                &[json!(&sid), json!(&req.kind), json!(title), json!(owner_id), json!(ts)],
            )
            .await?;
        if affected > 0 {
            chat_id = chat_internal_id(db, &sid).await?;
            created_sid = sid;
            break;
        }
    }
    if chat_id == 0 {
        return Err(AppError::Internal("Не удалось создать чат: заняты все server_id".into()));
    }
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
    get_chat_by_server_id(db, &created_sid).await
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

/// Проверка текста сообщения: непустой после trim, не длиннее лимита
/// (символы, не байты — иначе кириллица урезалась бы вдвое).
fn validate_body(body: &str) -> AppResult<&str> {
    let body = body.trim();
    if body.is_empty() {
        return Err(AppError::BadRequest("Пустое сообщение".into()));
    }
    if body.chars().count() > MAX_MESSAGE_CHARS {
        return Err(AppError::BadRequest(format!(
            "Сообщение слишком длинное (макс. {MAX_MESSAGE_CHARS} символов)"
        )));
    }
    Ok(body)
}

/// Сохранение сообщения: id даёт AUTOINCREMENT (никакого MAX(id)+1!),
/// после INSERT читаем строку по уникальной комбинации (chat_id, user_id,
/// created_at, body) — самый свежий ряд (ORDER BY id DESC LIMIT 1).
pub async fn save_message(db: &Db, chat_id: i64, user_id: i64, body: &str) -> AppResult<Message> {
    let body = validate_body(body)?;
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dm_key_normalizes_order() {
        assert_eq!(dm_key(7, 3), "3:7");
        assert_eq!(dm_key(3, 7), "3:7");
    }

    #[test]
    fn body_is_trimmed_and_measured_in_chars() {
        assert_eq!(validate_body("  привет  ").unwrap(), "привет");
        assert!(validate_body("   ").is_err());
        // 4000 кириллических символов проходят, 4001 — уже нет
        assert_eq!(validate_body(&"я".repeat(4000)).unwrap().chars().count(), 4000);
        assert!(validate_body(&"я".repeat(4001)).is_err());
    }

    #[test]
    fn display_name_prefers_first_name_then_username() {
        let v = |json: &str| serde_json::from_str::<serde_json::Value>(json).unwrap();
        assert_eq!(display_name(&v(r#"{"first_name":"Алиса","username":"alice"}"#)), "Алиса");
        assert_eq!(display_name(&v(r#"{"first_name":"","username":"alice"}"#)), "@alice");
        assert_eq!(display_name(&v(r#"{"first_name":null,"username":null}"#)), "?");
    }
}
