use std::{
    collections::{HashMap, HashSet},
    time::{Duration, Instant},
};

use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        Query, State,
    },
    http::{header::ORIGIN, HeaderMap},
    response::Response,
};
use dashmap::{DashMap, DashSet};
use futures_util::{stream::SplitSink, SinkExt, StreamExt};
use rand::{rngs::OsRng, RngCore};
use serde::Deserialize;
use tokio::{
    sync::{mpsc, mpsc::error::TrySendError},
    time::{self, MissedTickBehavior},
};

use crate::{
    models::{
        auth::AuthUser,
        chat::KIND_PRIVATE,
        ws::{ClientEvent, RealtimeEnvelope, ServerEvent},
    },
    services::{auth, chats, messages, users},
    state::AppState,
    utils::AppError,
};

const REDIS_CHANNEL: &str = "ct:events";
const CONTROL_CHANNEL: &str = "ct:control";
const OUTGOING_BUFFER: usize = 256;

#[derive(Debug)]
struct Connection {
    user_id: i64,
    display_name: String,
    tx: mpsc::Sender<ServerEvent>,
    chats: DashSet<i64>,
}

/// Registry of live WebSocket connections and their chat subscriptions.
pub struct WsManager {
    connections: DashMap<u64, Connection>,
    rooms: DashMap<i64, HashSet<u64>>,
}

impl WsManager {
    pub fn new() -> Self {
        Self {
            connections: DashMap::new(),
            rooms: DashMap::new(),
        }
    }

    pub fn register(
        &self,
        conn_id: u64,
        user_id: i64,
        display_name: String,
        tx: mpsc::Sender<ServerEvent>,
    ) {
        self.connections.insert(
            conn_id,
            Connection {
                user_id,
                display_name,
                tx,
                chats: DashSet::new(),
            },
        );
    }

    pub fn subscribe(&self, conn_id: u64, chat_id: i64) -> bool {
        let Some(conn) = self.connections.get(&conn_id) else {
            return false;
        };
        conn.chats.insert(chat_id);
        drop(conn);
        self.rooms.entry(chat_id).or_default().insert(conn_id);
        true
    }

    pub fn unsubscribe(&self, conn_id: u64, chat_id: i64) {
        if let Some(conn) = self.connections.get(&conn_id) {
            conn.chats.remove(&chat_id);
        }
        if let Some(mut room) = self.rooms.get_mut(&chat_id) {
            room.remove(&conn_id);
        }
    }

    pub fn is_subscribed(&self, conn_id: u64, chat_id: i64) -> bool {
        self.rooms
            .get(&chat_id)
            .map(|room| room.contains(&conn_id))
            .unwrap_or(false)
    }

    pub fn remove(&self, conn_id: u64) {
        if let Some((_, conn)) = self.connections.remove(&conn_id) {
            let chats: Vec<i64> = conn.chats.iter().map(|chat| *chat).collect();
            for chat_id in chats {
                if let Some(mut room) = self.rooms.get_mut(&chat_id) {
                    room.remove(&conn_id);
                }
            }
        }
    }

    pub fn send(&self, conn_id: u64, event: ServerEvent) {
        if let Some(conn) = self.connections.get(&conn_id) {
            match conn.tx.try_send(event) {
                Ok(()) => {}
                Err(TrySendError::Full(_)) => {
                    tracing::debug!(conn_id, "websocket send buffer is full; dropping event");
                }
                Err(TrySendError::Closed(_)) => {}
            }
        }
    }

    pub fn dispatch(&self, chat_id: i64, event: &ServerEvent) {
        let recipients = match self.rooms.get(&chat_id) {
            Some(room) => room.iter().copied().collect::<Vec<_>>(),
            None => return,
        };

        for conn_id in recipients {
            if let Some(conn) = self.connections.get(&conn_id) {
                match conn.tx.try_send(event.clone()) {
                    Ok(()) => {}
                    Err(TrySendError::Full(_)) => {
                        tracing::debug!(
                            conn_id,
                            chat_id,
                            "websocket send buffer is full; dropping realtime event"
                        );
                    }
                    Err(TrySendError::Closed(_)) => {}
                }
            }
        }
    }

    pub fn display_name(&self, conn_id: u64) -> Option<String> {
        self.connections
            .get(&conn_id)
            .map(|conn| conn.display_name.clone())
    }

    pub fn update_display_name(&self, user_id: i64, display_name: &str) {
        for mut conn in self.connections.iter_mut() {
            if conn.user_id == user_id {
                conn.display_name = display_name.to_owned();
            }
        }
    }

    pub fn connection_count(&self) -> usize {
        self.connections.len()
    }

    /// Stops all sockets of a user from receiving a chat after they were
    /// removed from it. Without this, a removed member would keep seeing
    /// realtime events until the socket was re-established.
    pub fn evict_user_from_chat(&self, chat_id: i64, user_id: i64) {
        let conn_ids = self
            .connections
            .iter()
            .filter(|conn| conn.user_id == user_id)
            .map(|conn| *conn.key())
            .collect::<Vec<_>>();

        for conn_id in conn_ids {
            self.unsubscribe(conn_id, chat_id);
            self.send(conn_id, ServerEvent::ChatRemoved { chat_id });
        }
    }
}

impl Default for WsManager {
    fn default() -> Self {
        Self::new()
    }
}

/// Publishes events to local subscribers immediately and to other instances
/// through Redis Pub/Sub. `origin` prevents duplicate delivery of our own echo.
#[derive(Debug, serde::Serialize, serde::Deserialize)]
struct EvictionEnvelope {
    origin: String,
    chat_id: i64,
    user_id: i64,
}

#[derive(Clone)]
pub struct RealtimeHub {
    manager: std::sync::Arc<WsManager>,
    redis: redis::aio::ConnectionManager,
    instance_id: std::sync::Arc<String>,
}

impl RealtimeHub {
    pub fn new(manager: std::sync::Arc<WsManager>, redis: redis::aio::ConnectionManager) -> Self {
        Self {
            manager,
            redis,
            instance_id: std::sync::Arc::new(random_hex(8)),
        }
    }

    /// Stops delivery for a removed member on every instance, not just the one
    /// that served the HTTP request that removed them.
    pub async fn evict_user_from_chat(&self, chat_id: i64, user_id: i64) {
        self.manager.evict_user_from_chat(chat_id, user_id);

        let payload = match serde_json::to_string(&EvictionEnvelope {
            origin: (*self.instance_id).clone(),
            chat_id,
            user_id,
        }) {
            Ok(payload) => payload,
            Err(err) => {
                tracing::warn!(error = %err, "failed to serialise eviction event");
                return;
            }
        };

        let mut conn = self.redis.clone();
        let publish = async move {
            let result: redis::RedisResult<i64> =
                redis::AsyncCommands::publish(&mut conn, CONTROL_CHANNEL, payload).await;
            result
        };

        match time::timeout(Duration::from_millis(750), publish).await {
            Ok(Ok(_)) => {}
            Ok(Err(err)) => {
                tracing::warn!(error = %err, "failed to publish eviction event to Redis")
            }
            Err(_) => tracing::warn!("timed out publishing eviction event to Redis"),
        }
    }

    pub async fn publish(&self, chat_id: i64, event: ServerEvent) {
        self.manager.dispatch(chat_id, &event);

        let envelope = RealtimeEnvelope {
            origin: (*self.instance_id).clone(),
            chat_id,
            event,
        };

        let payload = match serde_json::to_string(&envelope) {
            Ok(payload) => payload,
            Err(err) => {
                tracing::warn!(error = %err, "failed to serialise realtime event");
                return;
            }
        };

        let mut conn = self.redis.clone();
        let publish = async move {
            let result: redis::RedisResult<i64> =
                redis::AsyncCommands::publish(&mut conn, REDIS_CHANNEL, payload).await;
            result
        };

        match time::timeout(Duration::from_millis(750), publish).await {
            Ok(Ok(_)) => {}
            Ok(Err(err)) => {
                tracing::warn!(error = %err, "failed to publish realtime event to Redis")
            }
            Err(_) => tracing::warn!("timed out publishing realtime event to Redis"),
        }
    }
}

/// Reconnects forever and forwards remote events into the local registry.
pub async fn run_redis_bridge(client: redis::Client, hub: RealtimeHub) {
    loop {
        match client.get_async_pubsub().await {
            Ok(mut pubsub) => {
                if let Err(err) = pubsub.subscribe(REDIS_CHANNEL).await {
                    tracing::warn!(error = %err, "failed to subscribe to Redis Pub/Sub");
                    time::sleep(Duration::from_secs(2)).await;
                    continue;
                }
                if let Err(err) = pubsub.subscribe(CONTROL_CHANNEL).await {
                    tracing::warn!(error = %err, "failed to subscribe to Redis control channel");
                    time::sleep(Duration::from_secs(2)).await;
                    continue;
                }

                tracing::info!("realtime bridge subscribed to {REDIS_CHANNEL} / {CONTROL_CHANNEL}");
                let mut stream = pubsub.on_message();
                while let Some(message) = stream.next().await {
                    let payload: String = match message.get_payload() {
                        Ok(payload) => payload,
                        Err(err) => {
                            tracing::warn!(error = %err, "invalid Redis Pub/Sub payload");
                            continue;
                        }
                    };

                    if message.get_channel_name() == CONTROL_CHANNEL {
                        match serde_json::from_str::<EvictionEnvelope>(&payload) {
                            Ok(eviction) if eviction.origin != *hub.instance_id => {
                                hub.manager
                                    .evict_user_from_chat(eviction.chat_id, eviction.user_id);
                            }
                            Ok(_) => {}
                            Err(err) => {
                                tracing::warn!(error = %err, "failed to decode eviction envelope")
                            }
                        }
                        continue;
                    }

                    let envelope: RealtimeEnvelope = match serde_json::from_str(&payload) {
                        Ok(envelope) => envelope,
                        Err(err) => {
                            tracing::warn!(error = %err, "failed to decode realtime envelope");
                            continue;
                        }
                    };

                    if envelope.origin != *hub.instance_id {
                        hub.manager.dispatch(envelope.chat_id, &envelope.event);
                    }
                }
                tracing::warn!("Redis Pub/Sub stream ended; reconnecting");
            }
            Err(err) => {
                tracing::warn!(error = %err, "failed to open Redis Pub/Sub connection");
            }
        }

        time::sleep(Duration::from_secs(2)).await;
    }
}

#[derive(Debug, Deserialize)]
pub struct WsQuery {
    pub token: String,
}

pub async fn ws_handler(
    State(state): State<AppState>,
    Query(query): Query<WsQuery>,
    headers: HeaderMap,
    ws: WebSocketUpgrade,
) -> Result<Response, AppError> {
    if !origin_allowed(&state, &headers) {
        return Err(AppError::Forbidden("Недопустимый Origin".into()));
    }

    let auth = auth::authenticate(&state, &query.token).await?;
    let ws = ws.max_message_size(64 * 1024).max_frame_size(64 * 1024);

    Ok(ws.on_upgrade(move |socket| handle_socket(state, auth, socket)))
}

async fn handle_socket(state: AppState, auth: AuthUser, socket: WebSocket) {
    let (mut sink, mut stream) = socket.split();
    let (tx, mut rx) = mpsc::channel::<ServerEvent>(OUTGOING_BUFFER);
    let conn_id = OsRng.next_u64();

    let display_name =
        match sqlx::query_scalar!("SELECT display_name FROM users WHERE id = $1", auth.user_id)
            .fetch_optional(&state.pool)
            .await
        {
            Ok(Some(name)) => name,
            Ok(None) => return,
            Err(err) => {
                tracing::warn!(error = %err, "failed to load display name for websocket");
                return;
            }
        };

    state.ws.register(conn_id, auth.user_id, display_name, tx);
    state.ws.send(
        conn_id,
        ServerEvent::Ready {
            user_id: auth.user_id,
            session_id: auth.session_id,
        },
    );

    if let Err(err) = users::touch_last_seen(&state.pool, auth.user_id).await {
        tracing::debug!(error = %err, "failed to update last_seen_at on connect");
    }

    let mut last_activity = Instant::now();
    let mut last_presence = Instant::now();
    let mut shutdown = state.shutdown.clone();
    let mut typing_last: HashMap<i64, Instant> = HashMap::new();
    let mut ticker = time::interval(Duration::from_secs(30));
    ticker.set_missed_tick_behavior(MissedTickBehavior::Delay);
    let mut ticks: u32 = 0;

    loop {
        tokio::select! {
            changed = shutdown.changed() => {
                if changed.is_err() || *shutdown.borrow() {
                    break;
                }
            }
            incoming = stream.next() => {
                match incoming {
                    Some(Ok(message)) => {
                        last_activity = Instant::now();
                        match message {
                            Message::Text(text) => {
                                handle_client_event(&state, conn_id, &auth, &text, &mut typing_last).await;
                            }
                            Message::Close(_) => break,
                            Message::Ping(_) | Message::Pong(_) | Message::Binary(_) => {}
                        }
                    }
                    Some(Err(err)) => {
                        tracing::debug!(error = %err, "websocket read error");
                        break;
                    }
                    None => break,
                }
            }
            outgoing = rx.recv() => {
                match outgoing {
                    Some(event) => {
                        if send_json(&mut sink, &event).await.is_err() {
                            break;
                        }
                    }
                    None => break,
                }
            }
            _ = ticker.tick() => {
                if last_activity.elapsed() > Duration::from_secs(90) {
                    tracing::debug!(conn_id, "websocket heartbeat timeout");
                    break;
                }

                if last_presence.elapsed() > Duration::from_secs(60) {
                    last_presence = Instant::now();
                    if let Err(err) = users::touch_last_seen(&state.pool, auth.user_id).await {
                        tracing::debug!(error = %err, "failed to refresh last_seen_at");
                    }
                }

                ticks = ticks.wrapping_add(1);
                // Every ~2 minutes ensure the session was not revoked (logout).
                if ticks.is_multiple_of(4)
                    && !auth::is_session_active(&state, auth.session_id, auth.user_id).await
                {
                    tracing::debug!(conn_id, "websocket session revoked");
                    break;
                }

                if sink.send(Message::Ping(Vec::new())).await.is_err() {
                    break;
                }
            }
        }
    }

    state.ws.remove(conn_id);
    if let Err(err) = users::touch_last_seen(&state.pool, auth.user_id).await {
        tracing::debug!(error = %err, "failed to update last_seen_at on disconnect");
    }
    let _ = sink.send(Message::Close(None)).await;
}

async fn handle_client_event(
    state: &AppState,
    conn_id: u64,
    auth: &AuthUser,
    text: &str,
    typing_last: &mut HashMap<i64, Instant>,
) {
    let event = match serde_json::from_str::<ClientEvent>(text) {
        Ok(event) => event,
        Err(err) => {
            tracing::debug!(error = %err, "invalid websocket client event");
            send_error(state, conn_id, "invalid_event", "Некорректное событие");
            return;
        }
    };

    match event {
        ClientEvent::Subscribe { chat_id } => {
            if chats::require_membership(&state.pool, chat_id, auth.user_id)
                .await
                .is_ok()
            {
                state.ws.subscribe(conn_id, chat_id);
                state.ws.send(conn_id, ServerEvent::Subscribed { chat_id });
            } else {
                send_error(state, conn_id, "not_a_member", "Чат не найден");
            }
        }
        ClientEvent::Unsubscribe { chat_id } => {
            state.ws.unsubscribe(conn_id, chat_id);
            state
                .ws
                .send(conn_id, ServerEvent::Unsubscribed { chat_id });
        }
        ClientEvent::Read {
            chat_id,
            message_id,
        } => {
            if !state.ws.is_subscribed(conn_id, chat_id) {
                send_error(
                    state,
                    conn_id,
                    "not_subscribed",
                    "Сначала подпишитесь на чат",
                );
                return;
            }
            if let Err(err) = messages::mark_read(state, chat_id, auth.user_id, message_id).await {
                send_error(state, conn_id, err.code(), &err.public_message());
            }
        }
        ClientEvent::Typing { chat_id } => {
            if !state.ws.is_subscribed(conn_id, chat_id) {
                send_error(
                    state,
                    conn_id,
                    "not_subscribed",
                    "Сначала подпишитесь на чат",
                );
                return;
            }

            if let Some(last) = typing_last.get(&chat_id) {
                if last.elapsed() < Duration::from_secs(3) {
                    return;
                }
            }
            typing_last.insert(chat_id, Instant::now());

            let Some(display_name) = state.ws.display_name(conn_id) else {
                return;
            };

            state
                .hub
                .publish(
                    chat_id,
                    ServerEvent::Typing {
                        chat_id,
                        user_id: auth.user_id,
                        display_name,
                    },
                )
                .await;
        }
        ClientEvent::Ping => {
            state.ws.send(conn_id, ServerEvent::Pong);
        }
        ClientEvent::CallOffer {
            call_id,
            chat_id,
            sdp,
            video,
        } => {
            if !valid_call_id(&call_id) || sdp.len() > 60_000 {
                send_error(state, conn_id, "invalid_call", "Некорректный вызов");
                return;
            }
            if !call_chat_allowed(state, conn_id, chat_id, auth.user_id).await {
                return;
            }
            let Some(display_name) = state.ws.display_name(conn_id) else {
                return;
            };
            state
                .hub
                .publish(
                    chat_id,
                    ServerEvent::CallOffer {
                        call_id,
                        chat_id,
                        from_user_id: auth.user_id,
                        display_name,
                        sdp,
                        video,
                    },
                )
                .await;
        }
        ClientEvent::CallAnswer {
            call_id,
            chat_id,
            sdp,
        } => {
            if !valid_call_id(&call_id) || sdp.len() > 60_000 {
                send_error(state, conn_id, "invalid_call", "Некорректный вызов");
                return;
            }
            if !call_chat_allowed(state, conn_id, chat_id, auth.user_id).await {
                return;
            }
            state
                .hub
                .publish(
                    chat_id,
                    ServerEvent::CallAnswer {
                        call_id,
                        chat_id,
                        from_user_id: auth.user_id,
                        sdp,
                    },
                )
                .await;
        }
        ClientEvent::CallIce {
            call_id,
            chat_id,
            candidate,
        } => {
            if !valid_call_id(&call_id) || candidate.to_string().len() > 16_384 {
                send_error(state, conn_id, "invalid_call", "Некорректный ICE-кандидат");
                return;
            }
            if !call_chat_allowed(state, conn_id, chat_id, auth.user_id).await {
                return;
            }
            state
                .hub
                .publish(
                    chat_id,
                    ServerEvent::CallIce {
                        call_id,
                        chat_id,
                        from_user_id: auth.user_id,
                        candidate,
                    },
                )
                .await;
        }
        ClientEvent::CallEnd {
            call_id,
            chat_id,
            reason,
        } => {
            if !valid_call_id(&call_id) {
                send_error(state, conn_id, "invalid_call", "Некорректный вызов");
                return;
            }
            if !call_chat_allowed(state, conn_id, chat_id, auth.user_id).await {
                return;
            }
            let reason = reason.map(|value| value.chars().take(200).collect::<String>());
            state
                .hub
                .publish(
                    chat_id,
                    ServerEvent::CallEnd {
                        call_id,
                        chat_id,
                        from_user_id: auth.user_id,
                        reason,
                    },
                )
                .await;
        }
    }
}

fn valid_call_id(call_id: &str) -> bool {
    !call_id.is_empty() && call_id.len() <= 64 && !call_id.chars().any(char::is_control)
}

async fn call_chat_allowed(state: &AppState, conn_id: u64, chat_id: i64, user_id: i64) -> bool {
    if !state.ws.is_subscribed(conn_id, chat_id) {
        send_error(
            state,
            conn_id,
            "not_subscribed",
            "Сначала подпишитесь на чат",
        );
        return false;
    }
    if chats::require_membership(&state.pool, chat_id, user_id)
        .await
        .is_err()
    {
        send_error(state, conn_id, "not_a_member", "Чат не найден");
        return false;
    }
    let kind = sqlx::query_scalar!("SELECT kind FROM chats WHERE id = $1", chat_id)
        .fetch_optional(&state.pool)
        .await;
    match kind {
        Ok(Some(kind)) if kind == KIND_PRIVATE => true,
        Ok(_) => {
            send_error(
                state,
                conn_id,
                "calls_private_only",
                "Звонки доступны только в личных чатах",
            );
            false
        }
        Err(err) => {
            tracing::warn!(error = %err, "call chat lookup failed");
            send_error(state, conn_id, "internal_error", "Не удалось проверить чат");
            false
        }
    }
}

fn send_error(state: &AppState, conn_id: u64, code: &str, message: &str) {
    state.ws.send(
        conn_id,
        ServerEvent::Error {
            code: code.to_owned(),
            message: message.to_owned(),
        },
    );
}

fn origin_allowed(state: &AppState, headers: &HeaderMap) -> bool {
    let Some(origin) = headers.get(ORIGIN) else {
        // Non-browser clients (mobile/native) do not send Origin.
        return true;
    };
    let Ok(origin) = origin.to_str() else {
        return false;
    };
    let origin = origin.trim_end_matches('/');

    if !state.cfg.cors_allowed_origins.is_empty() {
        return state
            .cfg
            .cors_allowed_origins
            .iter()
            .any(|allowed| allowed == origin);
    }

    // Same-origin fallback for deployments without an explicit allowlist.
    let host = headers
        .get(axum::http::header::HOST)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default();
    !host.is_empty() && (origin == format!("http://{host}") || origin == format!("https://{host}"))
}

async fn send_json(
    sink: &mut SplitSink<WebSocket, Message>,
    event: &ServerEvent,
) -> Result<(), axum::Error> {
    match serde_json::to_string(event) {
        Ok(payload) => sink.send(Message::Text(payload)).await,
        Err(err) => {
            tracing::warn!(error = %err, "failed to serialise websocket event");
            Ok(())
        }
    }
}

fn random_hex(bytes: usize) -> String {
    let mut buffer = vec![0u8; bytes];
    OsRng.fill_bytes(&mut buffer);
    hex::encode(buffer)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn dispatch_reaches_subscribed_connection() {
        let manager = WsManager::new();
        let (tx, mut rx) = mpsc::channel(8);
        manager.register(7, 1, "Bob".to_owned(), tx);
        assert!(manager.subscribe(7, 42));
        assert!(manager.is_subscribed(7, 42));

        manager.dispatch(42, &ServerEvent::Pong);
        let event = rx.try_recv().expect("event");
        assert!(matches!(event, ServerEvent::Pong));

        manager.unsubscribe(7, 42);
        assert!(!manager.is_subscribed(7, 42));

        assert!(manager.subscribe(7, 42));
        manager.evict_user_from_chat(42, 1);
        assert!(!manager.is_subscribed(7, 42));
        let removed = rx.try_recv().expect("chat.removed");
        assert!(matches!(removed, ServerEvent::ChatRemoved { chat_id: 42 }));
    }
}
