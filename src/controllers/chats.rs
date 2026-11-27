use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    Extension, Json,
};

use crate::{
    models::chat::KIND_GROUP,
    models::{
        auth::{AuthUser, OkResponse},
        chat::{
            AddMembersRequest, ChatDetails, ChatListResponse, ChatSummary, CreateGroupChatRequest,
            CreatePrivateChatRequest, ListChatsQuery,
        },
        message::{MarkReadRequest, ReadState},
    },
    services::chats as chat_service,
    state::AppState,
    utils::{
        error::{AppError, AppResult},
        pagination::{DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE},
    },
};

pub async fn list(
    State(state): State<AppState>,
    Extension(auth): Extension<AuthUser>,
    Query(query): Query<ListChatsQuery>,
) -> AppResult<Json<ChatListResponse>> {
    let limit = query.limit.unwrap_or(DEFAULT_PAGE_SIZE);
    if !(1..=MAX_PAGE_SIZE).contains(&limit) {
        return Err(AppError::Validation(format!(
            "limit должен быть от 1 до {MAX_PAGE_SIZE}"
        )));
    }
    let offset = query.offset.unwrap_or(0);
    if offset < 0 {
        return Err(AppError::Validation(
            "offset не может быть отрицательным".into(),
        ));
    }

    let items: Vec<ChatSummary> =
        chat_service::list_chats(&state, auth.user_id, limit, offset).await?;
    Ok(Json(ChatListResponse { items }))
}

pub async fn create_private(
    State(state): State<AppState>,
    Extension(auth): Extension<AuthUser>,
    Json(req): Json<CreatePrivateChatRequest>,
) -> AppResult<Json<ChatDetails>> {
    Ok(Json(
        chat_service::create_private(&state, auth.user_id, req.user_id).await?,
    ))
}

pub async fn create_group(
    State(state): State<AppState>,
    Extension(auth): Extension<AuthUser>,
    Json(req): Json<CreateGroupChatRequest>,
) -> AppResult<(StatusCode, Json<ChatDetails>)> {
    let details = chat_service::create_group(&state, auth.user_id, req).await?;
    if details.kind != KIND_GROUP {
        return Err(AppError::Internal(anyhow::anyhow!(
            "create_group returned a non-group chat"
        )));
    }
    Ok((StatusCode::CREATED, Json(details)))
}

pub async fn details(
    State(state): State<AppState>,
    Extension(auth): Extension<AuthUser>,
    Path(chat_id): Path<i64>,
) -> AppResult<Json<ChatDetails>> {
    Ok(Json(
        chat_service::get_details(&state, chat_id, auth.user_id).await?,
    ))
}

pub async fn add_members(
    State(state): State<AppState>,
    Extension(auth): Extension<AuthUser>,
    Path(chat_id): Path<i64>,
    Json(req): Json<AddMembersRequest>,
) -> AppResult<Json<ChatDetails>> {
    Ok(Json(
        chat_service::add_members(&state, chat_id, auth.user_id, req.user_ids).await?,
    ))
}

pub async fn remove_member(
    State(state): State<AppState>,
    Extension(auth): Extension<AuthUser>,
    Path((chat_id, target_id)): Path<(i64, i64)>,
) -> AppResult<Json<OkResponse>> {
    chat_service::remove_member(&state, chat_id, auth.user_id, target_id).await?;
    Ok(Json(OkResponse { ok: true }))
}

pub async fn mark_read(
    State(state): State<AppState>,
    Extension(auth): Extension<AuthUser>,
    Path(chat_id): Path<i64>,
    Json(req): Json<MarkReadRequest>,
) -> AppResult<Json<ReadState>> {
    Ok(Json(
        crate::services::messages::mark_read(&state, chat_id, auth.user_id, req.message_id).await?,
    ))
}
