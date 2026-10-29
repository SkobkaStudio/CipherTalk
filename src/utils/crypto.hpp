#pragma once
// ============================================================
// Криптографические утилиты: хеширование паролей (SHA-256 + соль)
// и генерация случайных строк. OpenSSL EVP API.
// ============================================================
#include <string>
#include <cstdint>

namespace crypto {

// HEX-строка байтов
std::string toHex(const uint8_t* data, size_t len);

// SHA-256 от произвольной строки -> hex
std::string sha256hex(const std::string& input);

// Сгенерировать случайную соль (16 байт -> 32 hex-символа)
std::string randomSalt();

// Хеш пароля с солью: sha256(salt + password), возвращает "salt$hash"
std::string hashPassword(const std::string& password);

// Проверить пароль против сохранённого "salt$hash"
bool verifyPassword(const std::string& password, const std::string& stored);

// HMAC-SHA256 (для JWT), результат — сырые байты
std::string hmacSha256(const std::string& key, const std::string& message);

// Base64url-кодирование (без символа =)
std::string base64urlEncode(const std::string& input);

// Base64url-декодирование
std::string base64urlDecode(const std::string& input);

} // namespace crypto
