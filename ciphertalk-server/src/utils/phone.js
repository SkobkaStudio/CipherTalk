const PHONE_RE = /^\+?[0-9]{5,20}$/;

function normalizePhone(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const digits = raw.replace(/[^0-9]/g, '');
  if (!digits) return raw;
  if (digits.length === 11 && digits.startsWith('8')) {
    return '+7' + digits.slice(1);
  }
  if (digits.length === 11 && digits.startsWith('7')) {
    return '+' + digits;
  }
  if (digits.length === 10) {
    return '+7' + digits;
  }
  if (raw.startsWith('+')) {
    return '+' + digits;
  }
  return '+' + digits;
}

function isValidPhone(value) {
  const p = normalizePhone(value);
  return PHONE_RE.test(p);
}

function maskPhone(phone) {
  const p = String(phone || '');
  if (p.length < 8) return p;
  return p.slice(0, 4) + '****' + p.slice(-2);
}

module.exports = { normalizePhone, isValidPhone, maskPhone, PHONE_RE };
