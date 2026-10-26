#pragma once

#include <string>
#include <cstdint>
#include <vector>

namespace cipher {

class Folder {
public:
    int64_t id = 0;
    int64_t user_id = 0;
    std::string name;
    std::string emoji;
    std::string color;
    std::string chat_ids; // JSON массив
    int64_t created_at = 0;
    int64_t updated_at = 0;

    Folder() = default;

    std::string toJson() const;
    std::vector<int64_t> chatIds() const;
};

} // namespace cipher
