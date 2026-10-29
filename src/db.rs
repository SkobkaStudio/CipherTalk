//! Клиент rqlite (распределённый SQLite поверх HTTP API) + миграции схемы.
//!
//! Все пользовательские значения передаются ТОЛЬКО позиционными параметрами
//! через массив параметров rqlite (`?` в SQL) — никакой конкатенации строк в SQL.

use crate::utils::error::{AppError, AppResult};
use serde_json::{json, Value};

/// Обёртка над reqwest для работы с rqlite.
#[derive(Clone)]
pub struct Db {
    client: reqwest::Client,
    base_url: String,
}

/// Ответ rqlite на /db/execute — проверяем наличие ошибок выполнения.
fn check_execute_response(v: &Value) -> AppResult<()> {
    // Формат: {"results":[{"execution_time":...,"rows_affected":...}, ...]}
    if let Some(results) = v.get("results").and_then(|r| r.as_array()) {
        for r in results {
            if let Some(err) = r.get("error").and_then(|e| e.as_str()) {
                return Err(AppError::Internal(format!("rqlite execute error: {err}")));
            }
        }
    }
    Ok(())
}

impl Db {
    /// Создаёт клиент по базовому URL rqlite.
    pub fn new(base_url: String) -> Self {
        Self {
            client: reqwest::Client::new(),
            base_url,
        }
    }

    /// Проверка доступности rqlite при старте: GET /readyz.
    /// При недоступности — понятная ошибка с подсказкой по запуску.
    pub async fn check_connection(&self) -> AppResult<()> {
        let url = format!("{}/readyz?strict", self.base_url);
        match self.client.get(&url).send().await {
            Ok(resp) if resp.status().is_success() => Ok(()),
            Ok(resp) => Err(AppError::Internal(format!(
                "rqlite ответил ошибкой {}: {}. \
                 Запустите rqlite: `rqlited -node-id 1 ./data` \
                 или docker: `docker run -p 4001:4001 rqlite/rqlite`",
                resp.status(), self.base_url
            ))),
            Err(e) => Err(AppError::Internal(format!(
                "Не удалось подключиться к rqlite по адресу {}: {}. \
                 Запустите rqlite: `rqlited -node-id 1 ./data` \
                 или docker: `docker run -p 4001:4001 rqlite/rqlite`",
                self.base_url, e
            ))),
        }
    }

    /// Выполнение SQL без параметров.
    pub async fn exec(&self, sql: &str) -> AppResult<()> {
        self.exec_inner(sql, json!([])).await
    }

    /// Выполнение SQL с позиционными параметрами (защита от инъекций).
    pub async fn exec_params(&self, sql: &str, params: &[Value]) -> AppResult<()> {
        self.exec_inner(sql, json!(params)).await
    }

    /// Внутренний POST {RQLITE_URL}/db/execute с телом [[sql, p1, p2, ...]].
    async fn exec_inner(&self, sql: &str, params: Value) -> AppResult<()> {
        let body = json!([[sql, params]]);
        let url = format!("{}/db/execute?timings", self.base_url);
        let resp = self
            .client
            .post(&url)
            .json(&body)
            .send()
            .await
            .map_err(|e| AppError::Internal(format!("rqlite request failed: {e}")))?;
        let status = resp.status();
        let v: Value = resp
            .json()
            .await
            .map_err(|e| AppError::Internal(format!("rqlite bad response: {e}")))?;
        if !status.is_success() {
            return Err(AppError::Internal(format!("rqlite http {status}: {v}")));
        }
        check_execute_response(&v)?;
        Ok(())
    }

    /// Чтение: POST {RQLITE_URL}/db/query, ответ — сырой JSON rqlite.
    pub async fn query(&self, sql: &str, params: &[Value]) -> AppResult<Value> {
        let body = json!([[sql, params]]);
        let url = format!("{}/db/query?timings", self.base_url);
        let resp = self
            .client
            .post(&url)
            .json(&body)
            .send()
            .await
            .map_err(|e| AppError::Internal(format!("rqlite request failed: {e}")))?;
        let status = resp.status();
        let v: Value = resp
            .json()
            .await
            .map_err(|e| AppError::Internal(format!("rqlite bad response: {e}")))?;
        if !status.is_success() {
            return Err(AppError::Internal(format!("rqlite http {status}: {v}")));
        }
        if let Some(results) = v.get("results").and_then(|r| r.as_array()) {
            for r in results {
                if let Some(err) = r.get("error").and_then(|e| e.as_str()) {
                    return Err(AppError::Internal(format!("rqlite query error: {err}")));
                }
            }
        }
        Ok(v)
    }

    /// Удобный помощник: достать первую строку результатов запроса как список объектов.
    pub async fn query_rows(&self, sql: &str, params: &[Value]) -> AppResult<Vec<Value>> {
        let v = self.query(sql, params).await?;
        Ok(extract_rows(&v))
    }

    /// Миграции: создание таблиц (идемпотентно, CREATE TABLE IF NOT EXISTS).
    pub async fn migrate(&self) -> AppResult<()> {
        self.exec(
            "CREATE TABLE IF NOT EXISTS users (\
                id INTEGER PRIMARY KEY, \
                username TEXT UNIQUE NOT NULL, \
                password_hash TEXT NOT NULL, \
                created_at INTEGER NOT NULL)",
        )
        .await?;
        self.exec(
            "CREATE TABLE IF NOT EXISTS chats (\
                id INTEGER PRIMARY KEY, \
                name TEXT NOT NULL, \
                owner_id INTEGER NOT NULL, \
                created_at INTEGER NOT NULL)",
        )
        .await?;
        self.exec(
            "CREATE TABLE IF NOT EXISTS chat_members (\
                chat_id INTEGER, \
                user_id INTEGER, \
                PRIMARY KEY(chat_id,user_id))",
        )
        .await?;
        self.exec(
            "CREATE TABLE IF NOT EXISTS messages (\
                id INTEGER PRIMARY KEY, \
                chat_id INTEGER NOT NULL, \
                user_id INTEGER NOT NULL, \
                body TEXT NOT NULL, \
                created_at INTEGER NOT NULL)",
        )
        .await?;
        // Индексы для частых выборок
        self.exec("CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages(chat_id, id)").await?;
        self.exec("CREATE INDEX IF NOT EXISTS idx_members_user ON chat_members(user_id)").await?;
        Ok(())
    }
}

/// Разбор ответа rqlite /db/query: приводит objects-формат к списку json-объектов.
/// Ожидаемая структура: {"results":[{"columns":[..],"values":[[..],[..]],"types":[..]}]}
pub fn extract_rows(v: &Value) -> Vec<Value> {
    let mut out = Vec::new();
    let Some(results) = v.get("results").and_then(|r| r.as_array()) else {
        return out;
    };
    for res in results {
        let Some(cols) = res.get("columns").and_then(|c| c.as_array()) else { continue };
        let empty = Vec::new();
        let rows = res.get("values").and_then(|r| r.as_array()).unwrap_or(&empty);
        for row in rows {
            let mut obj = serde_json::Map::new();
            if let Some(arr) = row.as_array() {
                for (i, col) in cols.iter().enumerate() {
                    let name = col.as_str().unwrap_or_default().to_string();
                    obj.insert(name, arr.get(i).cloned().unwrap_or(Value::Null));
                }
            }
            out.push(Value::Object(obj));
        }
    }
    out
}
