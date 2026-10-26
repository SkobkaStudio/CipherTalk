#pragma once

#include <string>
#include <vector>
#include <cstdint>
#include <openssl/evp.h>
#include <openssl/hmac.h>
#include <openssl/sha.h>

namespace cipher {

class EncryptionService {
public:
    static EncryptionService& instance();

    // --- AES-256-GCM (96-bit IV, 128-bit tag) ---
    // Формат: CTV1.<ivBase64>.<tagBase64>.<ciphertextBase64>
    std::string encrypt(const std::string& plaintext);
    std::string decrypt(const std::string& payload); // возвращает пустую строку при ошибке
    bool isEncrypted(const std::string& payload) const;

    // --- Ключ at-rest (AES-256-GCM) ---
    const std::vector<uint8_t>& atRestKey();

    // --- PBKDF2-SHA512 пароли ---
    std::string hashPassword(const std::string& password, int iterations = 100000);
    bool verifyPassword(const std::string& password, const std::string& stored) const;
    bool safeCompare(const std::string& a, const std::string& b) const;

    // --- Токены ---
    std::string generateToken();           // base64url 32 байта
    std::string hashToken(const std::string& token); // SHA256 hex

    // --- OTP коды ---
    std::string randomDigits(int length = 6);
    std::vector<uint8_t> randomBytes(size_t n);

private:
    EncryptionService();
    std::vector<uint8_t> loadOrCreateAtRestKey();

    std::vector<uint8_t> _key;
    bool _keyLoaded = false;
};

} // namespace cipher
