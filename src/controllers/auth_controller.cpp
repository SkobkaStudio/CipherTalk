// ============================================================
// Реализация контроллера аутентификации.
// Регистрация: валидация -> хеш пароля -> INSERT -> JWT.
// Логин: поиск пользователя -> проверка пароля -> JWT.
// ============================================================
#include "controllers/auth_controller.hpp"
#include "models/user.hpp"
#include "services/auth_service.hpp"
#include "utils/crypto.hpp"
#include "utils/json.hpp"

#include <algorithm>
#include <cctype>

namespace auth_controller {

// Проверка допустимости имени пользователя: 3..32 символа, [a-zA-Z0-9_.]
static bool validUsername(const std::string& u) {
    if (u.size() < 3 || u.size() > 32) return false;
    for (char c : u) {
        if (!(std::isalnum(static_cast<unsigned char>(c)) || c == '_' || c == '.'))
            return false;
    }
    return true;
}

// Обрезать строку и проверить непустоту
static std::string trim(const std::string& s) {
    size_t a = s.find_first_not_of(" \t\r\n");
    if (a == std::string::npos) return "";
    size_t b = s.find_last_not_of(" \t\r\n");
    return s.substr(a, b - a + 1);
}

// JSON-ответ с ошибкой
static HttpResponse error(int status, const std::string& message) {
    json::JsonObject o;
    o.put("error", message);
    return HttpResponse::json(status, json::dump(o));
}

HttpResponse registerUser(const HttpRequest& req) {
    json::JsonObject body;
    if (!json::parse(req.body, body)) return error(400, "некорректный JSON");

    std::string username = trim(body.get("username"));
    std::string password = body.get("password");
    std::string displayName = trim(body.get("displayName"));
    if (displayName.empty()) displayName = username;

    if (!validUsername(username))
        return error(400, "логин: 3-32 символа, только буквы/цифры/_/.");
    if (password.size() < 6)
        return error(400, "пароль должен быть не короче 6 символов");

    // Хеш пароля с солью (bcrypt-подобная схема salt$sha256)
    std::string hash = crypto::hashPassword(password);

    int64_t existingId = 0;
    int64_t id = User::create(username, displayName, hash, &existingId);
    if (id < 0) {
        if (existingId > 0) return error(409, "такое имя пользователя уже занято");
        return error(500, "ошибка создания пользователя");
    }

    std::string token = auth::createToken(id, username);

    json::JsonObject out;
    out.put("token", token);
    out.put("userId", std::to_string(id));
    out.put("username", username);
    out.put("displayName", displayName);
    return HttpResponse::json(201, json::dump(out));
}

HttpResponse login(const HttpRequest& req) {
    json::JsonObject body;
    if (!json::parse(req.body, body)) return error(400, "некорректный JSON");

    std::string username = trim(body.get("username"));
    std::string password = body.get("password");

    User user;
    if (!User::findByUsername(username, user))
        return error(401, "неверный логин или пароль");
    if (!crypto::verifyPassword(password, user.passwordHash))
        return error(401, "неверный логин или пароль");

    std::string token = auth::createToken(user.id, user.username);

    json::JsonObject out;
    out.put("token", token);
    out.put("userId", std::to_string(user.id));
    out.put("username", user.username);
    out.put("displayName", user.displayName);
    return HttpResponse::json(200, json::dump(out));
}

// Общая реализация проверки авторизации
int64_t requireAuth(const HttpRequest& req, HttpResponse* errorResp) {
    std::string bearer = auth::extractBearer(req.header("authorization"));
    int64_t userId = 0;
    std::string username;
    if (bearer.empty() || !auth::verifyToken(bearer, userId, username)) {
        if (errorResp) *errorResp = error(401, "требуется авторизация");
        return -1;
    }
    // Убеждаемся, что пользователь всё ещё существует
    User u;
    if (!User::findById(userId, u)) {
        if (errorResp) *errorResp = error(401, "пользователь не найден");
        return -1;
    }
    return userId;
}

HttpResponse me(const HttpRequest& req) {
    HttpResponse err;
    int64_t userId = requireAuth(req, &err);
    if (userId < 0) return err;

    User u;
    User::findById(userId, u);
    json::JsonObject out;
    out.put("id", std::to_string(u.id));
    out.put("username", u.username);
    out.put("displayName", u.displayName);
    return HttpResponse::json(200, json::dump(out));
}

} // namespace auth_controller
