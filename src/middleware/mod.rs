//! JWT-мидлварь для защищённых /api/* маршрутов.

use axum::extract::{Request, State};
#[allow(unused_imports)] // Parts используется в bearer_token
use axum::http::{header, request::Parts, StatusCode};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use std::sync::Arc;

use crate::utils::jwt::{self}; // Claims кладётся в extensions через require_auth
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

// Контроллеры получают claims через штатный экстрактор axum `Extension<Claims>` —
// собственного FromRequestParts-экстрактора здесь нет намеренно.
