#include "user.h"
#include "encryption_service.h" // hashPassword/verifyPassword
#include <sstream>

namespace cipher {

static std::string jsonEscape(const std::string& s) {
    std::string out;
    out.reserve(s.size() + 2);
    for (char c : s) {
        switch (c) {
            case '"': out += "\\\""; break;
            case '\\': out += "\\\\"; break;
            case '\b': out += "\\b"; break;
            case '\f': out += "\\f"; break;
            case '\n': out += "\\n"; break;
            case '\r': out += "\\r"; break;
            case '\t': out += "\\t"; break;
            default:
                if (static_cast<unsigned char>(c) < 0x20) {
                    char buf[8];
                    snprintf(buf, sizeof(buf), "\\u%04x", c);
                    out += buf;
                } else {
                    out.push_back(c);
                }
        }
    }
    return out;
}

static std::string jsonStr(const std::string& s) {
    return "\"" + jsonEscape(s) + "\"";
}

static std::string jsonNum(int64_t n) { return std::to_string(n); }

User::User(const std::string& /*rowJson*/) {}

void User::setPassword(const std::string& password) {
    password_hash = EncryptionService::instance().hashPassword(password);
}

bool User::verifyPassword(const std::string& password) const {
    return EncryptionService::instance().verifyPassword(password, password_hash);
}

std::string User::toJson() const {
    std::string s = "{";
    s += "\"id\":" + jsonNum(id) + ",";
    s += "public_id:" + jsonStr(public_id) + ",";
    s += "phone:" + jsonStr(phone) + ",";
    s += "email:" + jsonStr(email) + ",";
    s += "first_name:" + jsonStr(first_name) + ",";
    s += "last_name:" + jsonStr(last_name) + ",";
    s += "name:" + jsonStr(name) + ",";
    s += "username:" + jsonStr(username) + ",";
    s += "avatar:" + jsonStr(avatar) + ",";
    s += "bio:" + jsonStr(bio) + ",";
    s += "public_key:" + jsonStr(public_key) + ",";
    s += "password_hash:" + jsonStr(password_hash) + ",";
    s += "online:" + jsonNum(online) + ",";
    s += "last_seen:" + jsonNum(last_seen) + ",";
    s += "hide_online:" + jsonNum(hide_online) + ",";
    s += "created_at:" + jsonNum(created_at) + ",";
    s += "crown_level:" + jsonStr(crown_level) + ",";
    s += "is_owner:" + jsonNum(is_owner);
    s += "}";
    return s;
}

std::string User::toSafeJson() const {
    std::string s = "{";
    s += "\"id\":" + jsonNum(id) + ",";
    s += "public_id:" + jsonStr(public_id) + ",";
    s += "phone:" + jsonStr(phone) + ",";
    s += "email:" + jsonStr(email) + ",";
    s += "first_name:" + jsonStr(first_name) + ",";
    s += "last_name:" + jsonStr(last_name) + ",";
    s += "name:" + jsonStr(name) + ",";
    s += "username:" + jsonStr(username) + ",";
    s += "avatar:" + jsonStr(avatar) + ",";
    s += "bio:" + jsonStr(bio) + ",";
    s += "public_key:" + jsonStr(public_key) + ",";
    s += "online:" + jsonNum(online) + ",";
    s += "last_seen:" + jsonNum(last_seen) + ",";
    s += "hide_online:" + jsonNum(hide_online) + ",";
    s += "created_at:" + jsonNum(created_at) + ",";
    s += "crown_level:" + jsonStr(crown_level) + ",";
    s += "is_owner:" + jsonNum(is_owner);
    s += "}";
    return s;
}

} // namespace cipher
