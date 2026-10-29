// ============================================================
// Реализация модели User: SELECT/INSERT через sqlite3_stmt.
// ============================================================
#include "models/user.hpp"
#include "models/database.hpp"

#include <ctime>

// Прочитать текущую строку результата в структуру User
static void readRow(sqlite3_stmt* stmt, User& u) {
    u.id = sqlite3_column_int64(stmt, 0);
    const unsigned char* un = sqlite3_column_text(stmt, 1);
    const unsigned char* dn = sqlite3_column_text(stmt, 2);
    const unsigned char* ph = sqlite3_column_text(stmt, 3);
    u.username = un ? reinterpret_cast<const char*>(un) : "";
    u.displayName = dn ? reinterpret_cast<const char*>(dn) : "";
    u.passwordHash = ph ? reinterpret_cast<const char*>(ph) : "";
    u.createdAt = sqlite3_column_int64(stmt, 4);
}

bool User::findById(int64_t id, User& out) {
    sqlite3_stmt* stmt = g_db->prepare(
        "SELECT id, username, display_name, password_hash, created_at FROM users WHERE id=?;");
    if (!stmt) return false;
    sqlite3_bind_int64(stmt, 1, id);
    bool found = (sqlite3_step(stmt) == SQLITE_ROW);
    if (found) readRow(stmt, out);
    g_db->finalize(stmt);
    return found;
}

bool User::findByUsername(const std::string& username, User& out) {
    sqlite3_stmt* stmt = g_db->prepare(
        "SELECT id, username, display_name, password_hash, created_at FROM users WHERE username=?;");
    if (!stmt) return false;
    sqlite3_bind_text(stmt, 1, username.c_str(), -1, SQLITE_TRANSIENT);
    bool found = (sqlite3_step(stmt) == SQLITE_ROW);
    if (found) readRow(stmt, out);
    g_db->finalize(stmt);
    return found;
}

int64_t User::create(const std::string& username,
                     const std::string& displayName,
                     const std::string& passwordHash,
                     int64_t* existingId) {
    // Проверяем уникальность логина заранее — чтобы вернуть понятную ошибку
    User existing;
    if (findByUsername(username, existing)) {
        if (existingId) *existingId = existing.id;
        return -1;
    }

    sqlite3_stmt* stmt = g_db->prepare(
        "INSERT INTO users (username, display_name, password_hash, created_at) VALUES (?,?,?,?);");
    if (!stmt) return -1;
    int64_t now = static_cast<int64_t>(std::time(nullptr));
    sqlite3_bind_text(stmt, 1, username.c_str(), -1, SQLITE_TRANSIENT);
    sqlite3_bind_text(stmt, 2, displayName.c_str(), -1, SQLITE_TRANSIENT);
    sqlite3_bind_text(stmt, 3, passwordHash.c_str(), -1, SQLITE_TRANSIENT);
    sqlite3_bind_int64(stmt, 4, now);

    if (sqlite3_step(stmt) != SQLITE_DONE) {
        g_db->finalize(stmt);
        return -1;
    }
    g_db->finalize(stmt);
    // last_insert_rowid получаем отдельным запросом
    sqlite3_stmt* q = g_db->prepare("SELECT last_insert_rowid();");
    int64_t id = -1;
    if (q && sqlite3_step(q) == SQLITE_ROW) id = sqlite3_column_int64(q, 0);
    g_db->finalize(q);
    return id;
}

std::vector<User> User::all() {
    std::vector<User> result;
    sqlite3_stmt* stmt = g_db->prepare(
        "SELECT id, username, display_name, password_hash, created_at FROM users ORDER BY id;");
    if (!stmt) return result;
    while (sqlite3_step(stmt) == SQLITE_ROW) {
        User u;
        readRow(stmt, u);
        result.push_back(std::move(u));
    }
    g_db->finalize(stmt);
    return result;
}
