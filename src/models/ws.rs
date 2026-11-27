use serde::{Deserialize, Serialize};

use crate::models::{message::MessageDto, user::PublicUser};

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ClientEvent {
    Subscribe {
        chat_id: i64,
    },
    Unsubscribe {
        chat_id: i64,
    },
    Read {
        chat_id: i64,
        message_id: i64,
    },
    Typing {
        chat_id: i64,
    },
    Ping,
    #[serde(rename = "call.offer")]
    CallOffer {
        call_id: String,
        chat_id: i64,
        sdp: String,
        video: bool,
    },
    #[serde(rename = "call.answer")]
    CallAnswer {
        call_id: String,
        chat_id: i64,
        sdp: String,
    },
    #[serde(rename = "call.ice")]
    CallIce {
        call_id: String,
        chat_id: i64,
        candidate: serde_json::Value,
    },
    #[serde(rename = "call.end")]
    CallEnd {
        call_id: String,
        chat_id: i64,
        #[serde(default)]
        reason: Option<String>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ServerEvent {
    Ready {
        user_id: i64,
        session_id: i64,
    },
    Subscribed {
        chat_id: i64,
    },
    Unsubscribed {
        chat_id: i64,
    },
    #[serde(rename = "message.new")]
    MessageNew {
        chat_id: i64,
        message: MessageDto,
    },
    #[serde(rename = "message.edited")]
    MessageEdited {
        chat_id: i64,
        message: MessageDto,
    },
    #[serde(rename = "message.deleted")]
    MessageDeleted {
        chat_id: i64,
        message_id: i64,
    },
    Typing {
        chat_id: i64,
        user_id: i64,
        display_name: String,
    },
    #[serde(rename = "read.updated")]
    ReadUpdated {
        chat_id: i64,
        user_id: i64,
        message_id: i64,
    },
    #[serde(rename = "chat.removed")]
    ChatRemoved {
        chat_id: i64,
    },
    #[serde(rename = "call.offer")]
    CallOffer {
        call_id: String,
        chat_id: i64,
        from_user_id: i64,
        display_name: String,
        sdp: String,
        video: bool,
    },
    #[serde(rename = "call.answer")]
    CallAnswer {
        call_id: String,
        chat_id: i64,
        from_user_id: i64,
        sdp: String,
    },
    #[serde(rename = "call.ice")]
    CallIce {
        call_id: String,
        chat_id: i64,
        from_user_id: i64,
        candidate: serde_json::Value,
    },
    #[serde(rename = "call.end")]
    CallEnd {
        call_id: String,
        chat_id: i64,
        from_user_id: i64,
        reason: Option<String>,
    },
    #[serde(rename = "user.updated")]
    UserUpdated {
        user: PublicUser,
    },
    Pong,
    Error {
        code: String,
        message: String,
    },
}

/// Internal Redis envelope. The origin id prevents an instance from applying
/// its own event twice (it dispatches locally before publishing).
#[derive(Debug, Serialize, Deserialize)]
pub struct RealtimeEnvelope {
    pub origin: String,
    pub chat_id: i64,
    pub event: ServerEvent,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn realtime_event_names_are_stable_and_dotted() {
        let new_message = ServerEvent::MessageNew {
            chat_id: 42,
            message: MessageDto {
                id: 1,
                chat_id: 42,
                sender: None,
                content: "hi".to_owned(),
                attachment: None,
                reply_to: None,
                created_at: chrono::Utc::now(),
                edited_at: None,
                deleted_at: None,
                is_deleted: false,
            },
        };
        let value = serde_json::to_value(new_message).expect("serialize");
        assert_eq!(value["type"], "message.new");

        let deleted = serde_json::to_value(ServerEvent::MessageDeleted {
            chat_id: 42,
            message_id: 1,
        })
        .expect("serialize");
        assert_eq!(deleted["type"], "message.deleted");

        let removed =
            serde_json::to_value(ServerEvent::ChatRemoved { chat_id: 42 }).expect("serialize");
        assert_eq!(removed["type"], "chat.removed");

        let read = serde_json::to_value(ServerEvent::ReadUpdated {
            chat_id: 42,
            user_id: 7,
            message_id: 1,
        })
        .expect("serialize");
        assert_eq!(read["type"], "read.updated");
    }

    #[test]
    fn client_events_deserialize() {
        let event: ClientEvent =
            serde_json::from_value(json!({"type": "subscribe", "chat_id": 3})).expect("subscribe");
        assert!(matches!(event, ClientEvent::Subscribe { chat_id: 3 }));

        let event: ClientEvent = serde_json::from_value(json!({"type": "ping"})).expect("ping");
        assert!(matches!(event, ClientEvent::Ping));
    }
}
