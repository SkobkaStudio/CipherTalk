#pragma once
// ============================================================
// Модель пользователя. Статические методы — CRUD-операции
// над таблицей users через подготовленные SQL-запросы.
// ============================================================
#include <string>
#include <vector>
#include <cstdint>

struct User {
    int64_t id = 0;
    std::string username;
    std::string displayName;
    std::string passwordHash;   // заполняется только внутри слоя моделей
    int64_t createdAt = 0;

    // Найти по id; false если не найден
    static bool findById(int64_t id, User& out);

    // Найти по логину; false если не найден
    static bool findByUsername(const std::string& username, User& out);

    // Создать пользователя (username уникален). Возвращает id или -1 при ошибке,
    // existingId заполняется если логин уже занят.
    static int64_t create(const std::string& username,
                          const std::string& displayName,
                          const std::string& passwordHash,
                          int64_t* existingId = nullptr);

    // Все пользователи (для списка контактов)
    static std::vector<User> all();
};
