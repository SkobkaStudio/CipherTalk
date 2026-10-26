#include "config.h"
#include "utils.h"
#include <fstream>
#include <sstream>
#include <filesystem>
#include <algorithm>

namespace cipher {

static std::string readEnvFileValue(const std::string& envPath, const std::string& key) {
    std::ifstream f(envPath);
    if (!f) return "";
    std::string line;
    while (std::getline(f, line)) {
        line = utils::trim(line);
        if (line.empty() || line[0] == '#') continue;
        auto eq = line.find('=');
        if (eq == std::string::npos) continue;
        std::string k = utils::trim(line.substr(0, eq));
        if (k != key) continue;
        std::string v = line.substr(eq + 1);
        // Убираем окружающие кавычки
        v = utils::trim(v);
        if (v.size() >= 2 && v.front() == '"' && v.back() == '"') v = v.substr(1, v.size() - 2);
        return v;
    }
    return "";
}

Config loadConfig() {
    Config cfg;

    // Корень проекта: папка, где лежит этот бинарник + ../.. ?
    // Проще: берём текущую рабочую директорию как serverRoot.
    cfg.serverRoot = std::filesystem::current_path().string();

    // Пытаемся прочитать .env из корня проекта
    std::string envPath = cfg.serverRoot + "/.env";
    std::string envExamplePath = cfg.serverRoot + "/.env.example";

    auto envGet = [&](const std::string& name) -> std::string {
        if (const char* v = std::getenv(name.c_str())) return v;
        std::string fromFile = readEnvFileValue(envPath, name);
        if (!fromFile.empty()) return fromFile;
        return readEnvFileValue(envExamplePath, name);
    };

    cfg.port = static_cast<uint16_t>(envInt("PORT", 3000));
    cfg.dbFile = envGet("DB_FILE");
    if (cfg.dbFile.empty()) cfg.dbFile = "./ciphertalk-db.sqlite";
    // Абсолютный путь
    if (!std::filesystem::path(cfg.dbFile).is_absolute()) {
        cfg.dbFile = std::filesystem::absolute(cfg.serverRoot + "/" + cfg.dbFile).string();
    }

    cfg.dbEncryption = envBool("DB_ENCRYPTION", true);
    cfg.dbKeyFile = envGet("DB_KEY_FILE");
    if (cfg.dbKeyFile.empty()) cfg.dbKeyFile = cfg.dbFile + ".dbkey";
    if (!std::filesystem::path(cfg.dbKeyFile).is_absolute()) {
        cfg.dbKeyFile = std::filesystem::absolute(cfg.serverRoot + "/" + cfg.dbKeyFile).string();
    }

    cfg.encryptionKeyFile = cfg.dbFile + ".key";

    cfg.uploadsPath = envGet("UPLOADS_DIR");
    if (cfg.uploadsPath.empty()) cfg.uploadsPath = "./uploads";
    if (!std::filesystem::path(cfg.uploadsPath).is_absolute()) {
        cfg.uploadsPath = std::filesystem::absolute(cfg.serverRoot + "/" + cfg.uploadsPath).string();
    }

    cfg.clientPath = cfg.serverRoot + "/public";

    cfg.maxFileSize = static_cast<size_t>(envInt("MAX_FILE_SIZE", 20 * 1024 * 1024));
    cfg.maxJsonBody = static_cast<size_t>(envInt("MAX_JSON_BODY", 10 * 1024 * 1024));
    cfg.wsMaxPayload = static_cast<size_t>(envInt("WS_MAX_PAYLOAD", 1024 * 1024));
    cfg.maxMessageLength = static_cast<size_t>(envInt("MAX_MESSAGE_LENGTH", 100 * 1000));

    cfg.saveIntervalMs = envInt("SAVE_INTERVAL", 10000);
    cfg.onlinePingIntervalMs = envInt("ONLINE_PING_INTERVAL", 30000);
    cfg.heartbeatIntervalMs = envInt("HEARTBEAT_INTERVAL", 30000);
    cfg.codeExpiryMinutes = envInt("CODE_EXPIRY_MINUTES", 5);
    cfg.sessionTtlDays = envInt("SESSION_TTL_DAYS", 30);

    cfg.ownerPhone = envGet("OWNER_PHONE");
    cfg.crownsFile = envGet("CROWNS_FILE");
    if (cfg.crownsFile.empty()) cfg.crownsFile = cfg.serverRoot + "/src/config/crowns.json";
    if (!std::filesystem::path(cfg.crownsFile).is_absolute()) {
        cfg.crownsFile = std::filesystem::absolute(cfg.serverRoot + "/" + cfg.crownsFile).string();
    }

    cfg.passwordMinLength = envInt("PASSWORD_MIN_LENGTH", 6);
    cfg.usernameMinLength = envInt("USERNAME_MIN_LENGTH", 3);

    cfg.encryptionKey = envGet("ENCRYPTION_KEY");
    cfg.jwtSecret = envGet("JWT_SECRET");

    // SMS
    cfg.sms.provider = envGet("SMS_PROVIDER");
    if (cfg.sms.provider.empty()) cfg.sms.provider = "console";
    cfg.sms.consoleAllowed = envBool("SMS_CONSOLE_ALLOW", false);
    cfg.sms.apiUrl = envGet("SMS_API_URL");
    cfg.sms.apiToken = envGet("SMS_API_TOKEN");
    cfg.sms.textTemplate = envGet("SMS_TEXT_TEMPLATE");
    if (cfg.sms.textTemplate.empty()) cfg.sms.textTemplate = "CipherTalk: ваш код {code}";
    cfg.sms.timeoutMs = envInt("SMS_TIMEOUT_MS", 10000);
    cfg.sms.twilioAccountSid = envGet("TWILIO_ACCOUNT_SID");
    cfg.sms.twilioAuthToken = envGet("TWILIO_AUTH_TOKEN");
    cfg.sms.twilioFrom = envGet("TWILIO_FROM");

    // ICE
    std::string stunRaw = envGet("STUN_URLS");
    if (!stunRaw.empty()) {
        auto parts = utils::split(stunRaw, ',');
        for (auto& p : parts) {
            p = utils::trim(p);
            if (!p.empty()) cfg.ice.stunUrls.push_back(p);
        }
    }
    if (cfg.ice.stunUrls.empty()) {
        cfg.ice.stunUrls = {"stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"};
    }
    cfg.ice.turnUrl = envGet("TURN_URL");
    cfg.ice.turnSecret = envGet("TURN_SECRET");
    cfg.ice.turnUsername = envGet("TURN_USERNAME");
    cfg.ice.turnCredential = envGet("TURN_CREDENTIAL");
    cfg.ice.turnTtlSeconds = envInt("TURN_TTL_SECONDS", 3600);

    cfg.corsOrigin = envGet("CORS_ORIGIN");

    return cfg;
}

std::string envStr(const char* name, const std::string& def) {
    if (const char* v = std::getenv(name)) return v;
    return def;
}

int envInt(const char* name, int def) {
    if (const char* v = std::getenv(name)) {
        try { return std::stoi(v); } catch (...) { return def; }
    }
    return def;
}

bool envBool(const char* name, bool def) {
    if (const char* v = std::getenv(name)) {
        std::string s = utils::toLower(utils::trim(v));
        if (s == "true" || s == "1" || s == "yes" || s == "on") return true;
        if (s == "false" || s == "0" || s == "no" || s == "off") return false;
    }
    return def;
}

} // namespace cipher
