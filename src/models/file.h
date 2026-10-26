#pragma once

#include <string>
#include <cstdint>

namespace cipher {

class File {
public:
    int64_t id = 0;
    std::string filename;
    std::string original_name;
    int64_t size = 0;
    std::string mimetype;
    int64_t uploader_id = 0;
    int64_t created_at = 0;

    File() = default;

    std::string toJson() const;
};

} // namespace cipher
