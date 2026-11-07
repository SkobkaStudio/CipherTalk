//! WebSocket-хендлер и брокер подписок на события чатов.
//!
//! Брокер — tokio::sync::broadcast: контроллер сообщений публикует событие
//! после сохранения в rqlite; каждый WS-коннект фильтрует поток по своим подпискам.

use crate::db::Db;
use crate::models::message::Message;
use axum::extract::ws::{Message as WsMessage, WebSocket, WebSocketUpgrade};
use axum::extract::{Query, State};
use axum::response::IntoResponse;
use futures_util::{SinkExt, StreamExt}; // split/next/send
use serde::Deserialize;
use serde_json::json;
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// Сколько живёт тикет на подключение к WS.
const WS_TICKET_TTL: Duration = Duration::from_secs(30);

/// Одноразовый тикет для /ws: чтобы JWT не уезжал в URL (и в логи прокси).
pub struct WsTicket {
    user_id: i64,
    expires_at: Instant,
}

/// Общий state приложения для всех хендлеров (HTTP и WS).
pub struct AppState {
    pub db: Db,
    pub jwt_secret: String,
    /// Канал рассылки новых сообщений всем WS-подключённым
    pub tx: Arc<tokio::sync::broadcast::Sender<Message>>,
    /// Выданные тикеты на WS-подключение (одноразовые, TTL 30 с)
    pub ws_tickets: Arc<Mutex<HashMap<String, WsTicket>>>,
    /// Лимит запросов на auth-эндпоинты
    pub auth_limiter: Arc<crate::middleware::rate_limit::RateLimiter>,
}

impl AppState {
    /// Выдаёт одноразовый тикет для подключения к /ws.
    pub fn issue_ws_ticket(&self, user_id: i64) -> String {
        use base64::Engine;
        use rand::Rng;
        let bytes: [u8; 24] = rand::thread_rng().gen();
        let ticket = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes);
        let now = Instant::now();
        let mut map = self.ws_tickets.lock().unwrap_or_else(|e| e.into_inner());
        // Убираем просроченные, чтобы карта не росла
        map.retain(|_, t| t.expires_at > now);
        map.insert(ticket.clone(), WsTicket { user_id, expires_at: now + WS_TICKET_TTL });
        ticket
    }

    /// Проверяет и сразу «сжигает» тикет: повторно им воспользоваться нельзя.
    pub fn consume_ws_ticket(&self, ticket: &str) -> Option<i64> {
        if ticket.is_empty() {
            return None;
        }
        let mut map = self.ws_tickets.lock().unwrap_or_else(|e| e.into_inner());
        let t = map.remove(ticket)?;
        (t.expires_at > Instant::now()).then_some(t.user_id)
    }
}

/// Событие от клиента: {"type":"subscribe","chat_id":N}
#[derive(Debug, Deserialize)]
struct ClientEvent {
    #[serde(rename = "type")]
    kind: String,
    chat_id: Option<i64>,
}

/// Запрос на подключение: GET /ws?ticket=... (тикет выдаёт GET /api/ws-ticket).
///
/// Раньше JWT передавался прямо в query string — он оседал в логах прокси и
/// истории запросов. Теперь это одноразовый тикет на 30 секунд: утёкший URL
/// уже ничего не даёт. Проверка происходит ДО апгрейда.
pub async fn ws_handler(
    ws: WebSocketUpgrade,
    State(state): State<Arc<AppState>>,
    Query(q): Query<HashMap<String, String>>,
) -> impl IntoResponse {
    let ticket = q.get("ticket").cloned().unwrap_or_default();
    match state.consume_ws_ticket(&ticket) {
        Some(user_id) => {
            ws.on_upgrade(move |socket| handle_socket(socket, state, user_id))
                .into_response()
        }
        None => axum::http::StatusCode::UNAUTHORIZED.into_response(),
    }
}

/// Основной цикл одного WS-соединения: параллельно читаем команды клиента
/// и пересылаем подходящие broadcast-события.
async fn handle_socket(socket: WebSocket, state: Arc<AppState>, user_id: i64) {
    // Разделяем сокет на части чтения/записи, чтобы писать из обеих задач
    let (mut sink, mut stream) = socket.split();

    // Подписки этого соединения: набор chat_id
    let subs: Arc<Mutex<HashSet<i64>>> = Default::default();
    // Очередь текстовых фреймов, которые надо отправить клиенту
    let (out_tx, mut out_rx) = tokio::sync::mpsc::unbounded_channel::<String>();
    let out_tx_reader = out_tx.clone(); // копия передатчика для цикла чтения клиента
    // Подписчик глобального broadcast-канала сообщений
    let mut rx = state.tx.subscribe();
    let subs2 = subs.clone();

    // Задача 1: фильтрация broadcast-потока по подпискам -> очередь отправки
    let filter_task = tokio::spawn(async move {
        loop {
            match rx.recv().await {
                Ok(msg) => {
                    let subscribed =
                        subs2.lock().map(|s| s.contains(&msg.chat_id)).unwrap_or(false);
                    if subscribed {
                        let payload = json!({
                            "type": "message",
                            "chat_id": msg.chat_id,
                            "user_id": msg.user_id,
                            "username": msg.username,
                            "body": msg.body,
                            "created_at": msg.created_at,
                        });
                        if out_tx.send(payload.to_string()).is_err() {
                            break; // сокет закрыт
                        }
                    }
                }
                // Отстающий читатель: историю можно добрать через REST, просто продолжаем
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                Err(_) => break,
            }
        }
    });

    // Задача 2: запись очередей во фреймы сокета
    let write_task = tokio::spawn(async move {
        while let Some(text) = out_rx.recv().await {
            if sink.send(WsMessage::Text(text)).await.is_err() {
                break;
            }
        }
    });

    // Цикл чтения команд клиента
    while let Some(Ok(frame)) = stream.next().await {
        let txt = match frame {
            WsMessage::Text(t) => t.to_string(),
            WsMessage::Close(_) => break,
            _ => continue,
        };
        match serde_json::from_str::<ClientEvent>(&txt) {
            Ok(ev) if ev.kind == "subscribe" => {
                if let Some(cid) = ev.chat_id {
                    // Пускаем только в чаты, где пользователь реально состоит
                    let member = crate::services::chat_service::is_member(&state.db, cid, user_id)
                        .await
                        .unwrap_or(false);
                    if member {
                        if let Ok(mut s) = subs.lock() {
                            s.insert(cid);
                        }
                        let _ = out_tx_reader.send(json!({"type":"subscribed","chat_id":cid}).to_string());
                    } else {
                        let _ = out_tx_reader
                            .send(json!({"type":"error","error":"not a member of chat"}).to_string());
                    }
                }
            }
            Ok(ev) if ev.kind == "unsubscribe" => {
                if let (Some(cid), Ok(mut s)) = (ev.chat_id, subs.lock()) {
                    s.remove(&cid);
                }
            }
            _ => {} // неизвестные события игнорируем
        }
    }

    // Клиент отключился — останавливаем служебные задачи
    filter_task.abort();
    write_task.abort();
}
