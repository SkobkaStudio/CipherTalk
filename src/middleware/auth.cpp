#include "auth.h"
#include "../services/session_service.h"

namespace cipher {

void AuthMiddleware::authenticate(HttpRequest& req, HttpResponse& res, bool& continueHandling) {
    continueHandling = true;
    auto it = req.headers.find("Authorization");
    if (it == req.headers.end() || it->second.compare(0, 7, "Bearer ") != 0) {
        res.status = 401;
        res.body = "{\"error\":\"Требуется авторизация\"}";
        continueHandling = false;
        return;
    }
    std::string token = it->second.substr(7);
    auto auth = SessionService::instance().verify(token);
    if (!auth.valid) {
        res.status = 401;
        res.body = "{\"error\":\"Сессия недействительна или истекла\"}";
        continueHandling = false;
        return;
    }
    req.headers["X-User-Id"] = std::to_string(auth.user.id);
    // Профиль целевого пользователя (если передан ?userId=)
    auto qit = req.headers.find("X-Target-User-Id"); // не используется
    (void)qit;
}

} // namespace cipher
