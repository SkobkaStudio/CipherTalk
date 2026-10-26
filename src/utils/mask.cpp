#include "mask.h"

namespace cipher::mask {

std::string maskPhone(const std::string& phone) {
    std::string s = phone;
    if (s.empty()) return "";
    if (s.size() <= 4) return "\u2022\u2022\u2022\u2022";
    size_t start = std::min<size_t>(3, s.size() - 2);
    return s.substr(0, start) + "\u2022\u2022\u2022\u2022" + s.substr(s.size() - 2);
}

std::string maskEmail(const std::string& email) {
    std::string s = email;
    if (s.empty()) return "";
    size_t at = s.find('@');
    if (at < 1) return "\u2022\u2022\u2022\u2022";
    std::string name = s.substr(0, at);
    std::string domain = s.substr(at);
    return name.substr(0, std::min<size_t>(2, name.size())) + "\u2022\u2022\u2022" + domain;
}

} // namespace cipher::mask
