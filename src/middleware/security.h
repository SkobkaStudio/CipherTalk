#pragma once

#include <string>
#include "../http_server.h"

namespace cipher {

class SecurityMiddleware {
public:
    static void apply(HttpResponse& res);
};

} // namespace cipher
