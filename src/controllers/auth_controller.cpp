#include "auth_controller.h"
#include "../config/config.h"
#include "../utils/utils.h"
#include "../utils/mask.h"
#include "../utils/crowns.h"
#include <ctime>
#include <sstream>
#include <iostream>

namespace cipher {

namespace {
static std::string jfieldStr(const std::string& json, const char* field) {
    std::string key = "\"" + std::string(field) + "\":\"";
    size_t p = json.find(key);
    if (p == std::string::npos) return "";
    size_t s = p + key.size(), e = json.find('"', s);
    return e != std::string::npos ? json.substr(s, e - s) : "";
}
static int64_t jfieldInt(const std::string& json, const char* field) {
    std::string key = "\"" + std::string(field) + "\":";
    size_t p = json.find(key);
    if (p == std::string::npos) return 0;
    size_t s = p + key.size(), e = json.find_first_of(",}", s);
    if (e == std::string::npos) return 0;
    try { return std::stoll(json.substr(s, e - s)); } catch (...) { return 0; }
}
static std::string qparam(const std::string& query, const char* key) {
    std::string k = std::string(key) + "=";
    size_t p = query.find(k);
    if (p == std::string::npos) return "";
    size_t s = p + k.size(), e = query.find('&', s);
    if (e == std::string::npos) e = query.size();
    return query.substr(s, e - s);
}
}

AuthController::AuthController()
    : db_(Database::instance()), sessionService_(SessionService::instance()),
      smsService_(SmsService::instance()), enc_(EncryptionService::instance()) {}

std::string AuthController::normalizePhone(const std::string& raw) {
    return utils::normalizePhone(raw);
}

void AuthController::sendCode(const HttpRequest& req, HttpResponse& res) {
    try {
        std::string phone = normalizePhone(jfieldStr(req.body, "phone"));
        if (phone.empty() || phone.size() < 5) {
            res.status = 400;
            res.body = "{\"error\":\"Введите корректный номер телефона\"}";
            return;
        }
        Config cfg = loadConfig();
        auto nowMs = static_cast<int64_t>(std::time(nullptr)) * 1000;
        // rate limit отправки (в памяти, упрощённо)
        static std::map<std::string, int64_t> cooldowns;
        auto it = cooldowns.find(phone);
        if (it != cooldowns.end() && nowMs - it->second < cfg.codeExpiryMinutes * 60 * 1000 / 6) {
            res.status = 429;
            res.body = "{\"error\":\"Повторная отправка через некоторое время\"}";
            return;
        }
        cooldowns[phone] = nowMs;

        std::string code = enc_.randomDigits(6);
        int64_t expiresAt = nowMs + cfg.codeExpiryMinutes * 60 * 1000;

        if (!smsService_.sendCode(phone, code)) {
            res.status = 503;
            res.body = "{\"error\":\"Не удалось отправить код\"}";
            return;
        }

        db_.deleteVerificationCode(phone);
        int64_t id = db_.nextId("verification_codes");
        db_.addVerificationCode(id, phone, enc_.encrypt(code), expiresAt);

        auto existing = db_.findUserByPhone(phone);
        res.body = "{\"success\":true,\"message\":\"Код отправлен\",\"exists\":" + std::string(existing ? "true" : "false") + "}";
    } catch (...) {
        res.status = 500;
        res.body = "{\"error\":\"Ошибка отправки кода\"}";
    }
}

void AuthController::verifyCode(const HttpRequest& req, HttpResponse& res) {
    try {
        std::string phone = normalizePhone(jfieldStr(req.body, "phone"));
        std::string code = jfieldStr(req.body, "code");
        if (phone.empty() || code.empty()) {
            res.status = 400;
            res.body = "{\"error\":\"Укажите номер и код\"}";
            return;
        }

        // Ищем код
        std::string storedRaw;
        for (auto& c : db_.findVerificationCode(phone)) {
            std::string dec = enc_.decrypt(c);
            if (dec == code) { storedRaw = c; break; }
        }
        if (storedRaw.empty()) {
            res.status = 400;
            res.body = "{\"error\":\"Неверный или просроченный код\"}";
            return;
        }

        db_.deleteVerificationCode(phone);
        auto existing = db_.findUserByPhone(phone);
        int64_t nowMs = static_cast<int64_t>(std::time(nullptr)) * 1000;
        int64_t ttlMs = 10 * 60 * 1000;

        if (existing) {
            std::string payload = "{\"phone\":\"" + phone + "\",\"userId\":" + std::to_string(existing->id) +
                                  ",\"scope\":\"login\",\"exp\":" + std::to_string(nowMs + ttlMs) + "}";
            std::string loginToken = enc_.encrypt(payload);
            res.body = "{\"success\":true,\"action\":\"login\",\"phone\":\"" + phone + "\",\"loginToken\":\"" + loginToken + "\"}";
        } else {
            std::string payload = "{\"phone\":\"" + phone + "\",\"scope\":\"register\",\"exp\":" + std::to_string(nowMs + ttlMs) + "}";
            std::string verifyToken = enc_.encrypt(payload);
            res.body = "{\"success\":true,\"action\":\"register\",\"phone\":\"" + phone + "\",\"verifyToken\":\"" + verifyToken + "\"}";
        }
    } catch (...) {
        res.status = 500;
        res.body = "{\"error\":\"Ошибка проверки кода\"}";
    }
}

bool AuthController::consumeRegisterProof(const std::string& phone, const std::string& verifyToken) {
    if (verifyToken.empty()) return false;
    std::string raw = enc_.decrypt(verifyToken);
    if (raw.empty()) return false;
    // Упрощённый парсинг: проверяем scope=register, phone, exp
    if (raw.find("\"scope\":\"register\"") == std::string::npos) return false;
    if (raw.find("\"phone\":\"" + phone + "\"") == std::string::npos) return false;
    size_t ep = raw.find("\"exp\":");
    if (ep == std::string::npos) return false;
    size_t s = ep + 6, e = raw.find('}', s);
    if (e == std::string::npos) e = raw.size();
    try {
        int64_t exp = std::stoll(raw.substr(s, e - s));
        if (exp <= static_cast<int64_t>(std::time(nullptr)) * 1000) return false;
    } catch (...) { return false; }
    return true;
}

bool AuthController::consumeLoginProof(const std::string& phone, const std::string& loginToken, int64_t& userId) {
    if (loginToken.empty()) return false;
    std::string raw = enc_.decrypt(loginToken);
    if (raw.empty()) return false;
    if (raw.find("\"scope\":\"login\"") == std::string::npos) return false;
    if (raw.find("\"phone\":\"" + phone + "\"") == std::string::npos) return false;
    size_t up = raw.find("\"userId\":");
    if (up == std::string::npos) return false;
    size_t s = up + 9, e = raw.find(',', s);
    if (e == std::string::npos) e = raw.find('}', s);
    try { userId = std::stoll(raw.substr(s, e - s)); } catch (...) { return false; }
    size_t ep = raw.find("\"exp\":");
    if (ep == std::string::npos) return false;
    size_t es = ep + 6, ee = raw.find('}', es);
    if (ee == std::string::npos) ee = raw.size();
    try {
        int64_t exp = std::stoll(raw.substr(es, ee - es));
        if (exp <= static_cast<int64_t>(std::time(nullptr)) * 1000) return false;
    } catch (...) { return false; }
    return true;
}

void AuthController::registerUser(const HttpRequest& req, HttpResponse& res) {
    try {
        std::string phone = normalizePhone(jfieldStr(req.body, "phone"));
        std::string verifyToken = jfieldStr(req.body, "verifyToken");
        if (!consumeRegisterProof(phone, verifyToken)) {
            res.status = 403;
            res.body = "{\"error\":\"Подтвердите номер телефона кодом из SMS\"}";
            return;
        }
        std::string firstName = jfieldStr(req.body, "firstName");
        std::string lastName = jfieldStr(req.body, "lastName");
        std::string username = utils::normalizeUsername(jfieldStr(req.body, "username"));
        std::string password = jfieldStr(req.body, "password");
        std::string publicKey = jfieldStr(req.body, "publicKey");
        std::string email = jfieldStr(req.body, "email");

        if (firstName.size() < 2) { res.status = 400; res.body = "{\"error\":\"Имя минимум 2 символа\"}"; return; }
        Config cfg = loadConfig();
        if (username.size() < cfg.usernameMinLength || username.size() > 32) { res.status = 400; res.body = "{\"error\":\"Некорректный username\"}"; return; }
        if (!password.empty() && password.size() < cfg.passwordMinLength) { res.status = 400; res.body = "{\"error\":\"Короткий пароль\"}"; return; }
        if (db_.findUserByPhone(phone)) { res.status = 400; res.body = "{\"error\":\"Номер уже зарегистрирован\"}"; return; }
        if (db_.isUsernameTaken(username)) { res.status = 400; res.body = "{\"error\":\"Username занят\"}"; return; }

        User u;
        u.phone = phone; u.email = email; u.first_name = firstName; u.last_name = lastName;
        u.name = firstName + (lastName.empty() ? "" : " " + lastName);
        u.username = username; u.public_key = publicKey;
        u.created_at = static_cast<int64_t>(std::time(nullptr)) * 1000;
        if (!password.empty()) u.setPassword(password);
        u = db_.addUser(u);

        // Избранное
        int64_t savedId = db_.nextId("chats");
        Chat saved; saved.id = savedId; saved.type = "saved"; saved.name = "Избранное";
        saved.owner_id = u.id; saved.public_id = u.public_id;
        saved.created_at = u.created_at; saved.updated_at = u.created_at;
        db_.addChat(saved);
        int64_t now = u.created_at;
        db_.addChatMember({savedId, u.id, "owner", now, 0, 0, 0});

        auto ss = sessionService_.create(u.id, "web");
        res.body = "{\"success\":true,\"user\":" + u.toSafeJson() + ",\"token\":\"" + ss.token + "\"}";
    } catch (...) {
        res.status = 500;
        res.body = "{\"error\":\"Ошибка регистрации\"}";
    }
}

void AuthController::login(const HttpRequest& req, HttpResponse& res) {
    try {
        std::string phone = normalizePhone(jfieldStr(req.body, "phone"));
        std::string password = jfieldStr(req.body, "password");
        std::string publicKey = jfieldStr(req.body, "publicKey");
        if (phone.empty() || password.empty()) { res.status = 400; res.body = "{\"error\":\"Номер и пароль\"}"; return; }

        auto user = db_.findUserByPhone(phone);
        if (!user) { res.status = 404; res.body = "{\"error\":\"Пользователь не найден\"}"; return; }
        if (!user->verifyPassword(password)) { res.status = 400; res.body = "{\"error\":\"Неверный пароль\"}"; return; }

        if (!publicKey.empty()) {
            db_.updateUser(user->id, {{"public_key", publicKey}});
        }
        auto ss = sessionService_.create(user->id, "web");
        res.body = "{\"success\":true,\"user\":" + user->toSafeJson() + ",\"token\":\"" + ss.token + "\"}";
    } catch (...) {
        res.status = 500;
        res.body = "{\"error\":\"Ошибка входа\"}";
    }
}

void AuthController::loginWithCode(const HttpRequest& req, HttpResponse& res) {
    try {
        std::string phone = normalizePhone(jfieldStr(req.body, "phone"));
        std::string loginToken = jfieldStr(req.body, "loginToken");
        std::string publicKey = jfieldStr(req.body, "publicKey");
        int64_t userId = 0;
        if (!consumeLoginProof(phone, loginToken, userId)) {
            res.status = 403;
            res.body = "{\"error\":\"Токен входа недействителен\"}";
            return;
        }
        auto user = db_.findUserById(userId);
        if (!user || user->phone != phone) { res.status = 404; res.body = "{\"error\":\"Пользователь не найден\"}"; return; }
        if (!publicKey.empty()) db_.updateUser(user->id, {{"public_key", publicKey}});
        auto ss = sessionService_.create(user->id, "web");
        res.body = "{\"success\":true,\"user\":" + user->toSafeJson() + ",\"token\":\"" + ss.token + "\"}";
    } catch (...) {
        res.status = 500;
        res.body = "{\"error\":\"Ошибка входа\"}";
    }
}

void AuthController::logout(const HttpRequest& req, HttpResponse& res) {
    // token передаётся через middleware (req.headers Authorization)
    auto it = req.headers.find("Authorization");
    if (it != req.headers.end()) {
        std::string hdr = it->second;
        if (hdr.compare(0, 7, "Bearer ") == 0) {
            sessionService_.revokeToken(hdr.substr(7));
        }
    }
    res.body = "{\"success\":true}";
}

void AuthController::me(const HttpRequest& req, HttpResponse& res) {
    // userId должен быть установлен middleware
    auto it = req.headers.find("X-User-Id");
    if (it == req.headers.end()) { res.status = 401; res.body = "{\"error\":\"Не авторизован\"}"; return; }
    int64_t uid = std::stoll(it->second);
    auto user = db_.findUserById(uid);
    if (!user) { res.status = 404; res.body = "{\"error\":\"Не найден\"}"; return; }
    res.body = "{\"success\":true,\"user\":" + user->toSafeJson() + "}";
}

void AuthController::listSessions(const HttpRequest& req, HttpResponse& res) {
    (void)req;
    res.body = "[]";
}

void AuthController::revokeSession(const HttpRequest& req, HttpResponse& res) {
    (void)req;
    res.body = "{\"success\":true}";
}

void AuthController::checkUsername(const HttpRequest& req, HttpResponse& res) {
    std::string username = qparam(req.query, "username");
    if (username.empty()) { res.body = "{\"available\":false}"; return; }
    username = utils::normalizeUsername(username);
    Config cfg = loadConfig();
    if (username.size() < cfg.usernameMinLength) { res.body = "{\"available\":false}"; return; }
    bool taken = db_.isUsernameTaken(username);
    res.body = "{\"available\":" + std::string(taken ? "false" : "true") + ",\"username\":\"" + username + "\"}";
}

} // namespace cipher
