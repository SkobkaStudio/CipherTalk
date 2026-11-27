use serde::Serialize;

use crate::models::user::Me;

/// Authenticated principal inserted into request extensions by the auth
/// middleware and reused by every protected handler.
#[derive(Debug, Clone)]
pub struct AuthUser {
    pub user_id: i64,
    pub session_id: i64,
}

#[derive(Debug, Serialize)]
pub struct AuthResponse {
    pub access_token: String,
    pub token_type: &'static str,
    pub expires_in: i64,
    pub user: Me,
}

#[derive(Debug, Serialize)]
pub struct OkResponse {
    pub ok: bool,
}
