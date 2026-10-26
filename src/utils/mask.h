#pragma once

#include <string>

namespace cipher::mask {
std::string maskPhone(const std::string& phone);
std::string maskEmail(const std::string& email);
}
