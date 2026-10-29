#pragma once
// ============================================================
// Обёртка над SQLite3: открытие БД, выполнение схемы,
// подготовленные запросы. Потокобезопасность обеспечивается
// мьютексом (критические секции короткие).
// ============================================================
#include <sqlite3.h>
#include <string>
#include <mutex>
#include <memory>

class Database {
public:
    // Открыть (или создать) базу по пути
    explicit Database(const std::string& path);
    ~Database();

    // Недублируемый объект
    Database(const Database&) = delete;
    Database& operator=(const Database&) = delete;

    // Выполнить SQL без результатов (DDL/DML)
    bool exec(const std::string& sql);

    // Подготовить statement; возвращает nullptr при ошибке
    sqlite3_stmt* prepare(const std::string& sql);

    // Завершить подготовку statement
    void finalize(sqlite3_stmt* stmt);

    // Выполнить SQL-скрипт из нескольких инструкций
    bool execScript(const std::string& sql);

    // Доступ к сырому указателю не отдаём — все операции через методы выше.

private:
    sqlite3* db_ = nullptr;
    std::recursive_mutex mtx_; // рекурсивный, т.к. методы вызывают друг друга
};

// Глобальный экземпляр базы данных приложения
extern Database* g_db;
