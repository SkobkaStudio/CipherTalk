//! Простой in-memory rate-limit для чувствительных auth-эндпоинтов.
//!
//! Зачем: подбор кода/пароля должен упираться не только в счётчик попыток
//! конкретного номера, но и в лимит запросов с одного адреса. Без него
//! `/api/auth/start` можно дёргать бесконечно и перебирать коды/номера.
//!
//! Ограничение честно работает для одного процесса и не требует Redis.
//! За обратным прокси все запросы придут с его IP — там лимит нужно
//! выставлять на прокси (или поднять `AUTH_RATE_LIMIT`).

use std::collections::HashMap;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use axum::extract::{ConnectInfo, Request, State};
use axum::http::{header, StatusCode};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde_json::json;

use crate::ws::AppState;

/// Окно учёта запросов одного IP.
struct Window {
    started: Instant,
    count: u32,
}

/// Фиксированное окно: не больше `limit` запросов за `window` с одного IP.
pub struct RateLimiter {
    limit: u32,
    window: Duration,
    map: Mutex<HashMap<IpAddr, Window>>,
}

impl RateLimiter {
    /// `limit` запросов за `window`.
    pub fn new(limit: u32, window: Duration) -> Self {
        Self { limit, window, map: Mutex::new(HashMap::new()) }
    }

    /// Ok(()) — запрос пропускаем; Err(секунды) — лимит исчерпан.
    pub fn check(&self, ip: IpAddr) -> Result<(), u64> {
        let now = Instant::now();
        // Mutex отравить нечем (внутри нет паник), но и в этом случае продолжаем
        let mut map = self.map.lock().unwrap_or_else(|e| e.into_inner());
        // Периодическая уборка, чтобы карта не росла бесконечно
        if map.len() > 10_000 {
            map.retain(|_, w| now.duration_since(w.started) < self.window);
        }
        let entry = map.entry(ip).or_insert(Window { started: now, count: 0 });
        if now.duration_since(entry.started) >= self.window {
            entry.started = now;
            entry.count = 0;
        }
        entry.count += 1;
        if entry.count > self.limit {
            let elapsed = now.duration_since(entry.started).as_secs();
            return Err(self.window.as_secs().saturating_sub(elapsed).max(1));
        }
        Ok(())
    }
}

/// Мидлварь для /api/auth/{start,verify,finish,login}: лимит по IP.
/// 429 + Retry-After вместо молчаливого «сервер тормозит».
pub async fn auth_rate_limit(
    State(state): State<Arc<AppState>>,
    req: Request,
    next: Next,
) -> Response {
    // ConnectInfo кладёт axum, если сервер запущен через
    // `into_make_service_with_connect_info` (см. main.rs).
    let ip = req
        .extensions()
        .get::<ConnectInfo<SocketAddr>>()
        .map(|ci| ci.0.ip())
        .unwrap_or(IpAddr::V4(Ipv4Addr::UNSPECIFIED));
    match state.auth_limiter.check(ip) {
        Ok(()) => next.run(req).await,
        Err(retry_after) => (
            StatusCode::TOO_MANY_REQUESTS,
            [(header::RETRY_AFTER, retry_after.to_string())],
            Json(json!({
                "error": format!("Слишком много запросов. Повторите через {retry_after} с")
            })),
        )
            .into_response(),
    }
}
