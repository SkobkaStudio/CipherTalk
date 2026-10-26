#include "ice_service.h"
#include "../config/config.h"
#include <sstream>

namespace cipher {

IceService::IceService() {
    Config cfg = loadConfig();
    stunUrls_ = cfg.ice.stunUrls;
    turnUrl_ = cfg.ice.turnUrl;
    turnSecret_ = cfg.ice.turnSecret;
    turnUsername_ = cfg.ice.turnUsername;
    turnCredential_ = cfg.ice.turnCredential;
    turnTtlSeconds_ = cfg.ice.turnTtlSeconds;
}

IceService::~IceService() = default;

std::string IceService::getIceServersJson() const {
    std::ostringstream oss;
    oss << "[";
    bool first = true;
    for (auto& s : stunUrls_) {
        if (!first) oss << ",";
        first = false;
        oss << "{\"urls\":\"" << s << "\"}";
    }
    if (!turnUrl_.empty()) {
        if (!first) oss << ",";
        first = false;
        if (!turnSecret_.empty()) {
            // 동적인 TURN credential генерируется на стороне клиента/сервера при запросе;
            // здесь отдаём статические URLs, а учётные данные — отдельно через /api/ice-servers логику.
            oss << "{\"urls\":\"" << turnUrl_ << "\",\"username\":\"temp\",\"credential\":\"temp\"}";
        } else {
            oss << "{\"urls\":\"" << turnUrl_ << "\",\"username\":\"" << turnUsername_ << "\",\"credential\":\"" << turnCredential_ << "\"}";
        }
    }
    oss << "]";
    return oss.str();
}

bool IceService::hasTurn() const {
    return !turnUrl_.empty();
}

} // namespace cipher
