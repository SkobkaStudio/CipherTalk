use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    Extension, Json,
};

use crate::{
    models::{
        auth::AuthUser,
        message::{EditMessageRequest, MessageDto, MessagePage, SendMessageRequest},
    },
    services::messages as message_service,
    state::AppState,
    utils::{error::AppResult, pagination::HistoryQuery},
};

pub async fn history(
    State(state): State<AppState>,
    Extension(auth): Extension<AuthUser>,
    Path(chat_id): Path<i64>,
    Query(query): Query<HistoryQuery>,
) -> AppResult<Json<MessagePage>> {
    let page = query.normalize()?;
    Ok(Json(
        message_service::history(&state, chat_id, auth.user_id, page).await?,
    ))
}

pub async fn send(
    State(state): State<AppState>,
    Extension(auth): Extension<AuthUser>,
    Path(chat_id): Path<i64>,
    Json(req): Json<SendMessageRequest>,
) -> AppResult<(StatusCode, Json<MessageDto>)> {
    let message = message_service::send(
        &state,
        chat_id,
        auth.user_id,
        &req.content,
        req.reply_to_id,
        req.attachment_id,
    )
    .await?;
    Ok((StatusCode::CREATED, Json(message)))
}

pub async fn edit(
    State(state): State<AppState>,
    Extension(auth): Extension<AuthUser>,
    Path(message_id): Path<i64>,
    Json(req): Json<EditMessageRequest>,
) -> AppResult<Json<MessageDto>> {
    Ok(Json(
        message_service::edit(&state, message_id, auth.user_id, &req.content).await?,
    ))
}

pub async fn delete(
    State(state): State<AppState>,
    Extension(auth): Extension<AuthUser>,
    Path(message_id): Path<i64>,
) -> AppResult<Json<MessageDto>> {
    Ok(Json(
        message_service::delete(&state, message_id, auth.user_id).await?,
    ))
}
