//! Единый тип ошибки приложения с конвертацией в HTTP-ответ {error:"..."}.

use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use serde_json::json;

/// Ошибки приложения: валидация, авторизация, не найдено, внутренний сбой.
#[derive(Debug)]
pub enum AppError {
    /// Некорректные данные от клиента (400)
    BadRequest(String),
    /// Нет доступа / неверный токен (401)
    Unauthorized(String),
    /// Не является участником чата и т.п. (403)
    Forbidden(String),
    /// Сущность не найдена (404)
    NotFound(String),
    /// Конфликт (например, имя занято) (409)
    Conflict(String),
    /// Внутренняя ошибка сервера (500)
    Internal(String),
}

pub type AppResult<T> = Result<T, AppError>;

impl AppError {
    /// HTTP-код для каждого варианта ошибки.
    fn status(&self) -> StatusCode {
        match self {
            AppError::BadRequest(_) => StatusCode::BAD_REQUEST,
            AppError::Unauthorized(_) => StatusCode::UNAUTHORIZED,
            AppError::Forbidden(_) => StatusCode::FORBIDDEN,
            AppError::NotFound(_) => StatusCode::NOT_FOUND,
            AppError::Conflict(_) => StatusCode::CONFLICT,
            AppError::Internal(_) => StatusCode::INTERNAL_SERVER_ERROR,
        }
    }
}

impl std::fmt::Display for AppError {
    /// Человекочитаемое сообщение ошибки (для логов).
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.message())
    }
}

// (blanket-конвертер удалён: конфликтовал с impl<T> From<T> for T)

/// Ответ клиенту: JSON {error:"текст"} с корректным статусом.
impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        let status = self.status();
        // Внутренние ошибки логируем полностью, но наружу отдаём общий текст
        let msg = match &self {
            AppError::Internal(text) => {
                tracing::error!("internal error: {text}");
                "Внутренняя ошибка сервера".to_string()
            }
            other => other.message().to_string(),
        };
        (status, axum::Json(json!({ "error": msg }))).into_response()
    }
}

impl AppError {
    fn message(&self) -> &str {
        match self {
            AppError::BadRequest(m)
            | AppError::Unauthorized(m)
            | AppError::Forbidden(m)
            | AppError::NotFound(m)
            | AppError::Conflict(m)
            | AppError::Internal(m) => m,
        }
    }
}
