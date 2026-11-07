//! HTTP-контроллеры (слой C в MVC).

pub mod auth;
pub mod chats;
pub mod messages;

use crate::utils::error::{AppError, AppResult};
use axum::extract::rejection::JsonRejection;
use axum::Json;

/// Разворачивает результат извлечения JSON-тела в понятную JSON-ошибку.
///
/// Штатный axum на битый JSON отвечает обычным текстом; нам нужен единый
/// формат `{"error": "..."}` для всех ответов API.
pub fn json_body<T>(payload: Result<Json<T>, JsonRejection>) -> AppResult<T> {
    payload.map(|Json(value)| value).map_err(|rejection| {
        AppError::BadRequest(format!(
            "Некорректное тело запроса: {}",
            rejection.body_text()
        ))
    })
}
