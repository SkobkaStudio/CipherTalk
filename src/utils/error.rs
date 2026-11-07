//! Единый тип ошибки приложения и его преобразование в HTTP-ответ.
//!
//! Все ошибки отдаются клиенту в формате `{"error": "текст"}` с подходящим
//! HTTP-статусом. Внутренние подробности БД логируются, но не раскрываются
//! как стектрейс.

use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde_json::json;

/// Ошибка, которую можно вернуть из любого хендлера.
#[derive(Debug, Clone)]
pub enum AppError {
    /// 400 — некорректный запрос/валидация.
    BadRequest(String),
    /// 401 — нет или невалиден JWT.
    Unauthorized(String),
    /// 403 — доступ запрещён (например, не участник чата).
    Forbidden(String),
    /// 404 — сущность не найдена.
    NotFound(String),
    /// 409 — конфликт (занятое имя пользователя).
    Conflict(String),
    /// 500 — ошибка базы данных rqlite.
    Database(String),
    /// 500 — прочая внутренняя ошибка.
    Internal(String),
}

/// Удобный псевдоним для результатов хендлеров и сервисов.
pub type AppResult<T> = Result<T, AppError>;

impl AppError {
    /// HTTP-статус, соответствующий варианту ошибки.
    pub fn status(&self) -> StatusCode {
        match self {
            AppError::BadRequest(_) => StatusCode::BAD_REQUEST,
            AppError::Unauthorized(_) => StatusCode::UNAUTHORIZED,
            AppError::Forbidden(_) => StatusCode::FORBIDDEN,
            AppError::NotFound(_) => StatusCode::NOT_FOUND,
            AppError::Conflict(_) => StatusCode::CONFLICT,
            AppError::Database(_) | AppError::Internal(_) => StatusCode::INTERNAL_SERVER_ERROR,
        }
    }

    /// Текст для клиента.
    pub fn message(&self) -> &str {
        match self {
            AppError::BadRequest(message)
            | AppError::Unauthorized(message)
            | AppError::Forbidden(message)
            | AppError::NotFound(message)
            | AppError::Conflict(message)
            | AppError::Database(message)
            | AppError::Internal(message) => message,
        }
    }
}

impl std::fmt::Display for AppError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(self.message())
    }
}

impl std::error::Error for AppError {}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        let status = self.status();
        if status.is_server_error() {
            // Для серверных ошибок полезно видеть детали в логе.
            tracing::error!("внутренняя ошибка: {self}");
        }
        (status, Json(json!({ "error": self.message() }))).into_response()
    }
}
