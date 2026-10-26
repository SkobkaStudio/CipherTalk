#pragma once
// Криптографические утилиты: SHA-256, случайные токены (OpenSSL RAND_bytes),
// PBKDF2-подобный KDF на HMAC-SHA256 для паролей и JWT HS256.
// ВАЖНО: нигде не логирует секреты (пароли, токены, ключи).
#include <openssl/sha.h>
#include <openssl/hmac.h>
#include <openssl/rand.h>
#include <string>
#include <vector>
#include <cstdint>
#include <cstring>
#include <stdexcept>

namespace crypto {

inline std::string toHex(const unsigned char* data, size_t len) {
    static const char* digits = "0123456789abcdef";
    std::string out;
    out.reserve(len * 2);
    for (size_t i = 0; i < len; ++i) {
        out += digits[data[i] >> 4];
        out += digits[data[i] & 0x0F];
    }
    return out;
}

inline std::string sha256Hex(const std::string& input) {
    unsigned char hash[SHA256_DIGEST_LENGTH];
    SHA256(reinterpret_cast<const unsigned char*>(input.data()), input.size(), hash);
    return toHex(hash, SHA256_DIGEST_LENGTH);
}

// Генерация cryptographically secure случайных байт. Бросает исключение при сбое CSPRNG.
inline std::string randomHex(size_t bytes) {
    std::vector<unsigned char> buf(bytes);
    if (RAND_bytes(buf.data(), static_cast<int>(bytes)) != 1) {
        throw std::runtime_error("RAND_bytes failed: no cryptographic randomness available");
    }
    std::string hex = toHex(buf.data(), bytes);
    // зануляем исходные байты после использования
    OPENSSL_cleanse(buf.data(), buf.size());
    return hex;
}

inline std::string randomBase64Url(size_t bytes) {
    std::vector<unsigned char> buf(bytes);
    if (RAND_bytes(buf.data(), static_cast<int>(bytes)) != 1) {
        throw std::runtime_error("RAND_bytes failed: no cryptographic randomness available");
    }
    static const char* alphabet =
        "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    std::string out;
    out.reserve((bytes * 4 + 2) / 3);
    for (size_t i = 0; i < bytes; i += 3) {
        size_t rem = bytes - i;
        uint32_t v = static_cast<uint32_t>(buf[i]) << 16;
        if (rem > 1) v |= static_cast<uint32_t>(buf[i + 1]) << 8;
        if (rem > 2) v |= static_cast<uint32_t>(buf[i + 2]);
        out += alphabet[(v >> 18) & 63];
        out += alphabet[(v >> 12) & 63];
        if (rem > 1) out += alphabet[(v >> 6) & 63];
        if (rem > 2) out += alphabet[v & 63];
    }
    OPENSSL_cleanse(buf.data(), buf.size());
    return out;
}

inline std::string hmacSha256(const std::string& key, const std::string& message) {
    unsigned char digest[EVP_MAX_MD_SIZE];
    unsigned int len = 0;
    HMAC(EVP_sha256(),
         key.data(), static_cast<int>(key.size()),
         reinterpret_cast<const unsigned char*>(message.data()), message.size(),
         digest, &len);
    return std::string(reinterpret_cast<char*>(digest), len);
}

inline std::string hmacSha256Hex(const std::string& key, const std::string& message) {
    std::string raw = hmacSha256(key, message);
    return toHex(reinterpret_cast<const unsigned char*>(raw.data()), raw.size());
}

// Простой константно-временной компаратор (защита от timing-атак на хэши/подписи).
inline bool constantTimeEquals(const std::string& a, const std::string& b) {
    if (a.size() != b.size()) return false;
    volatile unsigned char diff = 0;
    for (size_t i = 0; i < a.size(); ++i) {
        diff |= static_cast<unsigned char>(a[i] ^ b[i]);
    }
    return diff == 0;
}

// KDF для паролей: итеративный HMAC-SHA256 (salt -> key).
// Формат хранения: pbkdf2$<iterations>$<salt_hex>$<hash_hex>
inline std::string deriveKey(const std::string& password, const std::string& salt_hex, int iterations) {
    std::string salt;
    for (size_t i = 0; i + 1 < salt_hex.size(); i += 2) {
        auto hexVal = [](char c) -> int {
            if (c >= '0' && c <= '9') return c - '0';
            if (c >= 'a' && c <= 'f') return c - 'a' + 10;
            if (c >= 'A' && c <= 'F') return c - 'A' + 10;
            return 0;
        };
        salt += static_cast<char>((hexVal(salt_hex[i]) << 4) | hexVal(salt_hex[i + 1]));
    }
    std::string dk = hmacSha256(salt, password);
    for (int i = 1; i < iterations; ++i) {
        dk = hmacSha256(salt, dk);
    }
    return toHex(reinterpret_cast<const unsigned char*>(dk.data()), dk.size());
}

inline std::string hashPassword(const std::string& password, int iterations = 10000) {
    std::string salt_hex = randomHex(16);
    std::string hash = deriveKey(password, salt_hex, iterations);
    return "pbkdf2$" + std::to_string(iterations) + "$" + salt_hex + "$" + hash;
}

inline bool verifyPassword(const std::string& password, const std::string& stored) {
    // Ожидаемый формат: pbkdf2$<iter>$<salt_hex>$<hash_hex>
    size_t p1 = stored.find('$');
    if (p1 == std::string::npos || stored.compare(0, p1, "pbkdf2") != 0) return false;
    size_t p2 = stored.find('$', p1 + 1);
    if (p2 == std::string::npos) return false;
    size_t p3 = stored.find('$', p2 + 1);
    if (p3 == std::string::npos) return false;
    int iterations = 0;
    try { iterations = std::stoi(stored.substr(p1 + 1, p2 - p1 - 1)); }
    catch (...) { return false; }
    if (iterations < 1 || iterations > 10000000) return false;
    std::string salt_hex = stored.substr(p2 + 1, p3 - p2 - 1);
    std::string want     = stored.substr(p3 + 1);
    std::string got      = deriveKey(password, salt_hex, iterations);
    return constantTimeEquals(want, got);
}

} // namespace crypto
