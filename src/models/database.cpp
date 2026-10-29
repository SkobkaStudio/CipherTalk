// ============================================================
// Реализация обёртки SQLite3 + инициализация схемы БД.
// Схема: users, chats, chat_participants, messages.
// ============================================================
#include "models/database.hpp"
#include <iostream>

Database::Database(const std::string& path) {
    int rc = sqlite3_open(path.c_str(), &db_);
    if (rc != SQLITE_OK) {
        std::cerr << "[db] Не удалось открыть базу: " << sqlite3_errmsg(db_) << std::endl;
        db_ = nullptr;
        return;
    }
    // Режим WAL — лучше для конкурентного доступа из нескольких потоков
    exec("PRAGMA journal_mode=WAL;");
    exec("PRAGMA foreign_keys=ON;");
}

Database::~Database() {
    if (db_) sqlite3_close(db_);
}

bool Database::exec(const std::string& sql) {
    std::lock_guard<std::recursive_mutex> lock(mtx_);
    if (!db_) return false;
    char* err = nullptr;
    int rc = sqlite3_exec(db_, sql.c_str(), nullptr, nullptr, &err);
    if (rc != SQLITE_OK) {
        std::cerr << "[db] Ошибка выполнения: " << (err ? err : "?") << std::endl;
        sqlite3_free(err);
        return false;
    }
    return true;
}

sqlite3_stmt* Database::prepare(const std::string& sql) {
    std::lock_guard<std::recursive_mutex> lock(mtx_);
    if (!db_) return nullptr;
    sqlite3_stmt* stmt = nullptr;
    if (sqlite3_prepare_v2(db_, sql.c_str(), -1, &stmt, nullptr) != SQLITE_OK) {
        std::cerr << "[db] Ошибка подготовки: " << sqlite3_errmsg(db_) << std::endl;
        return nullptr;
    }
    return stmt;
}

void Database::finalize(sqlite3_stmt* stmt) {
    if (stmt) sqlite3_finalize(stmt);
}

bool Database::execScript(const std::string& sql) {
    std::lock_guard<std::recursive_mutex> lock(mtx_);
    if (!db_) return false;
    char* err = nullptr;
    int rc = sqlite3_exec(db_, sql.c_str(), nullptr, nullptr, &err);
    if (rc != SQLITE_OK) {
        std::cerr << "[db] Ошибка скрипта: " << (err ? err : "?") << std::endl;
        sqlite3_free(err);
        return false;
    }
    return true;
}
