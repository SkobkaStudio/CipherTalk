#pragma once

#include <string>
#include <cstdint>
#include <vector>

namespace cipher {

class Chat {
public:
    int64_t id = 0;
    std::string type;        // private | group | supergroup | channel | saved
    std::string public_id;
    std::string name;
    std::string avatar;
    std::string description;
    int64_t owner_id = 0;
    int is_pinned = 0;
    int is_channel = 0;
    int64_t folder_id = 0;
    int64_t created_at = 0;
    int64_t updated_at = 0;

    Chat() = default;

    std::string toJson() const;
};

struct ChatMember {
    int64_t chat_id = 0;
    int64_t user_id = 0;
    std::string role;        // owner | admin | member
    int64_t joined_at = 0;
    int64_t last_read_message_id = 0;
    int hidden = 0;
    int64_t cleared_at = 0;
};

} // namespace cipher
