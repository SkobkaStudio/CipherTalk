/**
 * Заголовки безопасности.
 * Клиент — статические файлы без inline-скриптов, поэтому CSP строгий:
 * inline-обработчики из index.html вынесены в app.js (data-action).
 */

const CSP_DIRECTIVES = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "media-src 'self' blob: data:",
  "font-src 'self' data:",
  "connect-src 'self' ws: wss:",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "frame-src 'self' blob:",
  "manifest-src 'self'",
  "upgrade-insecure-requests"
].join('; ');

function securityHeaders(req, res, next) {
  res.setHeader('Content-Security-Policy', CSP_DIRECTIVES);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-DNS-Prefetch-Control', 'off');
  res.setHeader('Permissions-Policy',
    'geolocation=(), microphone=(self), camera=(self), payment=(), usb=(), magnetometer=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.removeHeader('X-Powered-By');
  next();
}

module.exports = securityHeaders;
