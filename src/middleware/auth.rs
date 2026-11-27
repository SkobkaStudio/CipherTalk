use axum::{
    extract::{Request, State},
    http::{header::AUTHORIZATION, HeaderMap},
    middleware::Next,
    response::Response,
};

use crate::{services::auth as auth_service, state::AppState, utils::AppError};

/// Extracts `Authorization: Bearer <jwt>`, validates the token and the
/// underlying session, then injects `AuthUser` into request extensions.
pub async fn require_auth(
    State(state): State<AppState>,
    mut request: Request,
    next: Next,
) -> Result<Response, AppError> {
    let token = bearer_token(request.headers()).ok_or(AppError::Unauthorized)?;
    let auth = auth_service::authenticate(&state, token).await?;
    request.extensions_mut().insert(auth);
    Ok(next.run(request).await)
}

fn bearer_token(headers: &HeaderMap) -> Option<&str> {
    let value = headers.get(AUTHORIZATION)?.to_str().ok()?.trim();
    let token = value
        .strip_prefix("Bearer ")
        .or_else(|| value.strip_prefix("bearer "))?;
    let token = token.trim();
    (!token.is_empty()).then_some(token)
}
