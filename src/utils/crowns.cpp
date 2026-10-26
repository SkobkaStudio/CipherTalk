#include "crowns.h"
#include "../config/config.h"

namespace cipher::crowns {

std::string getCrownLevelByPhone(const std::string& phone) {
    Config cfg = loadConfig();
    if (!cfg.ownerPhone.empty() && phone == cfg.ownerPhone) return "gold";
    return "";
}

} // namespace cipher::crowns
