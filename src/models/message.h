#pragma once

#include <string>
#include <cstdint>
#include <vector>
#include <map>

namespace cipher {

class Message {
public:
    int64_t id = 0;
    int64_t chat_id = 0;
    int64_t sender_id = 0;
    std::string encrypted_content; // клиентский шифротекст
    std::string iv;
    std::string header;            // JSON метаданные
    std::string type;              // text | file | sticker | system
    int64_t reply_to = 0;
    int64_t forwarded_from = 0;
    int edited = 0;
    int deleted_for_all = 0;
    std::string deleted_by;        // JSON массив
    std::string reactions;         // JSON объект
    int pinned = 0;
    int64_t expires_at = 0;
    int64_t created_at = 0;

    Message() = default;

    std::string toJson() const;
    std::string toSafeJson(const std::string& senderName, const std::string& senderAvatar) const;
};

} // namespace cipher
