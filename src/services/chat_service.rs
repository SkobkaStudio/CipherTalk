//! Сервис чатов и сообщений.
//!
//! Здесь сосредоточены все SQL-запросы к `chats`, `chat_members` и `messages`.
//! Контроллеры только проверяют HTTP-контекст и вызывают эти функции.
//!
//! Особенности rqlite:
//! * нет `RETURNING` — после INSERT читаем строку отдельным SELECT;
//! * `last_insert_rowid()` из `/db/execute` не используется;
//! * сообщение после вставки ищется по совокупности (chat_id, user_id,
//!   created_at, body) с сортировкой по id — без `MAX(id)+1`.

use crate::db::{Db, Row};
use crate::models::chat::Chat;
use crate::models::message::Message;
use crate::utils::error::{AppError, AppResult};
use crate::utils::jwt::now_ts;
use serde_json::json;

/// Максимальная длина названия чата.
const MAX_CHAT_NAME_LEN: usize = 64;
/// Максимальная длина сообщения.
const MAX_MESSAGE_LEN: usize = 4000;
/// Значение limit по умолчанию.
const DEFAULT_LIMIT: i64 = 50;
/// Жёсткий потолок limit, чтобы клиент не вытянул всю историю.
const MAX_LIMIT: i64 = 200;

/// Список чатов, в которых состоит пользователь, новые сверху.
pub async fn list_chats(db: &Db, user_id: i64) -> AppResult<Vec<Chat>> {
    let rows = db
        .query(
            "SELECT c.id, c.name, c.owner_id, c.created_at, \
                    (SELECT COUNT(*) FROM chat_members all_members \
                     WHERE all_members.chat_id = c.id) AS member_count \
             FROM chats c \
             JOIN chat_members member ON member.chat_id = c.id \
             WHERE member.user_id = ? \
             ORDER BY c.id DESC",
            &[json!(user_id)],
        )
        .await?;

    rows.iter().map(row_to_chat).collect()
}

/// Создаёт чат и сразу добавляет владельца в участники.
///
/// Оба INSERT уходят одним запросом `/db/execute` — rqlite выполняет пакет
/// атомарно, поэтому «чат без владельца» не появится.
pub async fn create_chat(db: &Db, raw_name: &str, owner_id: i64) -> AppResult<i64> {
    let name = raw_name.trim();
    if name.is_empty() {
        return Err(AppError::BadRequest(
            "Название чата не может быть пустым".into(),
        ));
    }
    if name.chars().count() > MAX_CHAT_NAME_LEN {
        return Err(AppError::BadRequest(format!(
            "Название чата должно быть не длиннее {MAX_CHAT_NAME_LEN} символов"
        )));
    }

    let created_at = now_ts();
    let insert_chat_params = vec![json!(name), json!(owner_id), json!(created_at)];
    let insert_member_params = vec![json!(owner_id), json!(name), json!(owner_id)];

    db.execute_batch(&[
        (
            "INSERT INTO chats (name, owner_id, created_at) VALUES (?, ?, ?)",
            insert_chat_params.as_slice(),
        ),
        (
            "INSERT OR IGNORE INTO chat_members (chat_id, user_id) \
             SELECT id, ? FROM chats WHERE name = ? AND owner_id = ? \
             ORDER BY id DESC LIMIT 1",
            insert_member_params.as_slice(),
        ),
    ])
    .await?;

    // Нет RETURNING/last_insert_rowid: ищем чат по уникальной для владельца паре
    // (name, owner_id), беря самый свежий id.
    let row = db
        .query_one(
            "SELECT id FROM chats WHERE name = ? AND owner_id = ? ORDER BY id DESC LIMIT 1",
            &[json!(name), json!(owner_id)],
        )
        .await?
        .ok_or_else(|| AppError::Internal("чат не найден после INSERT".into()))?;

    row.i64("id")
        .ok_or_else(|| AppError::Internal("в строке chats нет id".into()))
}

/// Проверяет, существует ли чат.
pub async fn chat_exists(db: &Db, chat_id: i64) -> AppResult<bool> {
    Ok(db
        .query_one("SELECT id FROM chats WHERE id = ?", &[json!(chat_id)])
        .await?
        .is_some())
}

/// Добавляет пользователя в чат (идемпотентно).
pub async fn join_chat(db: &Db, chat_id: i64, user_id: i64) -> AppResult<()> {
    if !chat_exists(db, chat_id).await? {
        return Err(AppError::NotFound("Чат не найден".into()));
    }

    db.execute(
        "INSERT OR IGNORE INTO chat_members (chat_id, user_id) VALUES (?, ?)",
        &[json!(chat_id), json!(user_id)],
    )
    .await?;

    Ok(())
}

/// Состоит ли пользователь в чате.
pub async fn is_member(db: &Db, chat_id: i64, user_id: i64) -> AppResult<bool> {
    Ok(db
        .query_one(
            "SELECT 1 AS member FROM chat_members WHERE chat_id = ? AND user_id = ?",
            &[json!(chat_id), json!(user_id)],
        )
        .await?
        .is_some())
}

/// Возвращает последние `limit` сообщений по возрастанию id.
pub async fn recent_messages(db: &Db, chat_id: i64, limit: i64) -> AppResult<Vec<Message>> {
    let limit = if limit <= 0 {
        DEFAULT_LIMIT
    } else {
        limit.min(MAX_LIMIT)
    };

    let rows = db
        .query(
            "SELECT m.id, m.chat_id, m.user_id, u.username, m.body, m.created_at \
             FROM messages m \
             JOIN users u ON u.id = m.user_id \
             WHERE m.chat_id = ? \
             ORDER BY m.id DESC \
             LIMIT ?",
            &[json!(chat_id), json!(limit)],
        )
        .await?;

    let mut messages: Vec<Message> = rows
        .iter()
        .map(row_to_message)
        .collect::<AppResult<Vec<_>>>()?;

    // SQL отдал новые сверху; в интерфейсе нужен хронологический порядок.
    messages.reverse();
    Ok(messages)
}

/// Сохраняет сообщение и возвращает его полное представление.
pub async fn save_message(
    db: &Db,
    chat_id: i64,
    user_id: i64,
    raw_body: &str,
) -> AppResult<Message> {
    let body = raw_body.trim();
    if body.is_empty() {
        return Err(AppError::BadRequest(
            "Сообщение не может быть пустым".into(),
        ));
    }
    if body.chars().count() > MAX_MESSAGE_LEN {
        return Err(AppError::BadRequest(format!(
            "Сообщение слишком длинное (максимум {MAX_MESSAGE_LEN} символов)"
        )));
    }

    let created_at = now_ts();
    db.execute(
        "INSERT INTO messages (chat_id, user_id, body, created_at) VALUES (?, ?, ?, ?)",
        &[
            json!(chat_id),
            json!(user_id),
            json!(body),
            json!(created_at),
        ],
    )
    .await?;

    // Пост-выборка без RETURNING: находим самый свежий подходящий ряд.
    let row = db
        .query_one(
            "SELECT m.id, m.chat_id, m.user_id, u.username, m.body, m.created_at \
             FROM messages m \
             JOIN users u ON u.id = m.user_id \
             WHERE m.chat_id = ? AND m.user_id = ? AND m.created_at = ? AND m.body = ? \
             ORDER BY m.id DESC LIMIT 1",
            &[
                json!(chat_id),
                json!(user_id),
                json!(created_at),
                json!(body),
            ],
        )
        .await?
        .ok_or_else(|| AppError::Internal("сообщение не найдено после INSERT".into()))?;

    row_to_message(&row)
}

/// Преобразует строку `chats` в модель.
fn row_to_chat(row: &Row) -> AppResult<Chat> {
    Ok(Chat {
        id: row
            .i64("id")
            .ok_or_else(|| AppError::Internal("в строке chats нет id".into()))?,
        name: row
            .string("name")
            .ok_or_else(|| AppError::Internal("в строке chats нет name".into()))?,
        owner_id: row
            .i64("owner_id")
            .ok_or_else(|| AppError::Internal("в строке chats нет owner_id".into()))?,
        created_at: row
            .i64("created_at")
            .ok_or_else(|| AppError::Internal("в строке chats нет created_at".into()))?,
        member_count: row.i64("member_count").unwrap_or(0),
    })
}

/// Преобразует JOIN-строку `messages + users` в модель.
fn row_to_message(row: &Row) -> AppResult<Message> {
    Ok(Message {
        id: row
            .i64("id")
            .ok_or_else(|| AppError::Internal("в строке messages нет id".into()))?,
        chat_id: row
            .i64("chat_id")
            .ok_or_else(|| AppError::Internal("в строке messages нет chat_id".into()))?,
        user_id: row
            .i64("user_id")
            .ok_or_else(|| AppError::Internal("в строке messages нет user_id".into()))?,
        username: row
            .string("username")
            .ok_or_else(|| AppError::Internal("в строке messages нет username".into()))?,
        body: row
            .string("body")
            .ok_or_else(|| AppError::Internal("в строке messages нет body".into()))?,
        created_at: row
            .i64("created_at")
            .ok_or_else(|| AppError::Internal("в строке messages нет created_at".into()))?,
    })
}
