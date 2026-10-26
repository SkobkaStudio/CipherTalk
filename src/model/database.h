// =============================================================================
//  model/database.h — подключение к SQLite, схема и миграции (слой MODEL, часть 1)
// =============================================================================
//  База данных — файл messenger.db рядом с бинарником. Движок: sqlite3.
//
//  Схема повторяет сущности Telegram:
//   users        — аккаунты (логин, хэш пароля, аватар, bio, публичный E2EE-ключ)
//   sessions     — авторизационные токены cookie sid
//   chats        — диалоги: private (личка), group (группа), channel (канал)
//   chat_members — кто в каком чате + роль (owner/admin/member) + last_read (непрочитанные)
//   messages     — сообщения; поле content хранит ЗАШИФРОВАННЫЙ контейнер E2EE
//   attachments  — файлы (картинки/документы), лежат в data/files/, в БД только путь
//   reactions    — реакции на сообщения (👍 ❤️ 🔥 ...)
//   message_views— статусы прочтения конкретных сообщений (галочки ✓✓)
//   contacts     — адресная книга пользователя
//   pinned       — закреплённые сообщения чата
// =============================================================================
#pragma once
#include <string>
#include <stdexcept>
#include <sqlite3.h>

class Database {
public:
    // Открыть (или создать) файл БД и применить схему
    explicit Database(const std::string& path = "messenger.db") {
        if (sqlite3_open(path.c_str(), &db_) != SQLITE_OK)
            throw std::runtime_error("Не удалось открыть БД: " + std::string(sqlite3_errmsg(db_)));
        exec("PRAGMA journal_mode=WAL;");   // конкурентные чтение/запись без блокировок
        exec("PRAGMA foreign_keys=ON;");    // внешние ключи: удалил чат — удалились сообщения
        createSchema();
    }
    ~Database() { sqlite3_close(db_); }

    sqlite3* raw() const { return db_; }

    // Выполнить SQL без результата (DDL/вставка). Бросает исключение при ошибке.
    void exec(const std::string& sql) {
        char* err = nullptr;
        if (sqlite3_exec(db_, sql.c_str(), nullptr, nullptr, &err) != SQLITE_OK) {
            std::string m = err ? err : "?";
            sqlite3_free(err);
            throw std::runtime_error("SQL error: " + m + " [" + sql + "]");
        }
    }
    long long lastInsertId() const { return sqlite3_last_insert_rowid(db_); }

private:
    sqlite3* db_ = nullptr;

    void createSchema() {
        exec(R"SQL(
        -- ---------- ПОЛЬЗОВАТЕЛИ ----------
        CREATE TABLE IF NOT EXISTS users (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            username    TEXT UNIQUE NOT NULL,           -- @login как в TG
            password    TEXT NOT NULL,                  -- pbkdf2$..., никогда не открытый пароль
            name        TEXT NOT NULL DEFAULT '',       -- отображаемое имя
            bio         TEXT NOT NULL DEFAULT '',       -- «о себе» из профиля
            avatar      TEXT NOT NULL DEFAULT '',       -- цвет аватара (#rrggbb) или data-url
            e2ee_pub    TEXT NOT NULL DEFAULT '',       -- ПУБЛИЧНЫЙ RSA-ключ для E2EE (PEM base64)
            created_at  INTEGER NOT NULL,               -- unix-time регистрации
            last_seen   INTEGER NOT NULL DEFAULT 0,     -- для статуса «был(а) в сети ...»
            online      INTEGER NOT NULL DEFAULT 0      -- текущее состояние (обновляет WS)
        );

        -- ---------- СЕССИИ (cookie sid -> user) ----------
        CREATE TABLE IF NOT EXISTS sessions (
            token       TEXT PRIMARY KEY,
            user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            created_at  INTEGER NOT NULL
        );

        -- ---------- ЧАТЫ: личка / группа / канал ----------
        CREATE TABLE IF NOT EXISTS chats (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            type        TEXT NOT NULL CHECK(type IN ('private','group','channel')),
            title       TEXT NOT NULL DEFAULT '',       -- название группы/канала
            about       TEXT NOT NULL DEFAULT '',       -- описание группы
            avatar      TEXT NOT NULL DEFAULT '',       -- цвет аватара группы
            owner_id    INTEGER REFERENCES users(id),   -- создатель (для групп — админ по умолчанию)
            invite_link TEXT NOT NULL DEFAULT '',       -- ссылка-приглашение, как t.me/+abc
            created_at  INTEGER NOT NULL
        );

        -- ---------- УЧАСТНИКИ ЧАТА ----------
        CREATE TABLE IF NOT EXISTS chat_members (
            chat_id     INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
            user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            role        TEXT NOT NULL DEFAULT 'member', -- owner | admin | member
            joined_at   INTEGER NOT NULL,
            last_read   INTEGER NOT NULL DEFAULT 0,     -- id последнего прочитанного сообщения
            PRIMARY KEY (chat_id, user_id)
        );

        -- ---------- СООБЩЕНИЯ ----------
        -- content_type: 'text' | 'encrypted' (E2EE-контейнер) | 'image' | 'file' | 'service'
        -- content:      для encrypted — JSON вида {"iv":"b64","ct":"b64"} (сервер его НЕ читает!)
        CREATE TABLE IF NOT EXISTS messages (
            id           INTEGER PRIMARY KEY AUTOINCREMENT,
            chat_id      INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
            sender_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
            content_type TEXT NOT NULL DEFAULT 'text',
            content      TEXT NOT NULL DEFAULT '',
            reply_to     INTEGER REFERENCES messages(id) ON DELETE SET NULL, -- «ответ на сообщение»
            edited_at    INTEGER NOT NULL DEFAULT 0,     -- время редактирования (0 = не редактировалось)
            deleted      INTEGER NOT NULL DEFAULT 0,     -- «удалено пользователем» (soft-delete)
            created_at   INTEGER NOT NULL,
            hash         TEXT NOT NULL DEFAULT ''        -- sha256 содержимого (для edit/delete проверок)
        );
        CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages(chat_id, id);

        -- ---------- ФАЙЛЫ (вложения) ----------
        CREATE TABLE IF NOT EXISTS attachments (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            message_id  INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
            uploader_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            filename    TEXT NOT NULL,
            mime        TEXT NOT NULL DEFAULT 'application/octet-stream',
            size        INTEGER NOT NULL DEFAULT 0,
            storage_key TEXT NOT NULL,                 -- имя файла в data/files/
            created_at  INTEGER NOT NULL
        );

        -- ---------- РЕАКЦИИ ----------
        CREATE TABLE IF NOT EXISTS reactions (
            message_id  INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
            user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            emoji       TEXT NOT NULL,
            PRIMARY KEY (message_id, user_id, emoji)
        );

        -- ---------- ПРОЧТЕНИЕ КОНКРЕТНЫХ СООБЩЕНИЙ (двойные галочки ✓✓) ----------
        CREATE TABLE IF NOT EXISTS message_views (
            message_id  INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
            user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            viewed_at   INTEGER NOT NULL,
            PRIMARY KEY (message_id, user_id)
        );

        -- ---------- КОНТАКТЫ (адресная книга) ----------
        CREATE TABLE IF NOT EXISTS contacts (
            owner_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            contact_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            PRIMARY KEY (owner_id, contact_id)
        );

        -- ---------- ЗАКРЕПЛЁННЫЕ СООБЩЕНИЯ ----------
        CREATE TABLE IF NOT EXISTS pinned (
            chat_id     INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
            message_id  INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
            PRIMARY KEY (chat_id, message_id)
        );
        )SQL");
    }
};
