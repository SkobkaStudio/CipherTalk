#pragma once

#include <string>
#include <cstdint>

namespace cipher {

class Session {
public:
    int64_t id = 0;
    int64_t user_id = 0;
    std::string token;             // raw (только в памяти, в БД не хранится)
    std::string token_hash;        // SHA256(token)
    int64_t expires_at = 0;
    int64_t created_at = 0;
    int64_t last_used = 0;
    std::string user_agent;
    std::string ip;

    Session() = default;

    bool isExpired(int64_t nowMs = 0) const;
    std::string toJson() const;
};

} // namespace cipher
