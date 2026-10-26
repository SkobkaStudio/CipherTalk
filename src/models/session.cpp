#include "session.h"
#include <ctime>
#include <string>

namespace cipher {

bool Session::isExpired(int64_t nowMs) const {
    if (nowMs == 0) nowMs = static_cast<int64_t>(std::time(nullptr)) * 1000;
    return expires_at > 0 && expires_at <= nowMs;
}

std::string Session::toJson() const {
    std::string s = "{";
    s += "\"id\":" + std::to_string(id) + ",";
    s += "\"user_id\":" + std::to_string(user_id) + ",";
    s += "\"token_hash\":\"" + token_hash + "\",";
    s += "\"expires_at\":" + std::to_string(expires_at) + ",";
    s += "\"created_at\":" + std::to_string(created_at) + ",";
    s += "\"last_used\":" + std::to_string(last_used) + ",";
    s += "\"user_agent\":\"" + user_agent + "\"";
    s += "}";
    return s;
}

} // namespace cipher
