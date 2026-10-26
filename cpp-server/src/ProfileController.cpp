#include "ProfileController.h"
#include "Crypto.h"
#include "Json.h"

ProfileController::ProfileController(AuthController& auth) : auth_(auth) {}

void ProfileController::registerRoutes(http::Server& server) {
    server.get("/api/me", [this](http::Request& req) { return handleMe(req); });
    server.post("/api/bots", [this](http::Request& req) { return handleCreateBot(req); });
}

// --- Шаг 1: GET /api/me ---
// Требует JWT (или токен бота). Возвращает {"id":1,"phone":"...","username":"...","is_bot":0}.
http::Response ProfileController::handleMe(http::Request& req) {
    Principal p;
    if (!auth_.authenticate(req, p)) return http::Response::error(401, "unauthorized");

    Database& db = auth_.db();
    auto user = db.findUserById(p.user_id);
    if (!user) return http::Response::error(401, "unauthorized"); // аккаунт удалён из БД

    json::Object resp;
    resp["id"] = json::Value(user->id);
    // phone/username у бота могут быть NULL — отдаём null в JSON вместо пустой строки
    resp["phone"] = user->phone.empty() ? json::Value(nullptr) : json::Value(user->phone);
    resp["username"] = user->username.empty() ? json::Value(nullptr) : json::Value(user->username);
    resp["is_bot"] = json::Value(user->is_bot ? 1 : 0);
    return http::Response::json(200, json::Value(resp).dump());
}

// --- Шаг 2: POST /api/bots ---
// Только обычный (не бот) авторизованный пользователь может создать бота.
// Токен генерируется через OpenSSL RAND_bytes (32 байта -> 64 hex символа),
// в БД хранится только его SHA-256; сам токен возвращается ОДИН раз.
http::Response ProfileController::handleCreateBot(http::Request& req) {
    Principal p;
    if (!auth_.authenticate(req, p)) return http::Response::error(401, "unauthorized");
    if (p.is_bot) return http::Response::error(403, "bots cannot create bots");

    Database& db = auth_.db();

    std::string token;      // 32 байта криптослучайных данных в hex
    long long bot_id = 0;
    for (int attempt = 0; attempt < 5; ++attempt) {
        token = crypto::randomHex(32);
        std::string username = "bot_" + token.substr(0, 12);
        try {
            bot_id = db.createBotUser(username);          // is_bot=1, phone=NULL, password_hash=NULL
            db.insertBotToken(bot_id, crypto::sha256Hex(token));
            break;
        } catch (const std::exception&) {
            // Коллизия username/token-hash — повторить попытку. Текст исключения не логируем
            // (он может содержать SQL-фрагменты с данными).
            continue;
        }
    }
    if (bot_id == 0) return http::Response::error(500, "failed to create bot, try again");

    json::Object resp;
    resp["bot_id"] = json::Value(bot_id);
    resp["token"] = json::Value(token);   // показывается ровно один раз
    return http::Response::json(201, json::Value(resp).dump());
}
