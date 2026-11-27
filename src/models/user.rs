use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

/// Public profile of another user. Never contains email or password hash.
#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
pub struct PublicUser {
    pub id: i64,
    pub username: String,
    pub display_name: String,
    pub bio: String,
    pub avatar_url: Option<String>,
    pub last_seen_at: Option<DateTime<Utc>>,
}

/// Full profile of the authenticated user (returned only to that user).
#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
pub struct Me {
    pub id: i64,
    pub username: String,
    pub email: Option<String>,
    pub display_name: String,
    pub bio: String,
    pub avatar_url: Option<String>,
    pub created_at: DateTime<Utc>,
    pub last_seen_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Deserialize)]
pub struct RegisterRequest {
    pub username: String,
    pub password: String,
    pub display_name: String,
    pub email: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct LoginRequest {
    /// Username or email; case-insensitive.
    pub username: String,
    pub password: String,
}

#[derive(Debug, Deserialize)]
pub struct UpdateProfileRequest {
    pub display_name: Option<String>,
    pub bio: Option<String>,
    pub avatar_url: Option<String>,
}
