use axum::{
    extract::{Request, State},
    http::{header::HeaderName, HeaderValue},
    middleware::Next,
    response::Response,
};

use crate::state::AppState;

const CSP: &str = "default-src 'self'; \
script-src 'self' https://cdn.tailwindcss.com; \
style-src 'self' 'unsafe-inline'; \
img-src 'self' data: blob: https:; \
media-src 'self' blob: https:; \
font-src 'self' data:; \
connect-src 'self' ws: wss:; \
object-src 'none'; \
base-uri 'self'; \
form-action 'self'; \
frame-ancestors 'none'";

pub async fn security_headers(
    State(state): State<AppState>,
    request: Request,
    next: Next,
) -> Response {
    let mut response = next.run(request).await;
    let headers = response.headers_mut();

    set(headers, "x-content-type-options", "nosniff");
    set(headers, "x-frame-options", "DENY");
    set(
        headers,
        "referrer-policy",
        "strict-origin-when-cross-origin",
    );
    set(
        headers,
        "permissions-policy",
        "camera=(self), microphone=(self), geolocation=(), payment=()",
    );
    set(headers, "content-security-policy", CSP);

    if state.cfg.cookie_secure {
        set(
            headers,
            "strict-transport-security",
            "max-age=31536000; includeSubDomains",
        );
    }

    response
}

fn set(headers: &mut axum::http::HeaderMap, name: &'static str, value: &'static str) {
    headers.insert(
        HeaderName::from_static(name),
        HeaderValue::from_static(value),
    );
}
