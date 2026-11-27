use axum::{
    extract::State,
    http::{header::USER_AGENT, HeaderMap, StatusCode},
    Extension, Json,
};
use base64::{
    engine::general_purpose::{STANDARD, URL_SAFE, URL_SAFE_NO_PAD},
    Engine as _,
};

use crate::{
    models::{
        auth::AuthUser,
        push::{
            PushKeyResponse, PushSubscriptionRequest, PushTestResponse, PushUnsubscribeRequest,
        },
    },
    state::AppState,
    utils::error::{AppError, AppResult},
};

fn decode_subscription_key(value: &str) -> Option<Vec<u8>> {
    let value = value.trim();
    URL_SAFE_NO_PAD
        .decode(value)
        .or_else(|_| URL_SAFE.decode(value))
        .or_else(|_| STANDARD.decode(value))
        .ok()
}

pub async fn public_key(State(state): State<AppState>) -> Json<PushKeyResponse> {
    match state.push.as_ref() {
        Some(push) => Json(PushKeyResponse {
            enabled: true,
            public_key: Some(push.public_key().to_owned()),
        }),
        None => Json(PushKeyResponse {
            enabled: false,
            public_key: None,
        }),
    }
}

pub async fn subscribe(
    State(state): State<AppState>,
    Extension(auth): Extension<AuthUser>,
    headers: HeaderMap,
    Json(req): Json<PushSubscriptionRequest>,
) -> AppResult<StatusCode> {
    let endpoint = req.endpoint.trim();
    if !endpoint.starts_with("https://") || !(12..=2048).contains(&endpoint.len()) {
        return Err(AppError::Validation("Некорректный push endpoint".into()));
    }
    let p256dh = decode_subscription_key(&req.p256dh)
        .filter(|key| key.len() == 65 && key.first() == Some(&4))
        .ok_or_else(|| AppError::Validation("Некорректный ключ p256dh".into()))?;
    let auth_secret = decode_subscription_key(&req.auth)
        .filter(|key| key.len() == 16)
        .ok_or_else(|| AppError::Validation("Некорректный auth-секрет".into()))?;
    let _ = (p256dh, auth_secret);

    let user_agent = headers
        .get(USER_AGENT)
        .and_then(|value| value.to_str().ok())
        .map(|value| value.chars().take(300).collect::<String>());

    sqlx::query!(
        r#"
        INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, user_agent)
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (endpoint) DO UPDATE SET
            user_id = EXCLUDED.user_id,
            p256dh = EXCLUDED.p256dh,
            auth = EXCLUDED.auth,
            user_agent = EXCLUDED.user_agent,
            updated_at = now()
        "#,
        auth.user_id,
        endpoint,
        req.p256dh,
        req.auth,
        user_agent
    )
    .execute(&state.pool)
    .await?;

    Ok(StatusCode::NO_CONTENT)
}

pub async fn unsubscribe(
    State(state): State<AppState>,
    Extension(auth): Extension<AuthUser>,
    Json(req): Json<PushUnsubscribeRequest>,
) -> AppResult<StatusCode> {
    sqlx::query!(
        "DELETE FROM push_subscriptions WHERE endpoint = $1 AND user_id = $2",
        req.endpoint.trim(),
        auth.user_id
    )
    .execute(&state.pool)
    .await?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn test(
    State(state): State<AppState>,
    Extension(auth): Extension<AuthUser>,
) -> AppResult<Json<PushTestResponse>> {
    let Some(push) = state.push.as_ref() else {
        return Err(AppError::Forbidden("Web Push не настроен".into()));
    };
    let sent = push
        .test_user(&state.pool, auth.user_id)
        .await
        .map_err(AppError::Internal)?;
    Ok(Json(PushTestResponse { sent }))
}
