#include "message.h"

namespace cipher {

static std::string jescape(const std::string& s) {
    std::string out;
    for (char c : s) {
        switch (c) {
            case '"': out += "\\\""; break;
            case '\\': out += "\\\\"; break;
            case '\n': out += "\\n"; break;
            case '\r': out += "\\r"; break;
            case '\t': out += "\\t"; break;
            default: out.push_back(c);
        }
    }
    return out;
}
static std::string jstr(const std::string& s) { return "\"" + jescape(s) + "\""; }

std::string Message::toJson() const {
    std::string s = "{";
    s += "\"id\":" + std::to_string(id) + ",";
    s += "\"chat_id\":" + std::to_string(chat_id) + ",";
    s += "\"sender_id\":" + std::to_string(sender_id) + ",";
    s += "\"encrypted_content\":" + jstr(encrypted_content) + ",";
    s += "\"iv\":" + jstr(iv) + ",";
    s += "\"header\":" + jstr(header) + ",";
    s += "\"type\":" + jstr(type) + ",";
    s += "\"reply_to\":" + std::to_string(reply_to) + ",";
    s += "\"forwarded_from\":" + std::to_string(forwarded_from) + ",";
    s += "\"edited\":" + std::to_string(edited) + ",";
    s += "\"deleted_for_all\":" + std::to_string(deleted_for_all) + ",";
    s += "\"deleted_by\":" + deleted_by + ",";
    s += "\"reactions\":" + reactions + ",";
    s += "\"pinned\":" + std::to_string(pinned) + ",";
    s += "\"expires_at\":" + std::to_string(expires_at) + ",";
    s += "\"created_at\":" + std::to_string(created_at);
    s += "}";
    return s;
}

std::string Message::toSafeJson(const std::string& senderName, const std::string& senderAvatar) const {
    std::string s = "{";
    s += "\"id\":" + std::to_string(id) + ",";
    s += "\"chat_id\":" + std::to_string(chat_id) + ",";
    s += "\"sender_id\":" + std::to_string(sender_id) + ",";
    s += "\"sender_name\":" + jstr(senderName) + ",";
    s += "\"sender_avatar\":" + jstr(senderAvatar) + ",";
    s += "\"encrypted_content\":" + jstr(encrypted_content) + ",";
    s += "\"content\":" + jstr(encrypted_content) + ",";
    s += "\"ciphertext\":" + jstr(encrypted_content) + ",";
    s += "\"iv\":" + jstr(iv) + ",";
    s += "\"header\":" + jstr(header) + ",";
    s += "\"type\":" + jstr(type) + ",";
    s += "\"reply_to\":" + std::to_string(reply_to) + ",";
    s += "\"forwarded_from\":" + std::to_string(forwarded_from) + ",";
    s += "\"edited\":" + std::to_string(edited) + ",";
    s += "\"deleted_for_all\":" + std::to_string(deleted_for_all) + ",";
    s += "\"reactions\":" + reactions + ",";
    s += "\"pinned\":" + std::to_string(pinned) + ",";
    s += "\"expires_at\":" + std::to_string(expires_at) + ",";
    s += "\"created_at\":" + std::to_string(created_at);
    s += "}";
    return s;
}

} // namespace cipher
