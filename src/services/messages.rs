use chrono::{DateTime, Utc};

use crate::{
    models::{
        chat::KIND_GROUP,
        media::AttachmentDto,
        message::{MessageDto, MessagePage, ReadState, ReplyPreview, SenderInfo},
        ws::ServerEvent,
    },
    services::chats,
    state::AppState,
    utils::{
        error::{AppError, AppResult},
        pagination::HistoryPage,
        validation::normalize_message,
    },
};

#[derive(Debug, sqlx::FromRow)]
struct MessageRow {
    id: i64,
    chat_id: i64,
    content: String,
    reply_to_id: Option<i64>,
    edited_at: Option<DateTime<Utc>>,
    deleted_at: Option<DateTime<Utc>>,
    created_at: DateTime<Utc>,
    sender_id: Option<i64>,
    sender_username: Option<String>,
    sender_display_name: Option<String>,
    sender_avatar_url: Option<String>,
    reply_content: Option<String>,
    reply_deleted_at: Option<DateTime<Utc>>,
    reply_sender_name: Option<String>,
    attachment_id: Option<i64>,
    attachment_kind: Option<String>,
    attachment_file_name: Option<String>,
    attachment_mime_type: Option<String>,
    attachment_size_bytes: Option<i64>,
    attachment_width: Option<i32>,
    attachment_height: Option<i32>,
    attachment_duration_ms: Option<i32>,
    attachment_thumbnail_key: Option<String>,
}

pub async fn send(
    state: &AppState,
    chat_id: i64,
    sender_id: i64,
    content: &str,
    reply_to_id: Option<i64>,
    attachment_id: Option<i64>,
) -> AppResult<MessageDto> {
    let has_attachment = attachment_id.is_some();
    let content = if content.trim().is_empty() {
        if has_attachment {
            String::new()
        } else {
            return Err(AppError::Validation(
                "Сообщение не может быть пустым".into(),
            ));
        }
    } else {
        normalize_message(content, state.cfg.max_message_len)?
    };

    let mut tx = state.pool.begin().await?;

    let membership = sqlx::query_scalar!(
        "SELECT role FROM chat_members WHERE chat_id = $1 AND user_id = $2",
        chat_id,
        sender_id
    )
    .fetch_optional(&mut *tx)
    .await?;
    if membership.is_none() {
        return Err(AppError::NotFound("Чат не найден".into()));
    }

    if let Some(attachment_id) = attachment_id {
        let owned = sqlx::query_scalar!(
            r#"
            SELECT id FROM attachments
            WHERE id = $1
              AND chat_id = $2
              AND uploader_id = $3
              AND message_id IS NULL
            FOR UPDATE
            "#,
            attachment_id,
            chat_id,
            sender_id
        )
        .fetch_optional(&mut *tx)
        .await?;
        if owned.is_none() {
            return Err(AppError::Validation(
                "Вложение не найдено или уже отправлено".into(),
            ));
        }
    }

    if let Some(reply_id) = reply_to_id {
        let exists = sqlx::query_scalar!(
            r#"
            SELECT id FROM messages
            WHERE id = $1 AND chat_id = $2 AND deleted_at IS NULL
            "#,
            reply_id,
            chat_id
        )
        .fetch_optional(&mut *tx)
        .await?;
        if exists.is_none() {
            return Err(AppError::Validation(
                "Сообщение для ответа не найдено".into(),
            ));
        }
    }

    let message_id = sqlx::query_scalar!(
        r#"
        INSERT INTO messages (chat_id, sender_id, content, reply_to_id, has_attachment)
        VALUES ($1, $2, $3, $4, $5)
        RETURNING id
        "#,
        chat_id,
        sender_id,
        content,
        reply_to_id,
        has_attachment
    )
    .fetch_one(&mut *tx)
    .await?;

    if let Some(attachment_id) = attachment_id {
        let linked = sqlx::query!(
            "UPDATE attachments SET message_id = $2 WHERE id = $1 AND message_id IS NULL",
            attachment_id,
            message_id
        )
        .execute(&mut *tx)
        .await?;
        if linked.rows_affected() != 1 {
            return Err(AppError::Conflict(
                "Вложение уже привязано к другому сообщению".into(),
            ));
        }
    }

    tx.commit().await?;

    let message = fetch_message(state, message_id).await?;
    state
        .hub
        .publish(
            chat_id,
            ServerEvent::MessageNew {
                chat_id,
                message: message.clone(),
            },
        )
        .await;

    if let Some(push) = state.push.clone() {
        let state = state.clone();
        let message = message.clone();
        tokio::spawn(async move {
            if let Err(err) = push
                .notify_message(&state, chat_id, sender_id, &message)
                .await
            {
                tracing::warn!(error = %err, "web push notification failed");
            }
        });
    }

    Ok(message)
}

pub async fn history(
    state: &AppState,
    chat_id: i64,
    user_id: i64,
    page: HistoryPage,
) -> AppResult<MessagePage> {
    chats::require_membership(&state.pool, chat_id, user_id).await?;

    let fetch_limit = page.limit + 1;

    if let Some(after_id) = page.after_id {
        let mut rows = sqlx::query_as!(
            MessageRow,
            r#"
            SELECT m.id, m.chat_id, m.content, m.reply_to_id, m.edited_at,
                   m.deleted_at, m.created_at,
                   u.id AS "sender_id?",
                   u.username AS "sender_username?",
                   u.display_name AS "sender_display_name?",
                   u.avatar_url AS "sender_avatar_url?",
                   r.content AS "reply_content?",
                   r.deleted_at AS "reply_deleted_at?",
                   ru.display_name AS "reply_sender_name?",
                   a.id AS "attachment_id?",
                   a.kind AS "attachment_kind?",
                   a.file_name AS "attachment_file_name?",
                   a.mime_type AS "attachment_mime_type?",
                   a.size_bytes AS "attachment_size_bytes?",
                   a.width AS "attachment_width?",
                   a.height AS "attachment_height?",
                   a.duration_ms AS "attachment_duration_ms?",
                   a.thumbnail_key AS "attachment_thumbnail_key?"
            FROM messages m
            LEFT JOIN users u ON u.id = m.sender_id
            LEFT JOIN messages r ON r.id = m.reply_to_id
            LEFT JOIN users ru ON ru.id = r.sender_id
            LEFT JOIN attachments a ON a.message_id = m.id
            WHERE m.chat_id = $1 AND m.id > $2
            ORDER BY m.id ASC
            LIMIT $3
            "#,
            chat_id,
            after_id,
            fetch_limit
        )
        .fetch_all(&state.pool)
        .await?;

        let has_more = rows.len() as i64 > page.limit;
        if has_more {
            rows.truncate(page.limit as usize);
        }
        let items = rows.into_iter().map(message_from_row).collect::<Vec<_>>();
        let next_after_id = has_more.then(|| items.last().map(|m| m.id)).flatten();

        return Ok(MessagePage {
            items,
            has_more,
            next_before_id: None,
            next_after_id,
        });
    }

    let mut rows = sqlx::query_as!(
        MessageRow,
        r#"
        SELECT m.id, m.chat_id, m.content, m.reply_to_id, m.edited_at,
               m.deleted_at, m.created_at,
               u.id AS "sender_id?",
               u.username AS "sender_username?",
               u.display_name AS "sender_display_name?",
               u.avatar_url AS "sender_avatar_url?",
               r.content AS "reply_content?",
               r.deleted_at AS "reply_deleted_at?",
               ru.display_name AS "reply_sender_name?",
               a.id AS "attachment_id?",
               a.kind AS "attachment_kind?",
               a.file_name AS "attachment_file_name?",
               a.mime_type AS "attachment_mime_type?",
               a.size_bytes AS "attachment_size_bytes?",
               a.width AS "attachment_width?",
               a.height AS "attachment_height?",
               a.duration_ms AS "attachment_duration_ms?",
               a.thumbnail_key AS "attachment_thumbnail_key?"
        FROM messages m
        LEFT JOIN users u ON u.id = m.sender_id
        LEFT JOIN messages r ON r.id = m.reply_to_id
        LEFT JOIN users ru ON ru.id = r.sender_id
        LEFT JOIN attachments a ON a.message_id = m.id
        WHERE m.chat_id = $1
          AND ($2::BIGINT IS NULL OR m.id < $2)
        ORDER BY m.id DESC
        LIMIT $3 OFFSET $4
        "#,
        chat_id,
        page.before_id,
        fetch_limit,
        page.offset
    )
    .fetch_all(&state.pool)
    .await?;

    let has_more = rows.len() as i64 > page.limit;
    if has_more {
        rows.truncate(page.limit as usize);
    }
    rows.reverse();

    let items = rows.into_iter().map(message_from_row).collect::<Vec<_>>();
    let next_before_id = if has_more {
        items.first().map(|m| m.id)
    } else {
        None
    };

    Ok(MessagePage {
        items,
        has_more,
        next_before_id,
        next_after_id: None,
    })
}

pub async fn edit(
    state: &AppState,
    message_id: i64,
    user_id: i64,
    content: &str,
) -> AppResult<MessageDto> {
    let row = sqlx::query!(
        "SELECT chat_id, sender_id, deleted_at, has_attachment FROM messages WHERE id = $1",
        message_id
    )
    .fetch_optional(&state.pool)
    .await?
    .ok_or_else(|| AppError::NotFound("Сообщение не найдено".into()))?;

    chats::require_membership(&state.pool, row.chat_id, user_id).await?;

    if row.sender_id != Some(user_id) {
        return Err(AppError::Forbidden(
            "Редактировать можно только свои сообщения".into(),
        ));
    }
    if row.deleted_at.is_some() {
        return Err(AppError::Validation(
            "Нельзя редактировать удалённое сообщение".into(),
        ));
    }

    let content = if content.trim().is_empty() {
        if row.has_attachment {
            String::new()
        } else {
            return Err(AppError::Validation(
                "Сообщение не может быть пустым".into(),
            ));
        }
    } else {
        normalize_message(content, state.cfg.max_message_len)?
    };

    sqlx::query!(
        "UPDATE messages SET content = $2, edited_at = now() WHERE id = $1",
        message_id,
        content
    )
    .execute(&state.pool)
    .await?;

    let message = fetch_message(state, message_id).await?;
    state
        .hub
        .publish(
            row.chat_id,
            ServerEvent::MessageEdited {
                chat_id: row.chat_id,
                message: message.clone(),
            },
        )
        .await;

    Ok(message)
}

pub async fn delete(state: &AppState, message_id: i64, user_id: i64) -> AppResult<MessageDto> {
    let row = sqlx::query!(
        r#"
        SELECT m.chat_id, m.sender_id, m.deleted_at, c.kind,
               cm.role AS "role!"
        FROM messages m
        JOIN chats c ON c.id = m.chat_id
        JOIN chat_members cm ON cm.chat_id = m.chat_id AND cm.user_id = $2
        WHERE m.id = $1
        "#,
        message_id,
        user_id
    )
    .fetch_optional(&state.pool)
    .await?
    .ok_or_else(|| AppError::NotFound("Сообщение не найдено".into()))?;

    if row.deleted_at.is_some() {
        return fetch_message(state, message_id).await;
    }

    let is_author = row.sender_id == Some(user_id);
    let is_group_moderator = row.kind == KIND_GROUP && (row.role == "owner" || row.role == "admin");
    if !is_author && !is_group_moderator {
        return Err(AppError::Forbidden("Удалять это сообщение нельзя".into()));
    }

    sqlx::query!(
        "UPDATE messages SET deleted_at = now(), content = '' WHERE id = $1",
        message_id
    )
    .execute(&state.pool)
    .await?;

    let message = fetch_message(state, message_id).await?;
    state
        .hub
        .publish(
            row.chat_id,
            ServerEvent::MessageDeleted {
                chat_id: row.chat_id,
                message_id,
            },
        )
        .await;

    Ok(message)
}

pub async fn mark_read(
    state: &AppState,
    chat_id: i64,
    user_id: i64,
    message_id: i64,
) -> AppResult<ReadState> {
    chats::require_membership(&state.pool, chat_id, user_id).await?;

    let new_watermark = sqlx::query_scalar!(
        r#"
        UPDATE chat_members
        SET last_read_message_id = GREATEST(COALESCE(last_read_message_id, 0), $3)
        WHERE chat_id = $1
          AND user_id = $2
          AND EXISTS (
              SELECT 1 FROM messages WHERE id = $3 AND chat_id = $1
          )
        RETURNING last_read_message_id AS "last_read_message_id!"
        "#,
        chat_id,
        user_id,
        message_id
    )
    .fetch_optional(&state.pool)
    .await?;

    let Some(new_watermark) = new_watermark else {
        return Err(AppError::Validation(
            "Сообщение не принадлежит этому чату".into(),
        ));
    };

    let read_state = ReadState {
        chat_id,
        user_id,
        message_id: new_watermark,
    };

    state
        .hub
        .publish(
            chat_id,
            ServerEvent::ReadUpdated {
                chat_id,
                user_id,
                message_id: new_watermark,
            },
        )
        .await;

    Ok(read_state)
}

pub async fn fetch_message(state: &AppState, message_id: i64) -> AppResult<MessageDto> {
    let row = sqlx::query_as!(
        MessageRow,
        r#"
        SELECT m.id, m.chat_id, m.content, m.reply_to_id, m.edited_at,
               m.deleted_at, m.created_at,
               u.id AS "sender_id?",
               u.username AS "sender_username?",
               u.display_name AS "sender_display_name?",
               u.avatar_url AS "sender_avatar_url?",
               r.content AS "reply_content?",
               r.deleted_at AS "reply_deleted_at?",
               ru.display_name AS "reply_sender_name?",
               a.id AS "attachment_id?",
               a.kind AS "attachment_kind?",
               a.file_name AS "attachment_file_name?",
               a.mime_type AS "attachment_mime_type?",
               a.size_bytes AS "attachment_size_bytes?",
               a.width AS "attachment_width?",
               a.height AS "attachment_height?",
               a.duration_ms AS "attachment_duration_ms?",
               a.thumbnail_key AS "attachment_thumbnail_key?"
        FROM messages m
        LEFT JOIN users u ON u.id = m.sender_id
        LEFT JOIN messages r ON r.id = m.reply_to_id
        LEFT JOIN users ru ON ru.id = r.sender_id
        LEFT JOIN attachments a ON a.message_id = m.id
        WHERE m.id = $1
        "#,
        message_id
    )
    .fetch_optional(&state.pool)
    .await?
    .ok_or_else(|| AppError::NotFound("Сообщение не найдено".into()))?;

    Ok(message_from_row(row))
}

fn message_from_row(row: MessageRow) -> MessageDto {
    let is_deleted = row.deleted_at.is_some();
    let sender = match (row.sender_id, row.sender_username, row.sender_display_name) {
        (Some(id), Some(username), Some(display_name)) => Some(SenderInfo {
            id,
            username,
            display_name,
            avatar_url: row.sender_avatar_url,
        }),
        _ => None,
    };

    let reply_to = row.reply_to_id.map(|id| {
        let reply_deleted = row.reply_deleted_at.is_some();
        ReplyPreview {
            id,
            sender_name: row.reply_sender_name,
            content: if reply_deleted {
                String::new()
            } else {
                row.reply_content.unwrap_or_default()
            },
            is_deleted: reply_deleted,
        }
    });

    let attachment = if is_deleted {
        None
    } else {
        match (
            row.attachment_id,
            row.attachment_kind,
            row.attachment_file_name,
            row.attachment_mime_type,
            row.attachment_size_bytes,
        ) {
            (Some(id), Some(kind), Some(file_name), Some(mime_type), Some(size_bytes)) => {
                Some(AttachmentDto {
                    id,
                    kind,
                    file_name,
                    mime_type,
                    size_bytes,
                    width: row.attachment_width,
                    height: row.attachment_height,
                    duration_ms: row.attachment_duration_ms,
                    content_url: format!("/api/attachments/{id}/content"),
                    thumbnail_url: row
                        .attachment_thumbnail_key
                        .map(|_| format!("/api/attachments/{id}/thumbnail")),
                })
            }
            _ => None,
        }
    };

    MessageDto {
        id: row.id,
        chat_id: row.chat_id,
        sender,
        content: if is_deleted {
            String::new()
        } else {
            row.content
        },
        attachment,
        reply_to,
        created_at: row.created_at,
        edited_at: row.edited_at,
        deleted_at: row.deleted_at,
        is_deleted,
    }
}
