use axum::{extract::State, http::HeaderMap, Extension, Json};
use axum_extra::extract::cookie::{Cookie, CookieJar, SameSite};

use crate::{
    models::{
        auth::{AuthResponse, AuthUser, OkResponse},
        user::{LoginRequest, RegisterRequest},
    },
    services::auth as auth_service,
    state::AppState,
    utils::{
        error::{AppError, AppResult},
        jwt::encode_access_token,
    },
};

const REFRESH_COOKIE: &str = "ct_refresh";
const MEDIA_COOKIE: &str = "ct_media";

pub async fn register(
    State(state): State<AppState>,
    jar: CookieJar,
    headers: HeaderMap,
    Json(req): Json<RegisterRequest>,
) -> AppResult<(CookieJar, Json<AuthResponse>)> {
    let tokens = auth_service::register(&state, req, &user_agent(&headers)).await?;

    let jar = jar
        .add(refresh_cookie(&state, &tokens.refresh_token))
        .add(media_cookie(&state, &tokens)?);
    Ok((jar, Json(auth_response(tokens))))
}

pub async fn login(
    State(state): State<AppState>,
    jar: CookieJar,
    headers: HeaderMap,
    Json(req): Json<LoginRequest>,
) -> AppResult<(CookieJar, Json<AuthResponse>)> {
    let tokens = auth_service::login(&state, req, &user_agent(&headers)).await?;

    let jar = jar
        .add(refresh_cookie(&state, &tokens.refresh_token))
        .add(media_cookie(&state, &tokens)?);
    Ok((jar, Json(auth_response(tokens))))
}

pub async fn refresh(
    State(state): State<AppState>,
    jar: CookieJar,
    headers: HeaderMap,
) -> AppResult<(CookieJar, Json<AuthResponse>)> {
    let token = jar
        .get(REFRESH_COOKIE)
        .map(|cookie| cookie.value().to_owned())
        .ok_or(AppError::Unauthorized)?;

    let tokens = auth_service::refresh(&state, &token, &user_agent(&headers)).await?;

    let jar = jar
        .add(refresh_cookie(&state, &tokens.refresh_token))
        .add(media_cookie(&state, &tokens)?);
    Ok((jar, Json(auth_response(tokens))))
}

pub async fn logout(
    State(state): State<AppState>,
    Extension(auth): Extension<AuthUser>,
    jar: CookieJar,
) -> AppResult<(CookieJar, Json<OkResponse>)> {
    auth_service::logout(&state, &auth).await?;

    let refresh_removal = Cookie::build((REFRESH_COOKIE, ""))
        .path("/api/auth")
        .http_only(true)
        .same_site(SameSite::Lax)
        .build();
    let media_removal = Cookie::build((MEDIA_COOKIE, ""))
        .path("/api/attachments")
        .http_only(true)
        .same_site(SameSite::Lax)
        .build();

    Ok((
        jar.remove(refresh_removal).remove(media_removal),
        Json(OkResponse { ok: true }),
    ))
}

fn auth_response(tokens: auth_service::AuthTokens) -> AuthResponse {
    AuthResponse {
        access_token: tokens.access_token,
        token_type: "Bearer",
        expires_in: tokens.expires_in,
        user: tokens.user,
    }
}

fn media_cookie(state: &AppState, tokens: &auth_service::AuthTokens) -> AppResult<Cookie<'static>> {
    let (token, _) = encode_access_token(
        &state.cfg.jwt_secret,
        &state.cfg.jwt_issuer,
        state.cfg.media_token_ttl,
        tokens.user.id,
        tokens.session_id,
        &tokens.user.username,
    )?;

    Ok(Cookie::build((MEDIA_COOKIE, token))
        .path("/api/attachments")
        .http_only(true)
        .secure(state.cfg.cookie_secure)
        .same_site(SameSite::Lax)
        .max_age(time::Duration::seconds(
            state.cfg.media_token_ttl.as_secs() as i64
        ))
        .build())
}

fn refresh_cookie(state: &AppState, token: &str) -> Cookie<'static> {
    Cookie::build((REFRESH_COOKIE, token.to_owned()))
        .path("/api/auth")
        .http_only(true)
        .secure(state.cfg.cookie_secure)
        .same_site(SameSite::Lax)
        .max_age(time::Duration::seconds(
            state.cfg.refresh_token_ttl.as_secs() as i64,
        ))
        .build()
}

fn user_agent(headers: &HeaderMap) -> String {
    headers
        .get(axum::http::header::USER_AGENT)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("unknown")
        .to_owned()
}
