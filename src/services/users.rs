use sqlx::PgPool;

use crate::{
    models::user::{Me, PublicUser, UpdateProfileRequest},
    state::AppState,
    utils::{
        error::{AppError, AppResult},
        validation::{
            escape_like, normalize_avatar_url, normalize_bio, normalize_display_name,
            normalize_search_query,
        },
    },
};

pub async fn get_me(state: &AppState, user_id: i64) -> AppResult<Me> {
    let user = sqlx::query_as!(
        Me,
        r#"
        SELECT id, username, email, display_name, bio, avatar_url, created_at, last_seen_at
        FROM users WHERE id = $1
        "#,
        user_id
    )
    .fetch_optional(&state.pool)
    .await?;

    user.ok_or_else(|| AppError::NotFound("Пользователь не найден".into()))
}

pub async fn update_me(state: &AppState, user_id: i64, req: UpdateProfileRequest) -> AppResult<Me> {
    let display_name = req
        .display_name
        .as_deref()
        .map(normalize_display_name)
        .transpose()?;
    let bio = req.bio.as_deref().map(normalize_bio).transpose()?;

    let (avatar_set, avatar_url) = match req.avatar_url {
        Some(raw) => (true, normalize_avatar_url(Some(raw))?),
        None => (false, None),
    };

    let user = sqlx::query_as!(
        Me,
        r#"
        UPDATE users
        SET display_name = COALESCE($2, display_name),
            bio = COALESCE($3, bio),
            avatar_url = CASE WHEN $4 THEN $5 ELSE avatar_url END
        WHERE id = $1
        RETURNING id, username, email, display_name, bio, avatar_url, created_at, last_seen_at
        "#,
        user_id,
        display_name,
        bio,
        avatar_set,
        avatar_url
    )
    .fetch_optional(&state.pool)
    .await?;

    user.ok_or_else(|| AppError::NotFound("Пользователь не найден".into()))
}

pub async fn search_users(
    state: &AppState,
    user_id: i64,
    query: &str,
) -> AppResult<Vec<PublicUser>> {
    let query = normalize_search_query(query)?;
    let pattern = format!("{}%", escape_like(&query));

    let users = sqlx::query_as!(
        PublicUser,
        r#"
        SELECT id, username, display_name, bio, avatar_url, last_seen_at
        FROM users
        WHERE lower(username) LIKE $2 ESCAPE '\'
          AND id <> $1
        ORDER BY username
        LIMIT 20
        "#,
        user_id,
        pattern
    )
    .fetch_all(&state.pool)
    .await?;

    Ok(users)
}

pub async fn touch_last_seen(pool: &PgPool, user_id: i64) -> AppResult<()> {
    sqlx::query!(
        "UPDATE users SET last_seen_at = now() WHERE id = $1",
        user_id
    )
    .execute(pool)
    .await?;
    Ok(())
}
