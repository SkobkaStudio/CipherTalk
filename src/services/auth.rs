use std::time::Duration;

use anyhow::anyhow;
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use chrono::{Duration as ChronoDuration, Utc};
use rand::{rngs::OsRng, RngCore};
use redis::AsyncCommands;
use sha2::{Digest, Sha256};
use sqlx::{Postgres, Transaction};

use crate::{
    models::{
        auth::AuthUser,
        user::{LoginRequest, Me, RegisterRequest},
    },
    services::users,
    state::AppState,
    utils::{
        error::{AppError, AppResult},
        jwt::{decode_access_token, encode_access_token},
        password::{hash_password, verify_password},
        validation::{
            normalize_display_name, normalize_email, normalize_login_identifier,
            normalize_username, validate_password,
        },
    },
};

pub struct AuthTokens {
    pub access_token: String,
    pub refresh_token: String,
    pub expires_in: i64,
    pub session_id: i64,
    pub user: Me,
}

const SESSION_CACHE_TTL_SECS: u64 = 60;

pub async fn register(
    state: &AppState,
    req: RegisterRequest,
    user_agent: &str,
) -> AppResult<AuthTokens> {
    let username = normalize_username(&req.username)?;
    let display_name = normalize_display_name(&req.display_name)?;
    validate_password(&req.password)?;
    let email = normalize_email(req.email)?;

    let password = req.password;
    let password_hash = tokio::task::spawn_blocking(move || hash_password(&password))
        .await
        .map_err(|err| AppError::Internal(anyhow!("password hashing task failed: {err}")))??;

    let mut tx = state.pool.begin().await?;
    let user = sqlx::query_as!(
        Me,
        r#"
        INSERT INTO users (username, email, password_hash, display_name, last_seen_at)
        VALUES ($1, $2, $3, $4, now())
        RETURNING id, username, email, display_name, bio, avatar_url, created_at, last_seen_at
        "#,
        username,
        email,
        password_hash,
        display_name
    )
    .fetch_one(&mut *tx)
    .await
    .map_err(|err| map_unique(err, "Этот username или email уже занят"))?;

    let (session_id, refresh_token) =
        create_session(&mut tx, user.id, user_agent, state.cfg.refresh_token_ttl).await?;
    tx.commit().await?;

    let (access_token, expires_in) = encode_access_token(
        &state.cfg.jwt_secret,
        &state.cfg.jwt_issuer,
        state.cfg.access_token_ttl,
        user.id,
        session_id,
        &user.username,
    )?;

    users::touch_last_seen(&state.pool, user.id).await.ok();

    Ok(AuthTokens {
        access_token,
        refresh_token,
        expires_in,
        session_id,
        user,
    })
}

pub async fn login(state: &AppState, req: LoginRequest, user_agent: &str) -> AppResult<AuthTokens> {
    let identifier = normalize_login_identifier(&req.username)?;

    let row = sqlx::query!(
        r#"
        SELECT id, username, email, display_name, bio, avatar_url,
               created_at, last_seen_at, password_hash
        FROM users
        WHERE lower(username) = $1 OR lower(email) = $1
        LIMIT 1
        "#,
        identifier
    )
    .fetch_optional(&state.pool)
    .await?;

    let Some(row) = row else {
        // Uniform error: do not reveal whether the account exists.
        return Err(AppError::Unauthorized);
    };

    let stored_hash = row.password_hash.clone();
    let password = req.password;
    let valid = tokio::task::spawn_blocking(move || verify_password(&stored_hash, &password))
        .await
        .map_err(|err| AppError::Internal(anyhow!("password verification task failed: {err}")))??;
    if !valid {
        return Err(AppError::Unauthorized);
    }

    let mut tx = state.pool.begin().await?;
    let user = sqlx::query_as!(
        Me,
        r#"
        UPDATE users SET last_seen_at = now()
        WHERE id = $1
        RETURNING id, username, email, display_name, bio, avatar_url, created_at, last_seen_at
        "#,
        row.id
    )
    .fetch_one(&mut *tx)
    .await?;

    let (session_id, refresh_token) =
        create_session(&mut tx, user.id, user_agent, state.cfg.refresh_token_ttl).await?;
    tx.commit().await?;

    let (access_token, expires_in) = encode_access_token(
        &state.cfg.jwt_secret,
        &state.cfg.jwt_issuer,
        state.cfg.access_token_ttl,
        user.id,
        session_id,
        &user.username,
    )?;

    Ok(AuthTokens {
        access_token,
        refresh_token,
        expires_in,
        session_id,
        user,
    })
}

pub async fn refresh(
    state: &AppState,
    refresh_token: &str,
    user_agent: &str,
) -> AppResult<AuthTokens> {
    if refresh_token.is_empty() {
        return Err(AppError::Unauthorized);
    }
    let old_hash = hash_refresh_token(refresh_token);

    let row = sqlx::query!(
        r#"
        SELECT s.id AS session_id, s.user_id,
               u.username, u.email, u.display_name, u.bio, u.avatar_url,
               u.created_at, u.last_seen_at
        FROM sessions s
        JOIN users u ON u.id = s.user_id
        WHERE s.refresh_token_hash = $1
          AND s.revoked_at IS NULL
          AND s.expires_at > now()
        "#,
        old_hash
    )
    .fetch_optional(&state.pool)
    .await?;

    let Some(row) = row else {
        return Err(AppError::Unauthorized);
    };

    let new_refresh = generate_refresh_token();
    let new_hash = hash_refresh_token(&new_refresh);
    let expires_at = expiry_from_now(state.cfg.refresh_token_ttl)?;

    let mut tx = state.pool.begin().await?;
    let updated = sqlx::query!(
        r#"
        UPDATE sessions
        SET refresh_token_hash = $2,
            last_used_at = now(),
            expires_at = $3,
            user_agent = $4
        WHERE id = $1
          AND refresh_token_hash = $5
          AND revoked_at IS NULL
          AND expires_at > now()
        "#,
        row.session_id,
        new_hash,
        expires_at,
        truncate_user_agent(user_agent),
        old_hash
    )
    .execute(&mut *tx)
    .await?;

    if updated.rows_affected() == 0 {
        // Lost a rotation race or the token was revoked concurrently.
        return Err(AppError::Unauthorized);
    }

    let user = Me {
        id: row.user_id,
        username: row.username,
        email: row.email,
        display_name: row.display_name,
        bio: row.bio,
        avatar_url: row.avatar_url,
        created_at: row.created_at,
        last_seen_at: row.last_seen_at,
    };

    let (access_token, expires_in) = encode_access_token(
        &state.cfg.jwt_secret,
        &state.cfg.jwt_issuer,
        state.cfg.access_token_ttl,
        user.id,
        row.session_id,
        &user.username,
    )?;
    tx.commit().await?;

    // Refresh-token rotation means the old plaintext is now useless.
    let _ = invalidate_session_cache(state, row.session_id).await;

    Ok(AuthTokens {
        access_token,
        refresh_token: new_refresh,
        expires_in,
        session_id: row.session_id,
        user,
    })
}

pub async fn logout(state: &AppState, auth: &AuthUser) -> AppResult<()> {
    sqlx::query!(
        "UPDATE sessions SET revoked_at = now() WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL",
        auth.session_id,
        auth.user_id
    )
    .execute(&state.pool)
    .await?;

    if let Err(err) = invalidate_session_cache(state, auth.session_id).await {
        tracing::warn!(error = %err, "failed to invalidate session cache");
    }
    Ok(())
}

/// Validates a JWT and its session. Positive session lookups are cached for a
/// short TTL; logout invalidates the key. Redis outages fall back to Postgres.
pub async fn authenticate(state: &AppState, token: &str) -> AppResult<AuthUser> {
    let claims = decode_access_token(&state.cfg.jwt_secret, &state.cfg.jwt_issuer, token)?;

    let key = session_cache_key(claims.sid);
    let mut redis = state.redis.clone();
    let cached: Result<Option<String>, redis::RedisError> = redis.get(&key).await;

    match cached {
        Ok(Some(value)) if value == claims.sub.to_string() => {
            return Ok(AuthUser {
                user_id: claims.sub,
                session_id: claims.sid,
            });
        }
        Ok(Some(value)) if value == "revoked" => return Err(AppError::Unauthorized),
        Ok(_) => {}
        Err(err) => {
            tracing::warn!(error = %err, "session cache read failed; using database");
        }
    }

    let row = sqlx::query!(
        r#"
        SELECT s.user_id
        FROM sessions s
        JOIN users u ON u.id = s.user_id
        WHERE s.id = $1
          AND s.user_id = $2
          AND s.revoked_at IS NULL
          AND s.expires_at > now()
        "#,
        claims.sid,
        claims.sub
    )
    .fetch_optional(&state.pool)
    .await?;

    let Some(row) = row else {
        return Err(AppError::Unauthorized);
    };

    let cache_value = row.user_id.to_string();
    let cached_set: Result<bool, redis::RedisError> = redis
        .set_ex(&key, cache_value, SESSION_CACHE_TTL_SECS)
        .await;
    if let Err(err) = cached_set {
        tracing::warn!(error = %err, "session cache write failed");
    }

    Ok(AuthUser {
        user_id: row.user_id,
        session_id: claims.sid,
    })
}

/// Periodic check for long-lived WebSocket connections. A JWT expires after
/// 15 minutes, but an open socket should survive it until the session is
/// revoked; this check enforces revocation without forcing re-auth.
pub async fn is_session_active(state: &AppState, session_id: i64, user_id: i64) -> bool {
    let result = sqlx::query_scalar!(
        r#"
        SELECT 1 as "one!"
        FROM sessions
        WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL AND expires_at > now()
        "#,
        session_id,
        user_id
    )
    .fetch_optional(&state.pool)
    .await;

    match result {
        Ok(Some(_)) => true,
        Ok(None) => false,
        Err(err) => {
            tracing::warn!(error = %err, "session liveness check failed; keeping socket open");
            true
        }
    }
}

async fn create_session(
    tx: &mut Transaction<'_, Postgres>,
    user_id: i64,
    user_agent: &str,
    ttl: Duration,
) -> AppResult<(i64, String)> {
    let refresh_token = generate_refresh_token();
    let refresh_hash = hash_refresh_token(&refresh_token);
    let expires_at = expiry_from_now(ttl)?;

    let row = sqlx::query!(
        r#"
        INSERT INTO sessions (user_id, refresh_token_hash, user_agent, expires_at)
        VALUES ($1, $2, $3, $4)
        RETURNING id
        "#,
        user_id,
        refresh_hash,
        truncate_user_agent(user_agent),
        expires_at
    )
    .fetch_one(&mut **tx)
    .await?;

    Ok((row.id, refresh_token))
}

fn generate_refresh_token() -> String {
    let mut bytes = [0u8; 32];
    OsRng.fill_bytes(&mut bytes);
    URL_SAFE_NO_PAD.encode(bytes)
}

fn hash_refresh_token(token: &str) -> String {
    hex::encode(Sha256::digest(token.as_bytes()))
}

fn expiry_from_now(ttl: Duration) -> AppResult<chrono::DateTime<Utc>> {
    let ttl = ChronoDuration::from_std(ttl)
        .map_err(|err| AppError::Internal(anyhow!("invalid token TTL: {err}")))?;
    Ok(Utc::now() + ttl)
}

fn truncate_user_agent(user_agent: &str) -> String {
    user_agent.chars().take(512).collect()
}

fn session_cache_key(session_id: i64) -> String {
    format!("ct:sess:{session_id}")
}

async fn invalidate_session_cache(
    state: &AppState,
    session_id: i64,
) -> Result<(), redis::RedisError> {
    let mut redis = state.redis.clone();
    let _: usize = redis.del(session_cache_key(session_id)).await?;
    Ok(())
}

fn map_unique(err: sqlx::Error, message: &str) -> AppError {
    if let sqlx::Error::Database(db) = &err {
        if db.code().as_deref() == Some("23505") {
            return AppError::Conflict(message.to_owned());
        }
    }
    err.into()
}
