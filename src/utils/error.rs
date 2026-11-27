use axum::{
    http::{header::RETRY_AFTER, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use serde_json::json;
use thiserror::Error;

pub type AppResult<T> = Result<T, AppError>;

/// The single error type crossing the service/controller boundary.
///
/// Internal details are logged server-side and never sent to the client.
#[derive(Debug, Error)]
pub enum AppError {
    #[error("Требуется авторизация")]
    Unauthorized,

    #[error("{0}")]
    Forbidden(String),

    #[error("{0}")]
    NotFound(String),

    #[error("{0}")]
    Conflict(String),

    #[error("{0}")]
    Validation(String),

    #[error("Слишком много запросов")]
    RateLimited { retry_after: u64 },

    #[error(transparent)]
    Internal(#[from] anyhow::Error),
}

impl AppError {
    pub fn code(&self) -> &'static str {
        match self {
            AppError::Unauthorized => "unauthorized",
            AppError::Forbidden(_) => "forbidden",
            AppError::NotFound(_) => "not_found",
            AppError::Conflict(_) => "conflict",
            AppError::Validation(_) => "validation_error",
            AppError::RateLimited { .. } => "rate_limited",
            AppError::Internal(_) => "internal_error",
        }
    }

    /// Message safe to expose over HTTP or WebSocket.
    pub fn public_message(&self) -> String {
        match self {
            AppError::Internal(err) => {
                tracing::error!(error = %err, "internal error");
                "Внутренняя ошибка сервера".to_owned()
            }
            other => other.to_string(),
        }
    }
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        let status = match &self {
            AppError::Unauthorized => StatusCode::UNAUTHORIZED,
            AppError::Forbidden(_) => StatusCode::FORBIDDEN,
            AppError::NotFound(_) => StatusCode::NOT_FOUND,
            AppError::Conflict(_) => StatusCode::CONFLICT,
            AppError::Validation(_) => StatusCode::BAD_REQUEST,
            AppError::RateLimited { .. } => StatusCode::TOO_MANY_REQUESTS,
            AppError::Internal(_) => StatusCode::INTERNAL_SERVER_ERROR,
        };

        let retry_after = match &self {
            AppError::RateLimited { retry_after } => Some(*retry_after),
            _ => None,
        };

        let body = json!({
            "error": {
                "code": self.code(),
                "message": self.public_message(),
            }
        });

        let mut response = (status, Json(body)).into_response();
        if let Some(retry_after) = retry_after {
            if let Ok(value) = HeaderValue::from_str(&retry_after.to_string()) {
                response.headers_mut().insert(RETRY_AFTER, value);
            }
        }
        response
    }
}

impl From<sqlx::Error> for AppError {
    fn from(err: sqlx::Error) -> Self {
        if let sqlx::Error::Database(db) = &err {
            match db.code().as_deref() {
                Some("23505") => return AppError::Conflict("Запись уже существует".to_owned()),
                Some("23503") => {
                    return AppError::Validation("Связанная запись не найдена".to_owned())
                }
                Some("23514") => {
                    return AppError::Validation("Данные не прошли проверку".to_owned())
                }
                _ => {}
            }
        }
        if matches!(&err, sqlx::Error::RowNotFound) {
            return AppError::NotFound("Запись не найдена".to_owned());
        }
        AppError::Internal(anyhow::Error::new(err))
    }
}

impl From<redis::RedisError> for AppError {
    fn from(err: redis::RedisError) -> Self {
        AppError::Internal(anyhow::Error::new(err))
    }
}

impl From<serde_json::Error> for AppError {
    fn from(err: serde_json::Error) -> Self {
        AppError::Internal(anyhow::Error::new(err))
    }
}
