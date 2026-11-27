use std::sync::Arc;

use redis::aio::ConnectionManager;
use sqlx::PgPool;

use crate::{
    config::Config,
    services::push::PushService,
    ws::{RealtimeHub, WsManager},
};

/// Shared, cheaply-cloneable application state. Axum clones this per request.
#[derive(Clone)]
pub struct AppState {
    pub cfg: Arc<Config>,
    pub pool: PgPool,
    pub redis: ConnectionManager,
    pub ws: Arc<WsManager>,
    pub hub: RealtimeHub,
    pub push: Option<Arc<PushService>>,
    /// Closed when the process is shutting down, so long-lived WebSockets do
    /// not keep the graceful shutdown hanging.
    pub shutdown: tokio::sync::watch::Receiver<bool>,
}
