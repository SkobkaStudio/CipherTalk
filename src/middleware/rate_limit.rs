use std::net::{IpAddr, Ipv4Addr, SocketAddr};

use axum::{
    extract::{ConnectInfo, Request, State},
    http::{header::HeaderName, HeaderValue},
    middleware::Next,
    response::Response,
};
use chrono::Utc;

use crate::{state::AppState, utils::AppError};

const RATE_LIMIT_SCRIPT: &str = r#"
local current = redis.call('INCR', KEYS[1])
if current == 1 then
  redis.call('EXPIRE', KEYS[1], ARGV[1])
end
return current
"#;

struct RateInfo {
    limit: u32,
    remaining: u32,
    reset_at: i64,
}

/// Distributed fixed-window limit for all API routes. Fails open (with a log)
/// when Redis is unavailable so that a cache outage does not take the API down.
pub async fn api_limit(
    State(state): State<AppState>,
    request: Request,
    next: Next,
) -> Result<Response, AppError> {
    apply_limit(
        &state,
        request,
        next,
        "api",
        state.cfg.rate_limit_api_per_minute,
        60,
    )
    .await
}

/// Stricter bucket for register/login/refresh/logout.
pub async fn auth_limit(
    State(state): State<AppState>,
    request: Request,
    next: Next,
) -> Result<Response, AppError> {
    apply_limit(
        &state,
        request,
        next,
        "auth",
        state.cfg.rate_limit_auth_per_minute,
        60,
    )
    .await
}

async fn apply_limit(
    state: &AppState,
    request: Request,
    next: Next,
    scope: &'static str,
    limit: u32,
    window_secs: u64,
) -> Result<Response, AppError> {
    let subject = client_ip(&request, state.cfg.trust_proxy)
        .map(|ip| ip.to_string())
        .unwrap_or_else(|| "unknown".to_owned());

    let bucket = Utc::now().timestamp() / window_secs as i64;
    let key = format!("ct:rl:{scope}:{subject}:{bucket}");

    let info = match increment(&state.redis, &key, window_secs).await {
        Ok(count) => {
            if count > limit as i64 {
                return Err(AppError::RateLimited {
                    retry_after: retry_after(window_secs),
                });
            }
            RateInfo {
                limit,
                remaining: limit.saturating_sub(count.max(0) as u32),
                reset_at: (bucket + 1) * window_secs as i64,
            }
        }
        Err(err) => {
            tracing::warn!(scope, error = %err, "rate limiter unavailable; failing open");
            RateInfo {
                limit,
                remaining: limit,
                reset_at: 0,
            }
        }
    };

    let mut response = next.run(request).await;
    let headers = response.headers_mut();
    insert_header(headers, "x-ratelimit-limit", &info.limit.to_string());
    insert_header(
        headers,
        "x-ratelimit-remaining",
        &info.remaining.to_string(),
    );
    insert_header(headers, "x-ratelimit-reset", &info.reset_at.to_string());
    Ok(response)
}

async fn increment(
    manager: &redis::aio::ConnectionManager,
    key: &str,
    window_secs: u64,
) -> redis::RedisResult<i64> {
    let mut conn = manager.clone();
    redis::Script::new(RATE_LIMIT_SCRIPT)
        .key(key)
        .arg(window_secs)
        .invoke_async(&mut conn)
        .await
}

fn retry_after(window_secs: u64) -> u64 {
    let now = Utc::now().timestamp();
    let next = (now / window_secs as i64 + 1) * window_secs as i64;
    (next - now).clamp(1, window_secs as i64) as u64
}

fn insert_header(headers: &mut axum::http::HeaderMap, name: &'static str, value: &str) {
    if let (Ok(name), Ok(value)) = (
        HeaderName::from_bytes(name.as_bytes()),
        HeaderValue::from_str(value),
    ) {
        headers.insert(name, value);
    }
}

fn client_ip(request: &Request, trust_proxy: bool) -> Option<IpAddr> {
    if trust_proxy {
        if let Some(value) = request
            .headers()
            .get("x-forwarded-for")
            .and_then(|v| v.to_str().ok())
        {
            if let Some(first) = value.split(',').next() {
                if let Ok(ip) = first.trim().parse::<IpAddr>() {
                    return Some(ip);
                }
            }
        }
        if let Some(value) = request
            .headers()
            .get("x-real-ip")
            .and_then(|v| v.to_str().ok())
        {
            if let Ok(ip) = value.trim().parse::<IpAddr>() {
                return Some(ip);
            }
        }
    }

    request
        .extensions()
        .get::<ConnectInfo<SocketAddr>>()
        .map(|ConnectInfo(addr)| addr.ip())
        .or(Some(IpAddr::V4(Ipv4Addr::UNSPECIFIED)))
}
