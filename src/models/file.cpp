#include "file.h"

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

std::string File::toJson() const {
    std::string s = "{";
    s += "\"id\":" + std::to_string(id) + ",";
    s += "\"filename\":" + jstr(filename) + ",";
    s += "\"original_name\":" + jstr(original_name) + ",";
    s += "\"size\":" + std::to_string(size) + ",";
    s += "\"mimetype\":" + jstr(mimetype) + ",";
    s += "\"uploader_id\":" + std::to_string(uploader_id) + ",";
    s += "\"created_at\":" + std::to_string(created_at);
    s += "}";
    return s;
}

} // namespace cipher
