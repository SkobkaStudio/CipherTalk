use std::collections::HashSet;

use chrono::{DateTime, Utc};
use sqlx::PgPool;

use crate::{
    models::chat::{
        ChatDetails, ChatMember, ChatPeer, ChatSummary, CreateGroupChatRequest, LastMessagePreview,
        KIND_GROUP, KIND_PRIVATE, ROLE_ADMIN, ROLE_OWNER,
    },
    state::AppState,
    utils::{
        error::{AppError, AppResult},
        validation::normalize_chat_title,
    },
};

#[derive(Debug, sqlx::FromRow)]
struct ChatListRow {
    id: i64,
    kind: String,
    title: Option<String>,
    description: String,
    avatar_url: Option<String>,
    created_at: DateTime<Utc>,
    last_message_at: DateTime<Utc>,
    my_role: String,
    last_read_message_id: Option<i64>,
    peer_id: Option<i64>,
    peer_username: Option<String>,
    peer_display_name: Option<String>,
    peer_avatar_url: Option<String>,
    peer_last_seen_at: Option<DateTime<Utc>>,
    last_message_id: Option<i64>,
    last_message_content: Option<String>,
    last_message_sender_name: Option<String>,
    last_message_attachment_kind: Option<String>,
    last_message_created_at: Option<DateTime<Utc>>,
    last_message_deleted_at: Option<DateTime<Utc>>,
    unread_count: i64,
    member_count: i64,
}

#[derive(Debug, sqlx::FromRow)]
struct ChatRow {
    id: i64,
    kind: String,
    title: Option<String>,
    description: String,
    avatar_url: Option<String>,
    created_at: DateTime<Utc>,
    last_read_message_id: Option<i64>,
}

#[derive(Debug, sqlx::FromRow)]
struct MemberRow {
    id: i64,
    username: String,
    display_name: String,
    avatar_url: Option<String>,
    last_seen_at: Option<DateTime<Utc>>,
    role: String,
    joined_at: DateTime<Utc>,
    last_read_message_id: Option<i64>,
}

pub async fn list_chats(
    state: &AppState,
    user_id: i64,
    limit: i64,
    offset: i64,
) -> AppResult<Vec<ChatSummary>> {
    let rows = sqlx::query_as!(
        ChatListRow,
        r#"
        SELECT
            c.id,
            c.kind,
            c.title,
            c.description,
            c.avatar_url,
            c.created_at,
            c.last_message_at,
            cm.role AS "my_role!",
            cm.last_read_message_id,
            pc.id AS "peer_id?",
            pc.username AS "peer_username?",
            pc.display_name AS "peer_display_name?",
            pc.avatar_url AS "peer_avatar_url?",
            pc.last_seen_at AS "peer_last_seen_at?",
            lm.id AS "last_message_id?",
            lm.content AS "last_message_content?",
            lu.display_name AS "last_message_sender_name?",
            la.kind AS "last_message_attachment_kind?",
            lm.created_at AS "last_message_created_at?",
            lm.deleted_at AS "last_message_deleted_at?",
            (
                SELECT COUNT(*)
                FROM messages um
                WHERE um.chat_id = c.id
                  AND um.deleted_at IS NULL
                  AND um.id > COALESCE(cm.last_read_message_id, 0)
                  AND um.sender_id IS DISTINCT FROM $1
            ) AS "unread_count!",
            (
                SELECT COUNT(*) FROM chat_members mc WHERE mc.chat_id = c.id
            ) AS "member_count!"
        FROM chat_members cm
        JOIN chats c ON c.id = cm.chat_id
        LEFT JOIN LATERAL (
            SELECT u.id, u.username, u.display_name, u.avatar_url, u.last_seen_at
            FROM chat_members pcm
            JOIN users u ON u.id = pcm.user_id
            WHERE c.kind = 'private'
              AND pcm.chat_id = c.id
              AND pcm.user_id <> $1
            LIMIT 1
        ) pc ON TRUE
        LEFT JOIN messages lm ON lm.id = c.last_message_id
        LEFT JOIN users lu ON lu.id = lm.sender_id
        LEFT JOIN attachments la ON la.message_id = lm.id
        WHERE cm.user_id = $1
        ORDER BY c.last_message_at DESC, c.id DESC
        LIMIT $2 OFFSET $3
        "#,
        user_id,
        limit,
        offset
    )
    .fetch_all(&state.pool)
    .await?;

    Ok(rows.into_iter().map(chat_summary_from_row).collect())
}

fn chat_summary_from_row(row: ChatListRow) -> ChatSummary {
    let peer = match (row.peer_id, row.peer_username, row.peer_display_name) {
        (Some(id), Some(username), Some(display_name)) => Some(ChatPeer {
            id,
            username,
            display_name,
            avatar_url: row.peer_avatar_url,
            last_seen_at: row.peer_last_seen_at,
        }),
        _ => None,
    };

    let title = if row.kind == KIND_PRIVATE {
        peer.as_ref().map(|p| p.display_name.clone())
    } else {
        row.title
    };

    let last_message = match (row.last_message_id, row.last_message_created_at) {
        (Some(id), Some(created_at)) => {
            let is_deleted = row.last_message_deleted_at.is_some();
            Some(LastMessagePreview {
                id,
                content: if is_deleted {
                    String::new()
                } else {
                    row.last_message_content.unwrap_or_default()
                },
                sender_name: row.last_message_sender_name,
                attachment_kind: row.last_message_attachment_kind,
                created_at,
                is_deleted,
            })
        }
        _ => None,
    };

    ChatSummary {
        id: row.id,
        kind: row.kind,
        title,
        description: row.description,
        avatar_url: row.avatar_url,
        created_at: row.created_at,
        last_message_at: row.last_message_at,
        last_message,
        unread_count: row.unread_count,
        member_count: row.member_count,
        my_role: row.my_role,
        last_read_message_id: row.last_read_message_id,
        peer,
    }
}

pub async fn require_membership(pool: &PgPool, chat_id: i64, user_id: i64) -> AppResult<String> {
    let role = sqlx::query_scalar!(
        "SELECT role FROM chat_members WHERE chat_id = $1 AND user_id = $2",
        chat_id,
        user_id
    )
    .fetch_optional(pool)
    .await?;

    role.ok_or_else(|| AppError::NotFound("Чат не найден".into()))
}

pub async fn get_details(state: &AppState, chat_id: i64, user_id: i64) -> AppResult<ChatDetails> {
    let my_role = require_membership(&state.pool, chat_id, user_id).await?;

    let chat = sqlx::query_as!(
        ChatRow,
        r#"
        SELECT c.id, c.kind, c.title, c.description, c.avatar_url, c.created_at,
               cm.last_read_message_id
        FROM chats c
        JOIN chat_members cm ON cm.chat_id = c.id AND cm.user_id = $2
        WHERE c.id = $1
        "#,
        chat_id,
        user_id
    )
    .fetch_optional(&state.pool)
    .await?
    .ok_or_else(|| AppError::NotFound("Чат не найден".into()))?;

    let member_rows = sqlx::query_as!(
        MemberRow,
        r#"
        SELECT u.id, u.username, u.display_name, u.avatar_url, u.last_seen_at,
               cm.role, cm.joined_at, cm.last_read_message_id
        FROM chat_members cm
        JOIN users u ON u.id = cm.user_id
        WHERE cm.chat_id = $1
        ORDER BY cm.joined_at, u.id
        "#,
        chat_id
    )
    .fetch_all(&state.pool)
    .await?;

    let members = member_rows
        .into_iter()
        .map(|row| ChatMember {
            user: ChatPeer {
                id: row.id,
                username: row.username,
                display_name: row.display_name,
                avatar_url: row.avatar_url,
                last_seen_at: row.last_seen_at,
            },
            role: row.role,
            joined_at: row.joined_at,
            last_read_message_id: row.last_read_message_id,
        })
        .collect::<Vec<_>>();

    let peer = if chat.kind == KIND_PRIVATE {
        members
            .iter()
            .find(|member| member.user.id != user_id)
            .map(|member| member.user.clone())
    } else {
        None
    };

    let title = if chat.kind == KIND_PRIVATE {
        peer.as_ref().map(|p| p.display_name.clone())
    } else {
        chat.title
    };

    Ok(ChatDetails {
        id: chat.id,
        kind: chat.kind,
        title,
        description: chat.description,
        avatar_url: chat.avatar_url,
        created_at: chat.created_at,
        my_role,
        peer,
        members,
        last_read_message_id: chat.last_read_message_id,
    })
}

pub async fn create_private(
    state: &AppState,
    user_id: i64,
    peer_id: i64,
) -> AppResult<ChatDetails> {
    if user_id == peer_id {
        return Err(AppError::Validation(
            "Нельзя начать личный чат с самим собой".into(),
        ));
    }

    let peer_exists = sqlx::query_scalar!("SELECT id FROM users WHERE id = $1", peer_id)
        .fetch_optional(&state.pool)
        .await?;
    if peer_exists.is_none() {
        return Err(AppError::NotFound("Пользователь не найден".into()));
    }

    let key = format!("{}:{}", user_id.min(peer_id), user_id.max(peer_id));

    let mut tx = state.pool.begin().await?;
    let inserted = sqlx::query_scalar!(
        r#"
        INSERT INTO chats (kind, private_key, created_by)
        VALUES ('private', $1, $2)
        ON CONFLICT DO NOTHING
        RETURNING id
        "#,
        key,
        user_id
    )
    .fetch_optional(&mut *tx)
    .await?;

    let chat_id = match inserted {
        Some(id) => id,
        None => {
            sqlx::query_scalar!("SELECT id FROM chats WHERE private_key = $1", key)
                .fetch_one(&mut *tx)
                .await?
        }
    };

    // Insert in deterministic order to avoid deadlocks between two users
    // opening the same DM concurrently.
    let (first, second) = (user_id.min(peer_id), user_id.max(peer_id));
    sqlx::query!(
        r#"
        INSERT INTO chat_members (chat_id, user_id, role)
        VALUES ($1, $2, 'member'), ($1, $3, 'member')
        ON CONFLICT DO NOTHING
        "#,
        chat_id,
        first,
        second
    )
    .execute(&mut *tx)
    .await?;

    tx.commit().await?;

    get_details(state, chat_id, user_id).await
}

pub async fn create_group(
    state: &AppState,
    creator_id: i64,
    req: CreateGroupChatRequest,
) -> AppResult<ChatDetails> {
    let title = normalize_chat_title(&req.title)?;

    let mut ids = Vec::with_capacity(req.member_ids.len() + 1);
    ids.push(creator_id);
    let mut seen = HashSet::from([creator_id]);
    for id in req.member_ids {
        if id <= 0 {
            return Err(AppError::Validation("Некорректный участник группы".into()));
        }
        if seen.insert(id) {
            ids.push(id);
        }
    }

    if ids.len() as i64 > state.cfg.max_group_members {
        return Err(AppError::Validation(format!(
            "В группе может быть не больше {} участников",
            state.cfg.max_group_members
        )));
    }

    let mut tx = state.pool.begin().await?;

    let found = sqlx::query_scalar!("SELECT id FROM users WHERE id = ANY($1)", &ids[..])
        .fetch_all(&mut *tx)
        .await?;
    if found.len() != ids.len() {
        return Err(AppError::Validation(
            "Некоторые пользователи не найдены".into(),
        ));
    }

    let chat_id = sqlx::query_scalar!(
        r#"
        INSERT INTO chats (kind, title, created_by)
        VALUES ('group', $1, $2)
        RETURNING id
        "#,
        title,
        creator_id
    )
    .fetch_one(&mut *tx)
    .await?;

    sqlx::query!(
        r#"
        INSERT INTO chat_members (chat_id, user_id, role)
        SELECT $1, uid,
               CASE WHEN uid = $2 THEN 'owner' ELSE 'member' END
        FROM UNNEST($3::BIGINT[]) AS uid
        "#,
        chat_id,
        creator_id,
        &ids[..]
    )
    .execute(&mut *tx)
    .await?;

    tx.commit().await?;

    get_details(state, chat_id, creator_id).await
}

pub async fn add_members(
    state: &AppState,
    chat_id: i64,
    actor_id: i64,
    user_ids: Vec<i64>,
) -> AppResult<ChatDetails> {
    let actor_role = require_membership(&state.pool, chat_id, actor_id).await?;
    if actor_role != ROLE_OWNER && actor_role != ROLE_ADMIN {
        return Err(AppError::Forbidden(
            "Добавлять участников могут владелец или администратор".into(),
        ));
    }

    let chat = sqlx::query!(
        "SELECT kind, last_message_id FROM chats WHERE id = $1",
        chat_id
    )
    .fetch_optional(&state.pool)
    .await?
    .ok_or_else(|| AppError::NotFound("Чат не найден".into()))?;

    if chat.kind != KIND_GROUP {
        return Err(AppError::Forbidden(
            "В личный чат нельзя добавлять участников".into(),
        ));
    }

    let mut ids = Vec::new();
    let mut seen = HashSet::new();
    for id in user_ids {
        if id > 0 && seen.insert(id) {
            ids.push(id);
        }
    }
    if ids.is_empty() {
        return get_details(state, chat_id, actor_id).await;
    }

    let mut tx = state.pool.begin().await?;

    let found = sqlx::query_scalar!("SELECT id FROM users WHERE id = ANY($1)", &ids[..])
        .fetch_all(&mut *tx)
        .await?;
    if found.len() != ids.len() {
        return Err(AppError::Validation(
            "Некоторые пользователи не найдены".into(),
        ));
    }

    let existing = sqlx::query_scalar!(
        "SELECT user_id FROM chat_members WHERE chat_id = $1 AND user_id = ANY($2)",
        chat_id,
        &ids[..]
    )
    .fetch_all(&mut *tx)
    .await?;

    let to_add = ids
        .into_iter()
        .filter(|id| !existing.contains(id))
        .collect::<Vec<_>>();

    if to_add.is_empty() {
        tx.rollback().await?;
        return get_details(state, chat_id, actor_id).await;
    }

    let member_count: i64 = sqlx::query_scalar!(
        "SELECT COUNT(*) AS \"count!\" FROM chat_members WHERE chat_id = $1",
        chat_id
    )
    .fetch_one(&mut *tx)
    .await?;

    if member_count + to_add.len() as i64 > state.cfg.max_group_members {
        return Err(AppError::Validation(format!(
            "В группе может быть не больше {} участников",
            state.cfg.max_group_members
        )));
    }

    sqlx::query!(
        r#"
        INSERT INTO chat_members (chat_id, user_id, role, last_read_message_id)
        SELECT $1, uid, 'member', $2
        FROM UNNEST($3::BIGINT[]) AS uid
        ON CONFLICT DO NOTHING
        "#,
        chat_id,
        chat.last_message_id,
        &to_add[..]
    )
    .execute(&mut *tx)
    .await?;

    tx.commit().await?;

    get_details(state, chat_id, actor_id).await
}

pub async fn remove_member(
    state: &AppState,
    chat_id: i64,
    actor_id: i64,
    target_id: i64,
) -> AppResult<()> {
    let actor_role = require_membership(&state.pool, chat_id, actor_id).await?;

    let chat = sqlx::query!("SELECT kind FROM chats WHERE id = $1", chat_id)
        .fetch_optional(&state.pool)
        .await?
        .ok_or_else(|| AppError::NotFound("Чат не найден".into()))?;
    if chat.kind != KIND_GROUP {
        return Err(AppError::Forbidden("Из личного чата нельзя выйти".into()));
    }

    let target_role = sqlx::query_scalar!(
        "SELECT role FROM chat_members WHERE chat_id = $1 AND user_id = $2",
        chat_id,
        target_id
    )
    .fetch_optional(&state.pool)
    .await?
    .ok_or_else(|| AppError::NotFound("Участник не найден".into()))?;

    if target_id == actor_id {
        if actor_role == ROLE_OWNER {
            return Err(AppError::Forbidden(
                "Владелец не может покинуть группу".into(),
            ));
        }
    } else {
        if actor_role != ROLE_OWNER && actor_role != ROLE_ADMIN {
            return Err(AppError::Forbidden(
                "Удалять участников могут владелец или администратор".into(),
            ));
        }
        if target_role == ROLE_OWNER {
            return Err(AppError::Forbidden(
                "Нельзя удалить владельца группы".into(),
            ));
        }
        if actor_role == ROLE_ADMIN && target_role == ROLE_ADMIN {
            return Err(AppError::Forbidden(
                "Администратор не может удалить другого администратора".into(),
            ));
        }
    }

    let deleted = sqlx::query!(
        "DELETE FROM chat_members WHERE chat_id = $1 AND user_id = $2",
        chat_id,
        target_id
    )
    .execute(&state.pool)
    .await?;

    if deleted.rows_affected() > 0 {
        state.hub.evict_user_from_chat(chat_id, target_id).await;
    }

    Ok(())
}
