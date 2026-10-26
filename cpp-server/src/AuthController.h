#pragma once
// AuthController: регистрация/логин (argon-подобный KDF + salt), выдача JWT, сессии,
// и ЕДИНАЯ проверка кредов для HTTP и WebSocket (Шаг 3):
//   - если токен содержит точки и проходит проверку HS256 => обычный JWT-пользователь;
//   - иначе это "сырой" токен бота: ищем SHA-256(token) в bot_tokens => авторизуем как бота.
#include "Http.h"
#include "Database.h"
#include "Jwt.h"
#include <string>

struct Principal {
    long long user_id = 0;
    bool is_bot = false;
    std::string sid;      // для JWT-сессий; у бота пуст
};

class AuthController {
public:
    AuthController(Database& db, std::string jwt_secret);

    Database& db() { return db_; }
    const std::string& jwtSecret() const { return jwt_secret_; }

    // Разбор Authorization: Bearer / query token. Возвращает true, если кред валиден.
    // Пустой/битый JWT => false (401 на уровне вызывающего), без исключений и логов секретов.
    bool authenticate(const http::Request& req, Principal& out);

    void registerRoutes(http::Server& server);

private:
    http::Response handleRegister(http::Request& req);
    http::Response handleLogin(http::Request& req);
    http::Response handleLogout(http::Request& req);

    Database& db_;
    std::string jwt_secret_;
};
