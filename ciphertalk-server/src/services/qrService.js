/**
 * Генерация QR-кода (SVG) без внешних зависимостей и без canvas:
 * qrcode-generator выдаёт матрицу модулей, из неё собирается SVG.
 *
 * Модули — тёмные на светлом фоне: так QR читается любым сканером.
 */
const qrcode = require('qrcode-generator');

const EC_LEVELS = new Set(['L', 'M', 'Q', 'H']);

/**
 * @param {string} text данные для кодирования
 * @param {object} opts { ec: 'L'|'M'|'Q'|'H', quiet: число, fg, bg }
 * @returns {string} SVG
 */
function qrSvg(text, opts = {}) {
  const data = String(text || '').trim();
  if (!data) throw new Error('Пустые данные для QR');

  const ec = EC_LEVELS.has(opts.ec) ? opts.ec : 'M';
  const qr = qrcode(0, ec);
  qr.addData(data);
  qr.make();

  const size = qr.getModuleCount();
  const quiet = Number.isInteger(opts.quiet) ? opts.quiet : 4;
  const dim = size + quiet * 2;
  const fg = opts.fg || '#000000';
  const bg = opts.bg || '#ffffff';

  // Один path со всеми модулями — компактно и быстро рисуется
  let path = '';
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (!qr.isDark(r, c)) continue;
      path += `M${c + quiet} ${r + quiet}h1v1h-1z`;
    }
  }

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${dim * 8}" height="${dim * 8}"`,
    ` viewBox="0 0 ${dim} ${dim}" shape-rendering="crispEdges" role="img"`,
    ` aria-label="QR-код для входа в мессенджер">`,
    `<rect width="${dim}" height="${dim}" fill="${bg}"/>`,
    `<path d="${path}" fill="${fg}"/>`,
    `</svg>`
  ].join('');
}

/** Размер матрицы (для тестов). */
function qrMatrixSize(text, ec = 'M') {
  const qr = qrcode(0, EC_LEVELS.has(ec) ? ec : 'M');
  qr.addData(String(text));
  qr.make();
  return qr.getModuleCount();
}

module.exports = { qrSvg, qrMatrixSize };
