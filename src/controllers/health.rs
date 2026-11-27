use axum::{
    extract::State,
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use serde_json::json;

use crate::state::AppState;

pub async fn live() -> StatusCode {
    StatusCode::NO_CONTENT
}

pub async fn ready(State(state): State<AppState>) -> Response {
    let db_ok = sqlx::query_scalar!("SELECT 1 AS \"one!\"")
        .fetch_one(&state.pool)
        .await
        .is_ok();

    let mut redis = state.redis.clone();
    let ping: redis::RedisResult<String> = redis::cmd("PING").query_async(&mut redis).await;
    let redis_ok = matches!(ping, Ok(ref pong) if pong == "PONG");

    let status = if db_ok && redis_ok {
        StatusCode::OK
    } else {
        StatusCode::SERVICE_UNAVAILABLE
    };

    (
        status,
        Json(json!({
            "status": if db_ok && redis_ok { "ok" } else { "degraded" },
            "db": db_ok,
            "redis": redis_ok,
            "websocket_connections": state.ws.connection_count(),
        })),
    )
        .into_response()
}
