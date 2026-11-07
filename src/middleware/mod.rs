//! JWT-мидлварь для защищённых маршрутов.
//!
//! Проверяет заголовок `Authorization: Bearer <JWT>`, декодирует claims и
//! кладёт их в расширения запроса. Хендлеры затем просто принимают
//! `Extension<Claims>` — собственный `FromRequestParts` не нужен и не
//! используется.

use crate::utils::error::AppError;
use crate::utils::jwt::decode_token;
use crate::ws::AppState;
use axum::extract::{Request, State};
use axum::http::header::AUTHORIZATION;
use axum::middleware::Next;
use axum::response::Response;

/// Проверяет Bearer-токен и добавляет `Claims` в `request.extensions_mut()`.
pub async fn require_auth(
    State(state): State<AppState>,
    mut request: Request,
    next: Next,
) -> Result<Response, AppError> {
    let header = request
        .headers()
        .get(AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .ok_or_else(|| AppError::Unauthorized("Требуется заголовок Authorization".into()))?;

    let token = header
        .strip_prefix("Bearer ")
        .or_else(|| header.strip_prefix("bearer "))
        .map(str::trim)
        .filter(|token| !token.is_empty())
        .ok_or_else(|| AppError::Unauthorized("Ожидается формат: Bearer <JWT>".into()))?;

    let claims = decode_token(token, &state.jwt_secret)?;

    // Именно штатный Extension — хендлеры читают claims через Extension<Claims>.
    request.extensions_mut().insert(claims);

    Ok(next.run(request).await)
}
