//! Клиент rqlite и миграции схемы.
//!
//! rqlite — это SQLite, доступный по HTTP. Мы не открываем локальный файл БД,
//! а отправляем SQL на `POST /db/execute` и `POST /db/query`.
//!
//! ВАЖНО: rqlite ожидает ПЛОСКИЙ массив параметров:
//! ```json
//! [["INSERT INTO users(name) VALUES(?)", "alice"]]
//! ```
//! Вложенный массив (`[["INSERT ...", ["alice"]]]`) приводит к ошибке
//! декодирования. Поэтому `params` всегда «разворачиваются» в тот же массив,
//! что и SQL-строка. Все пользовательские значения передаются только через
//! позиционные параметры `?` — конкатенации SQL нет.

use crate::utils::error::{AppError, AppResult};
use reqwest::Client;
use serde::Deserialize;
use serde_json::Value;
use std::collections::HashMap;
use std::time::Duration;

/// Таймаут HTTP-запроса к rqlite.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(15);

/// DDL-миграции. Все запросы идемпотентны, поэтому выполняются при каждом старте.
const SCHEMA: &[&str] = &[
    "CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        created_at INTEGER NOT NULL
    )",
    "CREATE TABLE IF NOT EXISTS chats (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        owner_id INTEGER NOT NULL,
        created_at INTEGER NOT NULL
    )",
    "CREATE TABLE IF NOT EXISTS chat_members (
        chat_id INTEGER,
        user_id INTEGER,
        PRIMARY KEY(chat_id, user_id)
    )",
    "CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_id INTEGER NOT NULL,
        user_id INTEGER NOT NULL,
        body TEXT NOT NULL,
        created_at INTEGER NOT NULL
    )",
    // Индексы не обязательны по схеме, но заметно ускоряют историю и список чатов.
    "CREATE INDEX IF NOT EXISTS idx_messages_chat_id ON messages(chat_id, id)",
    "CREATE INDEX IF NOT EXISTS idx_chat_members_user ON chat_members(user_id)",
];

/// Клиент rqlite. Дёшево клонируется и разделяется между хендлерами.
#[derive(Clone)]
pub struct Db {
    client: Client,
    base_url: String,
}

/// Одна строка результата: колонка -> значение.
#[derive(Debug, Clone)]
pub struct Row {
    values: HashMap<String, Value>,
}

impl Row {
    /// Целое значение по имени колонки.
    pub fn i64(&self, column: &str) -> Option<i64> {
        self.values.get(column).and_then(Value::as_i64)
    }

    /// Строковое значение по имени колонки.
    pub fn str(&self, column: &str) -> Option<&str> {
        self.values.get(column).and_then(Value::as_str)
    }

    /// Строковое значение, которым удобно владеть (например, для моделей).
    pub fn string(&self, column: &str) -> Option<String> {
        self.str(column).map(ToString::to_string)
    }
}

/// Ответ rqlite. Поля сделаны необязательными, потому что набор ключей
/// зависит от типа запроса и версии rqlite.
#[derive(Debug, Deserialize)]
struct RqliteResponse {
    #[serde(default)]
    results: Vec<RqliteResult>,
    #[serde(default)]
    error: Option<String>,
}

#[derive(Debug, Deserialize)]
struct RqliteResult {
    #[serde(default)]
    columns: Option<Vec<String>>,
    #[serde(default)]
    values: Option<Vec<Vec<Value>>>,
    #[serde(default)]
    error: Option<String>,
}

impl Db {
    /// Создаёт клиент для указанного адреса rqlite.
    pub fn new(base_url: impl Into<String>) -> Self {
        let client = Client::builder()
            .timeout(REQUEST_TIMEOUT)
            .user_agent(concat!("ciphertalk/", env!("CARGO_PKG_VERSION")))
            .build()
            .expect("не удалось создать HTTP-клиент reqwest");

        Self {
            client,
            base_url: base_url.into().trim_end_matches('/').to_string(),
        }
    }

    /// Ждёт, пока rqlite будет готов (`GET /readyz`).
    ///
    /// При недоступности возвращает понятную ошибку с подсказкой, как запустить
    /// rqlite. Несколько попыток нужны, чтобы пережить гонку со стартом узла.
    pub async fn ensure_ready(&self) -> AppResult<()> {
        let url = format!("{}/readyz", self.base_url);
        let mut last_error = String::new();

        for attempt in 1..=10 {
            match self.client.get(&url).send().await {
                Ok(response) if response.status().is_success() => return Ok(()),
                Ok(response) => {
                    last_error = format!("HTTP {}", response.status());
                }
                Err(error) => {
                    last_error = error.to_string();
                }
            }

            if attempt < 10 {
                tokio::time::sleep(Duration::from_millis(500)).await;
            }
        }

        Err(AppError::Database(format!(
            "rqlite недоступен по адресу {}: {}. Запусти rqlite: rqlited -node-id 1 ./data",
            self.base_url, last_error
        )))
    }

    /// Создаёт таблицы и индексы, если их ещё нет.
    pub async fn init_schema(&self) -> AppResult<()> {
        for statement in SCHEMA {
            self.execute(statement, &[]).await.map_err(|error| {
                AppError::Database(format!("не удалось применить миграцию: {error}"))
            })?;
        }
        tracing::info!("схема БД проверена/создана");
        Ok(())
    }

    /// Выполняет один SQL-запрос без возврата строк.
    pub async fn execute(&self, sql: &str, params: &[Value]) -> AppResult<()> {
        self.execute_batch(&[(sql, params)]).await
    }

    /// Выполняет пакет запросов одним HTTP-вызовом.
    ///
    /// rqlite выполняет несколько операторов из одного `/db/execute` в рамках
    /// одной транзакции — это удобно, например, для создания чата вместе
    /// с добавлением владельца в участники.
    pub async fn execute_batch(&self, statements: &[(&str, &[Value])]) -> AppResult<()> {
        if statements.is_empty() {
            return Ok(());
        }

        let payload = statements_to_json(statements);
        let response = self.post("/db/execute", &payload).await?;

        // Даже при успешном HTTP-статусе отдельный результат может содержать
        // ошибку SQL. `post` уже проверяет её, поэтому здесь достаточно
        // убедиться, что ответ не пустой и не содержит top-level error.
        if response.results.is_empty() && response.error.is_none() {
            return Err(AppError::Database(
                "rqlite вернул пустой ответ на /db/execute".into(),
            ));
        }
        Ok(())
    }

    /// Выполняет SELECT и возвращает строки в виде отображений «колонка -> значение».
    pub async fn query(&self, sql: &str, params: &[Value]) -> AppResult<Vec<Row>> {
        let payload = statements_to_json(&[(sql, params)]);
        let response = self.post("/db/query", &payload).await?;

        let first =
            response.results.into_iter().next().ok_or_else(|| {
                AppError::Database("rqlite вернул пустой ответ на /db/query".into())
            })?;

        let Some(columns) = first.columns else {
            return Ok(Vec::new());
        };
        let values = first.values.unwrap_or_default();

        let rows = values
            .into_iter()
            .map(|row_values| {
                let mut values = HashMap::with_capacity(columns.len());
                for (column, value) in columns.iter().cloned().zip(row_values) {
                    values.insert(column, value);
                }
                Row { values }
            })
            .collect();

        Ok(rows)
    }

    /// Возвращает первую строку SELECT или `None`.
    pub async fn query_one(&self, sql: &str, params: &[Value]) -> AppResult<Option<Row>> {
        Ok(self.query(sql, params).await?.into_iter().next())
    }

    /// Низкоуровневый POST к rqlite с разбором ошибок.
    async fn post(&self, endpoint: &str, payload: &Value) -> AppResult<RqliteResponse> {
        let url = format!("{}{}", self.base_url, endpoint);

        let response = self
            .client
            .post(&url)
            .json(payload)
            .send()
            .await
            .map_err(|error| {
                AppError::Database(format!(
                    "не удалось отправить запрос в rqlite ({}): {error}",
                    url
                ))
            })?;

        let status = response.status();
        let body = response.text().await.map_err(|error| {
            AppError::Database(format!("не удалось прочитать ответ rqlite: {error}"))
        })?;

        let parsed: RqliteResponse = serde_json::from_str(&body).map_err(|error| {
            AppError::Database(format!(
                "rqlite вернул некорректный JSON ({}): {error}; тело: {}",
                status,
                truncate(&body, 400)
            ))
        })?;

        // Ошибка может лежать на верхнем уровне или в конкретном результате.
        if let Some(error) = parsed.error.as_deref() {
            return Err(AppError::Database(error.to_string()));
        }
        if let Some(error) = parsed
            .results
            .iter()
            .find_map(|result| result.error.as_deref())
        {
            return Err(AppError::Database(error.to_string()));
        }
        if !status.is_success() {
            return Err(AppError::Database(format!(
                "rqlite ответил статусом {status}: {}",
                truncate(&body, 400)
            )));
        }

        Ok(parsed)
    }
}

/// Превращает пары «SQL + параметры» в плоский rqlite-массив:
/// `[["INSERT ...", "alice", 1], ["SELECT ..."]]`.
fn statements_to_json(statements: &[(&str, &[Value])]) -> Value {
    let queries: Vec<Value> = statements
        .iter()
        .map(|(sql, params)| {
            let mut query = Vec::with_capacity(params.len() + 1);
            query.push(Value::String((*sql).to_string()));
            query.extend(params.iter().cloned());
            Value::Array(query)
        })
        .collect();

    Value::Array(queries)
}

/// Обрезает длинный текст для сообщения об ошибке.
fn truncate(text: &str, max_chars: usize) -> String {
    if text.chars().count() <= max_chars {
        return text.to_string();
    }
    let short: String = text.chars().take(max_chars).collect();
    format!("{short}…")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parameters_are_flat_not_nested() {
        let params = vec![json!("alice"), json!(1)];
        let payload = statements_to_json(&[(
            "INSERT INTO users(username, created_at) VALUES(?, ?)",
            params.as_slice(),
        )]);

        // Именно плоский массив: [["SQL", "alice", 1]], а не [["SQL", ["alice", 1]]].
        assert_eq!(
            payload,
            json!([[
                "INSERT INTO users(username, created_at) VALUES(?, ?)",
                "alice",
                1
            ]])
        );
    }
}
