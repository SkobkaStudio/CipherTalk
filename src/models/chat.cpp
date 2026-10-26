#include "chat.h"

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

std::string Chat::toJson() const {
    std::string s = "{";
    s += "\"id\":" + std::to_string(id) + ",";
    s += "\"public_id\":" + jstr(public_id) + ",";
    s += "\"type\":" + jstr(type) + ",";
    s += "\"name\":" + jstr(name) + ",";
    s += "\"avatar\":" + jstr(avatar) + ",";
    s += "\"description\":" + jstr(description) + ",";
    s += "\"owner_id\":" + std::to_string(owner_id) + ",";
    s += "\"is_pinned\":" + std::to_string(is_pinned) + ",";
    s += "\"is_channel\":" + std::to_string(is_channel) + ",";
    s += "\"folder_id\":" + std::to_string(folder_id) + ",";
    s += "\"created_at\":" + std::to_string(created_at) + ",";
    s += "\"updated_at\":" + std::to_string(updated_at);
    s += "}";
    return s;
}

} // namespace cipher
