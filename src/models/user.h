#pragma once

#include <string>
#include <cstdint>
#include <ctime>
#include "utils.h"

namespace cipher {

class User {
public:
    int64_t id = 0;
    std::string public_id;
    std::string phone;
    std::string email;
    std::string first_name;
    std::string last_name;
    std::string name;
    std::string username;
    std::string avatar;
    std::string bio;
    std::string public_key;
    std::string password_hash;
    int online = 0;
    int64_t last_seen = 0;
    int hide_online = 0;
    int64_t created_at = 0;
    int64_t updated_at = 0;
    std::string crown_level;
    int is_owner = 0;

    User() = default;
    explicit User(const std::string& rowJson); // для совместимости с десериализацией

    bool isOwner() const { return crown_level == "gold"; }

    void setPassword(const std::string& password);
    bool verifyPassword(const std::string& password) const;

    // Сериализация в JSON-строку (без пароля)
    std::string toSafeJson() const;
    std::string toJson() const;
};

} // namespace cipher
