#pragma once

#include <string>
#include <cstdint>
#include "../models/session.h"
#include "../models/user.h"
#include "../services/encryption_service.h"

namespace cipher {

class SessionService {
public:
    static SessionService& instance();

    SessionService();

    struct SessionResult { std::string token; Session session; };
    SessionResult create(int64_t userId, const std::string& userAgent = "");

    struct AuthResult { Session session; User user; bool valid; };
    AuthResult verify(const std::string& token);

    void revokeToken(const std::string& token);
    void purgeExpired();

private:
    std::string signJwt(const Session& s);
    bool verifyJwt(const std::string& token, Session& out) const;
    const std::vector<uint8_t>& jwtSecret() const;
};

} // namespace cipher
