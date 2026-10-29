//! JWT-мидлварь для защищённых /api/* маршрутов.

use axum::extract::{Request, State};
use axum::http::{header, request::Parts, StatusCode};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use std::sync::Arc;

use crate::utils::jwt::{self, Claims};
use crate::ws::AppState;

/// Извлекает Bearer-токен из заголовка Authorization.
fn bearer_token(parts: &Parts) -> Option<String> {
    parts
        .headers
        .get(header::AUTHORIZATION)?
        .to_str()
        .ok()?
        .strip_prefix("Bearer ")
        .map(|s| s.trim().to_string())
}

/// Мидлварь: проверяет JWT и инжектирует Claims в extensions запроса.
pub async fn require_auth(
    State(state): State<Arc<AppState>>,
    req: Request,
    next: Next,
) -> Response {
    let (mut parts, body) = req.into_parts();
    match bearer_token(&parts).and_then(|t| jwt::verify_token(&state.jwt_secret, &t).ok()) {
        Some(claims) => {
            parts.extensions.insert(claims);
            next.run(Request::from_parts(parts, body)).await
        }
        None => (
            StatusCode::UNAUTHORIZED,
            axum::Json(serde_json::json!({"error": "Требуется авторизация"})),
        )
            .into_response(),
    }
}

/// Обёртка над Claims для хендлеров.
#[derive(Clone)]
pub struct Authed(pub Claims);

impl Authed {
    /// Достаёт claims, которые мидлварь `require_auth` положила в extensions запроса.
    pub fn from_request(req: &Request) -> Result<Self, crate::utils::error::AppError> {
        req.extensions()
            .get::<Claims>()
            .cloned()
            .map(Authed)
            .ok_or_else(|| crate::utils::error::AppError::Unauthorized("Требуется авторизация".into()))
    }
}
