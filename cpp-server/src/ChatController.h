#pragma once
// ChatController: список чатов, создание чатов/участников и история сообщений (Шаг 4).
#include "Http.h"
#include "AuthController.h"

class WsController; // forward

class ChatController {
public:
    ChatController(AuthController& auth, WsController& ws);

    void registerRoutes(http::Server& server);

private:
    http::Response handleListChats(http::Request& req);
    http::Response handleCreateChat(http::Request& req);
    http::Response handleAddMember(http::Request& req);
    http::Response handleMessages(http::Request& req);   // GET /api/chats/:id/messages

    bool parseChatId(const http::Request& req, long long& out) const;

    AuthController& auth_;
    WsController& ws_;
};
