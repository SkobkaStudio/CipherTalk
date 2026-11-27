use serde::{Deserialize, Serialize};

#[derive(Debug, Deserialize)]
pub struct PushSubscriptionRequest {
    pub endpoint: String,
    pub p256dh: String,
    pub auth: String,
}

#[derive(Debug, Deserialize)]
pub struct PushUnsubscribeRequest {
    pub endpoint: String,
}

#[derive(Debug, Serialize)]
pub struct PushKeyResponse {
    pub enabled: bool,
    pub public_key: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct PushTestResponse {
    pub sent: usize,
}
