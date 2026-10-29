#pragma once
// ============================================================
// Контроллер чатов и сообщений:
// GET  /api/chats          — список чатов пользователя
// POST /api/chats          — создать чат {withUserId} или группу {name, memberIds[]}
// GET  /api/messages?chatId=N&limit=100 — история сообщений
// POST /api/messages       — отправить сообщение {chatId, text} (JSON + WebSocket)
// GET  /api/users          — все пользователи (для новых чатов)
// ============================================================
#include "utils/http_server.hpp"

namespace chat_controller {

HttpResponse listChats(const HttpRequest& req);
HttpResponse createChat(const HttpRequest& req);
HttpResponse listMessages(const HttpRequest& req);
HttpResponse sendMessage(const HttpRequest& req);
HttpResponse listUsers(const HttpRequest& req);

} // namespace chat_controller
