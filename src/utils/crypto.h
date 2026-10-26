// =============================================================================
//  utils/crypto.h — обёртка над OpenSSL: SHA-256, PBKDF2, случайные токены
// =============================================================================
//  Здесь только «криптография сервера»:
//    * hashPassword() — соль + PBKDF2 (пароли НИКОГДА не хранятся в открытом виде)
//    * randomToken()  — токены сессий и идентификаторы файлов
//    * sha256Hex()    — хэши сообщений для функции «редактировать/удалить»
//
//  ВАЖНО ПРО E2EE: сквозное шифрование самих сообщений выполняется НЕ здесь,
//  а на клиенте (web/js/e2ee.js) через WebCrypto AES-GCM. Сервер хранит только
//  зашифрованный «контейнер» (iv + ciphertext) и никогда не видит ключи.
// =============================================================================
#pragma once
#include <string>
#include <openssl/evp.h>
#include <openssl/rand.h>
#include <openssl/hmac.h>
#include "encoding.h"

namespace crypto {

// Криптостойкие случайные байты (для солей, токенов, nonce)
inline std::string randomBytes(size_t n) {
    std::string out(n, '\0');
    RAND_bytes(reinterpret_cast<unsigned char*>(&out[0]), (int)n);
    return out;
}
inline std::string randomToken(size_t bytes = 32) {
    return enc::hexEncode(randomBytes(bytes)); // hex-строка длиной 2*bytes
}

// Простой SHA-256 -> hex. Применяется к содержимому сообщений (message_hash),
// чтобы можно было безопасно ссылаться на сообщение при редактировании/удалении.
inline std::string sha256Hex(const std::string& data) {
    unsigned char md[EVP_MAX_MD_SIZE]; unsigned int len = 0;
    EVP_Digest(data.data(), data.size(), md, &len, EVP_sha256(), nullptr);
    return enc::hexEncode(std::string((char*)md, len));
}

// PBKDF2-HMAC-SHA256 — медленный хэш пароля (устойчив к брутфорсу).
inline std::string pbkdf2(const std::string& password, const std::string& salt, int iters = 100000) {
    unsigned char out[32];
    PKCS5_PBKDF2_HMAC(password.c_str(), (int)password.size(),
        reinterpret_cast<const unsigned char*>(salt.data()), (int)salt.size(),
        iters, EVP_sha256(), 32, out);
    return enc::hexEncode(std::string((char*)out, 32));
}

// Формат хранения пароля:  "pbkdf2$<итерации>$<hex-соль>$<hex-хэш>"
inline std::string hashPassword(const std::string& password) {
    std::string salt = enc::hexEncode(randomBytes(16));
    int iters = 100000;
    return "pbkdf2$" + std::to_string(iters) + "$" + salt + "$" + pbkdf2(password, salt, iters);
}

// Проверка пароля: разбираем сохранённую строку и пересчитываем хэш.
// Сравнение «постоянное по времени» не критично здесь, но аккуратно через ==.
inline bool verifyPassword(const std::string& password, const std::string& stored) {
    // ожидаем 4 поля через '$'
    size_t p1 = stored.find('$');
    size_t p2 = stored.find('$', p1+1);
    size_t p3 = stored.find('$', p2+1);
    if (p1==std::string::npos||p2==std::string::npos||p3==std::string::npos) return false;
    if (stored.substr(0,p1) != "pbkdf2") return false;
    int iters = atoi(stored.substr(p1+1,p2-p1-1).c_str());
    std::string salt = stored.substr(p2+1,p3-p2-1);
    std::string want = stored.substr(p3+1);
    return pbkdf2(password, salt, iters) == want;
}

} // namespace crypto
