#include "session_service.h"
#include "../db/database.h"
#include "../config/config.h"
#include "../utils/utils.h"
#include <ctime>
#include <fstream>
#include <sys/stat.h>

namespace cipher {

SessionService& SessionService::instance() {
    static SessionService svc;
    return svc;
}

SessionService::SessionService() {}

std::string SessionService::signJwt(const Session& s) {
    auto b64url = [](const std::string& data) {
        return utils::base64urlEncode(reinterpret_cast<const uint8_t*>(data.data()), data.size());
    };
    auto enc = [&](const std::string& obj) { return b64url(obj); };

    std::string header = enc("{\"alg\":\"HS256\",\"typ\":\"JWT\"}");
    int64_t now = static_cast<int64_t>(std::time(nullptr));
    int64_t exp = now + static_cast<int64_t>(loadConfig().sessionTtlDays) * 86400;
    std::string payload = "{\"sub\":" + std::to_string(s.user_id) +
                          ",\"sid\":" + std::to_string(s.id) +
                          ",\"iat\":" + std::to_string(now) +
                          ",\"exp\":" + std::to_string(exp) +
                          ",\"iss\":\"ciphertalk\"}";

    std::string data = header + "." + payload;
    auto sig = utils::hmacSha256(jwtSecret().data(), jwtSecret().size(),
                                 reinterpret_cast<const uint8_t*>(data.data()), data.size());
    return data + "." + b64url(std::string(sig.begin(), sig.end()));
}

bool SessionService::verifyJwt(const std::string& token, Session& out) const {
    auto parts = utils::split(token, '.');
    if (parts.size() != 3) return false;
    std::string data = parts[0] + "." + parts[1];
    auto expected = utils::hmacSha256(jwtSecret().data(), jwtSecret().size(),
                                      reinterpret_cast<const uint8_t*>(data.data()), data.size());
    auto sig = utils::base64urlDecode(parts[2] + "===");
    if (sig.size() != expected.size() || !utils::timingSafeEqual(std::string(sig.begin(), sig.end()),
                                                                 std::string(expected.begin(), expected.end())))
        return false;
    try {
        auto pbytes = utils::base64urlDecode(parts[1] + "===");
        std::string pstr(pbytes.begin(), pbytes.end());
        size_t subPos = pstr.find("\"sub\":");
        size_t sidPos = pstr.find("\"sid\":");
        size_t expPos = pstr.find("\"exp\":");
        if (subPos == std::string::npos || sidPos == std::string::npos) return false;
        auto num = [](const std::string& s, size_t pos) -> int64_t {
            size_t start = s.find_first_of("0123456789", pos);
            if (start == std::string::npos) return 0;
            size_t end = s.find_first_not_of("0123456789", start);
            if (end == std::string::npos) end = s.size();
            return std::stoll(s.substr(start, end - start));
        };
        out.user_id = num(pstr, subPos);
        out.id = num(pstr, sidPos);
        int64_t exp = num(pstr, expPos);
        if (exp * 1000 <= static_cast<int64_t>(std::time(nullptr)) * 1000) return false;
        return true;
    } catch (...) {
        return false;
    }
}

const std::vector<uint8_t>& SessionService::jwtSecret() const {
    static std::vector<uint8_t> secret;
    static bool loaded = false;
    if (!loaded) {
        Config cfg = loadConfig();
        if (!cfg.jwtSecret.empty()) {
            secret.assign(cfg.jwtSecret.begin(), cfg.jwtSecret.end());
        } else {
            std::string file = cfg.dbFile + ".jwt-secret";
            if (utils::fileExists(file)) {
                std::string hex = utils::trim(utils::readFile(file));
                if (hex.size() == 64) {
                    secret = utils::hexDecode(hex);
                } else {
                    throw std::runtime_error("Файл JWT-секрета повреждён: " + file);
                }
            } else {
                auto s = utils::randomBytes(32);
                ::chmod(file.c_str(), 0600);
                std::ofstream f(file, std::ios::binary | std::ios::trunc);
                f << utils::hexEncode(s.data(), s.size());
                secret = s;
            }
        }
        loaded = true;
    }
    return secret;
}

SessionService::SessionResult SessionService::create(int64_t userId, const std::string& userAgent) {
    auto& db = Database::instance();
    int64_t id = db.nextId("sessions");
    int64_t now = static_cast<int64_t>(std::time(nullptr)) * 1000;
    int64_t exp = now + static_cast<int64_t>(loadConfig().sessionTtlDays) * 86400 * 1000;

    Session s;
    s.id = id;
    s.user_id = userId;
    s.expires_at = exp;
    s.created_at = now;
    s.last_used = now;
    s.user_agent = userAgent.substr(0, 200);

    std::string token = signJwt(s);
    s.token_hash = EncryptionService::instance().hashToken(token);

    db.addSession(s);
    return {token, s};
}

SessionService::AuthResult SessionService::verify(const std::string& token) {
    AuthResult result;
    result.valid = false;
    if (token.empty()) return result;

    Session parsed;
    if (!verifyJwt(token, parsed)) {
        std::string hash = EncryptionService::instance().hashToken(token);
        auto& db = Database::instance();
        auto s = db.findSessionByHash(hash);
        if (!s) return result;
        parsed = *s;
    }

    auto& db = Database::instance();
    auto session = db.findSessionById(parsed.id);
    if (!session) return result;
    if (session->user_id != parsed.user_id) return result;
    if (session->token_hash != EncryptionService::instance().hashToken(token)) return result;
    if (session->isExpired()) {
        db.deleteSessionByHash(session->token_hash);
        return result;
    }
    auto user = db.findUserById(session->user_id);
    if (!user) return result;

    result.session = *session;
    result.user = *user;
    result.valid = true;
    return result;
}

void SessionService::revokeToken(const std::string& token) {
    if (token.empty()) return;
    auto& db = Database::instance();
    db.deleteSessionByHash(EncryptionService::instance().hashToken(token));
}

void SessionService::purgeExpired() {
    Database::instance().purgeExpiredSessions();
}

} // namespace cipher
