// ============================================================
// Реализация JWT (HS256) с использованием OpenSSL HMAC.
// ============================================================
#include "services/auth_service.hpp"
#include "utils/crypto.hpp"
#include "utils/config.hpp"

#include <ctime>
#include <cstdlib>

namespace auth {

std::string createToken(int64_t userId, const std::string& username) {
    // Заголовок алгоритма
    std::string header = "{\"alg\":\"HS256\",\"typ\":\"JWT\"}";
    // Полезная нагрузка: id, логин, время выдачи и срок действия
    long now = static_cast<long>(std::time(nullptr));
    std::string payload =
        "{\"uid\":" + std::to_string(userId) +
        ",\"username\":\"" + username + "\"" +
        ",\"iat\":" + std::to_string(now) +
        ",\"exp\":" + std::to_string(now + config::JWT_EXPIRES_IN) + "}";

    std::string h = crypto::base64urlEncode(header);
    std::string p = crypto::base64urlEncode(payload);
    std::string signingInput = h + "." + p;
    std::string sig = crypto::base64urlEncode(
        crypto::hmacSha256(config::JWT_SECRET, signingInput));
    return signingInput + "." + sig;
}

bool verifyToken(const std::string& token, int64_t& userId, std::string& username) {
    // Разбираем три части токена
    size_t d1 = token.find('.');
    if (d1 == std::string::npos) return false;
    size_t d2 = token.find('.', d1 + 1);
    if (d2 == std::string::npos) return false;

    std::string h = token.substr(0, d1);
    std::string p = token.substr(d1 + 1, d2 - d1 - 1);
    std::string sig = token.substr(d2 + 1);

    // Проверяем подпись HMAC-SHA256
    std::string expected = crypto::base64urlEncode(
        crypto::hmacSha256(config::JWT_SECRET, h + "." + p));
    if (expected != sig) return false;

    // Декодируем payload и проверяем срок действия
    std::string payloadJson = crypto::base64urlDecode(p);

    // Извлекаем поля простым поиском (payload генерируем сами — формат известен)
    auto extractNum = [&payloadJson](const char* key) -> long {
        std::string k = std::string("\"") + key + "\":";
        size_t pos = payloadJson.find(k);
        if (pos == std::string::npos) return -1;
        pos += k.size();
        return std::strtol(payloadJson.c_str() + pos, nullptr, 10);
    };
    auto extractStr = [&payloadJson](const char* key) -> std::string {
        std::string k = std::string("\"") + key + "\":\"";
        size_t pos = payloadJson.find(k);
        if (pos == std::string::npos) return "";
        pos += k.size();
        size_t end = payloadJson.find('"', pos);
        if (end == std::string::npos) return "";
        return payloadJson.substr(pos, end - pos);
    };

    long exp = extractNum("exp");
    long now = static_cast<long>(std::time(nullptr));
    if (exp < 0 || now > exp) return false; // токен просрочен

    userId = extractNum("uid");
    username = extractStr("username");
    return userId > 0;
}

std::string extractBearer(const std::string& authHeader) {
    const std::string prefix = "Bearer ";
    if (authHeader.rfind(prefix, 0) == 0) return authHeader.substr(prefix.size());
    return "";
}

} // namespace auth
