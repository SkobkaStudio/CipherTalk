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
use crate::utils::{jwt, password, server_id};

fn now_ts() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0)
}

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
    // Ищем пользователя с завершённой регистрацией (password_hash NOT NULL)
    let rows = db
        .query_rows("SELECT id, password_hash FROM users WHERE phone = ?", &[json!(&phone)])
        .await?;
    let registered = rows
        .first()
        .map(|r| r.get("password_hash").and_then(|v| v.as_str()).is_some())
        .unwrap_or(false);
    if registered {
        return Ok(StartAuthResponse { registered: true, needs_code: false });
    }
    // Новый (или незавершённый) номер: выдаём одноразовый код, TTL 5 минут
    let code = server_id::random_code();
    let expires = now_ts() + 300;
    db.exec_params(
        "INSERT OR REPLACE INTO phone_codes (phone, code, expires_at, attempts) VALUES (?, ?, ?, 0)",
        &[json!(&phone), json!(&code), json!(expires)],
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
    if attempts >= 5 {
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

/// Шаг 3–6: завершение регистрации. Код уже подтверждён frontend'ом —
/// проверяем ещё раз (защита от прямого вызова endpoint'а), создаём
/// пользователя, его saved-чат («Избранное») и выдаём JWT.
pub async fn finish_register(db: &Db, secret: &str, req: &FinishRegisterRequest) -> AppResult<AuthResponse> {
    verify_code(db, &req.phone, &req.code).await?;

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
    let rows = db.query_rows("SELECT id FROM users WHERE username = ?", &[json!(&username)]).await?;
    if !rows.is_empty() {
        return Err(AppError::Conflict("Этот username уже занят".into()));
    }
    if req.password.len() < 8 {
        return Err(AppError::BadRequest("Пароль должен быть не короче 8 символов".into()));
    }
    if req.password != req.password_repeat {
        return Err(AppError::BadRequest("Пароли не совпадают".into()));
    }
    let hash = password::hash_password(&req.password)?;
    let phone = normalize_phone(&req.phone);
    let server = server_id::next_user_server_id(db).await?;
    let color = server_id::avatar_color_for(&server);
    let ts = now_ts();
    db.exec_params(
        "INSERT INTO users (server_id, phone, username, first_name, last_name, \
         password_hash, created_at, avatar_color) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        &[
            json!(&server), json!(&phone), json!(&username), json!(first),
            json!(last.clone()), json!(hash), json!(ts), json!(color),
        ],
    )
    .await?;
    // Код больше не нужен
    db.exec_params("DELETE FROM phone_codes WHERE phone = ?", &[json!(&phone)]).await?;
    // rqlite не поддерживает RETURNING — читаем созданную строку по уникальному phone
    let rows = db
        .query_rows(&format!("SELECT {USER_COLS} FROM users WHERE phone = ?"), &[json!(&phone)])
        .await?;
    let user = rows.first().map(row_to_user).ok_or_else(|| {
        AppError::Internal("Пользователь не найден после INSERT".into())
    })?;

    // Saved-чат «Избранное»: server_id совпадает с server_id пользователя
    // (не конфликт — другая таблица), owner — сам пользователь.
    db.exec_params(
        "INSERT INTO chats (server_id, kind, title, owner_id, created_at) VALUES (?, 'saved', NULL, ?, ?)",
        &[json!(&user.server_id), json!(user.id), json!(ts)],
    )
    .await?;
    let rows = db
        .query_rows("SELECT id FROM chats WHERE server_id = ?", &[json!(&user.server_id)])
        .await?;
    if let Some(cid) = rows.first().and_then(|r| r.get("id")).and_then(|v| v.as_i64()) {
        db.exec_params(
            "INSERT OR IGNORE INTO chat_members (chat_id, user_id) VALUES (?, ?)",
            &[json!(cid), json!(user.id)],
        )
        .await?;
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
    let rows = db.query_rows("SELECT 1 AS ok FROM users WHERE username = ?", &[json!(u)]).await?;
    if rows.is_empty() {
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
