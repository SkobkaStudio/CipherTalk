/**
 * imageHeaders.js — ручные парсеры заголовков растровых изображений (без sharp).
 *
 * Поддержаны: PNG/APNG, GIF87a/89a, WebP (VP8 / VP8L / VP8X), JPEG.
 * Все функции возвращают null при любом повреждении входного буфера —
 * они никогда не бросают исключений и всегда проверяют buffer.length
 * перед readUInt32BE/readUInt16LE.
 */

const MAX_CHUNK_SCAN = 4 * 1024 * 1024; // предохранитель от бесконечного скана чанков

/**
 * Определяет фактический MIME-тип по magic bytes.
 * @param {Buffer} buf - начало файла (>= 13 байт для надёжности)
 * @returns {string|null} 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp' | null
 */
function sniffMime(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return null;
  if (buf.readUInt32BE(0) === 0x89504e47 && buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a) return 'image/png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  const head4 = buf.toString('latin1', 0, 4);
  if (head4 === 'GIF8') return 'image/gif';
  if (buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

/** Разрешение PNG (IHDR) + флаг анимации (наличие acTL => APNG). */
function parsePng(buf) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (buf.length < sig.length + 12 || !buf.subarray(0, sig.length).equals(sig)) return null;
  let hasActl = false;
  let off = sig.length;
  while (off + 12 <= buf.length && off < MAX_CHUNK_SCAN) {
    const size = buf.readUInt32BE(off);
    const type = buf.toString('latin1', off + 4, off + 8);
    if (type === 'acTL') hasActl = true;
    if (type === 'IHDR') {
      if (size < 13 || off + 8 + 13 > buf.length) return null;
      const width = buf.readUInt32BE(off + 8);
      const height = buf.readUInt32BE(off + 12);
      if (width === 0 || height === 0) return null;
      return { width, height, animated: hasActl };
    }
    if (type === 'IEND') break;
    off += 12 + size; // len(4) + type(4) + data + crc(4)
  }
  return null;
}

/** Разрешение GIF (LSD в заголовке потока). */
function parseGif(buf) {
  if (buf.length < 13) return null;
  const ver = buf.toString('latin1', 0, 6);
  if (ver !== 'GIF87a' && ver !== 'GIF89a') return null;
  const width = buf.readUInt16LE(6);
  const height = buf.readUInt16LE(8);
  if (width === 0 || height === 0) return null;
  let frames = 0;
  for (let i = 0; i + 1 < buf.length; i++) {
    if (buf[i] === 0x21 && buf[i + 1] === 0xf9) frames++;
    if (frames >= 2) break;
  }
  return { width, height, animated: frames >= 2 };
}

/** Разрешение JPEG: обход сегментов SOFn до первого Start-Of-Frame. */
function parseJpeg(buf) {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let off = 2;
  while (off + 4 <= buf.length && off < MAX_CHUNK_SCAN) {
    if (buf[off] !== 0xff) { off++; continue; }
    const marker = buf[off + 1];
    const isSof = marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker);
    if (isSof) {
      if (off + 9 > buf.length) return null;
      const height = buf.readUInt16BE(off + 5);
      const width = buf.readUInt16BE(off + 7);
      if (width === 0 || height === 0) return null;
      return { width, height, animated: false };
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { off += 2; continue; }
    if (marker === 0xd9) return null;
    const segLen = buf.readUInt16BE(off + 2);
    if (segLen < 2) return null;
    off += 2 + segLen;
  }
  return null;
}

/** Разрешение WebP: фреймворк RIFF, подтипы VP8 (lossy) / VP8L (lossless) / VP8X (extended). */
function parseWebp(buf) {
  if (buf.length < 12) return null;
  if (buf.toString('latin1', 0, 4) !== 'RIFF' || buf.toString('latin1', 8, 12) !== 'WEBP') return null;
  let off = 12;
  let animated = false;
  while (off + 8 <= buf.length && off < MAX_CHUNK_SCAN) {
    const fourcc = buf.toString('latin1', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    const dataStart = off + 8;
    if (fourcc === 'ANMF') animated = true;
    if (fourcc === 'VP8X') {
      if (dataStart + 10 > buf.length) return null;
      const flags = buf[dataStart];
      const width = 1 + (buf[dataStart + 4] | (buf[dataStart + 5] << 8) | (buf[dataStart + 6] << 16));
      const height = 1 + (buf[dataStart + 7] | (buf[dataStart + 8] << 8) | (buf[dataStart + 9] << 16));
      return { width, height, animated: animated || !!(flags & 0x02) };
    }
    if (fourcc === 'VP8 ') {
      if (dataStart + 10 > buf.length) return null;
      // Кадры lossy: после 10-байтного frame tag — 3 байта sync + 14-битная ширина/высота
      const w = buf.readUInt16LE(dataStart + 6) & 0x3fff;
      const h = buf.readUInt16LE(dataStart + 8) & 0x3fff;
      if (w === 0 || h === 0) return null;
      return { width: w, height: h, animated };
    }
    if (fourcc === 'VP8L') {
      if (dataStart + 5 > buf.length) return null;
      if (buf[dataStart] !== 0x2f) return null;
      const bits = buf.readUInt32LE(dataStart + 1);
      const width = (bits & 0x3fff) + 1;
      const height = ((bits >> 14) & 0x3fff) + 1;
      return { width, height, animated };
    }
    off = dataStart + size + (size % 2); // чанки выровнены по 2 байтам
  }
  return null;
}

/**
 * Единая точка входа: определяет тип по содержимому и возвращает метаданные.
 * @param {Buffer} buf
 * @returns {{mime:string,width:number,height:number,animated:boolean}|null}
 */
function probeImage(buf) {
  const mime = sniffMime(buf);
  if (!mime) return null;
  let meta = null;
  if (mime === 'image/png') meta = parsePng(buf);
  else if (mime === 'image/gif') meta = parseGif(buf);
  else if (mime === 'image/jpeg') meta = parseJpeg(buf);
  else if (mime === 'image/webp') meta = parseWebp(buf);
  if (!meta) return null;
  return { mime, width: meta.width, height: meta.height, animated: !!meta.animated };
}

module.exports = { sniffMime, probeImage, parsePng, parseGif, parseJpeg, parseWebp };
