#include "database.h"
#include "../config/config.h"
#include "../utils/utils.h"
#include "../services/encryption_service.h"
#include <cstring>
#include <ctime>
#include <sys/stat.h>
#include <algorithm>

namespace cipher {

static std::string padDigits(int64_t n, int digits) {
    std::string s = std::to_string(n < 0 ? -n : n);
    while ((int)s.size() < digits) s = "0" + s;
    return s;
}
static std::string formatUserId(int64_t id) { return id <= 0 ? "" : padDigits(id, 8); }
static std::string formatChatId(int64_t id, const std::string& type) {
    if (id <= 0) return "";
    if (type == "group" || type == "supergroup" || type == "channel") return "-" + padDigits(id, 14);
    return padDigits(id, 8);
}
static int64_t privateChatInternalId(int64_t a, int64_t b) {
    if (a <= 0 || b <= 0) return 0;
    int64_t lo = a < b ? a : b, hi = a < b ? b : a;
    return -(lo * 1000000LL + hi);
}

static void bindS(sqlite3_stmt* st, int idx, const std::string& s) {
    sqlite3_bind_text(st, idx, s.c_str(), -1, SQLITE_TRANSIENT);
}
static void bindC(sqlite3_stmt* st, int idx, const char* s) {
    sqlite3_bind_text(st, idx, s ? s : "", -1, SQLITE_TRANSIENT);
}

static std::string colText(sqlite3_stmt* st, int col) {
    const char* v = reinterpret_cast<const char*>(sqlite3_column_text(st, col));
    return v ? v : "";
}

std::string Database::esc(const std::string& s) {
    std::string out;
    out.reserve(s.size() * 2);
    for (char c : s) {
        if (c == '\'') out += "''";
        else out.push_back(c);
    }
    return out;
}

Database& Database::instance() {
    static Database db;
    return db;
}

Database::Database() = default;

Database::~Database() {
    flush();
    if (db) { sqlite3_close(db); db = nullptr; }
}

bool Database::exec(const char* sql) {
    char* err = nullptr;
    int rc = sqlite3_exec(db, sql, nullptr, nullptr, &err);
    if (err) sqlite3_free(err);
    return rc == SQLITE_OK;
}

void Database::exec(const std::string& sql) {
    exec(sql.c_str());
}

void Database::ensureDirs() {
    size_t slash = dbPath.find_last_of("/\\");
    if (slash != std::string::npos) ::mkdir(dbPath.substr(0, slash).c_str(), 0755);
}

void Database::applyKey() {
    if (keyHex.empty()) return;
    std::string sql = "PRAGMA key = \"x'" + keyHex + "'\";";
    exec(sql.c_str());
    exec("PRAGMA cipher='sqlcipher';");
}

bool Database::isPlainSqlite() {
    FILE* f = std::fopen(dbPath.c_str(), "rb");
    if (!f) return false;
    char buf[16] = {0};
    size_t rd = std::fread(buf, 1, 16, f);
    std::fclose(f);
    return rd == 16 && std::string(buf, 16) == "SQLite format 3\0";
}

bool Database::load() {
    Config cfg = loadConfig();
    dbPath = cfg.dbFile;
    if (cfg.dbEncryption) {
        if (utils::fileExists(cfg.dbKeyFile)) keyHex = utils::trim(utils::readFile(cfg.dbKeyFile));
        else if (!cfg.encryptionKey.empty()) keyHex = utils::sha256Hex(cfg.encryptionKey);
    }
    bool hadSqlite = utils::fileExists(dbPath);
    if (hadSqlite && cfg.dbEncryption && keyHex.empty()) return false;
    if (hadSqlite && cfg.dbEncryption && isPlainSqlite()) return false;

    ensureDirs();
    if (sqlite3_open(dbPath.c_str(), &db) != SQLITE_OK) return false;
    applyKey();
    exec("PRAGMA journal_mode = WAL;");
    exec("PRAGMA synchronous = NORMAL;");
    exec("PRAGMA foreign_keys = ON;");
    exec("PRAGMA busy_timeout = 5000;");
    ensureSchema();
    migrateSchema();
    assignPublicIds();
    return true;
}

void Database::flush() { }
void Database::markDirty() { flush(); }

int64_t Database::nextId(const std::string& name) {
    std::string q = "INSERT OR REPLACE INTO counters(name,value) VALUES('" + esc(name) + "', COALESCE((SELECT value FROM counters WHERE name='" + esc(name) + "'),0)+1)";
    exec(q.c_str());
    sqlite3_stmt* st;
    sqlite3_prepare_v2(db, "SELECT value FROM counters WHERE name = ?", -1, &st, nullptr);
    bindS(st, 1, name);
    int64_t val = 0;
    if (sqlite3_step(st) == SQLITE_ROW) val = sqlite3_column_int64(st, 0);
    sqlite3_finalize(st);
    return val;
}

int64_t Database::nextPublicUserId() {
    for (int64_t i = 1; i <= 99999999; ++i) {
        std::string tok = formatUserId(i);
        sqlite3_stmt* st;
        sqlite3_prepare_v2(db, "SELECT 1 FROM users WHERE public_id = ?", -1, &st, nullptr);
        bindS(st, 1, tok);
        bool exists = (sqlite3_step(st) == SQLITE_ROW);
        sqlite3_finalize(st);
        if (!exists) return i;
    }
    return nextId("users");
}

// ---------- USERS ----------
std::optional<User> Database::findUserById(int64_t id) {
    sqlite3_stmt* st;
    sqlite3_prepare_v2(db, "SELECT * FROM users WHERE id = ?", -1, &st, nullptr);
    sqlite3_bind_int64(st, 1, id);
    std::optional<User> res;
    if (sqlite3_step(st) == SQLITE_ROW) {
        User u;
        u.id = sqlite3_column_int64(st, 0);
        u.phone = colText(st, 1);
        u.email = colText(st, 2);
        u.first_name = colText(st, 3);
        u.last_name = colText(st, 4);
        u.name = colText(st, 5);
        u.username = colText(st, 6);
        u.password_hash = colText(st, 7);
        u.avatar = colText(st, 8);
        u.bio = colText(st, 9);
        u.public_key = colText(st, 10);
        u.online = sqlite3_column_int(st, 11);
        u.last_seen = sqlite3_column_int64(st, 12);
        u.hide_online = sqlite3_column_int(st, 13);
        u.created_at = sqlite3_column_int64(st, 14);
        u.updated_at = sqlite3_column_int64(st, 15);
        u.public_id = colText(st, 16);
        if (u.public_id.empty()) u.public_id = formatUserId(u.id);
        u.crown_level = u.phone == loadConfig().ownerPhone ? "gold" : "";
        u.is_owner = u.crown_level == "gold" ? 1 : 0;
        res = u;
    }
    sqlite3_finalize(st);
    return res;
}

std::optional<User> Database::findUserByPhone(const std::string& phone) {
    sqlite3_stmt* st;
    sqlite3_prepare_v2(db, "SELECT * FROM users WHERE phone = ?", -1, &st, nullptr);
    bindS(st, 1, phone);
    std::optional<User> res;
    if (sqlite3_step(st) == SQLITE_ROW) {
        User u;
        u.id = sqlite3_column_int64(st, 0);
        u.phone = colText(st, 1);
        u.email = colText(st, 2);
        u.first_name = colText(st, 3);
        u.last_name = colText(st, 4);
        u.name = colText(st, 5);
        u.username = colText(st, 6);
        u.password_hash = colText(st, 7);
        u.avatar = colText(st, 8);
        u.bio = colText(st, 9);
        u.public_key = colText(st, 10);
        u.online = sqlite3_column_int(st, 11);
        u.last_seen = sqlite3_column_int64(st, 12);
        u.hide_online = sqlite3_column_int(st, 13);
        u.created_at = sqlite3_column_int64(st, 14);
        u.updated_at = sqlite3_column_int64(st, 15);
        u.public_id = colText(st, 16);
        if (u.public_id.empty()) u.public_id = formatUserId(u.id);
        u.crown_level = u.phone == loadConfig().ownerPhone ? "gold" : "";
        u.is_owner = u.crown_level == "gold" ? 1 : 0;
        res = u;
    }
    sqlite3_finalize(st);
    return res;
}

std::optional<User> Database::findUserByEmail(const std::string& email) {
    sqlite3_stmt* st;
    sqlite3_prepare_v2(db, "SELECT * FROM users WHERE lower(email) = lower(?)", -1, &st, nullptr);
    bindS(st, 1, email);
    std::optional<User> res;
    if (sqlite3_step(st) == SQLITE_ROW) {
        User u;
        u.id = sqlite3_column_int64(st, 0);
        u.phone = colText(st, 1);
        u.email = colText(st, 2);
        u.first_name = colText(st, 3);
        u.last_name = colText(st, 4);
        u.name = colText(st, 5);
        u.username = colText(st, 6);
        u.password_hash = colText(st, 7);
        u.avatar = colText(st, 8);
        u.bio = colText(st, 9);
        u.public_key = colText(st, 10);
        u.online = sqlite3_column_int(st, 11);
        u.last_seen = sqlite3_column_int64(st, 12);
        u.hide_online = sqlite3_column_int(st, 13);
        u.created_at = sqlite3_column_int64(st, 14);
        u.updated_at = sqlite3_column_int64(st, 15);
        u.public_id = colText(st, 16);
        if (u.public_id.empty()) u.public_id = formatUserId(u.id);
        u.crown_level = u.phone == loadConfig().ownerPhone ? "gold" : "";
        u.is_owner = u.crown_level == "gold" ? 1 : 0;
        res = u;
    }
    sqlite3_finalize(st);
    return res;
}

std::optional<User> Database::findUserByPublicId(const std::string& publicId) {
    std::string t = utils::trim(publicId);
    if (t.empty()) return std::nullopt;
    sqlite3_stmt* st;
    sqlite3_prepare_v2(db, "SELECT * FROM users WHERE public_id = ?", -1, &st, nullptr);
    bindS(st, 1, t);
    if (sqlite3_step(st) != SQLITE_ROW) {
        try { int64_t n = std::stoll(t); sqlite3_finalize(st);
            sqlite3_prepare_v2(db, "SELECT * FROM users WHERE id = ?", -1, &st, nullptr);
            sqlite3_bind_int64(st, 1, n); }
        catch (...) { sqlite3_finalize(st); return std::nullopt; }
    }
    std::optional<User> res;
    if (sqlite3_step(st) == SQLITE_ROW) {
        User u;
        u.id = sqlite3_column_int64(st, 0);
        u.phone = colText(st, 1);
        u.email = colText(st, 2);
        u.first_name = colText(st, 3);
        u.last_name = colText(st, 4);
        u.name = colText(st, 5);
        u.username = colText(st, 6);
        u.password_hash = colText(st, 7);
        u.avatar = colText(st, 8);
        u.bio = colText(st, 9);
        u.public_key = colText(st, 10);
        u.online = sqlite3_column_int(st, 11);
        u.last_seen = sqlite3_column_int64(st, 12);
        u.hide_online = sqlite3_column_int(st, 13);
        u.created_at = sqlite3_column_int64(st, 14);
        u.updated_at = sqlite3_column_int64(st, 15);
        u.public_id = colText(st, 16);
        if (u.public_id.empty()) u.public_id = formatUserId(u.id);
        u.crown_level = u.phone == loadConfig().ownerPhone ? "gold" : "";
        u.is_owner = u.crown_level == "gold" ? 1 : 0;
        res = u;
    }
    sqlite3_finalize(st);
    return res;
}

bool Database::isUsernameTaken(const std::string& username, std::optional<int64_t> excludeUserId) {
    std::string clean = utils::normalizeUsername(username);
    sqlite3_stmt* st;
    if (excludeUserId) {
        sqlite3_prepare_v2(db, "SELECT COUNT(*) FROM users WHERE lower(username) = lower(?) AND id != ?", -1, &st, nullptr);
        bindS(st, 1, clean);
        sqlite3_bind_int64(st, 2, *excludeUserId);
    } else {
        sqlite3_prepare_v2(db, "SELECT COUNT(*) FROM users WHERE lower(username) = lower(?)", -1, &st, nullptr);
        bindS(st, 1, clean);
    }
    bool taken = false;
    if (sqlite3_step(st) == SQLITE_ROW) taken = sqlite3_column_int(st, 0) > 0;
    sqlite3_finalize(st);
    return taken;
}

User Database::addUser(const User& u) {
    int64_t id = u.id ? u.id : nextId("users");
    std::string publicId = u.public_id.empty() ? formatUserId(nextPublicUserId()) : u.public_id;
    int64_t now = static_cast<int64_t>(std::time(nullptr)) * 1000;
    std::string sql = "INSERT OR REPLACE INTO users(id,phone,email,first_name,last_name,name,username,password_hash,avatar,bio,public_key,online,last_seen,hide_online,created_at,updated_at,public_id) VALUES("
        + std::to_string(id) + ", '" + esc(u.phone) + "', '" + esc(u.email) + "', '" + esc(u.first_name) + "', '" + esc(u.last_name) + "', "
        + "'" + esc(u.name) + "', '" + esc(u.username) + "', '" + esc(u.password_hash) + "', '" + esc(u.avatar) + "', '" + esc(u.bio) + "', '"
        + esc(u.public_key) + "', " + (u.online ? "1" : "0") + ", " + std::to_string(u.last_seen) + ", " + (u.hide_online ? "1" : "0") + ", "
        + std::to_string(u.created_at ? u.created_at : now) + ", " + std::to_string(u.updated_at ? u.updated_at : now) + ", '" + esc(publicId) + "');";
    exec(sql.c_str());
    User res = u;
    res.id = id;
    res.public_id = publicId;
    res.updated_at = now;
    return res;
}

bool Database::updateUser(int64_t id, const std::map<std::string, std::string>& patch) {
    std::string sets;
    for (auto& [k, v] : patch) {
        if (!sets.empty()) sets += ", ";
        sets += k + " = '" + esc(v) + "'";
    }
    if (sets.empty()) return true;
    sets += ", updated_at = " + std::to_string(static_cast<int64_t>(std::time(nullptr)) * 1000);
    std::string sql = "UPDATE users SET " + sets + " WHERE id = " + std::to_string(id) + ";";
    return exec(sql.c_str());
}

// ---------- CHATS ----------
std::optional<Chat> Database::findChatById(int64_t id) {
    sqlite3_stmt* st;
    sqlite3_prepare_v2(db, "SELECT * FROM chats WHERE id = ?", -1, &st, nullptr);
    sqlite3_bind_int64(st, 1, id);
    std::optional<Chat> res;
    if (sqlite3_step(st) == SQLITE_ROW) {
        Chat c;
        c.id = sqlite3_column_int64(st, 0);
        c.type = colText(st, 1);
        c.public_id = colText(st, 2);
        c.name = colText(st, 3);
        c.avatar = colText(st, 4);
        c.description = colText(st, 5);
        c.owner_id = sqlite3_column_int64(st, 6);
        c.is_pinned = sqlite3_column_int(st, 7);
        c.is_channel = sqlite3_column_int(st, 8);
        c.folder_id = sqlite3_column_int64(st, 9);
        c.created_at = sqlite3_column_int64(st, 10);
        c.updated_at = sqlite3_column_int64(st, 11);
        res = c;
    }
    sqlite3_finalize(st);
    return res;
}

std::optional<Chat> Database::findChatByPublicId(const std::string& publicId) {
    sqlite3_stmt* st;
    sqlite3_prepare_v2(db, "SELECT * FROM chats WHERE public_id = ?", -1, &st, nullptr);
    bindS(st, 1, publicId);
    std::optional<Chat> res;
    if (sqlite3_step(st) == SQLITE_ROW) {
        Chat c;
        c.id = sqlite3_column_int64(st, 0);
        c.type = colText(st, 1);
        c.public_id = colText(st, 2);
        c.name = colText(st, 3);
        c.avatar = colText(st, 4);
        c.description = colText(st, 5);
        c.owner_id = sqlite3_column_int64(st, 6);
        c.is_pinned = sqlite3_column_int(st, 7);
        c.is_channel = sqlite3_column_int(st, 8);
        c.folder_id = sqlite3_column_int64(st, 9);
        c.created_at = sqlite3_column_int64(st, 10);
        c.updated_at = sqlite3_column_int64(st, 11);
        res = c;
    }
    sqlite3_finalize(st);
    return res;
}

Chat Database::addChat(const Chat& c) {
    int64_t id = c.id ? c.id : nextId("chats");
    std::string publicId = c.public_id;
    if (publicId.empty()) {
        if (c.type == "group" || c.type == "supergroup" || c.type == "channel")
            publicId = "-" + formatChatId(id, c.type);
        else
            publicId = formatChatId(id, c.type);
    }
    int64_t now = static_cast<int64_t>(std::time(nullptr)) * 1000;
    std::string sql = "INSERT OR REPLACE INTO chats(id,type,name,avatar,description,owner_id,is_pinned,is_channel,folder_id,created_at,updated_at,public_id) VALUES("
        + std::to_string(id) + ", '" + esc(c.type) + "', '" + esc(c.name) + "', '" + esc(c.avatar) + "', '" + esc(c.description) + "', "
        + std::to_string(c.owner_id) + ", " + std::to_string(c.is_pinned) + ", " + std::to_string(c.is_channel) + ", "
        + std::to_string(c.folder_id) + ", " + std::to_string(c.created_at ? c.created_at : now) + ", "
        + std::to_string(c.updated_at ? c.updated_at : now) + ", '" + esc(publicId) + "');";
    exec(sql.c_str());
    Chat res = c;
    res.id = id;
    res.public_id = publicId;
    return res;
}

int64_t Database::nextPrivateChatId(int64_t a, int64_t b) {
    int64_t det = privateChatInternalId(a, b);
    if (det == 0) return nextId("chats");
    sqlite3_stmt* st;
    sqlite3_prepare_v2(db, "SELECT 1 FROM chats WHERE id = ?", -1, &st, nullptr);
    sqlite3_bind_int64(st, 1, det);
    bool exists = (sqlite3_step(st) == SQLITE_ROW);
    sqlite3_finalize(st);
    return exists ? nextId("chats") : det;
}

bool Database::updateChat(int64_t id, const std::map<std::string, std::string>& patch) {
    std::string sets;
    for (auto& [k, v] : patch) {
        if (!sets.empty()) sets += ", ";
        sets += k + " = '" + esc(v) + "'";
    }
    if (sets.empty()) return true;
    sets += ", updated_at = " + std::to_string(static_cast<int64_t>(std::time(nullptr)) * 1000);
    std::string sql = "UPDATE chats SET " + sets + " WHERE id = " + std::to_string(id) + ";";
    return exec(sql.c_str());
}

bool Database::deleteChat(int64_t chatId) {
    exec("DELETE FROM chats WHERE id = " + std::to_string(chatId) + ";");
    exec("DELETE FROM chat_members WHERE chat_id = " + std::to_string(chatId) + ";");
    exec("DELETE FROM messages WHERE chat_id = " + std::to_string(chatId) + ";");
    exec("DELETE FROM group_keys WHERE chat_id = " + std::to_string(chatId) + ";");
    removeChatFromAllFolders(chatId);
    return true;
}

// ---------- CHAT MEMBERS ----------
std::vector<ChatMember> Database::getChatMembers(int64_t chatId) {
    std::vector<ChatMember> out;
    sqlite3_stmt* st;
    sqlite3_prepare_v2(db, "SELECT * FROM chat_members WHERE chat_id = ?", -1, &st, nullptr);
    sqlite3_bind_int64(st, 1, chatId);
    while (sqlite3_step(st) == SQLITE_ROW) {
        ChatMember m;
        m.chat_id = sqlite3_column_int64(st, 0);
        m.user_id = sqlite3_column_int64(st, 1);
        m.role = colText(st, 2);
        m.joined_at = sqlite3_column_int64(st, 3);
        m.last_read_message_id = sqlite3_column_int64(st, 4);
        m.hidden = sqlite3_column_int(st, 5);
        m.cleared_at = sqlite3_column_int64(st, 6);
        out.push_back(m);
    }
    sqlite3_finalize(st);
    return out;
}

bool Database::isChatMember(int64_t chatId, int64_t userId) {
    sqlite3_stmt* st;
    sqlite3_prepare_v2(db, "SELECT 1 FROM chat_members WHERE chat_id = ? AND user_id = ?", -1, &st, nullptr);
    sqlite3_bind_int64(st, 1, chatId);
    sqlite3_bind_int64(st, 2, userId);
    bool res = (sqlite3_step(st) == SQLITE_ROW);
    sqlite3_finalize(st);
    return res;
}

std::optional<ChatMember> Database::getChatMember(int64_t chatId, int64_t userId) {
    sqlite3_stmt* st;
    sqlite3_prepare_v2(db, "SELECT * FROM chat_members WHERE chat_id = ? AND user_id = ?", -1, &st, nullptr);
    sqlite3_bind_int64(st, 1, chatId);
    sqlite3_bind_int64(st, 2, userId);
    std::optional<ChatMember> res;
    if (sqlite3_step(st) == SQLITE_ROW) {
        ChatMember m;
        m.chat_id = sqlite3_column_int64(st, 0);
        m.user_id = sqlite3_column_int64(st, 1);
        m.role = colText(st, 2);
        m.joined_at = sqlite3_column_int64(st, 3);
        m.last_read_message_id = sqlite3_column_int64(st, 4);
        m.hidden = sqlite3_column_int(st, 5);
        m.cleared_at = sqlite3_column_int64(st, 6);
        res = m;
    }
    sqlite3_finalize(st);
    return res;
}

void Database::addChatMember(const ChatMember& cm) {
    std::string sql = "INSERT OR REPLACE INTO chat_members(chat_id,user_id,role,joined_at,last_read_message_id,hidden,cleared_at) VALUES("
        + std::to_string(cm.chat_id) + ", " + std::to_string(cm.user_id) + ", '" + esc(cm.role) + "', "
        + std::to_string(cm.joined_at) + ", " + std::to_string(cm.last_read_message_id) + ", "
        + std::to_string(cm.hidden) + ", " + std::to_string(cm.cleared_at) + ");";
    exec(sql.c_str());
}

void Database::removeChatMember(int64_t chatId, int64_t userId) {
    exec("DELETE FROM chat_members WHERE chat_id = " + std::to_string(chatId) + " AND user_id = " + std::to_string(userId) + ";");
}

void Database::updateChatMember(int64_t chatId, int64_t userId, const std::map<std::string, std::string>& patch) {
    std::string sets;
    for (auto& [k, v] : patch) {
        if (!sets.empty()) sets += ", ";
        sets += k + " = '" + esc(v) + "'";
    }
    if (sets.empty()) return;
    std::string sql = "UPDATE chat_members SET " + sets + " WHERE chat_id = " + std::to_string(chatId) + " AND user_id = " + std::to_string(userId) + ";";
    exec(sql.c_str());
}

void Database::hideChatForUser(int64_t chatId, int64_t userId) {
    int64_t now = static_cast<int64_t>(std::time(nullptr)) * 1000;
    exec("UPDATE chat_members SET hidden = 1, cleared_at = " + std::to_string(now) + " WHERE chat_id = " + std::to_string(chatId) + " AND user_id = " + std::to_string(userId) + ";");
}

bool Database::restoreChatForUser(int64_t chatId, int64_t userId) {
    auto m = getChatMember(chatId, userId);
    if (!m) return false;
    if (m->hidden) {
        exec("UPDATE chat_members SET hidden = 0 WHERE chat_id = " + std::to_string(chatId) + " AND user_id = " + std::to_string(userId) + ";");
        return true;
    }
    return false;
}

int64_t Database::getChatClearedAt(int64_t chatId, int64_t userId) {
    auto m = getChatMember(chatId, userId);
    return m ? m->cleared_at : 0;
}

std::vector<int64_t> Database::restoreHiddenChatMembers(int64_t chatId) {
    std::vector<int64_t> out;
    sqlite3_stmt* st;
    sqlite3_prepare_v2(db, "SELECT user_id FROM chat_members WHERE chat_id = ? AND hidden = 1", -1, &st, nullptr);
    sqlite3_bind_int64(st, 1, chatId);
    while (sqlite3_step(st) == SQLITE_ROW) out.push_back(sqlite3_column_int64(st, 0));
    sqlite3_finalize(st);
    exec("UPDATE chat_members SET hidden = 0 WHERE chat_id = " + std::to_string(chatId) + " AND hidden = 1;");
    return out;
}

std::vector<int64_t> Database::getChatMemberIds(int64_t chatId) {
    std::vector<int64_t> out;
    sqlite3_stmt* st;
    sqlite3_prepare_v2(db, "SELECT user_id FROM chat_members WHERE chat_id = ?", -1, &st, nullptr);
    sqlite3_bind_int64(st, 1, chatId);
    while (sqlite3_step(st) == SQLITE_ROW) out.push_back(sqlite3_column_int64(st, 0));
    sqlite3_finalize(st);
    return out;
}

std::vector<int64_t> Database::getUserChats(int64_t userId) {
    std::vector<int64_t> out;
    sqlite3_stmt* st;
    sqlite3_prepare_v2(db, "SELECT chat_id FROM chat_members WHERE user_id = ? AND (hidden IS NULL OR hidden = 0)", -1, &st, nullptr);
    sqlite3_bind_int64(st, 1, userId);
    while (sqlite3_step(st) == SQLITE_ROW) out.push_back(sqlite3_column_int64(st, 0));
    sqlite3_finalize(st);
    return out;
}

// ---------- MESSAGES ----------
std::optional<Message> Database::findMessageById(int64_t id) {
    sqlite3_stmt* st;
    sqlite3_prepare_v2(db, "SELECT * FROM messages WHERE id = ?", -1, &st, nullptr);
    sqlite3_bind_int64(st, 1, id);
    std::optional<Message> res;
    if (sqlite3_step(st) == SQLITE_ROW) {
        Message m;
        m.id = sqlite3_column_int64(st, 0);
        m.chat_id = sqlite3_column_int64(st, 1);
        m.sender_id = sqlite3_column_int64(st, 2);
        m.encrypted_content = colText(st, 3);
        m.iv = colText(st, 4);
        m.header = colText(st, 5);
        m.type = colText(st, 6);
        m.reply_to = sqlite3_column_int64(st, 7);
        m.forwarded_from = sqlite3_column_int64(st, 8);
        m.edited = sqlite3_column_int(st, 9);
        m.deleted_for_all = sqlite3_column_int(st, 10);
        m.deleted_by = colText(st, 11);
        m.reactions = colText(st, 12);
        m.pinned = sqlite3_column_int(st, 13);
        m.expires_at = sqlite3_column_int64(st, 14);
        m.created_at = sqlite3_column_int64(st, 15);
        res = m;
    }
    sqlite3_finalize(st);
    return res;
}

Message Database::addMessage(const Message& m) {
    int64_t id = m.id ? m.id : nextId("messages");
    int64_t now = static_cast<int64_t>(std::time(nullptr)) * 1000;
    std::string sql = "INSERT OR REPLACE INTO messages(id,chat_id,sender_id,encrypted_content,iv,header,type,reply_to,forwarded_from,edited,deleted_for_all,deleted_by,reactions,pinned,expires_at,created_at) VALUES("
        + std::to_string(id) + ", " + std::to_string(m.chat_id) + ", " + std::to_string(m.sender_id) + ", '"
        + esc(m.encrypted_content) + "', '" + esc(m.iv) + "', '" + esc(m.header) + "', '" + esc(m.type) + "', "
        + std::to_string(m.reply_to) + ", " + std::to_string(m.forwarded_from) + ", " + std::to_string(m.edited) + ", "
        + std::to_string(m.deleted_for_all) + ", '" + esc(m.deleted_by) + "', '" + esc(m.reactions) + "', "
        + std::to_string(m.pinned) + ", " + std::to_string(m.expires_at) + ", " + std::to_string(m.created_at ? m.created_at : now) + ");";
    exec(sql.c_str());
    Message res = m;
    res.id = id;
    return res;
}

bool Database::updateMessage(int64_t id, const std::map<std::string, std::string>& patch) {
    std::string sets;
    for (auto& [k, v] : patch) {
        if (!sets.empty()) sets += ", ";
        if (k == "deleted_by" || k == "reactions") sets += k + " = '" + esc(v) + "'";
        else if (k == "edited" || k == "deleted_for_all" || k == "pinned") sets += k + " = " + v;
        else sets += k + " = '" + esc(v) + "'";
    }
    if (sets.empty()) return true;
    std::string sql = "UPDATE messages SET " + sets + " WHERE id = " + std::to_string(id) + ";";
    return exec(sql.c_str());
}

bool Database::deleteMessage(int64_t id) {
    exec("DELETE FROM messages WHERE id = " + std::to_string(id) + ";");
    return true;
}

int Database::deleteMessagesByIds(const std::vector<int64_t>& ids) {
    for (auto id : ids) exec("DELETE FROM messages WHERE id = " + std::to_string(id) + ";");
    return (int)ids.size();
}

std::vector<Message> Database::getChatMessages(int64_t chatId, int limit, std::optional<int64_t> beforeId) {
    std::vector<Message> out;
    std::string sql = "SELECT * FROM messages WHERE chat_id = " + std::to_string(chatId);
    if (beforeId) sql += " AND id < " + std::to_string(*beforeId);
    sql += " ORDER BY id DESC LIMIT " + std::to_string(limit) + ";";
    sqlite3_stmt* st;
    sqlite3_prepare_v2(db, sql.c_str(), -1, &st, nullptr);
    std::vector<Message> tmp;
    while (sqlite3_step(st) == SQLITE_ROW) {
        Message m;
        m.id = sqlite3_column_int64(st, 0);
        m.chat_id = sqlite3_column_int64(st, 1);
        m.sender_id = sqlite3_column_int64(st, 2);
        m.encrypted_content = colText(st, 3);
        m.iv = colText(st, 4);
        m.header = colText(st, 5);
        m.type = colText(st, 6);
        m.reply_to = sqlite3_column_int64(st, 7);
        m.forwarded_from = sqlite3_column_int64(st, 8);
        m.edited = sqlite3_column_int(st, 9);
        m.deleted_for_all = sqlite3_column_int(st, 10);
        m.deleted_by = colText(st, 11);
        m.reactions = colText(st, 12);
        m.pinned = sqlite3_column_int(st, 13);
        m.expires_at = sqlite3_column_int64(st, 14);
        m.created_at = sqlite3_column_int64(st, 15);
        tmp.push_back(m);
    }
    sqlite3_finalize(st);
    for (auto it = tmp.rbegin(); it != tmp.rend(); ++it) out.push_back(*it);
    return out;
}

std::vector<Message> Database::getMessagesByChat(int64_t chatId) {
    return getChatMessages(chatId, 100000, std::nullopt);
}

std::vector<Message> Database::getPinnedMessages(int64_t chatId) {
    std::vector<Message> out;
    std::string sql = "SELECT * FROM messages WHERE chat_id = " + std::to_string(chatId) + " AND pinned = 1 ORDER BY id ASC;";
    sqlite3_stmt* st;
    sqlite3_prepare_v2(db, sql.c_str(), -1, &st, nullptr);
    while (sqlite3_step(st) == SQLITE_ROW) {
        Message m;
        m.id = sqlite3_column_int64(st, 0);
        m.chat_id = sqlite3_column_int64(st, 1);
        m.sender_id = sqlite3_column_int64(st, 2);
        m.encrypted_content = colText(st, 3);
        m.iv = colText(st, 4);
        m.header = colText(st, 5);
        m.type = colText(st, 6);
        m.reply_to = sqlite3_column_int64(st, 7);
        m.forwarded_from = sqlite3_column_int64(st, 8);
        m.edited = sqlite3_column_int(st, 9);
        m.deleted_for_all = sqlite3_column_int(st, 10);
        m.deleted_by = colText(st, 11);
        m.reactions = colText(st, 12);
        m.pinned = sqlite3_column_int(st, 13);
        m.expires_at = sqlite3_column_int64(st, 14);
        m.created_at = sqlite3_column_int64(st, 15);
        out.push_back(m);
    }
    sqlite3_finalize(st);
    return out;
}

// ---------- SESSIONS ----------
std::optional<Session> Database::findSessionById(int64_t id) {
    sqlite3_stmt* st;
    sqlite3_prepare_v2(db, "SELECT * FROM sessions WHERE id = ?", -1, &st, nullptr);
    sqlite3_bind_int64(st, 1, id);
    std::optional<Session> res;
    if (sqlite3_step(st) == SQLITE_ROW) {
        Session s;
        s.id = sqlite3_column_int64(st, 0);
        s.user_id = sqlite3_column_int64(st, 1);
        s.token = colText(st, 2);
        s.token_hash = colText(st, 3);
        s.expires_at = sqlite3_column_int64(st, 4);
        s.created_at = sqlite3_column_int64(st, 5);
        s.last_used = sqlite3_column_int64(st, 6);
        s.user_agent = colText(st, 7);
        s.ip = colText(st, 8);
        res = s;
    }
    sqlite3_finalize(st);
    return res;
}

std::optional<Session> Database::findSessionByToken(const std::string& token) {
    std::string hash = EncryptionService::instance().hashToken(token);
    return findSessionByHash(hash);
}

std::optional<Session> Database::findSessionByHash(const std::string& hash) {
    sqlite3_stmt* st;
    sqlite3_prepare_v2(db, "SELECT * FROM sessions WHERE token_hash = ?", -1, &st, nullptr);
    bindS(st, 1, hash);
    std::optional<Session> res;
    if (sqlite3_step(st) == SQLITE_ROW) {
        Session s;
        s.id = sqlite3_column_int64(st, 0);
        s.user_id = sqlite3_column_int64(st, 1);
        s.token = colText(st, 2);
        s.token_hash = colText(st, 3);
        s.expires_at = sqlite3_column_int64(st, 4);
        s.created_at = sqlite3_column_int64(st, 5);
        s.last_used = sqlite3_column_int64(st, 6);
        s.user_agent = colText(st, 7);
        s.ip = colText(st, 8);
        res = s;
    }
    sqlite3_finalize(st);
    return res;
}

void Database::addSession(const Session& s) {
    int64_t id = s.id ? s.id : nextId("sessions");
    std::string sql = "INSERT OR REPLACE INTO sessions(id,user_id,token,token_hash,expires_at,created_at,last_used,user_agent,ip) VALUES("
        + std::to_string(id) + ", " + std::to_string(s.user_id) + ", '" + esc(s.token) + "', '" + esc(s.token_hash) + "', "
        + std::to_string(s.expires_at) + ", " + std::to_string(s.created_at) + ", " + std::to_string(s.last_used) + ", '"
        + esc(s.user_agent) + "', '" + esc(s.ip) + "');";
    exec(sql.c_str());
}

bool Database::deleteSession(int64_t id) {
    exec("DELETE FROM sessions WHERE id = " + std::to_string(id) + ";");
    return true;
}

bool Database::deleteSessionByToken(const std::string& token) {
    exec("DELETE FROM sessions WHERE token = '" + esc(token) + "';");
    return true;
}

bool Database::deleteSessionByHash(const std::string& hash) {
    sqlite3_stmt* st;
    sqlite3_prepare_v2(db, "DELETE FROM sessions WHERE token_hash = ?", -1, &st, nullptr);
    bindS(st, 1, hash);
    int rc = sqlite3_step(st);
    sqlite3_finalize(st);
    return rc == SQLITE_DONE;
}

void Database::purgeExpiredSessions(int64_t nowMs) {
    if (nowMs == 0) nowMs = static_cast<int64_t>(std::time(nullptr)) * 1000;
    exec("DELETE FROM sessions WHERE expires_at > 0 AND expires_at < " + std::to_string(nowMs) + ";");
}

// ---------- FILES ----------
std::optional<File> Database::findFileById(int64_t id) {
    sqlite3_stmt* st;
    sqlite3_prepare_v2(db, "SELECT * FROM files WHERE id = ?", -1, &st, nullptr);
    sqlite3_bind_int64(st, 1, id);
    std::optional<File> res;
    if (sqlite3_step(st) == SQLITE_ROW) {
        File f;
        f.id = sqlite3_column_int64(st, 0);
        f.filename = colText(st, 1);
        f.original_name = colText(st, 2);
        f.size = sqlite3_column_int64(st, 3);
        f.mimetype = colText(st, 4);
        f.uploader_id = sqlite3_column_int64(st, 5);
        f.created_at = sqlite3_column_int64(st, 6);
        res = f;
    }
    sqlite3_finalize(st);
    return res;
}

File Database::addFile(const File& f) {
    int64_t id = f.id ? f.id : nextId("files");
    int64_t now = static_cast<int64_t>(std::time(nullptr)) * 1000;
    std::string sql = "INSERT OR REPLACE INTO files(id,filename,original_name,size,mimetype,uploader_id,created_at) VALUES("
        + std::to_string(id) + ", '" + esc(f.filename) + "', '" + esc(f.original_name) + "', " + std::to_string(f.size) + ", '"
        + esc(f.mimetype) + "', " + std::to_string(f.uploader_id) + ", " + std::to_string(f.created_at ? f.created_at : now) + ");";
    exec(sql.c_str());
    File res = f;
    res.id = id;
    return res;
}

// ---------- VERIFICATION CODES ----------
void Database::addVerificationCode(int64_t id, const std::string& phone, const std::string& code, int64_t expiresAt) {
    std::string sql = "INSERT OR REPLACE INTO verification_codes(id,phone,code,attempts,expires_at,used,created_at) VALUES("
        + std::to_string(id) + ", '" + esc(phone) + "', '" + esc(code) + "', 0, " + std::to_string(expiresAt) + ", 0, " + std::to_string(expiresAt - 300000) + ");";
    exec(sql.c_str());
}

std::vector<std::string> Database::findVerificationCode(const std::string& phone) {
    std::vector<std::string> out;
    sqlite3_stmt* st;
    sqlite3_prepare_v2(db, "SELECT code FROM verification_codes WHERE phone = ? ORDER BY id ASC", -1, &st, nullptr);
    bindS(st, 1, phone);
    while (sqlite3_step(st) == SQLITE_ROW) out.push_back(colText(st, 0));
    sqlite3_finalize(st);
    return out;
}

std::optional<std::string> Database::findLatestVerificationCodeRaw(const std::string& phone) {
    sqlite3_stmt* st;
    sqlite3_prepare_v2(db, "SELECT code FROM verification_codes WHERE phone = ? ORDER BY id DESC LIMIT 1", -1, &st, nullptr);
    bindS(st, 1, phone);
    std::optional<std::string> res;
    if (sqlite3_step(st) == SQLITE_ROW) res = colText(st, 0);
    sqlite3_finalize(st);
    return res;
}

void Database::deleteVerificationCode(const std::string& phone) {
    exec("DELETE FROM verification_codes WHERE phone = '" + esc(phone) + "';");
}

// ---------- FOLDERS ----------
std::vector<Folder> Database::getFolders(int64_t userId) {
    std::vector<Folder> out;
    sqlite3_stmt* st;
    sqlite3_prepare_v2(db, "SELECT * FROM folders WHERE user_id = ?", -1, &st, nullptr);
    sqlite3_bind_int64(st, 1, userId);
    while (sqlite3_step(st) == SQLITE_ROW) {
        Folder f;
        f.id = sqlite3_column_int64(st, 0);
        f.user_id = sqlite3_column_int64(st, 1);
        f.name = colText(st, 2);
        f.emoji = colText(st, 3);
        f.color = colText(st, 4);
        f.chat_ids = colText(st, 5);
        f.created_at = sqlite3_column_int64(st, 6);
        f.updated_at = sqlite3_column_int64(st, 7);
        out.push_back(f);
    }
    sqlite3_finalize(st);
    return out;
}

std::optional<Folder> Database::findFolderById(int64_t id) {
    sqlite3_stmt* st;
    sqlite3_prepare_v2(db, "SELECT * FROM folders WHERE id = ?", -1, &st, nullptr);
    sqlite3_bind_int64(st, 1, id);
    std::optional<Folder> res;
    if (sqlite3_step(st) == SQLITE_ROW) {
        Folder f;
        f.id = sqlite3_column_int64(st, 0);
        f.user_id = sqlite3_column_int64(st, 1);
        f.name = colText(st, 2);
        f.emoji = colText(st, 3);
        f.color = colText(st, 4);
        f.chat_ids = colText(st, 5);
        f.created_at = sqlite3_column_int64(st, 6);
        f.updated_at = sqlite3_column_int64(st, 7);
        res = f;
    }
    sqlite3_finalize(st);
    return res;
}

Folder Database::createFolder(int64_t userId, const std::string& name, const std::string& emoji, const std::string& color) {
    int64_t id = nextId("folders");
    int64_t now = static_cast<int64_t>(std::time(nullptr)) * 1000;
    Folder f;
    f.id = id; f.user_id = userId; f.name = name.substr(0, 80); f.emoji = emoji; f.color = color;
    f.chat_ids = "[]"; f.created_at = now; f.updated_at = now;
    addFolder(f);
    return f;
}

void Database::addFolder(const Folder& f) {
    int64_t id = f.id ? f.id : nextId("folders");
    int64_t now = static_cast<int64_t>(std::time(nullptr)) * 1000;
    std::string sql = "INSERT OR REPLACE INTO folders(id,user_id,name,emoji,color,chat_ids,created_at,updated_at) VALUES("
        + std::to_string(id) + ", " + std::to_string(f.user_id) + ", '" + esc(f.name) + "', '" + esc(f.emoji) + "', '" + esc(f.color) + "', '"
        + esc(f.chat_ids) + "', " + std::to_string(f.created_at ? f.created_at : now) + ", " + std::to_string(f.updated_at ? f.updated_at : now) + ");";
    exec(sql.c_str());
}

std::optional<Folder> Database::updateFolder(int64_t id, int64_t userId, const std::map<std::string, std::string>& patch) {
    auto f = findFolderById(id);
    if (!f) return std::nullopt;
    if (f->user_id != userId) return std::nullopt;
    std::string sets;
    for (auto& [k, v] : patch) {
        if (!sets.empty()) sets += ", ";
        sets += k + " = '" + esc(v) + "'";
    }
    sets += ", updated_at = " + std::to_string(static_cast<int64_t>(std::time(nullptr)) * 1000);
    exec("UPDATE folders SET " + sets + " WHERE id = " + std::to_string(id) + ";");
    return findFolderById(id);
}

bool Database::deleteFolder(int64_t id, int64_t userId) {
    auto f = findFolderById(id);
    if (!f) return false;
    if (userId >= 0 && f->user_id != userId) return false;
    exec("UPDATE chats SET folder_id = NULL WHERE folder_id = " + std::to_string(id) + ";");
    exec("DELETE FROM folders WHERE id = " + std::to_string(id) + ";");
    return true;
}

void Database::removeChatFromAllFolders(int64_t chatId) {
    exec("UPDATE chats SET folder_id = NULL WHERE id = " + std::to_string(chatId) + ";");
}

// ---------- GROUP KEYS ----------
std::optional<Database::GroupKey> Database::findGroupKey(int64_t chatId) {
    sqlite3_stmt* st;
    sqlite3_prepare_v2(db, "SELECT * FROM group_keys WHERE chat_id = ?", -1, &st, nullptr);
    sqlite3_bind_int64(st, 1, chatId);
    std::optional<GroupKey> res;
    if (sqlite3_step(st) == SQLITE_ROW) {
        GroupKey gk;
        gk.chat_id = sqlite3_column_int64(st, 0);
        gk.version = sqlite3_column_int(st, 1);
        gk.wrapped = colText(st, 2);
        gk.created_by = sqlite3_column_int64(st, 3);
        gk.created_at = sqlite3_column_int64(st, 4);
        gk.updated_at = sqlite3_column_int64(st, 5);
        res = gk;
    }
    sqlite3_finalize(st);
    return res;
}

void Database::saveGroupKey(int64_t chatId, int version, const std::string& wrapped, int64_t createdBy) {
    int64_t now = static_cast<int64_t>(std::time(nullptr)) * 1000;
    exec("INSERT OR REPLACE INTO group_keys(chat_id,version,wrapped,created_by,created_at,updated_at) VALUES("
        + std::to_string(chatId) + ", " + std::to_string(version) + ", '" + esc(wrapped) + "', " + std::to_string(createdBy) + ", "
        + std::to_string(now) + ", " + std::to_string(now) + ");");
}

// ---------- COMPAT COLLECTIONS ----------
std::vector<User> Database::allUsers() {
    std::vector<User> out;
    sqlite3_stmt* st;
    sqlite3_prepare_v2(db, "SELECT * FROM users", -1, &st, nullptr);
    while (sqlite3_step(st) == SQLITE_ROW) {
        User u;
        u.id = sqlite3_column_int64(st, 0);
        u.phone = colText(st, 1);
        u.email = colText(st, 2);
        u.first_name = colText(st, 3);
        u.last_name = colText(st, 4);
        u.name = colText(st, 5);
        u.username = colText(st, 6);
        u.password_hash = colText(st, 7);
        u.avatar = colText(st, 8);
        u.bio = colText(st, 9);
        u.public_key = colText(st, 10);
        u.online = sqlite3_column_int(st, 11);
        u.last_seen = sqlite3_column_int64(st, 12);
        u.hide_online = sqlite3_column_int(st, 13);
        u.created_at = sqlite3_column_int64(st, 14);
        u.updated_at = sqlite3_column_int64(st, 15);
        u.public_id = colText(st, 16);
        if (u.public_id.empty()) u.public_id = formatUserId(u.id);
        u.crown_level = u.phone == loadConfig().ownerPhone ? "gold" : "";
        u.is_owner = u.crown_level == "gold" ? 1 : 0;
        out.push_back(u);
    }
    sqlite3_finalize(st);
    return out;
}
std::vector<Chat> Database::allChats() { return {}; }
std::vector<Message> Database::allMessages() { return {}; }
std::vector<ChatMember> Database::allChatMembers() { return {}; }
std::vector<Session> Database::allSessions() { return {}; }
std::vector<File> Database::allFiles() { return {}; }
std::vector<Folder> Database::allFolders() { return {}; }
std::vector<Database::GroupKey> Database::allGroupKeys() { return {}; }
std::vector<std::string> Database::allVerificationCodes() { return {}; }

// ---------- PUBLIC IDS ----------
std::string Database::getPublicUserId(int64_t internalId) {
    auto u = findUserById(internalId);
    return u ? u->public_id : formatUserId(internalId);
}

std::string Database::getPublicChatId(int64_t internalId, const std::string& type, std::optional<int64_t> requesterId) {
    auto c = findChatById(internalId);
    if (!c) return "";
    if (!c->public_id.empty()) return c->public_id;
    if (type == "private" && requesterId) {
        auto other = getPrivateChatOtherUserId(internalId, *requesterId);
        if (other) {
            auto u = findUserById(other);
            return u ? u->public_id : "";
        }
    }
    return formatChatId(internalId, type);
}

int64_t Database::getPrivateChatOtherUserId(int64_t negativeChatId, std::optional<int64_t> requesterInternalId) {
    if (negativeChatId >= 0) return 0;
    auto members = getChatMemberIds(negativeChatId);
    if (members.empty()) return 0;
    if (requesterInternalId) {
        for (auto m : members) if (m != *requesterInternalId) return m;
    }
    return members[0];
}

std::optional<Database::PublicResolve> Database::resolvePublicToken(const std::string& token) {
    std::string t = utils::trim(token);
    if (t.empty()) return std::nullopt;
    if (t.size() > 1 && t[0] == '-') {
        auto c = findChatByPublicId(t);
        if (c) return PublicResolve{false, c->id};
        return std::nullopt;
    }
    auto u = findUserByPublicId(t);
    if (u) return PublicResolve{true, u->id};
    auto c = findChatByPublicId(t);
    if (c) return PublicResolve{false, c->id};
    return std::nullopt;
}

void Database::assignPublicIds() {
    // public_id проставляется при добавлении (addUser/addChat); здесь ничего не делаем.
}

void Database::ensureSchema() {
    exec(R"(
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY, phone TEXT, email TEXT, first_name TEXT, last_name TEXT, name TEXT, username TEXT,
  password_hash TEXT, avatar TEXT, bio TEXT, public_key TEXT, online INTEGER DEFAULT 0, last_seen INTEGER DEFAULT 0,
  hide_online INTEGER DEFAULT 0, created_at INTEGER, updated_at INTEGER, public_id TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_phone ON users(phone);
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username ON users(username);
CREATE TABLE IF NOT EXISTS chats (id INTEGER PRIMARY KEY, type TEXT, public_id TEXT, name TEXT, avatar TEXT, description TEXT,
  owner_id INTEGER, is_pinned INTEGER DEFAULT 0, is_channel INTEGER DEFAULT 0, folder_id INTEGER, created_at INTEGER, updated_at INTEGER
);
CREATE TABLE IF NOT EXISTS chat_members (chat_id INTEGER, user_id INTEGER, role TEXT, joined_at INTEGER, last_read_message_id INTEGER DEFAULT 0,
  hidden INTEGER DEFAULT 0, cleared_at INTEGER DEFAULT 0, PRIMARY KEY(chat_id, user_id)
);
CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY, chat_id INTEGER, sender_id INTEGER, encrypted_content TEXT, iv TEXT,
  header TEXT, type TEXT, reply_to INTEGER, forwarded_from INTEGER, edited INTEGER DEFAULT 0, deleted_for_all INTEGER DEFAULT 0,
  deleted_by TEXT, reactions TEXT, pinned INTEGER DEFAULT 0, expires_at INTEGER, created_at INTEGER
);
CREATE TABLE IF NOT EXISTS sessions (id INTEGER PRIMARY KEY, user_id INTEGER, token TEXT, token_hash TEXT, expires_at INTEGER,
  created_at INTEGER, last_used INTEGER, user_agent TEXT, ip TEXT
);
CREATE TABLE IF NOT EXISTS files (id INTEGER PRIMARY KEY, filename TEXT, original_name TEXT, size INTEGER, mimetype TEXT, uploader_id INTEGER, created_at INTEGER
);
CREATE TABLE IF NOT EXISTS verification_codes (id INTEGER PRIMARY KEY, phone TEXT, code TEXT, attempts INTEGER DEFAULT 0, expires_at INTEGER, used INTEGER DEFAULT 0, created_at INTEGER
);
CREATE TABLE IF NOT EXISTS folders (id INTEGER PRIMARY KEY, user_id INTEGER, name TEXT, emoji TEXT, color TEXT, chat_ids TEXT, created_at INTEGER, updated_at INTEGER
);
CREATE TABLE IF NOT EXISTS group_keys (chat_id INTEGER PRIMARY KEY, version INTEGER, wrapped TEXT, created_by INTEGER, created_at INTEGER, updated_at INTEGER
);
CREATE TABLE IF NOT EXISTS counters (name TEXT PRIMARY KEY, value INTEGER);
CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages(chat_id, id);
CREATE INDEX IF NOT EXISTS idx_sessions_token_hash ON sessions(token_hash);
CREATE INDEX IF NOT EXISTS idx_chat_members_user ON chat_members(user_id);
CREATE INDEX IF NOT EXISTS idx_vcodes_phone ON verification_codes(phone);
)");
}

void Database::migrateSchema() {
    auto hasCol = [&](const char* table, const char* col) -> bool {
        sqlite3_stmt* st;
        std::string q = std::string("PRAGMA table_info(") + table + ")";
        sqlite3_prepare_v2(db, q.c_str(), -1, &st, nullptr);
        bool found = false;
        while (sqlite3_step(st) == SQLITE_ROW) {
            const char* c = reinterpret_cast<const char*>(sqlite3_column_text(st, 1));
            if (c && std::string(c) == col) { found = true; break; }
        }
        sqlite3_finalize(st);
        return found;
    };
    if (!hasCol("users", "email")) exec("ALTER TABLE users ADD COLUMN email TEXT;");
    if (!hasCol("users", "bio")) exec("ALTER TABLE users ADD COLUMN bio TEXT;");
    if (!hasCol("users", "hide_online")) exec("ALTER TABLE users ADD COLUMN hide_online INTEGER DEFAULT 0;");
    if (!hasCol("users", "public_id")) exec("ALTER TABLE users ADD COLUMN public_id TEXT;");
    if (!hasCol("users", "updated_at")) exec("ALTER TABLE users ADD COLUMN updated_at INTEGER;");
    if (!hasCol("chats", "public_id")) exec("ALTER TABLE chats ADD COLUMN public_id TEXT;");
    if (!hasCol("chats", "avatar")) exec("ALTER TABLE chats ADD COLUMN avatar TEXT;");
    if (!hasCol("chats", "is_channel")) exec("ALTER TABLE chats ADD COLUMN is_channel INTEGER DEFAULT 0;");
    if (!hasCol("chats", "folder_id")) exec("ALTER TABLE chats ADD COLUMN folder_id INTEGER;");
    if (!hasCol("sessions", "token_hash")) exec("ALTER TABLE sessions ADD COLUMN token_hash TEXT;");
    if (!hasCol("messages", "expires_at")) exec("ALTER TABLE messages ADD COLUMN expires_at INTEGER;");
}

} // namespace cipher
