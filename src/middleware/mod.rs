//! Мидлвари: JWT-проверка для защищённых /api/*, rate-limit для auth
//! и базовые security-заголовки для всех ответов.

pub mod rate_limit;

use axum::extract::{Request, State};
#[allow(unused_imports)] // Parts используется в bearer_token
use axum::http::{header, request::Parts, HeaderValue, StatusCode};
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

/// Заголовки безопасности на каждый ответ.
///
/// CSP разрешает только свои скрипты/стили и WebSocket на тот же хост:
/// фронтенд — ванильный, внешних CDN и inline-скриптов нет, так что
/// ломаться нечему. `frame-ancestors`/`X-Frame-Options` закрывают кликджекинг.
pub async fn security_headers(req: Request, next: Next) -> Response {
    let mut res = next.run(req).await;
    let headers = res.headers_mut();
    headers.insert(header::X_CONTENT_TYPE_OPTIONS, HeaderValue::from_static("nosniff"));
    headers.insert(header::X_FRAME_OPTIONS, HeaderValue::from_static("DENY"));
    headers.insert(header::REFERRER_POLICY, HeaderValue::from_static("no-referrer"));
    headers.insert(
        header::CONTENT_SECURITY_POLICY,
        HeaderValue::from_static(
            "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; \
             img-src 'self' data:; connect-src 'self' ws: wss:; object-src 'none'; \
             base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
        ),
    );
    res
}
