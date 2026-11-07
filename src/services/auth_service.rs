//! Авторизация v2: телефон -> код из «SMS» (лог) -> профиль -> username -> пароль.
//! Весь SQL и бизнес-правила живут здесь; про HTTP сервис ничего не знает.

use once_cell::sync::Lazy;
use regex::Regex;
use serde_json::json;
use std::time::{SystemTime, UNIX_EPOCH};

use crate::db::Db;
use crate::models::user::{
    AuthResponse, FinishRegisterRequest, LoginRequest, StartAuthResponse, UsernameCheckResponse, User,
};
use crate::utils::error::{AppError, AppResult};
use crate::services::chat_service;
use crate::utils::{jwt, password, server_id};

fn now_ts() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0)
}

/// Время жизни одноразового кода (5 минут).
const CODE_TTL_SECS: i64 = 300;
/// Сколько неверных вводов кода допускается до блокировки.
const MAX_CODE_ATTEMPTS: i64 = 5;
/// Минимальный интервал между выдачами новых кодов на один номер.
const RESEND_COOLDOWN_SECS: i64 = 60;
/// Минимальная и максимальная длина пароля (в символах).
const PASSWORD_MIN_CHARS: usize = 8;
const PASSWORD_MAX_CHARS: usize = 128;

/// Телефон после нормализации: "+", затем 8..15 цифр, первая не ноль.
static PHONE_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"^\+[1-9][0-9]{7,14}$").unwrap());
/// @username: латиница, цифры, подчёркивание, 4..32 символа.
static USERNAME_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"^[a-zA-Z0-9_]{4,32}$").unwrap());

/// Нормализация номера: убираем пробелы, скобки, дефисы; ведущий 8 (росформат)
/// заменяем на +7; если "+" нет — добавляем.
pub fn normalize_phone(raw: &str) -> String {
    let cleaned: String = raw
        .chars()
        .filter(|c| !matches!(c, ' ' | '(' | ')' | '-' | '\u{00A0}'))
        .collect();
    if let Some(rest) = cleaned.strip_prefix('+') {
        format!("+{rest}")
    } else if let Some(rest) = cleaned.strip_prefix('8') {
        format!("+7{rest}")
    } else {
        format!("+{cleaned}")
    }
}

/// Зарегистрирован ли номер (есть password_hash — регистрация завершена).
async fn registered_by_phone(db: &Db, phone: &str) -> AppResult<bool> {
    let rows = db
        .query_rows("SELECT password_hash FROM users WHERE phone = ?", &[json!(phone)])
        .await?;
    Ok(rows
        .first()
        .and_then(|r| r.get("password_hash"))
        .and_then(|v| v.as_str())
        .is_some())
}

/// Занят ли @username.
async fn username_taken(db: &Db, username: &str) -> AppResult<bool> {
    let rows = db
        .query_rows("SELECT 1 AS ok FROM users WHERE username = ?", &[json!(username)])
        .await?;
    Ok(!rows.is_empty())
}

/// Чтение строки users (SELECT по любому уникальному ключу) -> модель User.
/// Поле может отсутствовать (NULL) — тогда Option::None.
fn row_to_user(r: &serde_json::Value) -> User {
    let opt_str = |k: &str| r.get(k).and_then(|v| v.as_str()).map(|s| s.to_string());
    User {
        id: r.get("id").and_then(|v| v.as_i64()).unwrap_or(0),
        server_id: opt_str("server_id").unwrap_or_default(),
        phone: opt_str("phone").unwrap_or_default(),
        username: opt_str("username"),
        first_name: opt_str("first_name"),
        last_name: opt_str("last_name"),
        created_at: r.get("created_at").and_then(|v| v.as_i64()).unwrap_or(0),
        avatar_color: opt_str("avatar_color").unwrap_or_else(|| "#89b4fa".to_string()),
    }
}

const USER_COLS: &str =
    "id, server_id, phone, username, first_name, last_name, created_at, avatar_color";

/// Шаг 1: старт авторизации по номеру.
/// Зарегистрированный номер (с паролем) -> сразу экран пароля;
/// нового номера нет -> генерируем 6-значный код и пишем его в лог (MVP без SMS).
pub async fn start_auth(db: &Db, phone_raw: &str) -> AppResult<StartAuthResponse> {
    let phone = normalize_phone(phone_raw);
    if !PHONE_RE.is_match(&phone) {
        return Err(AppError::BadRequest("Неверный номер телефона".into()));
    }
    // Зарегистрированный номер -> сразу экран пароля, код не нужен
    if registered_by_phone(db, &phone).await? {
        return Ok(StartAuthResponse { registered: true, needs_code: false });
    }

    let now = now_ts();
    let existing = db
        .query_rows(
            "SELECT code, expires_at, attempts, sent_at FROM phone_codes WHERE phone = ?",
            &[json!(&phone)],
        )
        .await?;

    if let Some(row) = existing.first() {
        let expires_at = row.get("expires_at").and_then(|v| v.as_i64()).unwrap_or(0);
        let attempts = row.get("attempts").and_then(|v| v.as_i64()).unwrap_or(0);
        let sent_at = row.get("sent_at").and_then(|v| v.as_i64()).unwrap_or(0);

        // Живой код с остатком попыток отдаём как есть: НЕ сбрасываем attempts
        // и не продлеваем TTL. Иначе клиент одним повторным /auth/start
        // обнулял счётчик и лимит в 5 попыток не работал вообще.
        if expires_at > now && attempts < MAX_CODE_ATTEMPTS {
            return Ok(StartAuthResponse { registered: false, needs_code: true });
        }

        // Код исчерпан или просрочен. Новый выдаём не чаще раза в минуту:
        // иначе тот же перебор продолжается бесконечно.
        let elapsed = now.saturating_sub(sent_at);
        if elapsed < RESEND_COOLDOWN_SECS {
            let wait = RESEND_COOLDOWN_SECS - elapsed;
            return Err(AppError::TooManyRequests(format!(
                "Новый код можно запросить через {wait} с"
            )));
        }
    }

    // Новый код: TTL 5 минут, счётчик попыток обнуляется только здесь.
    let code = server_id::random_code();
    let expires = now + CODE_TTL_SECS;
    db.exec_params(
        "INSERT INTO phone_codes (phone, code, expires_at, attempts, sent_at) \
         VALUES (?, ?, ?, 0, ?) \
         ON CONFLICT(phone) DO UPDATE SET code = excluded.code, \
         expires_at = excluded.expires_at, attempts = 0, sent_at = excluded.sent_at",
        &[json!(&phone), json!(&code), json!(expires), json!(now)],
    )
    .await?;
    // В MVP вместо реальной SMS код пишется в лог сервера
    tracing::info!("SMS-код для {}: {}", phone, code);
    Ok(StartAuthResponse { registered: false, needs_code: true })
}

/// Шаг 2: проверка кода. Срок, счётчик попыток (макс. 5), совпадение.
pub async fn verify_code(db: &Db, phone_raw: &str, code: &str) -> AppResult<()> {
    let phone = normalize_phone(phone_raw);
    let rows = db
        .query_rows(
            "SELECT code, expires_at, attempts FROM phone_codes WHERE phone = ?",
            &[json!(&phone)],
        )
        .await?;
    let row = rows.first().ok_or_else(|| AppError::BadRequest("Сначала запросите код".into()))?;
    let stored = row.get("code").and_then(|v| v.as_str()).unwrap_or_default();
    let expires = row.get("expires_at").and_then(|v| v.as_i64()).unwrap_or(0);
    let attempts = row.get("attempts").and_then(|v| v.as_i64()).unwrap_or(0);
    if expires < now_ts() {
        return Err(AppError::BadRequest("Код истёк, запросите новый".into()));
    }
    if attempts >= MAX_CODE_ATTEMPTS {
        return Err(AppError::BadRequest("Слишком много попыток, запросите новый код".into()));
    }
    if code.trim() != stored {
        // Увеличиваем счётчик неверных попыток
        db.exec_params(
            "UPDATE phone_codes SET attempts = attempts + 1 WHERE phone = ?",
            &[json!(&phone)],
        )
        .await?;
        return Err(AppError::Unauthorized("Неверный код".into()));
    }
    Ok(())
}

/// Валидация и нормализация @username: trim, снятие ведущего "@", regex.
fn validate_username(raw: &str) -> AppResult<String> {
    let u = raw.trim().trim_start_matches('@').to_string();
    if !USERNAME_RE.is_match(&u) {
        return Err(AppError::BadRequest(
            "Username: 4–32 символа, только латиница, цифры и _".into(),
        ));
    }
    Ok(u)
}

/// Проверка пароля: длина в СИМВОЛАХ (а не в байтах — иначе кириллический
/// пароль из 4 букв проходил бы порог «8»), совпадение, верхняя граница
/// (чтобы не хешировать мегабайты по запросу).
fn validate_password(password: &str, repeat: &str) -> AppResult<()> {
    let len = password.chars().count();
    if len < PASSWORD_MIN_CHARS {
        return Err(AppError::BadRequest(format!(
            "Пароль должен быть не короче {PASSWORD_MIN_CHARS} символов"
        )));
    }
    if len > PASSWORD_MAX_CHARS {
        return Err(AppError::BadRequest(format!(
            "Пароль слишком длинный (макс. {PASSWORD_MAX_CHARS} символов)"
        )));
    }
    if password != repeat {
        return Err(AppError::BadRequest("Пароли не совпадают".into()));
    }
    Ok(())
}

/// Шаг 3–6: завершение регистрации. Код уже подтверждён frontend'ом —
/// проверяем ещё раз (защита от прямого вызова endpoint'а), создаём
/// пользователя, его saved-чат («Избранное») и выдаём JWT.
pub async fn finish_register(db: &Db, secret: &str, req: &FinishRegisterRequest) -> AppResult<AuthResponse> {
    let phone = normalize_phone(&req.phone);
    // Номер могли зарегистрировать, пока пользователь заполнял профиль (вторая
    // вкладка/устройство). После успешной регистрации код удаляется, поэтому
    // verify_code ниже ответил бы невнятным «Сначала запросите код» — проверяем
    // регистрацию заранее и отправляем такого пользователя на вход по паролю.
    if registered_by_phone(db, &phone).await? {
        return Err(AppError::Conflict(
            "Этот номер уже зарегистрирован — войдите с паролем".into(),
        ));
    }
    verify_code(db, &phone, &req.code).await?;

    // Имя обязательно, фамилия опциональна
    let first = req.first_name.trim();
    if first.is_empty() || first.chars().count() > 64 {
        return Err(AppError::BadRequest("Имя обязательно (до 64 символов)".into()));
    }
    let last = match req.last_name.as_deref().map(str::trim) {
        None | Some("") => None,
        Some(l) if l.chars().count() <= 64 => Some(l.to_string()),
        Some(_) => return Err(AppError::BadRequest("Фамилия слишком длинная".into())),
    };
    let username = validate_username(&req.username)?;
    if username_taken(db, &username).await? {
        return Err(AppError::Conflict("Этот username уже занят".into()));
    }
    validate_password(&req.password, &req.password_repeat)?;
    let hash = password::hash_password(&req.password)?;
    let ts = now_ts();
    // Проверки username/телефона выше — не атомарны: параллельная регистрация
    // может занять тот же ключ. Поэтому вставляем с ON CONFLICT DO NOTHING и,
    // если строка не вставилась, отвечаем 409 с точной причиной, а не 500.
    let mut created_server_id = String::new();
    for _ in 0..5 {
        let server = server_id::next_user_server_id(db).await?;
        let color = server_id::avatar_color_for(&server);
        let affected = db
            .exec_params_affected(
                "INSERT INTO users (server_id, phone, username, first_name, last_name, \
                 password_hash, created_at, avatar_color) VALUES (?, ?, ?, ?, ?, ?, ?, ?) \
                 ON CONFLICT DO NOTHING",
                &[
                    json!(&server), json!(&phone), json!(&username), json!(first),
                    json!(last.clone()), json!(&hash), json!(ts), json!(color),
                ],
            )
            .await?;
        if affected > 0 {
            created_server_id = server;
            break;
        }
        if registered_by_phone(db, &phone).await? {
            return Err(AppError::Conflict(
                "Этот номер уже зарегистрирован — войдите с паролем".into(),
            ));
        }
        if username_taken(db, &username).await? {
            return Err(AppError::Conflict("Этот username уже занят".into()));
        }
    }
    if created_server_id.is_empty() {
        return Err(AppError::Internal(
            "Не удалось подобрать свободный server_id пользователя".into(),
        ));
    }
    // Код больше не нужен
    db.exec_params("DELETE FROM phone_codes WHERE phone = ?", &[json!(&phone)]).await?;
    // rqlite не поддерживает RETURNING — читаем созданную строку по уникальному phone
    let rows = db
        .query_rows(&format!("SELECT {USER_COLS} FROM users WHERE phone = ?"), &[json!(&phone)])
        .await?;
    let user = rows.first().map(row_to_user).ok_or_else(|| {
        AppError::Internal("Пользователь не найден после INSERT".into())
    })?;

    // «Избранное»: раньше здесь использовался server_id пользователя, и он мог
    // совпасть с уже существующим dm (общая 8-значная нумерация chats) — регистрация
    // падала на UNIQUE. Теперь chat_service сам выделяет свободный id.
    // Ошибку не считаем фатальной: чат досоздастся при первом открытии «Избранного».
    if let Err(e) = chat_service::ensure_saved_chat(db, user.id).await {
        tracing::warn!("Не удалось создать «Избранное» для user_id={}: {e}", user.id);
    }

    let token = jwt::issue_token(secret, user.id, &username)?;
    Ok(AuthResponse { token, user })
}

/// Логин по телефону и паролю.
pub async fn login(db: &Db, secret: &str, req: &LoginRequest) -> AppResult<AuthResponse> {
    let phone = normalize_phone(&req.phone);
    let rows = db
        .query_rows(
            &format!("SELECT {USER_COLS}, password_hash FROM users WHERE phone = ?"),
            &[json!(&phone)],
        )
        .await?;
    let row = rows
        .first()
        .ok_or_else(|| AppError::Unauthorized("Неверный номер или пароль".into()))?;
    let hash = row.get("password_hash").and_then(|v| v.as_str());
    let Some(hash) = hash else {
        // Регистрация начата, но не завершена — идём по потоку кода
        return Err(AppError::BadRequest("Сначала завершите регистрацию по коду".into()));
    };
    if !password::verify_password(&req.password, hash) {
        return Err(AppError::Unauthorized("Неверный номер или пароль".into()));
    }
    let user = row_to_user(row);
    let token = jwt::issue_token(secret, user.id, user.username.as_deref().unwrap_or(""))?;
    Ok(AuthResponse { token, user })
}

/// Проверка доступности @username (GET /api/auth/check-username, debounce на фронте).
pub async fn check_username(db: &Db, raw: &str) -> AppResult<UsernameCheckResponse> {
    let u = raw.trim().trim_start_matches('@');
    if !USERNAME_RE.is_match(u) {
        return Ok(UsernameCheckResponse {
            available: false,
            reason: Some("Недопустимые символы".into()),
        });
    }
    if !username_taken(db, u).await? {
        Ok(UsernameCheckResponse { available: true, reason: None })
    } else {
        Ok(UsernameCheckResponse { available: false, reason: Some("занят".into()) })
    }
}

/// Получение пользователя по внутреннему id (для контроллера /api/me).
pub async fn get_user_by_id(db: &Db, user_id: i64) -> AppResult<User> {
    let rows = db
        .query_rows(&format!("SELECT {USER_COLS} FROM users WHERE id = ?"), &[json!(user_id)])
        .await?;
    rows.first()
        .map(row_to_user)
        .ok_or_else(|| AppError::NotFound("Пользователь не найден".into()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_common_phone_styles() {
        assert_eq!(normalize_phone("+7 999 000-11-22"), "+79990001122");
        assert_eq!(normalize_phone("8 (999) 000-11-22"), "+79990001122");
        assert_eq!(normalize_phone("79990001122"), "+79990001122");
        assert_eq!(normalize_phone("+1 415 555 0100"), "+14155550100");
    }

    #[test]
    fn phone_regex_rejects_garbage() {
        assert!(PHONE_RE.is_match(&normalize_phone("+79990001122")));
        assert!(!PHONE_RE.is_match(&normalize_phone("123")));
        assert!(!PHONE_RE.is_match(&normalize_phone("+09990001122")));
        assert!(!PHONE_RE.is_match(&normalize_phone("+7abcdefghij")));
    }

    #[test]
    fn username_validation() {
        assert_eq!(validate_username("  @alice_1 ").unwrap(), "alice_1");
        assert!(validate_username("ab").is_err());       // короче 4
        assert!(validate_username("кириллица").is_err());
        assert!(validate_username("with space").is_err());
    }

    #[test]
    fn password_length_counts_chars_not_bytes() {
        // 4 кириллические буквы — 8 байт, но всё равно слишком короткий пароль
        assert!(validate_password("пароль", "пароль").is_err());
        assert!(validate_password("пароль12", "пароль12").is_ok());
        assert!(validate_password("пароль12", "пароль13").is_err());
        assert!(validate_password(&"x".repeat(200), &"x".repeat(200)).is_err());
    }
}
