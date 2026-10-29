// ============================================================
// Реализация модели Message: вставка и выборка сообщений.
// ============================================================
#include "models/message.hpp"
#include "models/database.hpp"

#include <ctime>
#include <algorithm>

int64_t Message::create(int64_t chatId, int64_t senderId, const std::string& text) {
    int64_t now = static_cast<int64_t>(std::time(nullptr));
    sqlite3_stmt* stmt = g_db->prepare(
        "INSERT INTO messages (chat_id, sender_id, text, created_at) VALUES (?,?,?,?);");
    if (!stmt) return -1;
    sqlite3_bind_int64(stmt, 1, chatId);
    sqlite3_bind_int64(stmt, 2, senderId);
    sqlite3_bind_text(stmt, 3, text.c_str(), -1, SQLITE_TRANSIENT);
    sqlite3_bind_int64(stmt, 4, now);
    if (sqlite3_step(stmt) != SQLITE_DONE) {
        g_db->finalize(stmt);
        return -1;
    }
    g_db->finalize(stmt);

    sqlite3_stmt* q = g_db->prepare("SELECT last_insert_rowid();");
    int64_t id = -1;
    if (q && sqlite3_step(q) == SQLITE_ROW) id = sqlite3_column_int64(q, 0);
    g_db->finalize(q);
    return id;
}

// Прочитать строку результата в Message (колонки: id, chat_id, sender_id, text, created_at)
static void readMsg(sqlite3_stmt* stmt, Message& m) {
    m.id = sqlite3_column_int64(stmt, 0);
    m.chatId = sqlite3_column_int64(stmt, 1);
    m.senderId = sqlite3_column_int64(stmt, 2);
    const unsigned char* t = sqlite3_column_text(stmt, 3);
    m.text = t ? reinterpret_cast<const char*>(t) : "";
    m.createdAt = sqlite3_column_int64(stmt, 4);
}

std::vector<Message> Message::latest(int64_t chatId, int limit) {
    std::vector<Message> result;
    sqlite3_stmt* stmt = g_db->prepare(R"SQL(
        SELECT id, chat_id, sender_id, text, created_at
        FROM messages
        WHERE chat_id = ?
        ORDER BY id DESC
        LIMIT ?;
    )SQL");
    if (!stmt) return result;
    sqlite3_bind_int64(stmt, 1, chatId);
    sqlite3_bind_int(stmt, 2, limit);
    while (sqlite3_step(stmt) == SQLITE_ROW) {
        Message m;
        readMsg(stmt, m);
        result.push_back(std::move(m));
    }
    g_db->finalize(stmt);
    // Запрос выдаёт в обратном порядке — разворачиваем к хронологии
    std::reverse(result.begin(), result.end());
    return result;
}

bool Message::findById(int64_t id, Message& out) {
    sqlite3_stmt* stmt = g_db->prepare(
        "SELECT id, chat_id, sender_id, text, created_at FROM messages WHERE id=?;");
    if (!stmt) return false;
    sqlite3_bind_int64(stmt, 1, id);
    bool found = (sqlite3_step(stmt) == SQLITE_ROW);
    if (found) readMsg(stmt, out);
    g_db->finalize(stmt);
    return found;
}
