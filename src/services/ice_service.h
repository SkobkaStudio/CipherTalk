#pragma once

#include <string>
#include <vector>

namespace cipher {

class IceService {
public:
    IceService();
    ~IceService();

    std::string getIceServersJson() const;
    bool hasTurn() const;

private:
    std::vector<std::string> stunUrls_;
    std::string turnUrl_, turnSecret_, turnUsername_, turnCredential_;
    int turnTtlSeconds_ = 3600;
};

} // namespace cipher
