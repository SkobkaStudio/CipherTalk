#pragma once
// ProfileController: GET /api/me (профиль текущего юзера/бота) и POST /api/bots (создание бота).
#include "Http.h"
#include "AuthController.h"

class ProfileController {
public:
    explicit ProfileController(AuthController& auth);

    void registerRoutes(http::Server& server);

private:
    http::Response handleMe(http::Request& req);
    http::Response handleCreateBot(http::Request& req);

    AuthController& auth_;
};
