#pragma once
// ============================================================
// Контроллер аутентификации: обработчики /api/register, /api/login,
// /api/me. Проверяют входные данные, вызывают модели и сервис JWT.
// ============================================================
#include "utils/http_server.hpp"

namespace auth_controller {

// POST /api/register {username, password, displayName?}
HttpResponse registerUser(const HttpRequest& req);

// POST /api/login {username, password}
HttpResponse login(const HttpRequest& req);

// GET /api/me — текущий пользователь по Bearer-токену
HttpResponse me(const HttpRequest& req);

// Проверить Bearer-токен запроса; при успехе возвращает id пользователя,
// иначе -1 (и заполняет errorResp, если он передан).
int64_t requireAuth(const HttpRequest& req, HttpResponse* errorResp = nullptr);

} // namespace auth_controller
