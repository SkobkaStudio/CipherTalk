#pragma once

#include <string>
#include "../http_server.h"

namespace cipher {

class AuthMiddleware {
public:
    // Проверка Bearer-токена, установка X-User-Id заголовка для контроллеров
    static void authenticate(HttpRequest& req, HttpResponse& res, bool& continueHandling);
};

} // namespace cipher
