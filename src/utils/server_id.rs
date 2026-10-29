//! Генерация человекочитаемых server_id для пользователей и чатов.
//!
//! Пользователь: "00000001" (ровно 8 цифр, ведущие нули).
//! Чат dm/saved: 8 цифр; group/channel: "-" + 14 цифр ("-00000000000001").
//! Источник — последний по id ряд таблицы (AUTOINCREMENT гарантирует рост id),
//! коллизии UNIQUE перебираются инкрементом (до 10 попыток).

use crate::db::Db;
use crate::utils::error::{AppError, AppResult};
use rand::Rng;

/// Палитра цветов аватара — выбирается детерминированно по server_id.
pub const AVATAR_PALETTE: [&str; 6] =
    ["#89b4fa", "#a6e3a1", "#f38ba8", "#fab387", "#cba6f7", "#94e2d5"];

/// Максимум попыток найти свободный server_id при UNIQUE-коллизии.
const MAX_TRIES: u32 = 10;

/// Формат user/dm/saved id: ровно 8 цифр с ведущими нулями.
fn fmt_user_like(n: u64) -> String {
    format!("{:08}", n)
}

/// Формат group/channel id: минус + ровно 14 цифр.
fn fmt_group_like(n: u64) -> String {
    format!("-{:014}", n)
}

/// Последний выданный числовой server_id в таблице (по максимальному id строки).
async fn last_numeric_id(db: &Db, table: &str) -> AppResult<Option<u64>> {
    // Имя таблицы — литерал из кода, не пользовательский ввод: инъекции нет
    let rows = db
        .query_rows(
            &format!("SELECT server_id FROM {table} ORDER BY id DESC LIMIT 1"),
            &[],
        )
        .await?;
    Ok(rows
        .first()
        .and_then(|r| r.get("server_id"))
        .and_then(|v| v.as_str())
        .map(|s| s.trim_start_matches('-').parse::<u64>().ok())
        .flatten())
}

/// Проверка: занят ли уже такой server_id в таблице.
async fn id_taken(db: &Db, table: &str, sid: &str) -> AppResult<bool> {
    let rows = db
        .query_rows(
            &format!("SELECT 1 AS ok FROM {table} WHERE server_id = ?"),
            &[serde_json::json!(sid)],
        )
        .await?;
    Ok(!rows.is_empty())
}

/// Следующий свободный 8-значный server_id пользователя ("00000001", ...).
pub async fn next_user_server_id(db: &Db) -> AppResult<String> {
    // Начинаем с последнего выданного + 1; если таблица пуста — с единицы.
    let mut candidate = last_numeric_id(db, "users").await?.map(|n| n + 1).unwrap_or(1);
    for _ in 0..MAX_TRIES {
        let sid = fmt_user_like(candidate);
        if !id_taken(db, "users", &sid).await? {
            return Ok(sid);
        }
        candidate += 1;
    }
    Err(AppError::Internal("Не удалось подобрать server_id пользователя".into()))
}

/// Следующий свободный server_id чата:
/// - kind "dm"/"saved" -> 8 цифр (общая нумерация с таблицей chats);
/// - kind "group"/"channel" -> "-" + 14 цифр.
pub async fn next_chat_server_id(db: &Db, kind: &str) -> AppResult<String> {
    let groupish = kind == "group" || kind == "channel";
    let last = last_numeric_id(db, "chats").await?;
    // Для групп стартуем с 1 по своей 14-значной шкале (существующие 8-значные
    // dm-id в этой же таблице не конфликтуют: формат строк разный, а проверка
    // id_taken ниже ловит любые реальные коллизии).
    let mut candidate = match last {
        Some(n) if groupish && n >= 1_000_000_000_000_000 => n + 1, // продолжаем 14-значную шкалу
        Some(n) if !groupish && n < 100_000_000 => n + 1,          // продолжаем 8-значную шкалу
        _ => 1,
    };
    for _ in 0..MAX_TRIES {
        let sid = if groupish { fmt_group_like(candidate) } else { fmt_user_like(candidate) };
        if !id_taken(db, "chats", &sid).await? {
            return Ok(sid);
        }
        candidate += 1;
    }
    Err(AppError::Internal("Не удалось подобрать server_id чата".into()))
}

/// Детерминированный выбор цвета аватара по server_id (сумма байтов % палитра).
pub fn avatar_color_for(server_id: &str) -> &'static str {
    // Простое стабильное хеширование: сумма кодов символов.
    let sum: u32 = server_id.bytes().map(|b| b as u32).sum();
    AVATAR_PALETTE[(sum as usize) % AVATAR_PALETTE.len()]
}

/// 6 случайных цифр для SMS-кода авторизации.
pub fn random_code() -> String {
    let n: u32 = rand::thread_rng().gen_range(0..1_000_000);
    format!("{n:06}")
}
