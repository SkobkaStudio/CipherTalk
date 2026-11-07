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
        self.exec_inner(sql, json!([])).await.map(|_| ())
    }

    /// Выполнение SQL с позиционными параметрами (защита от инъекций).
    pub async fn exec_params(&self, sql: &str, params: &[Value]) -> AppResult<()> {
        self.exec_inner(sql, json!(params)).await.map(|_| ())
    }

    /// То же, что exec_params, но возвращает число изменённых строк.
    /// Нужно для `INSERT ... ON CONFLICT DO NOTHING`: 0 значит «конфликт, ничего не вставили».
    pub async fn exec_params_affected(&self, sql: &str, params: &[Value]) -> AppResult<u64> {
        let v = self.exec_inner(sql, json!(params)).await?;
        Ok(v.get("results")
            .and_then(|r| r.as_array())
            .and_then(|r| r.first())
            .and_then(|r| r.get("rows_affected"))
            .and_then(|n| n.as_u64())
            .unwrap_or(0))
    }

    /// Внутренний POST {RQLITE_URL}/db/execute с телом [[sql, p1, p2, ...]].
    /// rqlite ожидает плоский массив: параметры идут сразу после SQL-строки,
    /// поэтому params "разворачивается" в сам стейтмент (вложенный массив он не принимает).
    async fn exec_inner(&self, sql: &str, params: Value) -> AppResult<Value> {
        let mut stmt = vec![json!(sql)];
        if let Value::Array(ps) = params {
            stmt.extend(ps);
        }
        let body = json!([stmt]);
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
        Ok(v)
    }

    /// Чтение: POST {RQLITE_URL}/db/query, ответ — сырой JSON rqlite.
    /// Параметры, как и в execute, передаются плоским списком сразу после SQL.
    pub async fn query(&self, sql: &str, params: &[Value]) -> AppResult<Value> {
        let mut stmt = vec![json!(sql)];
        stmt.extend(params.iter().cloned());
        let body = json!([stmt]);
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

    /// Миграции: проверка старой схемы и создание таблиц (идемпотентно).
    pub async fn migrate(&self) -> AppResult<()> {
        self.ensure_schema_v2().await?;
        // Идемпотентное создание всех таблиц актуальной схемы v2
        self.exec(
            "CREATE TABLE IF NOT EXISTS users (\
                id INTEGER PRIMARY KEY AUTOINCREMENT, \
                server_id TEXT UNIQUE NOT NULL, \
                phone TEXT UNIQUE NOT NULL, \
                username TEXT UNIQUE, \
                first_name TEXT, \
                last_name TEXT, \
                password_hash TEXT, \
                created_at INTEGER NOT NULL, \
                avatar_color TEXT NOT NULL DEFAULT '#89b4fa')",
        )
        .await?;
        self.exec(
            "CREATE TABLE IF NOT EXISTS phone_codes (\
                phone TEXT PRIMARY KEY, \
                code TEXT NOT NULL, \
                expires_at INTEGER NOT NULL, \
                attempts INTEGER NOT NULL DEFAULT 0, \
                sent_at INTEGER NOT NULL DEFAULT 0)",
        )
        .await?;
        self.exec(
            "CREATE TABLE IF NOT EXISTS chats (\
                id INTEGER PRIMARY KEY AUTOINCREMENT, \
                server_id TEXT UNIQUE NOT NULL, \
                kind TEXT NOT NULL, \
                title TEXT, \
                owner_id INTEGER, \
                created_at INTEGER NOT NULL, \
                dm_key TEXT)",
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
                id INTEGER PRIMARY KEY AUTOINCREMENT, \
                chat_id INTEGER NOT NULL, \
                user_id INTEGER NOT NULL, \
                body TEXT NOT NULL, \
                created_at INTEGER NOT NULL)",
        )
        .await?;
        // Колонки, появившиеся позже: досоздаём на уже существующих таблицах.
        // sent_at — время выдачи кода (нужно для кулдауна перевыдачи), dm_key — ключ
        // уникальности диалога («меньший id:больший id»), чтобы не было двух dm на пару.
        self.ensure_column("phone_codes", "sent_at", "INTEGER NOT NULL DEFAULT 0").await?;
        self.ensure_column("chats", "dm_key", "TEXT").await?;
        // Диалоги, созданные до появления колонки, получают ключ здесь.
        // Идемпотентно и дешево: трогаем только строки с dm_key IS NULL.
        self.backfill_dm_keys().await?;
        // Уникальность пары: два dm на одних и тех же двоих — это баг.
        // Индекс создаём после бэкфилла, а на «грязной» базе с уже существующими
        // дублями не падаем, а предупреждаем.
        if let Err(e) = self
            .exec(
                "CREATE UNIQUE INDEX IF NOT EXISTS idx_chats_dm_key ON chats(dm_key) \
                 WHERE dm_key IS NOT NULL",
            )
            .await
        {
            tracing::warn!(
                "Не удалось создать уникальный индекс dm_key ({e}). \
                 В таблице chats есть дубли диалогов — почистите их вручную"
            );
        }
        // Индексы для частых выборок
        self.exec("CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages(chat_id, id)").await?;
        self.exec("CREATE INDEX IF NOT EXISTS idx_members_user ON chat_members(user_id)").await?;
        Ok(())
    }

    /// Проверяет схему users и, если это старая v1, сбрасывает таблицы —
    /// но ТОЛЬКО при явном разрешении через ALLOW_DESTRUCTIVE_MIGRATION=1.
    /// Иначе отказываемся стартовать: молча терять данные недопустимо.
    async fn ensure_schema_v2(&self) -> AppResult<()> {
        let cols = self.query_rows("PRAGMA table_info(users)", &[]).await?;
        if cols.is_empty() {
            return Ok(()); // таблицы ещё нет — обычное создание ниже
        }
        let has_server_id =
            cols.iter().any(|r| r.get("name").and_then(|v| v.as_str()) == Some("server_id"));
        if has_server_id {
            return Ok(());
        }
        let allow = std::env::var("ALLOW_DESTRUCTIVE_MIGRATION")
            .map(|v| v == "1" || v.eq_ignore_ascii_case("true"))
            .unwrap_or(false);
        if !allow {
            return Err(AppError::Internal(
                "Найдена схема авторизации v1 (username-логин). Перевод на v2 требует \
                 удаления таблиц users/chats/messages/chat_members/phone_codes, поэтому \
                 выполняется только вручную: запустите сервер с ALLOW_DESTRUCTIVE_MIGRATION=1 \
                 (или укажите пустую БД в RQLITE_URL)."
                    .into(),
            ));
        }
        tracing::warn!(
            "ALLOW_DESTRUCTIVE_MIGRATION=1: схема v1 будет удалена и создана заново (данные потеряны)"
        );
        self.migrate_auth_v2().await
    }

    /// Добавляет колонку, если её нет. Возвращает true, если колонка была добавлена.
    async fn ensure_column(&self, table: &str, column: &str, ddl: &str) -> AppResult<bool> {
        let cols = self.query_rows(&format!("PRAGMA table_info({table})"), &[]).await?;
        if cols.iter().any(|r| r.get("name").and_then(|v| v.as_str()) == Some(column)) {
            return Ok(false);
        }
        // Имена таблицы/колонки — литералы из кода, не пользовательский ввод
        self.exec(&format!("ALTER TABLE {table} ADD COLUMN {column} {ddl}")).await?;
        Ok(true)
    }

    /// Бэкфилл dm_key для уже существующих диалогов. Дубликаты (если успели
    /// появиться до появления индекса) остаются с NULL — их не трогаем.
    async fn backfill_dm_keys(&self) -> AppResult<()> {
        let chats = self
            .query_rows("SELECT id FROM chats WHERE kind = 'dm' AND dm_key IS NULL ORDER BY id", &[])
            .await?;
        let mut seen: std::collections::HashMap<String, i64> = std::collections::HashMap::new();
        for chat in chats {
            let Some(chat_id) = chat.get("id").and_then(|v| v.as_i64()) else { continue };
            let members = self
                .query_rows(
                    "SELECT user_id FROM chat_members WHERE chat_id = ? ORDER BY user_id",
                    &[json!(chat_id)],
                )
                .await?;
            let ids: Vec<i64> = members
                .iter()
                .filter_map(|m| m.get("user_id").and_then(|v| v.as_i64()))
                .collect();
            if ids.len() != 2 {
                continue;
            }
            let key = crate::services::chat_service::dm_key(ids[0], ids[1]);
            if seen.contains_key(&key) {
                tracing::warn!("Дубликат диалога chat_id={chat_id} (ключ {key}) — оставляю без dm_key");
                continue;
            }
            if let Err(e) = self
                .exec_params(
                    "UPDATE chats SET dm_key = ? WHERE id = ?",
                    &[json!(&key), json!(chat_id)],
                )
                .await
            {
                tracing::warn!("Не удалось проставить dm_key для chat_id={chat_id}: {e}");
                continue;
            }
            seen.insert(key, chat_id);
        }
        Ok(())
    }

    /// Миграция схемы авторизации v2 (телефоны, server_id, типы чатов).
    /// Честно: это учебный проект, сброс данных допустим — старую схему v1
    /// (username-логин, name-чаты) мигрировать содержательно невозможно,
    /// поэтому таблицы DROP'аются в порядке зависимостей и создаются заново
    /// обычным migrate() ниже.
    pub async fn migrate_auth_v2(&self) -> AppResult<()> {
        for t in ["messages", "chat_members", "chats", "phone_codes", "users"] {
            // Имя таблицы — литерал из кода, не пользовательский ввод: SQL-инъекции нет
            self.exec(&format!("DROP TABLE IF EXISTS {t}")).await?;
        }
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extract_rows_maps_columns_to_objects() {
        let v = json!({
            "results": [{
                "columns": ["id", "username"],
                "values": [[1, "alice"], [2, null]]
            }]
        });
        let rows = extract_rows(&v);
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0]["username"], "alice");
        assert!(rows[1]["username"].is_null());
    }

    #[test]
    fn extract_rows_handles_empty_and_error_results() {
        assert!(extract_rows(&json!({"results": []})).is_empty());
        assert!(extract_rows(&json!({"results": [{"error": "boom"}]})).is_empty());
        assert!(extract_rows(&json!({})).is_empty());
    }

    #[test]
    fn execute_error_is_detected() {
        let v = json!({"results": [{"error": "UNIQUE constraint failed"}]});
        assert!(check_execute_response(&v).is_err());
        assert!(check_execute_response(&json!({"results": [{"rows_affected": 1}]})).is_ok());
    }
}
