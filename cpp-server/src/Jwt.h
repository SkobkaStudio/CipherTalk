#pragma once
// JWT HS256: подпись HMAC-SHA256, base64url без padding, проверка exp и alg (отсечение none/alg-confusion).
#include "Crypto.h"
#include "Json.h"
#include <string>
#include <ctime>

namespace jwt {

inline std::string base64UrlEncode(const std::string& in) {
    static const char* tbl = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    std::string out;
    int val = 0, bits = -6;
    for (unsigned char c : in) {
        val = (val << 8) + c;
        bits += 8;
        while (bits >= 0) {
            out += tbl[(val >> bits) & 0x3F];
            bits -= 6;
        }
    }
    if (bits > -6) out += tbl[((val << 8) >> (bits + 8)) & 0x3F];
    return out;
}

inline std::string base64UrlDecode(const std::string& in) {
    std::vector<int> rev(256, -1);
    const std::string alphabet =
        "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    for (int i = 0; i < 64; ++i) rev[static_cast<unsigned char>(alphabet[i])] = i;
    std::string out;
    int val = 0, bits = 0;
    for (unsigned char c : in) {
        if (c == '=' || c == '+' || c == '/') continue; // терпимо к variant-ам
        if (rev[c] < 0) return std::string();            // недопустимый символ => ошибка
        val = (val << 6) | rev[c];
        bits += 6;
        if (bits >= 8) {
            bits -= 8;
            out += static_cast<char>((val >> bits) & 0xFF);
        }
    }
    return out;
}

struct Claims {
    long long sub = 0;      // user id
    bool is_bot = false;    // тип субъекта
    long long exp = 0;      // время жизни (unix)
    std::string sid;        // идентификатор сессии
};

// Создаёт токен. secret НЕ логируется.
inline std::string create(const std::string& secret, long long user_id, bool is_bot,
                          const std::string& sid, long long ttl_seconds) {
    json::Object header;
    header["alg"] = json::Value("HS256");
    header["typ"] = json::Value("JWT");

    json::Object payload;
    payload["sub"] = json::Value(user_id);
    payload["bot"] = json::Value(is_bot);
    payload["sid"] = json::Value(sid);
    payload["iat"] = json::Value(static_cast<long long>(std::time(nullptr)));
    payload["exp"] = json::Value(static_cast<long long>(std::time(nullptr)) + ttl_seconds);

    std::string h = base64UrlEncode(json::Value(header).dump());
    std::string p = base64UrlEncode(json::Value(payload).dump());
    std::string signing_input = h + "." + p;
    std::string sig = base64UrlEncode(crypto::hmacSha256(secret, signing_input));
    return signing_input + "." + sig;
}

// Проверяет подпись, alg и exp. Возвращает false при любой проблеме (без деталей в логах).
inline bool verify(const std::string& secret, const std::string& token, Claims& out) {
    size_t d1 = token.find('.');
    if (d1 == std::string::npos) return false;
    size_t d2 = token.find('.', d1 + 1);
    if (d2 == std::string::npos) return false;
    if (token.find('.', d2 + 1) != std::string::npos) return false; // ровно 3 части

    std::string header_b64  = token.substr(0, d1);
    std::string payload_b64 = token.substr(d1 + 1, d2 - d1 - 1);
    std::string sig_b64     = token.substr(d2 + 1);

    // Проверка подписи до разбора содержимого
    std::string expected_sig =
        base64UrlEncode(crypto::hmacSha256(secret, header_b64 + "." + payload_b64));
    if (!crypto::constantTimeEquals(expected_sig, sig_b64)) return false;

    try {
        std::string header_json = base64UrlDecode(header_b64);
        std::string payload_json = base64UrlDecode(payload_b64);
        json::Value header = json::parse(header_json);
        if (!header.isObject()) return false;
        if (!header.has("alg") || !header["alg"].isString() || header["alg"].asString() != "HS256")
            return false; // отсекаем "none" и подмену алгоритма

        json::Value payload = json::parse(payload_json);
        if (!payload.isObject()) return false;
        if (!payload.has("sub") || !payload["sub"].isNumber()) return false;

        long long now = static_cast<long long>(std::time(nullptr));
        if (payload.has("exp") && payload["exp"].isNumber() && payload["exp"].asInt() < now)
            return false; // просрочен

        out.sub = payload["sub"].asInt();
        out.is_bot = payload.has("bot") && payload["bot"].isBool() && payload["bot"].asBool();
        out.exp = payload.has("exp") && payload["exp"].isNumber() ? payload["exp"].asInt() : 0;
        out.sid = payload.has("sid") && payload["sid"].isString() ? payload["sid"].asString() : "";
        return true;
    } catch (const std::exception&) {
        return false;
    }
}

} // namespace jwt
