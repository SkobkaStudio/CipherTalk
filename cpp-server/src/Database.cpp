#include "Database.h"
#include <ctime>
#include <stdexcept>
#include <algorithm>

namespace {
int64_t nowMs() {
    return std::chrono::duration_cast<std::chrono::milliseconds>(
               std::chrono::system_clock::now().time_since_epoch())
        .count();
}

// Читает TEXT-колонку, отображая NULL в пустую строку.
std::string textOrNull(SQLite::Statement& stmt, int col) {
    if (stmt.isColumnNull(col)) return std::string();
    return stmt.getColumn(col).getString();
}
} // namespace

std::unique_ptr<Database> Database::open(const std::string& path, const std::string& cipher_key) {
    // OPEN_FULLMUTEX: SQLite сам защищает соединение на случай внешних гонок;
    // дополнительно весь доступ к БД сериализуется Database::mtx_.
    auto db = std::make_unique<SQLite::Database>(
        path, SQLite::OPEN_READWRITE | SQLite::OPEN_CREATE | SQLite::OPEN_FULLMUTEX);

    // Ключ SQLCipher должен быть задан до любых операций с данными.
    // Экранирование одинарных кавычек в ключе для PRAGMA key '...'
    std::string escaped_key;
    for (char c : cipher_key) {
        if (c == '\'') escaped_key += "''";
        else escaped_key += c;
    }
    // PRAGMA key не поддерживает bind(), поэтому аккуратно экранируем литерал.
    SQLite::Statement key_stmt(*db, "PRAGMA key = '" + escaped_key + "'");
    key_stmt.exec();

    // Проверка, что ключ подошёл (чтение служебной таблицы).
    try {
        SQLite::Statement probe(*db, "SELECT count(*) FROM sqlite_master");
        probe.executeStep();
    } catch (const SQLite::Exception&) {
        throw std::runtime_error("Failed to open encrypted database: bad cipher key or corrupt file");
    }

    return std::unique_ptr<Database>(new Database(std::move(db)));
}

Database::Database(std::unique_ptr<SQLite::Database> db) : db_(std::move(db)) {}

void Database::ensureSchema() {
    std::lock_guard<std::mutex> lock(mtx_);
    db_->exec(
        "CREATE TABLE IF NOT EXISTS users ("
        "  id INTEGER PRIMARY KEY AUTOINCREMENT,"
        "  phone TEXT UNIQUE,"
        "  username TEXT,"
        "  password_hash TEXT,"
        "  public_key TEXT,"
        "  created_at INTEGER DEFAULT (strftime('%s','now'))"
        ")");
    db_->exec(
        "CREATE TABLE IF NOT EXISTS chats ("
        "  id INTEGER PRIMARY KEY AUTOINCREMENT,"
        "  type TEXT NOT NULL DEFAULT 'private',"
        "  title TEXT,"
        "  created_by INTEGER,"
        "  created_at INTEGER DEFAULT (strftime('%s','now'))"
        ")");
    db_->exec(
        "CREATE TABLE IF NOT EXISTS chat_members ("
        "  chat_id INTEGER NOT NULL,"
        "  user_id INTEGER NOT NULL,"
        "  joined_at INTEGER DEFAULT (strftime('%s','now')),"
        "  PRIMARY KEY (chat_id, user_id)"
        ")");
    db_->exec(
        "CREATE TABLE IF NOT EXISTS messages ("
        "  id INTEGER PRIMARY KEY AUTOINCREMENT,"
        "  chat_id INTEGER NOT NULL,"
        "  sender_id INTEGER NOT NULL,"
        "  content TEXT NOT NULL,"
        "  timestamp INTEGER NOT NULL"
        ")");
    db_->exec("CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages(chat_id, id)");
    db_->exec(
        "CREATE TABLE IF NOT EXISTS sessions ("
        "  sid TEXT PRIMARY KEY,"
        "  user_id INTEGER NOT NULL,"
        "  expires_at INTEGER NOT NULL"
        ")");

    // --- Шаг 1: миграция users.is_bot через PRAGMA table_info ---
    bool has_is_bot = false;
    {
        SQLite::Statement pragma(*db_, "PRAGMA table_info(users)");
        while (pragma.executeStep()) {
            if (pragma.getColumn("name").getString() == "is_bot") { has_is_bot = true; break; }
        }
    }
    if (!has_is_bot) {
        db_->exec("ALTER TABLE users ADD COLUMN is_bot INTEGER DEFAULT 0");
    }

    // --- Шаг 1: таблица токенов ботов ---
    db_->exec(
        "CREATE TABLE IF NOT EXISTS bot_tokens ("
        "  id INTEGER PRIMARY KEY AUTOINCREMENT,"
        "  bot_id INTEGER NOT NULL,"
        "  token_hash TEXT NOT NULL UNIQUE,"
        "  created_at INTEGER DEFAULT (strftime('%s','now'))"
        ")");
    db_->exec("CREATE INDEX IF NOT EXISTS idx_bot_tokens_hash ON bot_tokens(token_hash)");

    db_->exec("DELETE FROM sessions WHERE expires_at < " + std::to_string(static_cast<long long>(nowMs() / 1000)));
}

// ---------------- users ----------------

std::optional<UserRow> Database::findUserByPhone(const std::string& phone) {
    std::lock_guard<std::mutex> lock(mtx_);
    SQLite::Statement q(*db_, "SELECT id, phone, username, password_hash, is_bot FROM users WHERE phone = ?");
    q.bind(1, phone);
    if (!q.executeStep()) return std::nullopt;
    UserRow u;
    u.id = q.getColumn(0).getInt64();
    u.phone = textOrNull(q, 1);
    u.username = textOrNull(q, 2);
    u.password_hash = textOrNull(q, 3);
    u.is_bot = q.getColumn(4).getInt() != 0;
    return u;
}

std::optional<UserRow> Database::findUserById(long long id) {
    std::lock_guard<std::mutex> lock(mtx_);
    SQLite::Statement q(*db_, "SELECT id, phone, username, password_hash, is_bot FROM users WHERE id = ?");
    q.bind(1, static_cast<long long>(id));
    if (!q.executeStep()) return std::nullopt;
    UserRow u;
    u.id = q.getColumn(0).getInt64();
    u.phone = textOrNull(q, 1);
    u.username = textOrNull(q, 2);
    u.password_hash = textOrNull(q, 3);
    u.is_bot = q.getColumn(4).getInt() != 0;
    return u;
}

long long Database::createUser(const std::string& phone, const std::string& password_hash) {
    std::lock_guard<std::mutex> lock(mtx_);
    SQLite::Statement q(*db_, "INSERT INTO users (phone, password_hash, is_bot) VALUES (?, ?, 0)");
    q.bind(1, phone);
    q.bind(2, password_hash);
    q.exec();
    return db_->getLastInsertRowid();
}

long long Database::createBotUser(const std::string& username) {
    std::lock_guard<std::mutex> lock(mtx_);
    // phone = NULL, password_hash = NULL, is_bot = 1
    SQLite::Statement q(*db_,
        "INSERT INTO users (phone, username, password_hash, is_bot) VALUES (NULL, ?, NULL, 1)");
    q.bind(1, username);
    q.exec();
    return db_->getLastInsertRowid();
}

// ---------------- bot_tokens ----------------

void Database::insertBotToken(long long bot_id, const std::string& token_hash) {
    std::lock_guard<std::mutex> lock(mtx_);
    SQLite::Statement q(*db_, "INSERT INTO bot_tokens (bot_id, token_hash) VALUES (?, ?)");
    q.bind(1, static_cast<long long>(bot_id));
    q.bind(2, token_hash);
    q.exec();
}

std::optional<long long> Database::findBotIdByTokenHash(const std::string& token_hash) {
    std::lock_guard<std::mutex> lock(mtx_);
    SQLite::Statement q(*db_,
        "SELECT bt.bot_id FROM bot_tokens bt JOIN users u ON u.id = bt.bot_id "
        "WHERE bt.token_hash = ? AND u.is_bot = 1");
    q.bind(1, token_hash);
    if (!q.executeStep()) return std::nullopt;
    return q.getColumn(0).getInt64();
}

// ---------------- sessions ----------------

void Database::createSession(const std::string& sid, long long user_id, int64_t expires_at) {
    std::lock_guard<std::mutex> lock(mtx_);
    SQLite::Statement q(*db_, "INSERT OR REPLACE INTO sessions (sid, user_id, expires_at) VALUES (?, ?, ?)");
    q.bind(1, sid);
    q.bind(2, static_cast<long long>(user_id));
    q.bind(3, static_cast<long long>(expires_at));
    q.exec();
}

bool Database::sessionActive(const std::string& sid, long long user_id) {
    std::lock_guard<std::mutex> lock(mtx_);
    SQLite::Statement q(*db_,
        "SELECT 1 FROM sessions WHERE sid = ? AND user_id = ? AND expires_at >= ?");
    q.bind(1, sid);
    q.bind(2, static_cast<long long>(user_id));
    q.bind(3, static_cast<long long>(std::time(nullptr)));
    return q.executeStep();
}

void Database::revokeSession(const std::string& sid) {
    std::lock_guard<std::mutex> lock(mtx_);
    SQLite::Statement q(*db_, "DELETE FROM sessions WHERE sid = ?");
    q.bind(1, sid);
    q.exec();
}

// ---------------- chats ----------------

long long Database::createChat(const std::string& type, const std::string& title) {
    std::lock_guard<std::mutex> lock(mtx_);
    if (title.empty()) {
        SQLite::Statement q(*db_, "INSERT INTO chats (type, title) VALUES (?, NULL)");
        q.bind(1, type);
        q.exec();
    } else {
        SQLite::Statement q(*db_, "INSERT INTO chats (type, title) VALUES (?, ?)");
        q.bind(1, type);
        q.bind(2, title);
        q.exec();
    }
    return db_->getLastInsertRowid();
}

void Database::addChatMember(long long chat_id, long long user_id) {
    std::lock_guard<std::mutex> lock(mtx_);
    SQLite::Statement q(*db_,
        "INSERT OR IGNORE INTO chat_members (chat_id, user_id) VALUES (?, ?)");
    q.bind(1, static_cast<long long>(chat_id));
    q.bind(2, static_cast<long long>(user_id));
    q.exec();
}

bool Database::isChatMember(long long chat_id, long long user_id) {
    std::lock_guard<std::mutex> lock(mtx_);
    SQLite::Statement q(*db_, "SELECT 1 FROM chat_members WHERE chat_id = ? AND user_id = ?");
    q.bind(1, static_cast<long long>(chat_id));
    q.bind(2, static_cast<long long>(user_id));
    return q.executeStep();
}

std::optional<ChatRow> Database::findChat(long long chat_id) {
    std::lock_guard<std::mutex> lock(mtx_);
    SQLite::Statement q(*db_, "SELECT id, type, title FROM chats WHERE id = ?");
    q.bind(1, static_cast<long long>(chat_id));
    if (!q.executeStep()) return std::nullopt;
    ChatRow c;
    c.id = q.getColumn(0).getInt64();
    c.type = q.getColumn(1).getString();
    c.title = textOrNull(q, 2);
    return c;
}

long long Database::ensurePrivateChat(long long user_a, long long user_b) {
    {
        std::lock_guard<std::mutex> lock(mtx_);
        SQLite::Statement q(*db_,
            "SELECT cm1.chat_id FROM chat_members cm1 "
            "JOIN chat_members cm2 ON cm1.chat_id = cm2.chat_id "
            "JOIN chats ch ON ch.id = cm1.chat_id "
            "WHERE cm1.user_id = ? AND cm2.user_id = ? AND ch.type = 'private' "
            "AND (SELECT COUNT(*) FROM chat_members x WHERE x.chat_id = cm1.chat_id) = 2 "
            "LIMIT 1");
        q.bind(1, static_cast<long long>(user_a));
        q.bind(2, static_cast<long long>(user_b));
        if (q.executeStep()) return q.getColumn(0).getInt64();
    }
    std::lock_guard<std::mutex> lock(mtx_);
    SQLite::Statement ins(*db_, "INSERT INTO chats (type, title) VALUES ('private', NULL)");
    ins.exec();
    long long chat_id = db_->getLastInsertRowid();
    SQLite::Statement m1(*db_, "INSERT INTO chat_members (chat_id, user_id) VALUES (?, ?)");
    m1.bind(1, static_cast<long long>(chat_id));
    m1.bind(2, static_cast<long long>(user_a));
    m1.exec();
    SQLite::Statement m2(*db_, "INSERT INTO chat_members (chat_id, user_id) VALUES (?, ?)");
    m2.bind(1, static_cast<long long>(chat_id));
    m2.bind(2, static_cast<long long>(user_b));
    m2.exec();
    return chat_id;
}

std::vector<long long> Database::chatIdsForUser(long long user_id) {
    std::lock_guard<std::mutex> lock(mtx_);
    std::vector<long long> out;
    SQLite::Statement q(*db_, "SELECT chat_id FROM chat_members WHERE user_id = ? ORDER BY chat_id");
    q.bind(1, static_cast<long long>(user_id));
    while (q.executeStep()) out.push_back(q.getColumn(0).getInt64());
    return out;
}

// ---------------- messages ----------------

long long Database::insertMessage(long long chat_id, long long sender_id,
                                  const std::string& encrypted_content, int64_t timestamp) {
    std::lock_guard<std::mutex> lock(mtx_);
    SQLite::Statement q(*db_,
        "INSERT INTO messages (chat_id, sender_id, content, timestamp) VALUES (?, ?, ?, ?)");
    q.bind(1, static_cast<long long>(chat_id));
    q.bind(2, static_cast<long long>(sender_id));
    q.bind(3, encrypted_content);
    q.bind(4, static_cast<long long>(timestamp));
    q.exec();
    return db_->getLastInsertRowid();
}

// Шаг 4: история сообщений. Задача описана как
//   SELECT * FROM messages WHERE chat_id = ? AND id < ? ORDER BY id DESC LIMIT ?
// Здесь тот же запрос, но withId<0 означает «без фильтра пагинации» (первая страница):
// условие id<? добавляется только когда beforeId > 0 — иначе первая страница была бы пустой.
std::vector<MessageRow> Database::getChatMessages(int chatId, int limit /*=50*/, int beforeId /*=0*/) {
    std::lock_guard<std::mutex> lock(mtx_);
    if (limit <= 0) limit = 50;
    if (limit > 500) limit = 500; // защита от выкачивания всей истории одним запросом

    std::string sql = "SELECT id, chat_id, sender_id, content, timestamp FROM messages WHERE chat_id = ?";
    if (beforeId > 0) sql += " AND id < ?";
    sql += " ORDER BY id DESC LIMIT ?";

    std::vector<MessageRow> out;
    SQLite::Statement q(*db_, sql);
    int param = 1;
    q.bind(param++, static_cast<long long>(chatId));
    if (beforeId > 0) q.bind(param++, static_cast<long long>(beforeId));
    q.bind(param++, static_cast<long long>(limit));

    while (q.executeStep()) {
        MessageRow m;
        m.id = q.getColumn(0).getInt64();
        m.chat_id = q.getColumn(1).getInt64();
        m.sender_id = q.getColumn(2).getInt64();
        m.content = q.getColumn(3).getString();
        m.timestamp = q.getColumn(4).getInt64();
        out.push_back(std::move(m));
    }
    // Храним в порядке убывания (для cursor-пагинации), клиенту отдаём в хронологическом.
    std::reverse(out.begin(), out.end());
    return out;
}
