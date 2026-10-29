// ============================================================
// Реализация модели Chat: создание диалогов, участники,
// поиск личного чата между двумя пользователями.
// ============================================================
#include "models/chat.hpp"
#include "models/database.hpp"

#include <ctime>
#include <algorithm>

bool Chat::findById(int64_t id, Chat& out) {
    sqlite3_stmt* stmt = g_db->prepare(
        "SELECT id, type, name, created_by, created_at FROM chats WHERE id=?;");
    if (!stmt) return false;
    sqlite3_bind_int64(stmt, 1, id);
    bool found = (sqlite3_step(stmt) == SQLITE_ROW);
    if (found) {
        out.id = sqlite3_column_int64(stmt, 0);
        const unsigned char* t = sqlite3_column_text(stmt, 1);
        const unsigned char* n = sqlite3_column_text(stmt, 2);
        out.type = t ? reinterpret_cast<const char*>(t) : "";
        out.name = n ? reinterpret_cast<const char*>(n) : "";
        out.createdBy = sqlite3_column_int64(stmt, 3);
        out.createdAt = sqlite3_column_int64(stmt, 4);
    }
    g_db->finalize(stmt);
    if (!found) return false;

    // Подгружаем участников
    stmt = g_db->prepare("SELECT user_id FROM chat_participants WHERE chat_id=? ORDER BY joined_at;");
    if (stmt) {
        sqlite3_bind_int64(stmt, 1, id);
        while (sqlite3_step(stmt) == SQLITE_ROW)
            out.participants.push_back(sqlite3_column_int64(stmt, 0));
        g_db->finalize(stmt);
    }
    return true;
}

std::vector<Chat> Chat::forUser(int64_t userId) {
    std::vector<Chat> result;
    sqlite3_stmt* stmt = g_db->prepare(R"SQL(
        SELECT c.id, c.type, c.name, c.created_by, c.created_at
        FROM chats c
        JOIN chat_participants p ON p.chat_id = c.id
        WHERE p.user_id = ?
        ORDER BY c.id;
    )SQL");
    if (!stmt) return result;
    sqlite3_bind_int64(stmt, 1, userId);
    while (sqlite3_step(stmt) == SQLITE_ROW) {
        Chat c;
        c.id = sqlite3_column_int64(stmt, 0);
        const unsigned char* t = sqlite3_column_text(stmt, 1);
        const unsigned char* n = sqlite3_column_text(stmt, 2);
        c.type = t ? reinterpret_cast<const char*>(t) : "";
        c.name = n ? reinterpret_cast<const char*>(n) : "";
        c.createdBy = sqlite3_column_int64(stmt, 3);
        c.createdAt = sqlite3_column_int64(stmt, 4);
        result.push_back(std::move(c));
    }
    g_db->finalize(stmt);

    // Для каждого чата подгружаем участников отдельным запросом
    for (auto& c : result) {
        sqlite3_stmt* ps = g_db->prepare(
            "SELECT user_id FROM chat_participants WHERE chat_id=? ORDER BY joined_at;");
        if (ps) {
            sqlite3_bind_int64(ps, 1, c.id);
            while (sqlite3_step(ps) == SQLITE_ROW)
                c.participants.push_back(sqlite3_column_int64(ps, 0));
            g_db->finalize(ps);
        }
    }
    return result;
}

int64_t Chat::create(const std::string& type,
                     const std::string& name,
                     int64_t creatorId,
                     const std::vector<int64_t>& memberIds) {
    int64_t now = static_cast<int64_t>(std::time(nullptr));
    sqlite3_stmt* stmt = g_db->prepare(
        "INSERT INTO chats (type, name, created_by, created_at) VALUES (?,?,?,?);");
    if (!stmt) return -1;
    sqlite3_bind_text(stmt, 1, type.c_str(), -1, SQLITE_TRANSIENT);
    if (name.empty()) sqlite3_bind_null(stmt, 2);
    else sqlite3_bind_text(stmt, 2, name.c_str(), -1, SQLITE_TRANSIENT);
    sqlite3_bind_int64(stmt, 3, creatorId);
    sqlite3_bind_int64(stmt, 4, now);
    if (sqlite3_step(stmt) != SQLITE_DONE) {
        g_db->finalize(stmt);
        return -1;
    }
    g_db->finalize(stmt);

    sqlite3_stmt* q = g_db->prepare("SELECT last_insert_rowid();");
    int64_t chatId = -1;
    if (q && sqlite3_step(q) == SQLITE_ROW) chatId = sqlite3_column_int64(q, 0);
    g_db->finalize(q);
    if (chatId < 0) return -1;

    // Добавляем создателя и всех участников (уникальные id)
    std::vector<int64_t> ids = memberIds;
    ids.push_back(creatorId);
    std::sort(ids.begin(), ids.end());
    ids.erase(std::unique(ids.begin(), ids.end()), ids.end());

    stmt = g_db->prepare(
        "INSERT OR IGNORE INTO chat_participants (chat_id, user_id, joined_at) VALUES (?,?,?);");
    if (!stmt) return -1;
    for (int64_t uid : ids) {
        sqlite3_reset(stmt);
        sqlite3_bind_int64(stmt, 1, chatId);
        sqlite3_bind_int64(stmt, 2, uid);
        sqlite3_bind_int64(stmt, 3, now);
        sqlite3_step(stmt);
    }
    g_db->finalize(stmt);
    return chatId;
}

int64_t Chat::findOrCreatePrivate(int64_t userA, int64_t userB) {
    // Ищем чат типа private, где состоят оба пользователя
    sqlite3_stmt* stmt = g_db->prepare(R"SQL(
        SELECT c.id
        FROM chats c
        JOIN chat_participants pa ON pa.chat_id = c.id AND pa.user_id = ?
        JOIN chat_participants pb ON pb.chat_id = c.id AND pb.user_id = ?
        WHERE c.type = 'private'
        LIMIT 1;
    )SQL");
    if (!stmt) return -1;
    sqlite3_bind_int64(stmt, 1, userA);
    sqlite3_bind_int64(stmt, 2, userB);
    int64_t chatId = -1;
    if (sqlite3_step(stmt) == SQLITE_ROW) chatId = sqlite3_column_int64(stmt, 0);
    g_db->finalize(stmt);

    if (chatId >= 0) return chatId;
    // Существующего нет — создаём новый диалог
    return create("private", "", userA, {userB});
}

bool Chat::hasParticipant(int64_t chatId, int64_t userId) {
    sqlite3_stmt* stmt = g_db->prepare(
        "SELECT 1 FROM chat_participants WHERE chat_id=? AND user_id=? LIMIT 1;");
    if (!stmt) return false;
    sqlite3_bind_int64(stmt, 1, chatId);
    sqlite3_bind_int64(stmt, 2, userId);
    bool ok = (sqlite3_step(stmt) == SQLITE_ROW);
    g_db->finalize(stmt);
    return ok;
}
