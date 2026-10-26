#include "encryption_service.h"
#include "../config/config.h"
#include "../utils/utils.h"
#include <fstream>
#include <sys/stat.h>
#include <cstring>
#include <openssl/rand.h>
#include <openssl/evp.h>
#include <openssl/hmac.h>
#include <openssl/sha.h>
#include <sstream>
#include <iomanip>

namespace cipher {

namespace {
constexpr char PREFIX[] = "CTV1";
constexpr char SALT[] = "CipherTalk-at-rest";

std::string b64urlNoPad(const std::vector<uint8_t>& data) {
    return utils::base64urlEncode(data.data(), data.size());
}
}

EncryptionService& EncryptionService::instance() {
    static EncryptionService svc;
    return svc;
}

EncryptionService::EncryptionService() = default;

const std::vector<uint8_t>& EncryptionService::atRestKey() {
    if (!_keyLoaded) {
        _key = loadOrCreateAtRestKey();
        _keyLoaded = true;
    }
    return _key;
}

std::vector<uint8_t> EncryptionService::loadOrCreateAtRestKey() {
    Config cfg = loadConfig();
    std::string keyFile = cfg.encryptionKeyFile;

    // Если задан ENCRYPTION_KEY — scrypt
    if (!cfg.encryptionKey.empty()) {
        std::vector<uint8_t> out(32);
        PKCS5_PBKDF2_HMAC(cfg.encryptionKey.c_str(), cfg.encryptionKey.size(),
                          reinterpret_cast<const uint8_t*>(SALT), strlen(SALT),
                          1, EVP_sha256(), 32, out.data());
        return out;
    }

    // Иначе читаем/создаём файл <db>.key
    if (utils::fileExists(keyFile)) {
        std::string hex = utils::readFile(keyFile);
        hex = utils::trim(hex);
        if (hex.size() == 64) {
            auto b = utils::hexDecode(hex);
            if (!b.empty()) return b;
        }
        // Повреждённый ключ — не перезаписываем, кидаем ошибку
        throw std::runtime_error("Файл ключа шифрования повреждён: " + keyFile);
    }

    auto key = utils::randomBytes(32);
    std::string hex = utils::hexEncode(key.data(), key.size());
    // Права 600
    ::chmod(keyFile.c_str(), 0600);
    std::ofstream f(keyFile, std::ios::binary | std::ios::trunc);
    f << hex;
    return key;
}

std::string EncryptionService::encrypt(const std::string& plaintext) {
    auto key = atRestKey();
    std::vector<uint8_t> iv(12);
    RAND_bytes(iv.data(), 12);

    EVP_CIPHER_CTX* ctx = EVP_CIPHER_CTX_new();
    EVP_EncryptInit_ex(ctx, EVP_aes_256_gcm(), nullptr, nullptr, nullptr);
    EVP_CIPHER_CTX_ctrl(ctx, EVP_CTRL_GCM_SET_IVLEN, 12, nullptr);
    EVP_EncryptInit_ex(ctx, nullptr, nullptr, key.data(), iv.data());

    std::vector<uint8_t> ct(plaintext.size() + 16);
    int len1 = 0, len2 = 0;
    EVP_EncryptUpdate(ctx, ct.data(), &len1,
                      reinterpret_cast<const uint8_t*>(plaintext.data()), plaintext.size());
    EVP_EncryptFinal_ex(ctx, ct.data() + len1, &len2);
    size_t ctLen = len1 + len2;

    uint8_t tag[16];
    EVP_CIPHER_CTX_ctrl(ctx, EVP_CTRL_GCM_GET_TAG, 16, tag);
    EVP_CIPHER_CTX_free(ctx);

    std::vector<uint8_t> ivb(iv.begin(), iv.end());
    std::vector<uint8_t> tagb(tag, tag + 16);
    std::vector<uint8_t> ctb(ct.begin(), ct.begin() + ctLen);

    return std::string(PREFIX) + "." + b64urlNoPad(ivb) + "." + b64urlNoPad(tagb) + "." + b64urlNoPad(ctb);
}

std::string EncryptionService::decrypt(const std::string& payload) {
    if (!isEncrypted(payload)) return payload; // не зашифровано — отдаём как есть
    try {
        // Разбиваем CTV1.iv.tag.ct
        size_t p1 = payload.find('.', 5);
        size_t p2 = payload.find('.', p1 + 1);
        if (p1 == std::string::npos || p2 == std::string::npos) return "";
        std::string ivB64 = payload.substr(5, p1 - 5); // после "CTV1."
        std::string tagB64 = payload.substr(p1 + 1, p2 - p1 - 1);
        std::string ctB64 = payload.substr(p2 + 1);

        auto iv = utils::base64urlDecode(ivB64 + "===");
        auto tag = utils::base64urlDecode(tagB64 + "===");
        auto ct = utils::base64urlDecode(ctB64 + "===");
        auto key = atRestKey();

        EVP_CIPHER_CTX* ctx = EVP_CIPHER_CTX_new();
        EVP_DecryptInit_ex(ctx, EVP_aes_256_gcm(), nullptr, nullptr, nullptr);
        EVP_CIPHER_CTX_ctrl(ctx, EVP_CTRL_GCM_SET_IVLEN, 12, nullptr);
        EVP_DecryptInit_ex(ctx, nullptr, nullptr, key.data(), iv.data());

        std::vector<uint8_t> pt(ct.size());
        int len1 = 0, len2 = 0;
        EVP_DecryptUpdate(ctx, pt.data(), &len1, ct.data(), ct.size());
        EVP_CIPHER_CTX_ctrl(ctx, EVP_CTRL_GCM_SET_TAG, 16, tag.data());
        int rc = EVP_DecryptFinal_ex(ctx, pt.data() + len1, &len2);
        EVP_CIPHER_CTX_free(ctx);

        if (rc <= 0) return "";
        pt.resize(len1 + len2);
        return std::string(pt.begin(), pt.end());
    } catch (...) {
        return "";
    }
}

bool EncryptionService::isEncrypted(const std::string& payload) const {
    return !payload.empty() && payload.compare(0, 4, PREFIX) == 0 && payload.size() > 4 && payload[4] == '.';
}

std::string EncryptionService::hashPassword(const std::string& password, int iterations) {
    std::string salt = utils::randomHex(16);
    std::vector<uint8_t> hash(64);
    PKCS5_PBKDF2_HMAC(password.c_str(), password.size(),
                      reinterpret_cast<const uint8_t*>(salt.data()), salt.size(),
                      iterations, EVP_sha512(), 64, hash.data());
    std::string h = utils::hexEncode(hash.data(), hash.size());
    return "pbkdf2-sha512$" + std::to_string(iterations) + "$" + salt + "$" + h;
}

bool EncryptionService::verifyPassword(const std::string& password, const std::string& stored) const {
    if (stored.empty()) return false;
    std::string salt, hash;
    int iterations = 100000;
    if (stored.compare(0, 14, "pbkdf2-sha512$") == 0) {
        size_t a = 14;
        size_t b = stored.find('$', a);
        iterations = std::stoi(stored.substr(a, b - a));
        size_t c = stored.find('$', b + 1);
        salt = stored.substr(b + 1, c - b - 1);
        hash = stored.substr(c + 1);
    } else {
        size_t colon = stored.find(':');
        if (colon == std::string::npos) return false;
        salt = stored.substr(0, colon);
        hash = stored.substr(colon + 1);
        iterations = 10000;
    }
    std::vector<uint8_t> out(64);
    PKCS5_PBKDF2_HMAC(password.c_str(), password.size(),
                      reinterpret_cast<const uint8_t*>(salt.data()), salt.size(),
                      iterations, EVP_sha512(), 64, out.data());
    std::string test = utils::hexEncode(out.data(), out.size());
    return safeCompare(test, hash);
}

bool EncryptionService::safeCompare(const std::string& a, const std::string& b) const {
    return utils::timingSafeEqual(a, b);
}

std::string EncryptionService::generateToken() {
    return b64urlNoPad(utils::randomBytes(32));
}

std::string EncryptionService::hashToken(const std::string& token) {
    return utils::sha256Hex(token);
}

std::string EncryptionService::randomDigits(int length) {
    return utils::randomDigits(length);
}

std::vector<uint8_t> EncryptionService::randomBytes(size_t n) {
    return utils::randomBytes(n);
}

} // namespace cipher
