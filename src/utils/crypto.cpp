// ============================================================
// Реализация криптографических утилит на OpenSSL EVP API:
// SHA-256, HMAC-SHA256, случайные байты, base64url.
// ============================================================
#include "utils/crypto.hpp"

#include <openssl/evp.h>
#include <openssl/hmac.h>
#include <openssl/rand.h>
#include <openssl/crypto.h>

#include <cstring>
#include <vector>
#include <random>

namespace crypto {

// Конвертация байтов в HEX-строку
std::string toHex(const uint8_t* data, size_t len) {
    static const char* digits = "0123456789abcdef";
    std::string out;
    out.reserve(len * 2);
    for (size_t i = 0; i < len; ++i) {
        out += digits[data[i] >> 4];
        out += digits[data[i] & 0x0F];
    }
    return out;
}

// SHA-256 через EVP interface (депрекейтиed SHA256_* функции не используем)
std::string sha256hex(const std::string& input) {
    unsigned char hash[EVP_MAX_MD_SIZE];
    unsigned int hashLen = 0;

    EVP_MD_CTX* ctx = EVP_MD_CTX_new();
    if (!ctx) return "";
    if (EVP_DigestInit_ex(ctx, EVP_sha256(), nullptr) != 1 ||
        EVP_DigestUpdate(ctx, input.data(), input.size()) != 1 ||
        EVP_DigestFinal_ex(ctx, hash, &hashLen) != 1) {
        EVP_MD_CTX_free(ctx);
        return "";
    }
    EVP_MD_CTX_free(ctx);
    return toHex(hash, hashLen);
}

// Случайная соль 16 байт через CSPRNG OpenSSL
std::string randomSalt() {
    unsigned char buf[16];
    if (RAND_bytes(buf, sizeof(buf)) != 1) {
        // Запасной вариант — генератор из <random>
        std::random_device rd;
        for (auto& b : buf) b = static_cast<unsigned char>(rd());
    }
    return toHex(buf, sizeof(buf));
}

// Хеш пароля формата "salt$sha256(salt+password)"
std::string hashPassword(const std::string& password) {
    std::string salt = randomSalt();
    std::string hash = sha256hex(salt + password);
    return salt + "$" + hash;
}

// Проверка пароля с постоянным по времени сравнением hex-строк
bool verifyPassword(const std::string& password, const std::string& stored) {
    size_t sep = stored.find('$');
    if (sep == std::string::npos) return false;
    std::string salt = stored.substr(0, sep);
    std::string expectedHash = stored.substr(sep + 1);
    std::string actualHash = sha256hex(salt + password);
    if (actualHash.size() != expectedHash.size()) return false;
    return CRYPTO_memcmp(actualHash.data(), expectedHash.data(),
                         actualHash.size()) == 0;
}

// HMAC-SHA256 -> сырые байты подписи
std::string hmacSha256(const std::string& key, const std::string& message) {
    unsigned char mac[EVP_MAX_MD_SIZE];
    unsigned int macLen = 0;
    HMAC(EVP_sha256(),
         key.data(), static_cast<int>(key.size()),
         reinterpret_cast<const unsigned char*>(message.data()), message.size(),
         mac, &macLen);
    return std::string(reinterpret_cast<char*>(mac), macLen);
}

// Стандартный алфавит base64 и его URL-вариант
static const char* B64CHARS =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

// Base64url без padding (нужен для JWT)
std::string base64urlEncode(const std::string& input) {
    std::string out;
    int val = 0, bits = -6;
    for (unsigned char c : input) {
        val = (val << 8) + c;
        bits += 8;
        while (bits >= 0) {
            out += B64CHARS[(val >> bits) & 0x3F];
            bits -= 6;
        }
    }
    if (bits > -6) out += B64CHARS[((val << 8) >> (bits + 8)) & 0x3F];
    // Замена спецсимволов на URL-безопасные, удаление '='
    for (char& c : out) {
        if (c == '+') c = '-';
        else if (c == '/') c = '_';
    }
    return out;
}

// Base64url-декодирование
std::string base64urlDecode(const std::string& input) {
    // Восстанавливаем стандартный base64
    std::string b64;
    b64.reserve(input.size());
    for (char c : input) {
        if (c == '-') b64 += '+';
        else if (c == '_') b64 += '/';
        else b64 += c;
    }
    while (b64.size() % 4) b64 += '=';

    std::vector<int> rev(256, -1);
    for (int i = 0; i < 64; ++i) rev[static_cast<unsigned char>(B64CHARS[i])] = i;

    std::string out;
    int val = 0, bits = -8;
    for (unsigned char c : b64) {
        if (rev[c] == -1) break; // '=' или мусор — конец
        val = (val << 6) + rev[c];
        bits += 6;
        if (bits >= 0) {
            out += static_cast<char>((val >> bits) & 0xFF);
            bits -= 8;
        }
    }
    return out;
}

} // namespace crypto
