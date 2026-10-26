#include "profile_controller.h"
#include "../config/config.h"
#include "../utils/utils.h"
#include "../utils/mask.h"
#include <ctime>
#include <sstream>

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

ProfileController::ProfileController() : db_(Database::instance()) {}

void ProfileController::updateProfile(const HttpRequest& req, HttpResponse& res) {
    try {
        auto it = req.headers.find("X-User-Id");
        if (it == req.headers.end()) { res.status = 401; res.body = "{\"error\":\"Не авторизован\"}"; return; }
        int64_t userId = std::stoll(it->second);
        auto user = db_.findUserById(userId);
        if (!user) { res.status = 404; res.body = "{\"error\":\"User not found\"}"; return; }

        std::map<std::string, std::string> updates;
        std::string firstName = jfieldStr(req.body, "firstName");
        if (!firstName.empty()) updates["first_name"] = firstName;
        std::string lastName = jfieldStr(req.body, "lastName");
        if (!lastName.empty()) updates["last_name"] = lastName;
        std::string name = jfieldStr(req.body, "name");
        if (!name.empty()) updates["name"] = name;
        std::string username = jfieldStr(req.body, "username");
        if (!username.empty()) {
            username = utils::normalizeUsername(username);
            if (db_.isUsernameTaken(username, userId)) { res.status = 400; res.body = "{\"error\":\"Username занят\"}"; return; }
            updates["username"] = username;
        }
        std::string email = jfieldStr(req.body, "email");
        if (!email.empty()) updates["email"] = email;
        std::string bio = jfieldStr(req.body, "bio");
        if (!bio.empty()) updates["bio"] = bio;
        std::string avatar = jfieldStr(req.body, "avatar");
        if (!avatar.empty()) updates["avatar"] = avatar;
        std::string publicKey = jfieldStr(req.body, "publicKey");
        if (!publicKey.empty()) updates["public_key"] = publicKey;

        if (!updates.empty()) db_.updateUser(userId, updates);
        auto updated = db_.findUserById(userId);
        res.body = "{\"success\":true,\"user\":" + updated->toSafeJson() + "}";
    } catch (...) {
        res.status = 500;
        res.body = "{\"error\":\"Ошибка обновления профиля\"}";
    }
}

void ProfileController::getProfile(const HttpRequest& req, HttpResponse& res) {
    try {
        auto it = req.headers.find("X-User-Id");
        int64_t me = 0;
        if (it != req.headers.end()) me = std::stoll(it->second);
        int64_t targetId = me;
        auto pit = req.headers.find("X-Target-User-Id");
        if (pit != req.headers.end()) targetId = std::stoll(pit->second);
        //либо из пути
        auto user = db_.findUserById(targetId);
        if (!user) { res.status = 404; res.body = "{\"error\":\"Пользователь не найден\"}"; return; }
        std::string json = user->toSafeJson();
        if (targetId != me) {
            // маскируем телефон/email
            size_t p = json.find("\"phone\":");
            if (p != std::string::npos) {
                size_t s = json.find('"', p + 8) + 1;
                size_t e = json.find('"', s);
                std::string masked = mask::maskPhone(json.substr(s, e - s));
                json = json.substr(0, s) + masked + json.substr(e);
            }
        }
        res.body = json;
    } catch (...) {
        res.status = 500;
        res.body = "{\"error\":\"Ошибка профиля\"}";
    }
}

void ProfileController::searchUsers(const HttpRequest& req, HttpResponse& res) {
    try {
        auto it = req.headers.find("X-User-Id");
        if (it == req.headers.end()) { res.status = 401; res.body = "{\"error\":\"Не авторизован\"}"; return; }
        int64_t me = std::stoll(it->second);
        std::string query = qparam(req.query, "q");
        if (query.empty()) query = qparam(req.query, "query");
        query = utils::trim(query);
        if (query.empty()) { res.body = "[]"; return; }

        std::string q = utils::toLower(utils::trim(query));
        if (!q.empty() && q[0] == '@') q.erase(0, 1);

        auto all = db_.allUsers();
        std::ostringstream oss;
        oss << "[";
        bool first = true;
        int count = 0;
        for (auto& u : all) {
            if (u.id == me) continue;
            std::string hay = utils::toLower(u.username + " " + u.email + " " + u.name + " " + u.first_name + " " + u.last_name + " " + u.phone);
            bool match = hay.find(q) != std::string::npos;
            if (!match) continue;
            if (!first) oss << ",";
            first = false;
            if (++count > 50) break;
            oss << "{\"id\":" << u.id << ",\"username\":\"" << u.username << "\",\"name\":\"" << u.name << "\""
                << ",\"phone\":\"" << mask::maskPhone(u.phone) << "\",\"email\":\"" << mask::maskEmail(u.email) << "\""
                << ",\"avatar\":\"" << u.avatar << "\",\"public_id\":\"" << u.public_id << "\"}";
        }
        oss << "]";
        res.body = oss.str();
    } catch (...) {
        res.status = 500;
        res.body = "{\"error\":\"Ошибка поиска\"}";
    }
}

} // namespace cipher
