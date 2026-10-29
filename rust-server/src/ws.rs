//! WebSocket-слой CipherTalk (старый протокол фронтенда + боты).
//!
//! Авторизация:
//! 1. Бот: подключение с `?token=<bot-token>` — проверяется по хэшу в rqlite.
//! 2. Пользователь: первым сообщением `{"type":"auth","token":"<jwt>"}`.
//!
//! После успешной авторизации сервер присылает `{"type":"chats","chats":[...]}`.
//! Обработчики: `get_messages`, `send_message`, `start_chat`, `typing`, `ping`.
//! Рассылка новым участникам: `{"type":"new_message","message":{...}}` (camelCase).

use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Query, State};
use axum::response::Response;
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;
use uuid::Uuid;

use crate::auth::ApiError;
use crate::chat::build_chat;
use crate::db::Db;
use crate::models::{ChatMessage, ClientWsMsg, UserRecord};

// ============================ Реестр соединений ============================

#[derive(Debug, Clone)]
pub enum Identity {
    User { user_id: String },
    Bot { bot_id: String },
}

impl Identity {
    pub fn id(&self) -> &str {
        match self {
            Identity::User { user_id } => user_id,
            Identity::Bot { bot_id } => bot_id,
        }
    }
}

pub(crate) struct Conn {
    sender: tokio::sync::mpsc::UnboundedSender<String>,
    identity: Identity,
    last_seen: Mutex<Instant>,
}

/// Общий реестр активных сокетов: socket_id -> соединение.
#[derive(Clone, Default)]
pub struct WsRegistry {
    conns: Arc<Mutex<HashMap<String, Arc<Conn>>>>,
}

impl WsRegistry {
    pub(crate) async fn add(&self, socket_id: String, conn: Arc<Conn>) {
        self.conns.lock().await.insert(socket_id, conn);
    }

    pub async fn remove(&self, socket_id: &str) {
        self.conns.lock().await.remove(socket_id);
    }

    pub async fn touch(&self, socket_id: &str) {
        if let Some(c) = self.conns.lock().await.get(socket_id) {
            *c.last_seen.lock().await = Instant::now();
        }
    }

    /// Отправить сериализуемое событие конкретному соединению (по socket_id).
    #[allow(dead_code)] // утилита реестра: точечная доставка/отладка
    pub async fn send_to(&self, socket_id: &str, event: &impl Serialize) {
        if let Ok(json) = serde_json::to_string(event) {
            if let Some(c) = self.conns.lock().await.get(socket_id) {
                let _ = c.sender.send(json);
            }
        }
    }

    /// Разослать событие всем соединениям, чьи identity присутствуют в `member_ids`.
    pub async fn broadcast_to_members(&self, member_ids: &[String], event: &impl Serialize) {
        let json = match serde_json::to_string(event) {
            Ok(j) => j,
            Err(e) => {
                tracing::error!("broadcast serialize: {e}");
                return;
            }
        };
        let guard = self.conns.lock().await;
        for conn in guard.values() {
            if member_ids.iter().any(|m| m == conn.identity.id()) {
                let _ = conn.sender.send(json.clone());
            }
        }
    }

    /// Все известные соединения пользователя (несколько вкладок).
    pub async fn user_socket_ids(&self, user_id: &str) -> Vec<String> {
        self.conns
            .lock()
            .await
            .iter()
            .filter(|(_, c)| matches!(&c.identity, Identity::User { user_id: u } if u == user_id))
            .map(|(id, _)| id.clone())
            .collect()
    }

    /// Есть ли у пользователя хотя бы одно активное соединение.
    pub async fn is_user_online(&self, user_id: &str) -> bool {
        !self.user_socket_ids(user_id).await.is_empty()
    }

    /// Множество id пользователей, у которых есть хотя бы одно активное
    /// (авторизованное) соединение. Используется для флага `online` в событиях.
    pub async fn online_user_ids(&self) -> Vec<String> {
        let guard = self.conns.lock().await;
        let mut ids: Vec<String> = guard
            .values()
            .filter_map(|c| match &c.identity {
                Identity::User { user_id } if !user_id.is_empty() => Some(user_id.clone()),
                _ => None,
            })
            .collect();
        ids.sort();
        ids.dedup();
        ids
    }

    pub async fn count(&self) -> usize {
        self.conns.lock().await.len()
    }

    /// Закрыть «зависшие» соединения (нет активности дольше таймаута).
    pub async fn reap_stale(&self, timeout: Duration) -> usize {
        let now = Instant::now();
        let mut dead = Vec::new();
        {
            let guard = self.conns.lock().await;
            for (id, c) in guard.iter() {
                if now.duration_since(*c.last_seen.lock().await) > timeout {
                    dead.push(id.clone());
                }
            }
        }
        let n = dead.len();
        for id in dead {
            self.remove(&id).await;
        }
        n
    }
}

// ============================ События сервера ============================

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ChatsEvent {
    #[serde(rename = "type")]
    msg_type: &'static str,
    chats: Vec<crate::models::Chat>,
}

/// Присутствие пользователей: `{type:"presence", userId, online}`.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PresenceEvent<'a> {
    #[serde(rename = "type")]
    msg_type: &'static str,
    user_id: &'a str,
    online: bool,
}

/// Полный список id онлайн-пользователей (полезно для отладки/клиентов).
#[allow(dead_code)]
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct OnlineListEvent {
    #[serde(rename = "type")]
    msg_type: &'static str,
    online_user_ids: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ErrorEvent {
    #[serde(rename = "type")]
    msg_type: &'static str,
    message: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct NewMessageEvent {
    #[serde(rename = "type")]
    msg_type: &'static str,
    message: ChatMessage,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct MessagesEvent {
    #[serde(rename = "type")]
    msg_type: &'static str,
    chat_id: String,
    messages: Vec<ChatMessage>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TypingEvent {
    #[serde(rename = "type")]
    msg_type: &'static str,
    chat_id: String,
    user_id: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct StartChatEvent {
    #[serde(rename = "type")]
    msg_type: &'static str,
    chat: crate::models::Chat,
}

#[derive(Serialize)]
struct PongEvent {
    #[serde(rename = "type")]
    msg_type: &'static str,
}

// ============================ Хелперы ============================

/// Загрузить пользователя по id или вернуть ошибку. Используется и REST-слоем.
pub async fn load_user(db: &Db, id: &str) -> Result<UserRecord, ApiError> {
    db.find_user_by_id(id)
        .await
        .map_err(|e| {
            tracing::error!("db error: {e}");
            ApiError::new(axum::http::StatusCode::INTERNAL_SERVER_ERROR, "database error")
        })?
        .ok_or_else(|| ApiError::new(axum::http::StatusCode::UNAUTHORIZED, "user not found"))
}

async fn send_json(sender: &tokio::sync::mpsc::UnboundedSender<String>, event: &impl Serialize) {
    match serde_json::to_string(event) {
        Ok(j) => {
            let _ = sender.send(j);
        }
        Err(e) => tracing::error!("ws serialize: {e}"),
    }
}

async fn build_chats_event(db: &Db, user_id: &str) -> Result<ChatsEvent, crate::db::DbError> {
    let rows = db.get_user_chats(user_id).await?;
    let mut chats = Vec::with_capacity(rows.len());
    for (id, chat_type, name, created_at) in rows {
        // Ошибку сборки одного чата не считаем фатальной для всего списка.
        match build_chat(db, &id, &chat_type, &name, created_at, user_id).await {
            Ok(c) => chats.push(c),
            Err(e) => tracing::warn!("skip chat {id}: {:?}", e),
        }
    }
    Ok(ChatsEvent {
        msg_type: "chats",
        chats,
    })
}

/// Разослать событие присутствия всем участникам чатов пользователя.
async fn broadcast_presence(state: &WsState, user_id: &str, online: bool) {
    let chat_ids = match state.db.get_user_chat_ids(user_id).await {
        Ok(ids) => ids,
        Err(e) => {
            tracing::warn!("presence chat ids: {e}");
            return;
        }
    };
    let mut members: Vec<String> = Vec::new();
    for cid in chat_ids {
        if let Ok(ms) = state.db.get_chat_members(&cid).await {
            members.extend(ms);
        }
    }
    members.sort();
    members.dedup();
    state
        .registry
        .broadcast_to_members(&members, &PresenceEvent { msg_type: "presence", user_id, online })
        .await;
}

// ============================ Upgrade ============================

#[derive(Debug, Deserialize)]
pub struct WsQuery {
    #[serde(default)]
    pub token: Option<String>,
}

/// GET /ws — апгрейд сокета.
pub async fn ws_handler(
    ws: WebSocketUpgrade,
    State(state): State<WsState>,
    Query(q): Query<WsQuery>,
) -> Response {
    ws.on_upgrade(move |socket| run_socket(socket, state, q.token.unwrap_or_default()))
}

/// Общее состояние приложения (Axum state). Совпадает с состоянием WS-слоя:
/// база rqlite + реестр активных соединений.
pub type AppState = WsState;

#[derive(Clone)]
pub struct WsState {
    pub db: Db,
    pub registry: WsRegistry,
}

async fn run_socket(socket: WebSocket, state: WsState, url_token: String) {
    let socket_id = Uuid::new_v4().to_string();
    let (mut out, mut inbound) = socket.split();

    // Канал writer'а: обработчик бизнес-логики пишет сюда JSON, writer шлёт в сокет.
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<String>();
    let writer = tokio::spawn(async move {
        while let Some(json) = rx.recv().await {
            if out.send(Message::Text(json)).await.is_err() {
                break;
            }
        }
        // При завершении канала корректно закрываем сокет.
        let _ = out.send(Message::Close(None)).await;
    });

    // Бот-авторизация по URL выполняется до регистрации соединения.
    let mut identity: Option<Identity> = None;
    if !url_token.is_empty() {
        if let Some(bot) = crate::auth::ws_auth_bot(&state.db, &url_token).await {
            identity = Some(Identity::Bot { bot_id: bot.id });
        }
    }

    let conn = Arc::new(Conn {
        sender: tx.clone(),
        identity: identity.clone().unwrap_or(Identity::User { user_id: String::new() }),
        last_seen: Mutex::new(Instant::now()),
    });
    // Неавторизованные соединения тоже видим в реестре (для лимита/мониторинга),
    // но broadcast их пропускает, т.к. их identity пустой.
    state.registry.add(socket_id.clone(), conn.clone()).await;
    tracing::debug!("ws connected: {socket_id} (bot={})", identity.is_some());

    // Для бота сразу отдаём список чатов.
    if let Some(Identity::Bot { bot_id }) = &identity {
        match build_chats_event(&state.db, bot_id).await {
            Ok(ev) => send_json(&tx, &ev).await,
            Err(e) => tracing::error!("bot chats: {e}"),
        }
    }

    let auth_timeout = Duration::from_secs(10);
    let start = Instant::now();

    while let Some(msg) = inbound.next().await {
        state.registry.touch(&socket_id).await;
        match msg {
            Ok(Message::Text(text)) => {
                let parsed: ClientWsMsg = match serde_json::from_str(text.as_ref()) {
                    Ok(m) => m,
                    Err(e) => {
                        send_json(
                            &tx,
                            &ErrorEvent {
                                msg_type: "error",
                                message: format!("malformed json: {e}"),
                            },
                        )
                        .await;
                        continue;
                    }
                };
                match (&identity, parsed) {
                    // До авторизации принимается только auth.
                    (None, ClientWsMsg::Auth { token }) => {
                        match crate::auth::ws_auth_user(&state.db, &token).await {
                            Some(user) => {
                                let new_identity = Identity::User { user_id: user.id.clone() };
                                // Обновляем identity соединения в реестре.
                                let updated = Arc::new(Conn {
                                    sender: tx.clone(),
                                    identity: new_identity.clone(),
                                    last_seen: Mutex::new(Instant::now()),
                                });
                                state.registry.add(socket_id.clone(), updated).await;
                                identity = Some(new_identity);
                                match build_chats_event(&state.db, &user.id).await {
                                    Ok(ev) => send_json(&tx, &ev).await,
                                    Err(e) => tracing::error!("user chats: {e}"),
                                }
                                // Уведомляем контакты пользователя о его появлении в сети.
                                if state.registry.is_user_online(&user.id).await {
                                    broadcast_presence(&state, &user.id, true).await;
                                }
                            }
                            None => {
                                send_json(
                                    &tx,
                                    &ErrorEvent {
                                        msg_type: "error",
                                        message: "authentication failed".to_string(),
                                    },
                                )
                                .await;
                            }
                        }
                    }
                    (None, _) => {
                        if start.elapsed() > auth_timeout {
                            break;
                        }
                        send_json(
                            &tx,
                            &ErrorEvent {
                                msg_type: "error",
                                message: "not authenticated: send {\"type\":\"auth\",\"token\":...} first".to_string(),
                            },
                        )
                        .await;
                    }
                    (Some(idn), ev) => {
                        handle_event(&state, idn, &tx, ev).await;
                    }
                }
            }
            Ok(Message::Close(_)) => break,
            Ok(Message::Ping(_)) | Ok(Message::Pong(_)) | Ok(Message::Binary(_)) => {}
            Err(e) => {
                tracing::debug!("ws recv error {socket_id}: {e}");
                break;
            }
        }
    }

    let offline_notify = match &identity {
        Some(Identity::User { user_id }) if !user_id.is_empty() => {
            // Отправляем событие «вышел из сети» только если это последнее
            // соединение пользователя (другие вкладки ещё не закрыты иначе).
            let remaining = state
                .registry
                .user_socket_ids(user_id)
                .await
                .iter()
                .any(|sid| sid != &socket_id);
            if !remaining {
                Some(user_id.clone())
            } else {
                None
            }
        }
        _ => None,
    };
    state.registry.remove(&socket_id).await;
    if let Some(uid) = offline_notify {
        broadcast_presence(&state, &uid, false).await;
    }
    drop(tx);
    let _ = writer.await;
    tracing::debug!("ws disconnected: {socket_id} ({} conns left)", state.registry.count().await);
}

// ============================ Обработчики событий ============================

async fn handle_event(state: &WsState, identity: &Identity, tx: &tokio::sync::mpsc::UnboundedSender<String>, ev: ClientWsMsg) {
    let actor_id = identity.id().to_string();
    match ev {
        ClientWsMsg::Ping => {
            send_json(tx, &PongEvent { msg_type: "pong" }).await;
        }
        ClientWsMsg::Auth { token: _ } => {
            // Уже авторизованы — повторный auth игнорируется.
        }
        ClientWsMsg::GetMessages { chat_id, before_id, limit } => {
            match state.db.is_chat_member(&chat_id, &actor_id).await {
                Ok(true) => {
                    let lim = limit.unwrap_or(50).clamp(1, 100);
                    match state.db.get_chat_messages(&chat_id, before_id.as_deref(), lim).await {
                        Ok(messages) => {
                            send_json(
                                tx,
                                &MessagesEvent {
                                    msg_type: "messages",
                                    chat_id,
                                    messages,
                                },
                            )
                            .await;
                        }
                        Err(e) => tracing::error!("get_chat_messages: {e}"),
                    }
                }
                Ok(false) => {
                    send_json(
                        tx,
                        &ErrorEvent {
                            msg_type: "error",
                            message: "not a member of this chat".to_string(),
                        },
                    )
                    .await;
                }
                Err(e) => tracing::error!("is_chat_member: {e}"),
            }
        }
        ClientWsMsg::SendMessage { chat_id, content, iv, header, msg_type } => {
            if content.trim().is_empty() && iv.trim().is_empty() {
                send_json(
                    tx,
                    &ErrorEvent {
                        msg_type: "error",
                        message: "empty message".to_string(),
                    },
                )
                .await;
                return;
            }
            if content.len() > 64 * 1024 || iv.len() > 4096 || header.len() > 8192 {
                send_json(
                    tx,
                    &ErrorEvent {
                        msg_type: "error",
                        message: "message too large".to_string(),
                    },
                )
                .await;
                return;
            }
            let mtype = if msg_type.is_empty() { "text".to_string() } else { msg_type.clone() };
            match state.db.is_chat_member(&chat_id, &actor_id).await {
                Ok(true) => match state
                    .db
                    .save_message(&chat_id, &actor_id, &content, &iv, &header, &mtype)
                    .await
                {
                    Ok(message) => {
                        let members = match state.db.get_chat_members(&chat_id).await {
                            Ok(m) => m,
                            Err(e) => {
                                tracing::error!("get_chat_members: {e}");
                                vec![actor_id.clone()]
                            }
                        };
                        // Отправителю — эхо (все его вкладки), остальным — new_message.
                        let event = NewMessageEvent {
                            msg_type: "new_message",
                            message: message.clone(),
                        };
                        state.registry.broadcast_to_members(&members, &event).await;
                    }
                    Err(e) => tracing::error!("save_message: {e}"),
                },
                Ok(false) => {
                    send_json(
                        tx,
                        &ErrorEvent {
                            msg_type: "error",
                            message: "not a member of this chat".to_string(),
                        },
                    )
                    .await;
                }
                Err(e) => tracing::error!("is_chat_member: {e}"),
            }
        }
        ClientWsMsg::StartChat { user_id } => {
            if user_id == actor_id {
                send_json(
                    tx,
                    &ErrorEvent {
                        msg_type: "error",
                        message: "cannot chat with yourself".to_string(),
                    },
                )
                .await;
                return;
            }
            match start_private_chat(state, &actor_id, &user_id).await {
                Ok(chat) => {
                    // Дополнительно отдаём компактный результат (chatId + partner) —
                    // удобная форма для клиентов, которым не нужен весь объект чата.
                    if let Some(res) = chat.to_start_result() {
                        send_json(tx, &res).await;
                    }
                    send_json(tx, &StartChatEvent { msg_type: "chat_created", chat }).await;
                }
                Err(msg) => {
                    send_json(tx, &ErrorEvent { msg_type: "error", message: msg }).await;
                }
            }
        }
        ClientWsMsg::Typing { chat_id } => {
            match state.db.is_chat_member(&chat_id, &actor_id).await {
                Ok(true) => {
                    if let Ok(members) = state.db.get_chat_members(&chat_id).await {
                        let others: Vec<String> =
                            members.into_iter().filter(|m| m != &actor_id).collect();
                        state
                            .registry
                            .broadcast_to_members(
                                &others,
                                &TypingEvent {
                                    msg_type: "typing",
                                    chat_id,
                                    user_id: actor_id,
                                },
                            )
                            .await;
                    }
                }
                Ok(false) => {}
                Err(e) => tracing::error!("typing check: {e}"),
            }
        }
    }
}

/// Создать/найти личный чат между двумя id (для WS start_chat).
async fn start_private_chat(state: &WsState, me_id: &str, other_id: &str) -> Result<crate::models::Chat, String> {
    let me = load_user(&state.db, me_id)
        .await
        .map_err(|_| "actor not found".to_string())?;
    let other = load_user(&state.db, other_id)
        .await
        .map_err(|_| "target user not found".to_string())?;
    let chat_id = match state.db.find_private_chat(me_id, other_id).await.map_err(|e| e.to_string())? {
        Some(id) => id,
        None => {
            let name = format!("{}, {}", me.display_name, other.display_name);
            state
                .db
                .create_chat("private", &name, &[me.id.clone(), other.id.clone()])
                .await
                .map_err(|e| e.to_string())?
        }
    };
    let (chat_type, name, created_ms) = state
        .db
        .get_chat_meta(&chat_id)
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "chat missing".to_string())?;
    build_chat(&state.db, &chat_id, &chat_type, &name, created_ms, me_id)
        .await
        .map_err(|_| "failed to build chat".to_string())
}
