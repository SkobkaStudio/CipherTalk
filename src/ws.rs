//! WebSocket-сервер и broadcast-брокер реального времени.
//!
//! Один общий `broadcast::Sender<Message>` живёт в [`AppState`]. Каждое
//! WS-соединение подписывается на канал и хранит набор `chat_id`, на которые
//! клиент явно подписался. Сообщение уходит только тем соединениям, чей набор
//! содержит `chat_id` сообщения.
//!
//! Протокол:
//! * клиент → сервер: `{"type":"subscribe","chat_id":1}`
//! * сервер → клиент: `{"type":"message","chat_id":1,...,"body":"..."}`
//! * сервер → клиент: `{"type":"subscribed","chat_id":1}`
//! * сервер → клиент: `{"type":"error","error":"..."}`

use crate::db::Db;
use crate::models::message::Message;
use crate::services::chat_service;
use crate::utils::error::{AppError, AppResult};
use crate::utils::jwt::{decode_token, Claims};
use axum::extract::ws::{Message as WsMessage, WebSocket, WebSocketUpgrade};
use axum::extract::{Query, State};
use axum::response::Response;
use futures_util::stream::SplitSink;
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::HashSet;
use std::sync::Arc;
use tokio::sync::broadcast;

/// Общее состояние приложения, доступное всем хендлерам и WS-соединениям.
#[derive(Clone)]
pub struct AppState {
    /// Клиент rqlite.
    pub db: Db,
    /// Секрет JWT (Arc, чтобы не копировать строку на каждый запрос).
    pub jwt_secret: Arc<String>,
    /// Broadcast-канал новых сообщений.
    pub tx: broadcast::Sender<Message>,
}

/// Query-параметры подключения: `/ws?token=...`.
#[derive(Debug, Deserialize)]
pub struct WsQuery {
    token: Option<String>,
}

/// Сообщение от клиента.
#[derive(Debug, Deserialize)]
struct ClientEvent {
    #[serde(rename = "type")]
    kind: String,
    #[serde(default)]
    chat_id: Option<i64>,
}

/// GET /ws?token=JWT — апгрейд до WebSocket.
///
/// Токен проверяется ДО апгрейда: при невалидном JWT клиент получает 401 и
/// соединение не поднимается.
pub async fn ws_handler(
    State(state): State<AppState>,
    Query(query): Query<WsQuery>,
    websocket: WebSocketUpgrade,
) -> AppResult<Response> {
    let token = query
        .token
        .filter(|token| !token.trim().is_empty())
        .ok_or_else(|| AppError::Unauthorized("Не передан token в query-параметре".into()))?;

    let claims = decode_token(token.trim(), state.jwt_secret.as_str())?;

    Ok(websocket.on_upgrade(move |socket| handle_socket(socket, state, claims)))
}

/// Основной цикл соединения: параллельно читает команды клиента и broadcast.
async fn handle_socket(socket: WebSocket, state: AppState, claims: Claims) {
    let (mut sender, mut receiver) = socket.split();
    let mut broker = state.tx.subscribe();
    let mut subscriptions: HashSet<i64> = HashSet::new();

    loop {
        tokio::select! {
            // ── команда от клиента ──────────────────────────────────────
            incoming = receiver.next() => {
                match incoming {
                    Some(Ok(WsMessage::Text(text))) => {
                        let event = match serde_json::from_str::<ClientEvent>(&text) {
                            Ok(event) => event,
                            Err(_) => {
                                if !send_json(&mut sender, &error_event("Некорректный JSON")).await {
                                    break;
                                }
                                continue;
                            }
                        };

                        match event.kind.as_str() {
                            "subscribe" => {
                                let Some(chat_id) = event.chat_id else {
                                    if !send_json(&mut sender, &error_event("Не указан chat_id")).await {
                                        break;
                                    }
                                    continue;
                                };

                                // Подписываться можно только на чаты, где пользователь состоит.
                                match chat_service::is_member(&state.db, chat_id, claims.sub).await {
                                    Ok(true) => {
                                        subscriptions.insert(chat_id);
                                        let event = json!({ "type": "subscribed", "chat_id": chat_id });
                                        if !send_json(&mut sender, &event).await {
                                            break;
                                        }
                                    }
                                    Ok(false) => {
                                        let event = error_event("Вы не состоите в этом чате");
                                        if !send_json(&mut sender, &event).await {
                                            break;
                                        }
                                    }
                                    Err(error) => {
                                        tracing::error!("не удалось проверить членство в чате: {error}");
                                        let event = error_event("Ошибка проверки доступа к чату");
                                        if !send_json(&mut sender, &event).await {
                                            break;
                                        }
                                    }
                                }
                            }
                            "unsubscribe" => {
                                if let Some(chat_id) = event.chat_id {
                                    subscriptions.remove(&chat_id);
                                    let event = json!({ "type": "unsubscribed", "chat_id": chat_id });
                                    if !send_json(&mut sender, &event).await {
                                        break;
                                    }
                                }
                            }
                            "ping" => {
                                if !send_json(&mut sender, &json!({ "type": "pong" })).await {
                                    break;
                                }
                            }
                            other => {
                                let message = format!("Неизвестный тип сообщения: {other}");
                                if !send_json(&mut sender, &error_event(&message)).await {
                                    break;
                                }
                            }
                        }
                    }
                    Some(Ok(WsMessage::Close(_))) | None => break,
                    // Ping/Pong/бинарные кадры не участвуют в протоколе.
                    Some(Ok(_)) => {}
                    Some(Err(error)) => {
                        tracing::debug!("ошибка чтения WS: {error}");
                        break;
                    }
                }
            }

            // ── новое сообщение из общего брокера ───────────────────────
            outgoing = broker.recv() => {
                match outgoing {
                    Ok(message) => {
                        if subscriptions.contains(&message.chat_id)
                            && !send_json(&mut sender, &message_event(&message)).await
                        {
                            break;
                        }
                    }
                    Err(broadcast::error::RecvError::Lagged(skipped)) => {
                        // Медленный клиент пропустил часть истории — соединение
                        // не рвём, но предупреждаем в логе.
                        tracing::warn!(
                            "WS-клиент {} отстал на {} сообщений",
                            claims.sub,
                            skipped
                        );
                    }
                    Err(broadcast::error::RecvError::Closed) => break,
                }
            }
        }
    }

    tracing::debug!("WS-соединение пользователя {} закрыто", claims.sub);
}

/// Отправляет JSON-кадр; `false` означает, что соединение пора закрывать.
async fn send_json(sender: &mut SplitSink<WebSocket, WsMessage>, value: &Value) -> bool {
    sender
        .send(WsMessage::Text(value.to_string()))
        .await
        .is_ok()
}

/// Событие `message` в формате, который ждёт фронтенд.
fn message_event(message: &Message) -> Value {
    json!({
        "type": "message",
        "chat_id": message.chat_id,
        "user_id": message.user_id,
        "username": &message.username,
        "body": &message.body,
        "created_at": message.created_at,
    })
}

/// Событие ошибки протокола.
fn error_event(message: &str) -> Value {
    json!({ "type": "error", "error": message })
}
