#include "AuthController.h"
#include "Crypto.h"
#include "Json.h"
#include <ctime>
#include <regex>
#include <iostream>

namespace {
constexpr long long kTokenTtlSeconds = 7 * 24 * 3600; // 7 дней

std::string extractCredential(const http::Request& req) {
    std::string auth = req.header("Authorization");
    const std::string prefix = "Bearer ";
    if (auth.size() > prefix.size() && auth.compare(0, prefix.size(), prefix) == 0) {
        return auth.substr(prefix.size());
    }
    if (!auth.empty()) return auth;              // голый токен без схемы
    return req.qparam("token");                  // fallback для GET/WS handshake
}
} // namespace

AuthController::AuthController(Database& db, std::string jwt_secret)
    : db_(db), jwt_secret_(std::move(jwt_secret)) {}

bool AuthController::authenticate(const http::Request& req, Principal& out) {
    std::string credential = extractCredential(req);
    if (credential.empty()) return false;

    // --- Ветка 1: JWT (содержит ровно две точки) ---
    if (credential.find('.') != std::string::npos) {
        jwt::Claims claims;
        if (!jwt::verify(jwt_secret_, credential, claims)) return false;
        auto user = db_.findUserById(claims.sub);
        if (!user) return false;                                  // юзер удалён
        if (user->is_bot != claims.is_bot) return false;          // тип не должен расходиться
        // Сессия обязательна для обычных пользователей (revocation support).
        if (!claims.is_bot) {
            if (claims.sid.empty() || !db_.sessionActive(claims.sid, claims.sub)) return false;
        }
        out.user_id = claims.sub;
        out.is_bot = claims.is_bot;
        out.sid = claims.sid;
        return true;
    }

    // --- Ветка 2: сырой токен бота (нет точек) -> SHA-256 -> bot_tokens ---
    std::string hash = crypto::sha256Hex(credential);
    auto bot_id = db_.findBotIdByTokenHash(hash);
    if (!bot_id) return false;
    out.user_id = *bot_id;
    out.is_bot = true;
    out.sid.clear();
    return true;
}

void AuthController::registerRoutes(http::Server& server) {
    server.post("/api/register", [this](http::Request& req) { return handleRegister(req); });
    server.post("/api/login",    [this](http::Request& req) { return handleLogin(req); });
    server.post("/api/logout",   [this](http::Request& req) { return handleLogout(req); });
}

http::Response AuthController::handleRegister(http::Request& req) {
    json::Value body;
    try {
        body = json::parse(req.body);
    } catch (const std::exception&) {
        return http::Response::error(400, "invalid JSON body");
    }
    if (!body.isObject()) return http::Response::error(400, "body must be an object");

    std::string phone, password;
    if (body.has("phone") && body["phone"].isString()) phone = body["phone"].asString();
    if (body.has("password") && body["password"].isString()) password = body["password"].asString();

    static const std::regex phone_re(R"(^\+?\d{7,15}$)");
    if (!std::regex_match(phone, phone_re)) return http::Response::error(400, "invalid phone format");
    if (password.size() < 8 || password.size() > 128)
        return http::Response::error(400, "password must be 8..128 characters");

    if (db_.findUserByPhone(phone)) {
        // Пользователь уже существует — не раскрываем, был ли это бот или юзер.
        return http::Response::error(409, "phone already registered");
    }

    std::string hash = crypto::hashPassword(password);
    long long id = db_.createUser(phone, hash);

    json::Object resp;
    resp["id"] = json::Value(id);
    resp["phone"] = json::Value(phone);
    return http::Response::json(201, json::Value(resp).dump());
}

http::Response AuthController::handleLogin(http::Request& req) {
    json::Value body;
    try {
        body = json::parse(req.body);
    } catch (const std::exception&) {
        return http::Response::error(400, "invalid JSON body");
    }
    if (!body.isObject()) return http::Response::error(400, "body must be an object");

    std::string phone, password;
    if (body.has("phone") && body["phone"].isString()) phone = body["phone"].asString();
    if (body.has("password") && body["password"].isString()) password = body["password"].asString();

    auto user = db_.findUserByPhone(phone);
    // Шаг 5: неверные креды => 401 (не 500). Одинаковый ответ для «нет юзера» и «неверный пароль»,
    // чтобы не давать oracle для перебора телефонов. Пароль/хэш не логируются.
    if (!user || user->is_bot || user->password_hash.empty() ||
        !crypto::verifyPassword(password, user->password_hash)) {
        return http::Response::error(401, "invalid phone or password");
    }

    std::string sid = crypto::randomHex(16);
    long long now = static_cast<long long>(std::time(nullptr));
    db_.createSession(sid, user->id, now + kTokenTtlSeconds);

    std::string token = jwt::create(jwt_secret_, user->id, /*is_bot=*/false, sid, kTokenTtlSeconds);

    json::Object resp;
    resp["token"] = json::Value(token);
    resp["user"] = json::Value([&] {
        json::Object u;
        u["id"] = json::Value(user->id);
        u["phone"] = json::Value(user->phone);
        u["is_bot"] = json::Value(0);
        return json::Value(u);
    }());
    return http::Response::json(200, json::Value(resp).dump());
}

http::Response AuthController::handleLogout(http::Request& req) {
    Principal p;
    if (!authenticate(req, p)) return http::Response::error(401, "unauthorized");
    if (!p.is_bot && !p.sid.empty()) db_.revokeSession(p.sid);
    return http::Response::json(200, "{\"ok\":true}");
}
