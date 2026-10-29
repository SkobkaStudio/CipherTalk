//! Асинхронный клиент rqlite (HTTP API) для CipherTalk.
//!
//! Никакого локального SQLite: только HTTP-запросы к rqlite.
//! * Запись:  `POST {base}/db/execute?subprotocol=rqlite`
//! * Чтение:  `POST {base}/db/query?subprotocol=rqlite`
//!
//! Подпротокол `rqlite` принимает параметризованные утверждения в формате
//! плоского массива `[["SQL с ?", p1, p2], ...]` — значения передаются как
//! отдельные JSON-параметры и подставляются движком rqlite, поэтому ручное
//! экранирование SQL не используется и инъекции через строковые данные
//! невозможны. Перед отправкой каждое утверждение проверяется на совпадение
//! числа плейсхолдеров и параметров, чтобы исключить тихие рассинхроны.

use std::fmt;

use serde_json::{json, Value};
use uuid::Uuid;

use crate::models::{ChatMessage, UserRecord};

#[derive(Debug, thiserror::Error)]
pub enum DbError {
    #[error("rqlite is unavailable: {0}")]
    Unavailable(String),
    #[error("bad rqlite response: status={status}, body={body}")]
    BadResponse { status: u16, body: String },
    #[error("rqlite statement error: {0}")]
    Statement(String),
    #[error("internal json error: {0}")]
    Json(#[from] serde_json::Error),
    #[error("invalid row shape from database")]
    RowShape,
}

pub type DbResult<T> = Result<T, DbError>;

/// Параметр SQL-запроса.
#[derive(Debug, Clone)]
pub enum P {
    Text(String),
    OptText(Option<String>),
    Int(i64),
    Bool(bool),
}

impl From<&str> for P {
    fn from(s: &str) -> Self {
        P::Text(s.to_string())
    }
}
impl From<String> for P {
    fn from(s: String) -> Self {
        P::Text(s)
    }
}
impl From<i64> for P {
    fn from(v: i64) -> Self {
        P::Int(v)
    }
}
impl From<bool> for P {
    fn from(v: bool) -> Self {
        P::Bool(v)
    }
}
impl From<Option<String>> for P {
    fn from(v: Option<String>) -> Self {
        P::OptText(v)
    }
}

impl P {
    fn to_value(&self) -> Value {
        match self {
            P::Text(s) => json!(s),
            P::OptText(Some(s)) => json!(s),
            P::OptText(None) => Value::Null,
            P::Int(i) => json!(i),
            P::Bool(b) => json!(*b),
        }
    }
}

fn count_placeholders(sql: &str) -> usize {
    // Плейсхолдеры рqlite — одиночные `?` вне строковых литералов.
    let mut in_str = false;
    let mut n = 0usize;
    for c in sql.chars() {
        match c {
            '\'' => in_str = !in_str,
            '?' if !in_str => n += 1,
            _ => {}
        }
    }
    n
}

fn stmt_pair(sql: &str, params: &[P]) -> DbResult<Vec<Value>> {
    let want = count_placeholders(sql);
    if want != params.len() {
        return Err(DbError::Statement(format!(
            "placeholder/param mismatch ({} vs {}) for: {}",
            want,
            params.len(),
            sql
        )));
    }
    let mut row = Vec::with_capacity(params.len() + 1);
    row.push(Value::String(sql.to_string()));
    row.extend(params.iter().map(|p| p.to_value()));
    Ok(row)
}

#[derive(Clone)]
pub struct Db {
    http: reqwest::Client,
    base: String,
}

impl fmt::Debug for Db {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Db").field("base", &self.base).finish()
    }
}

/// Одна строка результата SELECT.
pub struct Row {
    columns: Vec<String>,
    values: Vec<Value>,
}

impl Row {
    fn get(&self, name: &str) -> Option<&Value> {
        self.columns
            .iter()
            .position(|c| c == name)
            .and_then(|i| self.values.get(i))
    }
    pub fn text(&self, name: &str) -> DbResult<String> {
        match self.get(name) {
            Some(Value::String(s)) => Ok(s.clone()),
            Some(Value::Number(n)) => Ok(n.to_string()),
            _ => Err(DbError::RowShape),
        }
    }
    pub fn opt_text(&self, name: &str) -> Option<String> {
        match self.get(name) {
            Some(Value::String(s)) => Some(s.clone()),
            _ => None,
        }
    }
    pub fn i64(&self, name: &str) -> DbResult<i64> {
        match self.get(name) {
            Some(Value::Number(n)) => n
                .as_i64()
                .ok_or_else(|| DbError::Statement(format!("column {name} is not int"))),
            Some(Value::String(s)) => s
                .parse::<i64>()
                .map_err(|_| DbError::Statement(format!("column {name} is not int"))),
            _ => Err(DbError::RowShape),
        }
    }
    pub fn boolean(&self, name: &str) -> DbResult<bool> {
        Ok(self.i64(name)? != 0)
    }
}

fn parse_rows(body: &Value) -> DbResult<Vec<Row>> {
    let results = body
        .get("results")
        .and_then(Value::as_array)
        .ok_or_else(|| DbError::Statement(format!("missing results: {body}")))?;
    let mut out = Vec::new();
    for res in results {
        if let Some(err) = res.get("error").and_then(Value::as_str) {
            return Err(DbError::Statement(err.to_string()));
        }
        let columns: Vec<String> = res
            .get("columns")
            .and_then(Value::as_array)
            .map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect())
            .unwrap_or_default();
        if let Some(values) = res.get("values").and_then(Value::as_array) {
            for row in values {
                let vals = row.as_array().ok_or(DbError::RowShape)?.clone();
                if vals.len() != columns.len() {
                    return Err(DbError::RowShape);
                }
                out.push(Row {
                    columns: columns.clone(),
                    values: vals,
                });
            }
        }
    }
    Ok(out)
}

impl Db {
    /// Создаёт клиент и проверяет доступность rqlite.
    /// Если rqlite недоступен — возвращает ошибку, сервер не стартует.
    pub async fn connect(base_url: &str) -> DbResult<Self> {
        let http = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(10))
            .build()
            .map_err(|e| DbError::Unavailable(e.to_string()))?;
        let base = base_url.trim_end_matches('/').to_string();
        // Проверка доступности: простой SELECT через query-эндпоинт.
        let url = format!("{}/db/query", base);
        match http.post(&url).json(&json!([["SELECT 1"]])).send().await {
            Ok(resp) if resp.status().is_success() => {}
            Ok(resp) => {
                return Err(DbError::BadResponse {
                    status: resp.status().as_u16(),
                    body: resp.text().await.unwrap_or_default(),
                })
            }
            Err(e) => return Err(DbError::Unavailable(format!("{url}: {e}"))),
        }
        tracing::info!("connected to rqlite at {base}");
        Ok(Self { http, base })
    }

    async fn post_json(&self, path: &str, payload: &Value) -> DbResult<Value> {
        let url = format!("{}{}", self.base, path);
        let resp = self
            .http
            .post(&url)
            .json(payload)
            .send()
            .await
            .map_err(|e| DbError::Unavailable(format!("{path}: {e}")))?;
        let status = resp.status();
        let body: Value = resp
            .json()
            .await
            .map_err(|e| DbError::BadResponse {
                status: status.as_u16(),
                body: format!("non-json response: {e}"),
            })?;
        if !status.is_success() {
            return Err(DbError::BadResponse {
                status: status.as_u16(),
                body: body.to_string(),
            });
        }
        Ok(body)
    }

    /// Выполняет запись (INSERT/UPDATE/DELETE/CREATE). Возвращает ошибку утверждения, если она есть.
    pub async fn execute(&self, sql: &str, params: &[P]) -> DbResult<()> {
        let pair = stmt_pair(sql, params)?;
        let body = self
            .post_json("/db/execute?subprotocol=rqlite", &json!([pair]))
            .await?;
        if let Some(results) = body.get("results").and_then(Value::as_array) {
            for res in results {
                if let Some(err) = res.get("error").and_then(Value::as_str) {
                    return Err(DbError::Statement(err.to_string()));
                }
            }
        }
        Ok(())
    }

    /// Выполняет чтение и возвращает строки.
    pub async fn query(&self, sql: &str, params: &[P]) -> DbResult<Vec<Row>> {
        let pair = stmt_pair(sql, params)?;
        let body = self
            .post_json("/db/query?subprotocol=rqlite", &json!([pair]))
            .await?;
        parse_rows(&body)
    }

    async fn query_one(&self, sql: &str, params: &[P]) -> DbResult<Option<Row>> {
        Ok(self.query(sql, params).await?.into_iter().next())
    }

    async fn exec_many(&self, stmts: &[(&str, Vec<P>)]) -> DbResult<()> {
        let mut payload: Vec<Value> = Vec::with_capacity(stmts.len());
        for (sql, params) in stmts {
            payload.push(Value::Array(stmt_pair(sql, params)?));
        }
        let body = self
            .post_json("/db/execute?subprotocol=rqlite", &Value::Array(payload))
            .await?;
        if let Some(results) = body.get("results").and_then(Value::as_array) {
            for res in results {
                if let Some(err) = res.get("error").and_then(Value::as_str) {
                    return Err(DbError::Statement(err.to_string()));
                }
            }
        }
        Ok(())
    }

    // ============================= Схема =============================

    pub async fn init_schema(&self) -> DbResult<()> {
        let stmts: Vec<(&str, Vec<P>)> = vec![
            (
                "CREATE TABLE IF NOT EXISTS users (
                    id TEXT PRIMARY KEY,
                    username TEXT NOT NULL UNIQUE,
                    display_name TEXT NOT NULL,
                    phone TEXT NOT NULL UNIQUE,
                    password_hash TEXT NOT NULL,
                    salt TEXT NOT NULL,
                    avatar TEXT,
                    public_key TEXT,
                    is_bot INTEGER NOT NULL DEFAULT 0,
                    created_at INTEGER NOT NULL
                )",
                vec![],
            ),
            (
                "CREATE TABLE IF NOT EXISTS chats (
                    id TEXT PRIMARY KEY,
                    chat_type TEXT NOT NULL,
                    name TEXT NOT NULL,
                    created_at INTEGER NOT NULL
                )",
                vec![],
            ),
            (
                "CREATE TABLE IF NOT EXISTS chat_members (
                    chat_id TEXT NOT NULL,
                    user_id TEXT NOT NULL,
                    joined_at INTEGER NOT NULL,
                    PRIMARY KEY (chat_id, user_id)
                )",
                vec![],
            ),
            (
                "CREATE TABLE IF NOT EXISTS messages (
                    id TEXT PRIMARY KEY,
                    chat_id TEXT NOT NULL,
                    sender_id TEXT NOT NULL,
                    content TEXT NOT NULL,
                    iv TEXT NOT NULL DEFAULT '',
                    header TEXT NOT NULL DEFAULT '',
                    msg_type TEXT NOT NULL DEFAULT 'text',
                    created_at INTEGER NOT NULL
                )",
                vec![],
            ),
            ("CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages (chat_id, created_at)", vec![]),
            (
                "CREATE TABLE IF NOT EXISTS sessions (
                    id TEXT PRIMARY KEY,
                    user_id TEXT NOT NULL,
                    created_at INTEGER NOT NULL,
                    expires_at INTEGER NOT NULL,
                    revoked INTEGER NOT NULL DEFAULT 0
                )",
                vec![],
            ),
            (
                "CREATE TABLE IF NOT EXISTS bot_tokens (
                    token_hash TEXT PRIMARY KEY,
                    bot_id TEXT NOT NULL,
                    created_at INTEGER NOT NULL
                )",
                vec![],
            ),
            (
                "CREATE TABLE IF NOT EXISTS verification_codes (
                    phone TEXT PRIMARY KEY,
                    code TEXT NOT NULL,
                    attempts INTEGER NOT NULL DEFAULT 0,
                    created_at INTEGER NOT NULL,
                    expires_at INTEGER NOT NULL
                )",
                vec![],
            ),
        ];
        self.exec_many(&stmts).await
    }

    // ============================= Пользователи =============================

    const USER_COLS: &'static str =
        "id, username, display_name, phone, password_hash, salt, avatar, public_key, is_bot, created_at";

    fn row_to_user(row: &Row) -> DbResult<UserRecord> {
        Ok(UserRecord {
            id: row.text("id")?,
            username: row.text("username")?,
            display_name: row.text("display_name")?,
            phone: row.text("phone")?,
            password_hash: row.text("password_hash")?,
            salt: row.text("salt")?,
            avatar: row.opt_text("avatar"),
            public_key: row.opt_text("public_key"),
            is_bot: row.boolean("is_bot").unwrap_or(false),
            created_at: row.i64("created_at")?,
        })
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn create_user_with_id(
        &self,
        id: &str,
        username: &str,
        display_name: &str,
        phone: &str,
        password_hash: &str,
        salt: &str,
        public_key: Option<&str>,
        is_bot: bool,
    ) -> DbResult<UserRecord> {
        let now = chrono::Utc::now().timestamp_millis();
        self.execute(
            "INSERT INTO users (id, username, display_name, phone, password_hash, salt, avatar, public_key, is_bot, created_at)
             VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)",
            &[
                P::Text(id.to_string()),
                P::Text(username.to_string()),
                P::Text(display_name.to_string()),
                P::Text(phone.to_string()),
                P::Text(password_hash.to_string()),
                P::Text(salt.to_string()),
                P::OptText(public_key.map(String::from)),
                P::Bool(is_bot),
                P::Int(now),
            ],
        )
        .await?;
        // Возвращаем то, что реально лежит в БД.
        let user = self
            .find_user_by_id(id)
            .await?
            .ok_or_else(|| DbError::Statement("user row missing after insert".into()))?;
        Ok(user)
    }

    pub async fn find_user_by_phone(&self, phone: &str) -> DbResult<Option<UserRecord>> {
        let sql = format!(
            "SELECT {} FROM users WHERE phone = ? LIMIT 1",
            Self::USER_COLS
        );
        let row = self.query_one(&sql, &[phone.into()]).await?;
        row.map(|r| Self::row_to_user(&r)).transpose()
    }

    pub async fn find_user_by_username(&self, username: &str) -> DbResult<Option<UserRecord>> {
        let sql = format!(
            "SELECT {} FROM users WHERE username = ? LIMIT 1",
            Self::USER_COLS
        );
        let row = self.query_one(&sql, &[username.into()]).await?;
        row.map(|r| Self::row_to_user(&r)).transpose()
    }

    pub async fn find_user_by_id(&self, id: &str) -> DbResult<Option<UserRecord>> {
        let sql = format!("SELECT {} FROM users WHERE id = ? LIMIT 1", Self::USER_COLS);
        let row = self.query_one(&sql, &[id.into()]).await?;
        row.map(|r| Self::row_to_user(&r)).transpose()
    }

    // ============================= OTP =============================

    /// Сохраняет (перезаписывает) код подтверждения для телефона.
    pub async fn save_otp(&self, phone: &str, code: &str, ttl_ms: i64) -> DbResult<()> {
        let now = chrono::Utc::now().timestamp_millis();
        let expires = now + ttl_ms;
        self.execute(
            "INSERT OR REPLACE INTO verification_codes (phone, code, attempts, created_at, expires_at)
             VALUES (?, ?, 0, ?, ?)",
            &[phone.into(), code.into(), P::Int(now), P::Int(expires)],
        )
        .await
    }

    /// Текущее состояние кода для телефона (для cooldown/анализа).
    pub async fn get_otp_state(&self, phone: &str) -> DbResult<Option<(i64, i64)>> {
        let row = self
            .query_one(
                "SELECT created_at, expires_at FROM verification_codes WHERE phone = ? LIMIT 1",
                &[phone.into()],
            )
            .await?;
        Ok(row.map(|r| {
            (
                r.i64("created_at").unwrap_or(0),
                r.i64("expires_at").unwrap_or(0),
            )
        }))
    }

    /// Проверка OTP: срок действия, лимит попыток (max_attempts), одноразовость.
    /// Возвращает true только при успешной проверке; при успехе код удаляется.
    pub async fn verify_otp(&self, phone: &str, code: &str, max_attempts: i64) -> DbResult<bool> {
        let now = chrono::Utc::now().timestamp_millis();
        let row = self
            .query_one(
                "SELECT code, attempts, expires_at FROM verification_codes WHERE phone = ? LIMIT 1",
                &[phone.into()],
            )
            .await?;
        let row = match row {
            Some(r) => r,
            None => return Ok(false),
        };
        let stored_code = row.text("code")?;
        let attempts = row.i64("attempts")?;
        let expires_at = row.i64("expires_at")?;
        if expires_at < now {
            // Истёкший код чистим.
            self.execute(
                "DELETE FROM verification_codes WHERE phone = ?",
                &[phone.into()],
            )
            .await?;
            return Ok(false);
        }
        if attempts >= max_attempts {
            return Ok(false);
        }
        if constant_time_eq(stored_code.as_bytes(), code.as_bytes()) {
            // Одноразовый код: удаляем сразу после успеха.
            self.execute(
                "DELETE FROM verification_codes WHERE phone = ?",
                &[phone.into()],
            )
            .await?;
            return Ok(true);
        }
        self.execute(
            "UPDATE verification_codes SET attempts = attempts + 1 WHERE phone = ?",
            &[phone.into()],
        )
        .await?;
        Ok(false)
    }

    /// Увеличивает счётчик неудачных попыток (используется auth-слоем при неверном коде).
    pub async fn otp_attempts(&self, phone: &str) -> DbResult<i64> {
        let row = self
            .query_one(
                "SELECT attempts FROM verification_codes WHERE phone = ? LIMIT 1",
                &[phone.into()],
            )
            .await?;
        Ok(row.map(|r| r.i64("attempts").unwrap_or(0)).unwrap_or(0))
    }

    // ============================= Сессии =============================

    pub async fn create_session(&self, session_id: &str, user_id: &str, ttl_ms: i64) -> DbResult<()> {
        let now = chrono::Utc::now().timestamp_millis();
        self.execute(
            "INSERT INTO sessions (id, user_id, created_at, expires_at, revoked) VALUES (?, ?, ?, ?, 0)",
            &[session_id.into(), user_id.into(), P::Int(now), P::Int(now + ttl_ms)],
        )
        .await
    }

    pub async fn session_valid(&self, session_id: &str) -> DbResult<bool> {
        let now = chrono::Utc::now().timestamp_millis();
        let row = self
            .query_one(
                "SELECT revoked, expires_at FROM sessions WHERE id = ? LIMIT 1",
                &[session_id.into()],
            )
            .await?;
        Ok(match row {
            Some(r) => {
                let revoked = r.i64("revoked").unwrap_or(1);
                let expires = r.i64("expires_at").unwrap_or(0);
                revoked == 0 && expires >= now
            }
            None => false,
        })
    }

    pub async fn revoke_session(&self, session_id: &str) -> DbResult<()> {
        self.execute(
            "UPDATE sessions SET revoked = 1 WHERE id = ?",
            &[session_id.into()],
        )
        .await
    }

    // ============================= Чаты =============================

    pub async fn create_chat(
        &self,
        chat_type: &str,
        name: &str,
        member_ids: &[String],
    ) -> DbResult<String> {
        let id = Uuid::new_v4().to_string();
        let now = chrono::Utc::now().timestamp_millis();
        let mut stmts: Vec<(&str, Vec<P>)> = vec![(
            "INSERT INTO chats (id, chat_type, name, created_at) VALUES (?, ?, ?, ?)",
            vec![id.clone().into(), chat_type.into(), name.into(), P::Int(now)],
        )];
        for m in member_ids {
            stmts.push((
                "INSERT INTO chat_members (chat_id, user_id, joined_at) VALUES (?, ?, ?)",
                vec![id.clone().into(), m.clone().into(), P::Int(now)],
            ));
        }
        self.exec_many(&stmts).await?;
        Ok(id)
    }

    pub async fn add_member(&self, chat_id: &str, user_id: &str) -> DbResult<()> {
        let now = chrono::Utc::now().timestamp_millis();
        self.execute(
            "INSERT OR IGNORE INTO chat_members (chat_id, user_id, joined_at) VALUES (?, ?, ?)",
            &[chat_id.into(), user_id.into(), P::Int(now)],
        )
        .await
    }

    pub async fn is_chat_member(&self, chat_id: &str, user_id: &str) -> DbResult<bool> {
        let row = self
            .query_one(
                "SELECT 1 AS ok FROM chat_members WHERE chat_id = ? AND user_id = ? LIMIT 1",
                &[chat_id.into(), user_id.into()],
            )
            .await?;
        Ok(row.is_some())
    }

    pub async fn find_private_chat(&self, user_a: &str, user_b: &str) -> DbResult<Option<String>> {
        // Личный чат = чат типа private, в котором состоят ровно оба участника.
        let rows = self
            .query(
                "SELECT cm.chat_id AS chat_id, COUNT(*) AS cnt
                 FROM chat_members cm
                 JOIN chats c ON c.id = cm.chat_id
                 WHERE c.chat_type = 'private' AND (cm.user_id = ? OR cm.user_id = ?)
                 GROUP BY cm.chat_id",
                &[user_a.into(), user_b.into()],
            )
            .await?;
        for r in rows {
            let chat_id = r.text("chat_id")?;
            let cnt = r.i64("cnt")?;
            if cnt == 2 {
                return Ok(Some(chat_id));
            }
        }
        Ok(None)
    }

    pub async fn get_chat_members(&self, chat_id: &str) -> DbResult<Vec<String>> {
        let rows = self
            .query(
                "SELECT user_id FROM chat_members WHERE chat_id = ? ORDER BY joined_at ASC",
                &[chat_id.into()],
            )
            .await?;
        rows.iter().map(|r| r.text("user_id")).collect()
    }

    /// Полная метаданные чата: (chat_type, name, created_at).
    pub async fn get_chat_meta(&self, chat_id: &str) -> DbResult<Option<(String, String, i64)>> {
        let row = self
            .query_one(
                "SELECT chat_type, name, created_at FROM chats WHERE id = ? LIMIT 1",
                &[chat_id.into()],
            )
            .await?;
        Ok(match row {
            Some(r) => Some((
                r.text("chat_type")?,
                r.text("name")?,
                r.i64("created_at")?,
            )),
            None => None,
        })
    }

    /// Список чатов пользователя (с типом, названием, временем создания).
    pub async fn get_user_chats(&self, user_id: &str) -> DbResult<Vec<(String, String, String, i64)>> {
        let rows = self
            .query(
                "SELECT c.id AS id, c.chat_type AS chat_type, c.name AS name, c.created_at AS created_at
                 FROM chats c JOIN chat_members cm ON cm.chat_id = c.id
                 WHERE cm.user_id = ?
                 ORDER BY c.created_at DESC",
                &[user_id.into()],
            )
            .await?;
        rows.iter()
            .map(|r| {
                Ok((
                    r.text("id")?,
                    r.text("chat_type")?,
                    r.text("name")?,
                    r.i64("created_at")?,
                ))
            })
            .collect()
    }

    /// Список id чатов пользователя (для presence-рассылок).
    pub async fn get_user_chat_ids(&self, user_id: &str) -> DbResult<Vec<String>> {
        let rows = self
            .query(
                "SELECT cm.chat_id AS chat_id FROM chat_members cm WHERE cm.user_id = ?",
                &[user_id.into()],
            )
            .await?;
        rows.iter().map(|r| r.text("chat_id")).collect()
    }

    /// Поиск пользователей по username/display_name (LIKE без регистрозависимости SQLite-ascii).
    pub async fn search_users(&self, term: &str) -> DbResult<Vec<UserRecord>> {
        let like = format!("%{}%", term.to_lowercase());
        let sql = format!(
            "SELECT {} FROM users
             WHERE is_bot = 0 AND (LOWER(username) LIKE ? OR LOWER(display_name) LIKE ?)
             ORDER BY username ASC LIMIT 20",
            Self::USER_COLS
        );
        let rows = self.query(&sql, &[like.clone().into(), like.into()]).await?;
        rows.iter().map(Self::row_to_user).collect()
    }

    // ============================= Сообщения =============================

    pub async fn save_message(
        &self,
        chat_id: &str,
        sender_id: &str,
        content: &str,
        iv: &str,
        header: &str,
        msg_type: &str,
    ) -> DbResult<ChatMessage> {
        let id = Uuid::new_v4().to_string();
        let now = chrono::Utc::now().timestamp_millis();
        self.execute(
            "INSERT INTO messages (id, chat_id, sender_id, content, iv, header, msg_type, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            &[
                id.clone().into(),
                chat_id.into(),
                sender_id.into(),
                content.into(),
                iv.into(),
                header.into(),
                msg_type.into(),
                P::Int(now),
            ],
        )
        .await?;
        Ok(ChatMessage {
            id,
            chat_id: chat_id.to_string(),
            sender_id: sender_id.to_string(),
            content: content.to_string(),
            iv: iv.to_string(),
            header: header.to_string(),
            msg_type: msg_type.to_string(),
            created_at: now,
        })
    }

    fn row_to_msg(r: &Row) -> DbResult<ChatMessage> {
        Ok(ChatMessage {
            id: r.text("id")?,
            chat_id: r.text("chat_id")?,
            sender_id: r.text("sender_id")?,
            content: r.text("content")?,
            iv: r.text("iv")?,
            header: r.text("header")?,
            msg_type: r.text("msg_type")?,
            created_at: r.i64("created_at")?,
        })
    }

    /// История сообщений чата с пагинацией «до before_id».
    /// Возвращает сообщения в хронологическом порядке (ASC).
    pub async fn get_chat_messages(
        &self,
        chat_id: &str,
        before_id: Option<&str>,
        limit: i64,
    ) -> DbResult<Vec<ChatMessage>> {
        let limit = limit.clamp(1, 100);
        let rows = if let Some(before_id) = before_id {
            // Полная история детерминирована по (created_at, id): берём окно перед указанным сообщением.
            self.query(
                "SELECT m.id AS id, m.chat_id AS chat_id, m.sender_id AS sender_id, m.content AS content,
                        m.iv AS iv, m.header AS header, m.msg_type AS msg_type, m.created_at AS created_at
                 FROM messages m
                 WHERE m.chat_id = ?
                   AND m.created_at < (SELECT created_at FROM messages WHERE id = ? AND chat_id = ?)
                 ORDER BY m.created_at DESC, m.id DESC
                 LIMIT ?",
                &[chat_id.into(), before_id.into(), chat_id.into(), P::Int(limit)],
            )
            .await?
        } else {
            self.query(
                "SELECT m.id AS id, m.chat_id AS chat_id, m.sender_id AS sender_id, m.content AS content,
                        m.iv AS iv, m.header AS header, m.msg_type AS msg_type, m.created_at AS created_at
                 FROM messages m
                 WHERE m.chat_id = ?
                 ORDER BY m.created_at DESC, m.id DESC
                 LIMIT ?",
                &[chat_id.into(), P::Int(limit)],
            )
            .await?
        };
        let mut msgs: Vec<ChatMessage> = rows.iter().map(Self::row_to_msg).collect::<DbResult<_>>()?;
        msgs.reverse();
        Ok(msgs)
    }

    pub async fn last_message_in_chat(&self, chat_id: &str) -> DbResult<Option<ChatMessage>> {
        let rows = self
            .query(
                "SELECT id, chat_id, sender_id, content, iv, header, msg_type, created_at
                 FROM messages WHERE chat_id = ? ORDER BY created_at DESC, id DESC LIMIT 1",
                &[chat_id.into()],
            )
            .await?;
        rows.first().map(Self::row_to_msg).transpose()
    }

    // ============================= Боты =============================

    /// Создаёт бота: запись в users (is_bot=1) + хэш токена в bot_tokens.
    pub async fn create_bot(
        &self,
        username: &str,
        display_name: &str,
        token_hash: &str,
    ) -> DbResult<UserRecord> {
        // У ботов нет входа по паролю: храним недостижимый случайный хэш.
        let fake_salt = Uuid::new_v4().to_string();
        let fake_hash = Uuid::new_v4().to_string();
        // Телефон бота — синтетический уникальный номер.
        let bot_phone = format!("bot-{}", Uuid::new_v4());
        let bot_id = Uuid::new_v4().to_string();
        let now = chrono::Utc::now().timestamp_millis();
        self.create_user_with_id(
            &bot_id,
            username,
            display_name,
            &bot_phone,
            &fake_hash,
            &fake_salt,
            None,
            true,
        )
        .await?;
        self.execute(
            "INSERT INTO bot_tokens (token_hash, bot_id, created_at) VALUES (?, ?, ?)",
            &[token_hash.into(), bot_id.clone().into(), P::Int(now)],
        )
        .await?;
        self.find_user_by_id(&bot_id)
            .await?
            .ok_or_else(|| DbError::Statement("bot row missing after insert".into()))
    }

    pub async fn find_bot_by_token_hash(&self, token_hash: &str) -> DbResult<Option<UserRecord>> {
        let row = self
            .query_one(
                "SELECT bt.bot_id AS bot_id FROM bot_tokens bt WHERE bt.token_hash = ? LIMIT 1",
                &[token_hash.into()],
            )
            .await?;
        let bot_id = match row {
            Some(r) => r.text("bot_id")?,
            None => return Ok(None),
        };
        self.find_user_by_id(&bot_id).await
    }
}

/// Сравнение за константное время (для OTP и хэшей).
pub fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}
