#include "security.h"

namespace cipher {

void SecurityMiddleware::apply(HttpResponse& res) {
    res.headers["Content-Security-Policy"] = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' ws: wss:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'";
    res.headers["X-Content-Type-Options"] = "nosniff";
    res.headers["X-Frame-Options"] = "DENY";
    res.headers["Referrer-Policy"] = "no-referrer";
}

} // namespace cipher
