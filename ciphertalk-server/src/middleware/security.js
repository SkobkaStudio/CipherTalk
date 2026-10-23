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
  "connect-src 'self' ws: wss: stun: turn:",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "frame-src 'self' blob:",
  "manifest-src 'self'"
].join('; ');

function securityHeaders(req, res, next) {
  // upgrade-insecure-requests только для HTTPS, иначе локальный HTTP-клиент
  // может начать принудительно запрашивать https://localhost и сломаться.
  const isHttps = req.secure || String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
  const csp = isHttps ? `${CSP_DIRECTIVES}; upgrade-insecure-requests` : CSP_DIRECTIVES;
  res.setHeader('Content-Security-Policy', csp);
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
