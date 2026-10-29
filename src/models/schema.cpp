// ============================================================
// SQL-схема приложения. Идемпотентна: CREATE TABLE IF NOT EXISTS.
// users — аккаунты (логин, хеш пароля)
// chats — диалоги (личные и групповые)
// chat_participants — связь многие-ко-многим пользователь<->чат
// messages — сообщения в чатах
// ============================================================
#include "models/schema.hpp"
#include "models/database.hpp"

bool initSchema() {
    const char* script = R"SQL(
CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    username      TEXT UNIQUE NOT NULL,
    display_name  TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    created_at    INTEGER NOT NULL               -- unix-time регистрации
);

CREATE TABLE IF NOT EXISTS chats (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    type        TEXT NOT NULL DEFAULT 'private', -- private | group
    name        TEXT,                            -- имя для группового чата
    created_by  INTEGER NOT NULL REFERENCES users(id),
    created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS chat_participants (
    chat_id    INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    joined_at  INTEGER NOT NULL,
    PRIMARY KEY (chat_id, user_id)
);

CREATE TABLE IF NOT EXISTS messages (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id    INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    sender_id  INTEGER NOT NULL REFERENCES users(id),
    text       TEXT NOT NULL,
    created_at INTEGER NOT NULL                  -- unix-time отправки
);

-- Индексы для быстрых выборок
CREATE INDEX IF NOT EXISTS idx_messages_chat   ON messages(chat_id, id);
CREATE INDEX IF NOT EXISTS idx_participants_user ON chat_participants(user_id);
)SQL";
    return g_db && g_db->execScript(script);
}
