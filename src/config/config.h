#pragma once

#include <string>
#include <vector>
#include <cstdint>

namespace cipher {

struct SmsConfig {
    std::string provider;        // console | http | twilio
    bool consoleAllowed = false;
    std::string apiUrl;
    std::string apiToken;
    std::string textTemplate = "CipherTalk: ваш код {code}";
    int timeoutMs = 10000;
    std::string twilioAccountSid;
    std::string twilioAuthToken;
    std::string twilioFrom;
};

struct IceConfig {
    std::vector<std::string> stunUrls;
    std::string turnUrl;
    std::string turnSecret;
    std::string turnUsername;
    std::string turnCredential;
    int turnTtlSeconds = 3600;
};

struct Config {
    // Server
    uint16_t port = 3000;
    std::string serverRoot;
    std::string clientPath;
    std::string dbFile;
    std::string dbKeyFile;
    bool dbEncryption = true;
    std::string uploadsPath;
    std::string encryptionKeyFile; // <dbFile>.key

    size_t maxFileSize = 20 * 1024 * 1024;      // 20 MB
    size_t maxJsonBody = 10 * 1024 * 1024;      // 10 MB
    size_t wsMaxPayload = 1024 * 1024;          // 1 MB
    size_t maxMessageLength = 100 * 1000;       // 100 KB

    int saveIntervalMs = 10000;
    int onlinePingIntervalMs = 30000;
    int heartbeatIntervalMs = 30000;
    int codeExpiryMinutes = 5;
    int sessionTtlDays = 30;

    std::string ownerPhone;
    std::string crownsFile;

    int passwordMinLength = 6;
    int usernameMinLength = 3;

    std::string encryptionKey;   // ENCRYPTION_KEY env (raw)
    std::string jwtSecret;       // JWT_SECRET env (raw)

    SmsConfig sms;
    IceConfig ice;

    std::string corsOrigin;      // raw CORS_ORIGIN env
};

/// Загрузить конфигурацию из .env (в корне проекта) и окружения.
Config loadConfig();

/// Получить строку из окружения с valeurs по умолчанию.
std::string envStr(const char* name, const std::string& def = "");
int envInt(const char* name, int def);
bool envBool(const char* name, bool def);

} // namespace cipher
