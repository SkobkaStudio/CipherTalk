use axum::{
    extract::{Query, State},
    Extension, Json,
};
use serde::Deserialize;

use crate::{
    models::{
        auth::AuthUser,
        user::{Me, PublicUser, UpdateProfileRequest},
    },
    services::users as user_service,
    state::AppState,
    utils::error::AppResult,
};

#[derive(Debug, Deserialize)]
pub struct SearchQuery {
    pub q: String,
}

pub async fn me(
    State(state): State<AppState>,
    Extension(auth): Extension<AuthUser>,
) -> AppResult<Json<Me>> {
    Ok(Json(user_service::get_me(&state, auth.user_id).await?))
}

pub async fn update_me(
    State(state): State<AppState>,
    Extension(auth): Extension<AuthUser>,
    Json(req): Json<UpdateProfileRequest>,
) -> AppResult<Json<Me>> {
    Ok(Json(
        user_service::update_me(&state, auth.user_id, req).await?,
    ))
}

pub async fn search(
    State(state): State<AppState>,
    Extension(auth): Extension<AuthUser>,
    Query(query): Query<SearchQuery>,
) -> AppResult<Json<Vec<PublicUser>>> {
    Ok(Json(
        user_service::search_users(&state, auth.user_id, &query.q).await?,
    ))
}
