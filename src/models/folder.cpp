#include "folder.h"

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

std::string Folder::toJson() const {
    std::string s = "{";
    s += "\"id\":" + std::to_string(id) + ",";
    s += "\"user_id\":" + std::to_string(user_id) + ",";
    s += "\"name\":" + jstr(name) + ",";
    s += "\"emoji\":" + jstr(emoji) + ",";
    s += "\"color\":" + jstr(color) + ",";
    s += "\"chat_ids\":" + chat_ids + ",";
    s += "\"created_at\":" + std::to_string(created_at) + ",";
    s += "\"updated_at\":" + std::to_string(updated_at);
    s += "}";
    return s;
}

std::vector<int64_t> Folder::chatIds() const {
    std::vector<int64_t> out;
    // Парсинг простого JSON массива чисел
    std::string s = chat_ids;
    size_t i = 0;
    while (i < s.size()) {
        if (std::isdigit(static_cast<unsigned char>(s[i])) || s[i] == '-') {
            int64_t v = std::stoll(s.substr(i));
            out.push_back(v);
            while (i < s.size() && (std::isdigit(static_cast<unsigned char>(s[i])) || s[i] == '-')) ++i;
        } else {
            ++i;
        }
    }
    return out;
}

} // namespace cipher
