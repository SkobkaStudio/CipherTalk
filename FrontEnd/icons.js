/* CipherTalk — единая библиотека SVG-иконок и стикеров.
   Иконки живут в спрайте #mq-i-sprite (вставлен в index.html), используются через
   <svg class="mq-icon"><use href="#mq-i-NAME"></use></svg>.
   Цвет берётся из currentColor, поэтому иконки автоматически перекрашиваются
   вместе с темой (переменные --mq-icon / --mq-icon-glow в icons.css). */
(function () {
  'use strict';

  // ==================== ИКОНКИ (24x24, stroke, без заливки) ====================
  const PATHS = {
    menu: '<path d="M3 6h18M3 12h18M3 18h18"/>',
    x: '<path d="M18 6L6 18M6 6l12 12"/>',
    'arrow-left': '<path d="M19 12H5M12 19l-7-7 7-7"/>',
    'arrow-right': '<path d="M5 12h14M12 5l7 7-7 7"/>',
    send: '<path d="M22 2L11 13"/><path d="M22 2l-7 20-4-9-9-4z"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="M20.5 20.5L16 16"/>',
    settings: '<circle cx="12" cy="12" r="7"/><circle cx="12" cy="12" r="2.6"/>' +
      '<path d="M12 5.2V2.5M12 18.8v2.7M5.2 12H2.5M18.8 12h2.7' +
      'M7.2 7.2L5.3 5.3M18.7 18.7l-1.9-1.9M16.8 7.2l1.9-1.9M5.3 18.7l1.9-1.9"/>',
    user: '<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
    users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/>' +
      '<path d="M22 21v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8"/>',
    message: '<path d="M21 11.5a8.4 8.4 0 0 1-9 8.4 8.4 8.4 0 0 1-3.8-.9L3 21l1.9-5.2A8.4 8.4 0 0 1 12 3a8.4 8.4 0 0 1 9 8.5z"/>',
    'message-square': '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
    pin: '<path d="M12 17v5M5 17h14M6 3h12l-2 8 3 3H5l3-3z"/>',
    star: '<path d="M12 2.6l2.95 5.98 6.55.95-4.74 4.66 1.12 6.51L12 17.62l-5.88 3.08 1.12-6.51L2.5 9.53l6.55-.95z"/>',
    bell: '<path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/>',
    megaphone: '<path d="M3 11v2a1 1 0 0 0 1 1h2l5 4V6L6 10H4a1 1 0 0 0-1 1z"/>' +
      '<path d="M14 7.5a5 5 0 0 1 0 9M17 4.5a9 9 0 0 1 0 15"/>',
    lock: '<rect x="3" y="11" width="18" height="10" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
    unlock: '<rect x="3" y="11" width="18" height="10" rx="2"/><path d="M7 11V7a5 5 0 0 1 9.9-1"/>',
    key: '<circle cx="8" cy="16" r="4"/><path d="M11 13L21 3M17 7l2 2M14 10l2 2"/>',
    shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>',
    'shield-check': '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="M9 12l2 2 4-4"/>',
    eye: '<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/>',
    'eye-off': '<path d="M9.9 5.2A9.9 9.9 0 0 1 12 5c6.4 0 10 7 10 7a17.6 17.6 0 0 1-3.2 4.1M6.3 6.4A17.6 17.6 0 0 0 2 12s3.6 7 10 7a9.6 9.6 0 0 0 4.1-.9"/>' +
      '<path d="M9.9 9.9a3 3 0 0 0 4.2 4.2M3 3l18 18"/>',
    logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="M16 17l5-5-5-5M21 12H9"/>',
    paperclip: '<path d="M21.4 11.1l-9.2 9.2a6 6 0 0 1-8.5-8.5l8.6-8.6a4 4 0 0 1 5.7 5.7l-8.6 8.6a2 2 0 0 1-2.8-2.8l8.5-8.5"/>',
    phone: '<path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .4 1.9.7 2.8a2 2 0 0 1-.4 2.1L8.1 9.9a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.9.6 2.8.7a2 2 0 0 1 1.7 2z"/>',
    video: '<path d="M23 7l-7 5 7 5z"/><rect x="1" y="5" width="15" height="14" rx="2"/>',
    'video-off': '<path d="M16 16v-2a2 2 0 0 0-2-2h-2M2 8.5v8.5a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V11"/><path d="M22 8v6M3 3l18 18"/>',
    mic: '<path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2M12 19v3M8 22h8"/>',
    'mic-off': '<path d="M9 9v3a3 3 0 0 0 5.1 2.1M15 9V5a3 3 0 0 0-5.9-1.2"/><path d="M19 10v2a7 7 0 0 1-10.6 6M5 10v2a7 7 0 0 0 11.4 5.4M12 19v3M8 22h8M3 3l18 18"/>',
    'volume-x': '<path d="M11 5L6 9H2v6h4l5 4z"/><path d="M22 9l-6 6M16 9l6 6"/>',
    image: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="M21 15l-5-5L5 21"/>',
    camera: '<path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/>',
    'camera-off': '<path d="M9 5h6l2 3h4a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h2M3 3l18 18"/>',
    film: '<rect x="2" y="2" width="20" height="20" rx="2"/><path d="M7 2v20M17 2v20M2 12h20M2 7h5M2 17h5M17 17h5M17 7h5"/>',
    music: '<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>',
    file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/>',
    'file-text': '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6M16 13H8M16 17H8M10 9H8"/>',
    'file-archive': '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6M10 4h1M10 7h1M10 10h1M12 13h1M12 16h1"/>',
    folder: '<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>',
    trash: '<path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6M10 11v6M14 11v6"/>',
    edit: '<path d="M17 3a2.8 2.8 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5z"/>',
    reply: '<path d="M9 17l-5-5 5-5"/><path d="M20 18v-2a4 4 0 0 0-4-4H4"/>',
    check: '<path d="M20 6L9 17l-5-5"/>',
    'check-check': '<path d="M18 6L7 17l-5-5"/><path d="M22 10l-8.5 8.5-2-2"/>',
    'alert-circle': '<circle cx="12" cy="12" r="10"/><path d="M12 8v5M12 16.5h.01"/>',
    info: '<circle cx="12" cy="12" r="10"/><path d="M12 16.5v-5M12 7.5h.01"/>',
    'x-circle': '<circle cx="12" cy="12" r="10"/><path d="M15 9l-6 6M9 9l6 6"/>',
    database: '<ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.7-4 3-9 3s-9-1.3-9-3"/><path d="M3 5v14c0 1.7 4 3 9 3s9-1.3 9-3V5"/>',
    flame: '<path d="M12 2c1 3 4 4.5 4 8a4 4 0 0 1-8 0c0-1 .3-1.8.3-1.8S6 10.5 6 14a6 6 0 0 0 12 0c0-6-6-12-6-12z"/>',
    'thumbs-up': '<path d="M7 21V10l5-8a2.5 2.5 0 0 1 2.4 3.2L13.5 9H19a2 2 0 0 1 2 2.4l-1.5 7A2 2 0 0 1 17.5 20H7z"/><path d="M7 10H4a1 1 0 0 0-1 1v9a1 1 0 0 0 1 1h3"/>',
    heart: '<path d="M20.8 5.6a5 5 0 0 0-7.1 0L12 7.3l-1.7-1.7a5 5 0 1 0-7.1 7.1L12 21.5l8.8-8.8a5 5 0 0 0 0-7.1z"/>',
    smile: '<circle cx="12" cy="12" r="10"/><path d="M8 14s1.5 2 4 2 4-2 4-2"/><path d="M9 9.5h.01M15 9.5h.01"/>',
    frown: '<circle cx="12" cy="12" r="10"/><path d="M16 16s-1.5-2-4-2-4 2-4 2"/><path d="M9 9.5h.01M15 9.5h.01"/>',
    laugh: '<circle cx="12" cy="12" r="10"/><path d="M7.5 13.5a5.5 5.5 0 0 0 9 0z"/><path d="M9 9h.01M15 9h.01"/>',
    sparkle: '<path d="M12 3l1.6 4.4L18 9l-4.4 1.6L12 15l-1.6-4.4L6 9l4.4-1.6z"/><path d="M18.5 15l.7 2 2 .7-2 .7-.7 2-.7-2-2-.7 2-.7z"/>',
    hands: '<path d="M8 12V5a1.5 1.5 0 0 1 3 0v6M11 11V4a1.5 1.5 0 0 1 3 0v7M14 11V6a1.5 1.5 0 0 1 3 0v8a6 6 0 0 1-6 6h-1a6 6 0 0 1-5-2.7L4 15a1.6 1.6 0 0 1 2.4-2.1L8 14"/>',
    rotate: '<path d="M1 4v6h6"/><path d="M3.5 15a9 9 0 1 0 2.2-9.4L1 10"/>',
    play: '<path d="M5 3l14 9-14 9z"/>',
    pause: '<rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/>',
    download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M7 10l5 5 5-5M12 15V3"/>',
    copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
    qr: '<path d="M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3z"/><path d="M5 5h3v3H5zM16 5h3v3h-3zM5 16h3v3H5z" fill="currentColor" stroke="none"/>' +
      '<path d="M14 14h3v3h-3zM18 18h3v3h-3zM14 18h1M18 14h1M21 14v1" fill="currentColor" stroke="none"/>',
    link: '<path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/>',
    refresh: '<path d="M21 12a9 9 0 1 1-2.6-6.4"/><path d="M21 3v6h-6"/>',
    clock: '<circle cx="12" cy="12" r="10"/><path d="M12 6.5V12l3.5 2"/>',
    'at-sign': '<circle cx="12" cy="12" r="4"/><path d="M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-3.9 7.9"/>',
    hash: '<path d="M4 9h16M4 15h16M10 3L8 21M16 3l-2 18"/>',
    zap: '<path d="M13 2L3 14h8l-1 8 10-12h-8z"/>',
    globe: '<circle cx="12" cy="12" r="10"/><path d="M2 12h20"/><path d="M12 2a15 15 0 0 1 0 20 15 15 0 0 1 0-20z"/>',
    bot: '<rect x="4" y="8" width="16" height="12" rx="3"/><path d="M12 8V4"/><circle cx="12" cy="3" r="1.2"/><path d="M9 13h.01M15 13h.01M9.5 16.5h5"/>',
    device: '<rect x="6" y="2" width="12" height="20" rx="2"/><path d="M11 18.5h2"/>',
    layout: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M9 21V9"/>',
    sticker: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/>' +
      '<circle cx="9.5" cy="13" r="1"/><circle cx="14.5" cy="13" r="1"/><path d="M9 16a3 3 0 0 0 6 0"/>',
    palette: '<path d="M12 3a9 9 0 0 0 0 18h1.5a1.5 1.5 0 0 0 0-3H12a2 2 0 0 1 0-4h3a6 6 0 0 0 6-6c0-2.8-4-5-9-5z"/>' +
      '<circle cx="7.5" cy="11" r="1.2" fill="currentColor" stroke="none"/><circle cx="9.5" cy="7" r="1.2" fill="currentColor" stroke="none"/>' +
      '<circle cx="14" cy="6.5" r="1.2" fill="currentColor" stroke="none"/><circle cx="17.5" cy="9.5" r="1.2" fill="currentColor" stroke="none"/>',
    'shield-off': '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="M9 9l6 6M15 9l-6 6"/>',
    'toggle-off': '<rect x="1" y="6" width="22" height="12" rx="6"/><circle cx="8" cy="12" r="2.6" fill="currentColor" stroke="none"/>',
    'toggle-on': '<rect x="1" y="6" width="22" height="12" rx="6"/><circle cx="16" cy="12" r="2.6" fill="currentColor" stroke="none"/>'
  };

  // ==================== РЕАКЦИИ: эмодзи -> иконка ====================
  const REACTION_ICONS = {
    '👍': 'thumbs-up',
    '❤️': 'heart',
    '❤': 'heart',
    '😂': 'laugh',
    '🔥': 'flame',
    '🎉': 'sparkle',
    '😢': 'frown',
    '🙏': 'hands',
    '👀': 'eye'
  };

  // ==================== СТИКЕРЫ (анимированные SVG-картинки) ====================
  const STICKERS = [
    {
      id: 'heart', icon: 'heart',
      svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120" width="120" height="120">' +
        '<defs><linearGradient id="s-heart-g" x1="0" y1="0" x2="0" y2="1">' +
        '<stop offset="0" stop-color="#ff8ec4"/><stop offset="1" stop-color="#e0245e"/></linearGradient></defs>' +
        '<g transform="translate(60 62)"><g>' +
        '<animateTransform attributeName="transform" type="scale" values="1;1.14;1" dur="1.3s" repeatCount="indefinite"/>' +
        '<path fill="url(#s-heart-g)" d="M0 38S-34 16-34-6a19 19 0 0 1 34-9 19 19 0 0 1 34 9c0 22-34 44-34 44z"/>' +
        '<path fill="rgba(255,255,255,.45)" d="M-22-6a12 12 0 0 1 10-6 5 5 0 0 0-8 6z"/>' +
        '</g></g></svg>'
    },
    {
      id: 'thumb', icon: 'thumbs-up',
      svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120" width="120" height="120">' +
        '<defs><linearGradient id="s-thumb-g" x1="0" y1="0" x2="1" y2="1">' +
        '<stop offset="0" stop-color="#ffd97a"/><stop offset="1" stop-color="#f4a62a"/></linearGradient></defs>' +
        '<g transform="translate(60 60)"><g>' +
        '<animateTransform attributeName="transform" type="rotate" values="-8;8;-8" dur="1.8s" repeatCount="indefinite"/>' +
        '<path fill="url(#s-thumb-g)" stroke="#c47f12" stroke-width="2.5" stroke-linejoin="round" ' +
        'd="M-32 2h14V46h-14z"/>' +
        '<path fill="url(#s-thumb-g)" stroke="#c47f12" stroke-width="2.5" stroke-linejoin="round" ' +
        'd="M-18 2 2-38a9 9 0 0 1 11 6l-4 14h24a8 8 0 0 1 8 10l-6 40a9 9 0 0 1-9 8h-44z"/>' +
        '</g></g></svg>'
    },
    {
      id: 'rocket', icon: 'zap',
      svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120" width="120" height="120">' +
        '<defs><linearGradient id="s-rocket-g" x1="0" y1="0" x2="0" y2="1">' +
        '<stop offset="0" stop-color="#ffffff"/><stop offset="1" stop-color="#b9c6d8"/></linearGradient>' +
        '<linearGradient id="s-flame-g" x1="0" y1="0" x2="0" y2="1">' +
        '<stop offset="0" stop-color="#ffd166"/><stop offset="1" stop-color="#ef476f"/></linearGradient></defs>' +
        '<g transform="translate(60 56)"><g>' +
        '<animateTransform attributeName="transform" type="translate" values="0 6;0 -6;0 6" dur="1.6s" repeatCount="indefinite"/>' +
        '<path fill="url(#s-flame-g)" d="M-9 34c6 14 12 14 18 0-4 4-14 4-18 0z">' +
        '<animate attributeName="opacity" values="1;.55;1" dur=".5s" repeatCount="indefinite"/></path>' +
        '<path fill="url(#s-rocket-g)" stroke="#5c6b80" stroke-width="2.5" stroke-linejoin="round" ' +
        'd="M0-46c13 13 17 30 15 48L0 18-15 2c-2-18 2-35 15-48z"/>' +
        '<circle cx="0" cy="-18" r="8" fill="#59c2ff" stroke="#2d7fb8" stroke-width="2.5"/>' +
        '<path fill="#ef476f" stroke="#b3325a" stroke-width="2" stroke-linejoin="round" d="M-15 2-27 18l12-3zM15 2l12 16-12-3z"/>' +
        '</g></g></svg>'
    },
    {
      id: 'ghost', icon: 'sparkle',
      svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120" width="120" height="120">' +
        '<g transform="translate(60 60)"><g>' +
        '<animateTransform attributeName="transform" type="translate" values="0 -6;0 6;0 -6" dur="2.4s" repeatCount="indefinite"/>' +
        '<path fill="#f6f8ff" stroke="#b9c2e6" stroke-width="2.5" stroke-linejoin="round" ' +
        'd="M-28 34V-6a28 28 0 0 1 56 0v40l-9-7-9 7-9-7-9 7-9-7-9 7z"/>' +
        '<circle cx="-10" cy="-4" r="4.5" fill="#2b3352"/><circle cx="10" cy="-4" r="4.5" fill="#2b3352"/>' +
        '<path d="M-8 12a10 10 0 0 0 16 0" fill="none" stroke="#2b3352" stroke-width="2.5" stroke-linecap="round"/>' +
        '</g></g></svg>'
    },
    {
      id: 'robot', icon: 'bot',
      svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120" width="120" height="120">' +
        '<defs><linearGradient id="s-bot-g" x1="0" y1="0" x2="0" y2="1">' +
        '<stop offset="0" stop-color="#7ee7ff"/><stop offset="1" stop-color="#3aa7d8"/></linearGradient></defs>' +
        '<g transform="translate(60 60)"><g>' +
        '<animateTransform attributeName="transform" type="translate" values="0 -4;0 4;0 -4" dur="2s" repeatCount="indefinite"/>' +
        '<path d="M0-40v-10" stroke="#3aa7d8" stroke-width="4" stroke-linecap="round"/>' +
        '<circle cx="0" cy="-54" r="7" fill="#ffd166"/>' +
        '<rect x="-34" y="-36" width="68" height="56" rx="16" fill="url(#s-bot-g)" stroke="#2b7fa8" stroke-width="3"/>' +
        '<circle cx="-14" cy="-10" r="8" fill="#0f2233"><animate attributeName="ry" values="8;1;8" dur="3s" repeatCount="indefinite"/></circle>' +
        '<circle cx="14" cy="-10" r="8" fill="#0f2233"><animate attributeName="ry" values="8;1;8" dur="3s" repeatCount="indefinite"/></circle>' +
        '<rect x="-18" y="6" width="36" height="6" rx="3" fill="#0f2233"/>' +
        '<path d="M-30 14-42 24M30 14l12 10" stroke="#3aa7d8" stroke-width="6" stroke-linecap="round"/>' +
        '</g></g></svg>'
    },
    {
      id: 'fire', icon: 'flame',
      svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120" width="120" height="120">' +
        '<defs><linearGradient id="s-fire-g" x1="0" y1="0" x2="0" y2="1">' +
        '<stop offset="0" stop-color="#ffe066"/><stop offset=".55" stop-color="#ff9f1c"/><stop offset="1" stop-color="#ef476f"/></linearGradient></defs>' +
        '<g transform="translate(60 64)"><g>' +
        '<animateTransform attributeName="transform" type="scale" values="1 1;1 1.1;1 1" dur=".8s" repeatCount="indefinite"/>' +
        '<path fill="url(#s-fire-g)" d="M0-52c3 16 16 21 16 40a16 16 0 0 1-32 0c0-4 1-7 1-7s-11 9-11 21a26 26 0 0 0 52 0c0-26-26-54-26-54z"/>' +
        '<path fill="#fff3b0" d="M0-14c2 8 8 10 8 18a8 8 0 0 1-16 0c0-6 8-18 8-18z">' +
        '<animate attributeName="opacity" values=".9;.5;.9" dur=".6s" repeatCount="indefinite"/></path>' +
        '</g></g></svg>'
    },
    {
      id: 'party', icon: 'sparkle',
      svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120" width="120" height="120">' +
        '<g transform="translate(60 60)"><g>' +
        '<animateTransform attributeName="transform" type="rotate" values="-10;10;-10" dur="1.4s" repeatCount="indefinite"/>' +
        '<path fill="#ffd166" stroke="#e0a020" stroke-width="2.5" stroke-linejoin="round" ' +
        'd="M-22-8h44L16 6l-8-4-8 4z"/><path d="M-22-8c-8-14 0-26 12-26-2 10 4 12 12 12-10 2-14 8-24 14z" fill="#ef476f"/>' +
        '<circle cx="-30" cy="-30" r="5" fill="#06d6a0"/><circle cx="34" cy="-26" r="6" fill="#118ab2"/>' +
        '<circle cx="30" cy="24" r="4" fill="#ef476f"/><circle cx="-32" cy="22" r="5" fill="#ffd166"/>' +
        '</g></g></svg>'
    },
    {
      id: 'cat', icon: 'smile',
      svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120" width="120" height="120">' +
        '<g transform="translate(60 62)"><g>' +
        '<animateTransform attributeName="transform" type="rotate" values="-4;4;-4" dur="3s" repeatCount="indefinite"/>' +
        '<path fill="#ffb86b" stroke="#d1782f" stroke-width="2.5" stroke-linejoin="round" d="M-32-24l-4-26 22 14zM32-24l4-26-22 14z"/>' +
        '<circle cx="0" cy="0" r="32" fill="#ffc98a" stroke="#d1782f" stroke-width="2.5"/>' +
        '<circle cx="-12" cy="-6" r="4" fill="#402c1c"/><circle cx="12" cy="-6" r="4" fill="#402c1c"/>' +
        '<path d="M0 2l-4 4h8z" fill="#e0739a"/>' +
        '<path d="M-9 12a9 9 0 0 0 18 0" fill="none" stroke="#402c1c" stroke-width="2.5" stroke-linecap="round"/>' +
        '<path d="M-20 4h-12M20 4h12M-20 10h-12M20 10h12" stroke="#d1782f" stroke-width="2" stroke-linecap="round"/>' +
        '</g></g></svg>'
    },
    {
      id: 'coffee', icon: 'zap',
      svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120" width="120" height="120">' +
        '<g transform="translate(58 62)"><g>' +
        '<animateTransform attributeName="transform" type="translate" values="0 0;0 -3;0 0" dur="2.6s" repeatCount="indefinite"/>' +
        '<path d="M-18-26c6-8 0-14 4-22" fill="none" stroke="#c9d6e5" stroke-width="4" stroke-linecap="round" opacity=".9">' +
        '<animate attributeName="opacity" values="0;.9;0" dur="2.6s" repeatCount="indefinite"/></path>' +
        '<path d="M-2-26c6-8 0-14 4-22" fill="none" stroke="#c9d6e5" stroke-width="4" stroke-linecap="round" opacity=".9">' +
        '<animate attributeName="opacity" values="0;.9;0" dur="2.6s" begin=".6s" repeatCount="indefinite"/></path>' +
        '<path d="M-24-14h48v22a16 16 0 0 1-16 16h-16a16 16 0 0 1-16-16z" fill="#fff" stroke="#c3cede" stroke-width="3"/>' +
        '<path d="M-24-4h48v12a16 16 0 0 1-16 16h-16a16 16 0 0 1-16-16z" fill="#6b4423"/>' +
        '<path d="M24-8h8a9 9 0 0 1 0 18h-8" fill="none" stroke="#c3cede" stroke-width="3"/>' +
        '</g></g></svg>'
    },
    {
      id: 'skull', icon: 'alert-circle',
      svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120" width="120" height="120">' +
        '<g transform="translate(60 58)"><g>' +
        '<animateTransform attributeName="transform" type="rotate" values="-6;6;-6" dur="2.2s" repeatCount="indefinite"/>' +
        '<path fill="#f2f5fa" stroke="#b6c2d4" stroke-width="3" stroke-linejoin="round" ' +
        'd="M0-40a34 34 0 0 1 34 34c0 12-5 18-9 22-3 3-4 6-4 10v6h-42v-6c0-4-1-7-4-10-4-4-9-10-9-22A34 34 0 0 1 0-40z"/>' +
        '<circle cx="-13" cy="-6" r="9" fill="#2b3352"/><circle cx="13" cy="-6" r="9" fill="#2b3352"/>' +
        '<path d="M0 8l-6 8h12z" fill="#2b3352"/>' +
        '<path d="M-13 26v10M0 26v10M13 26v10" stroke="#b6c2d4" stroke-width="3" stroke-linecap="round"/>' +
        '</g></g></svg>'
    },
    {
      id: 'info', icon: 'info',
      svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120" width="120" height="120">' +
        '<defs>' +
        '<linearGradient id="s-info-g" x1="0.15" y1="0" x2="0.85" y2="1">' +
        '<stop offset="0" stop-color="#8ed8ff"/><stop offset="0.55" stop-color="#3d9df0"/>' +
        '<stop offset="1" stop-color="#1450a8"/></linearGradient>' +
        '<radialGradient id="s-info-gloss" cx="0.32" cy="0.26" r="0.45">' +
        '<stop offset="0" stop-color="rgba(255,255,255,.62)"/>' +
        '<stop offset="1" stop-color="rgba(255,255,255,0)"/></radialGradient>' +
        '</defs>' +
        '<g transform="translate(60 60)">' +
        // расходящееся кольцо-« маяк»
        '<circle r="40" fill="none" stroke="#7fc4ff" stroke-width="3">' +
        '<animate attributeName="r" values="40;52" dur="2.4s" repeatCount="indefinite"/>' +
        '<animate attributeName="opacity" values=".65;0" dur="2.4s" repeatCount="indefinite"/></circle>' +
        '<g>' +
        '<animateTransform attributeName="transform" type="scale" values="1;1.07;1" dur="2.4s" repeatCount="indefinite"/>' +
        '<circle r="40" fill="url(#s-info-g)"/>' +
        '<circle r="40" fill="url(#s-info-gloss)"/>' +
        '<circle r="39" fill="none" stroke="#0d4c96" stroke-width="2.5" opacity=".5"/>' +
        // белая «i»
        '<circle cx="0" cy="-17" r="7.5" fill="#ffffff"/>' +
        '<path d="M-6.5-4h13l-1.6 30h-9.8z" fill="#ffffff"/>' +
        '</g></g></svg>'
    }
  ];

  // ==================== ЭМОДЗИ В ТЕКСТАХ ИНТЕРФЕЙСА -> ИКОНКИ ====================
  // Строки переводов иногда начинаются/заканчиваются эмодзи. В интерфейсе
  // (модалки, тосты, меню) они заменяются на тематические SVG-иконки.
  const EMOJI_ICONS = {
    '🔒': 'lock',
    '🔑': 'key',
    '🛡️': 'shield',
    '🛡': 'shield',
    '📌': 'pin',
    '📍': 'pin',
    '📁': 'folder',
    '🗂': 'folder',
    '🧑': 'user',
    '👤': 'user',
    '⚙️': 'settings',
    '⚙': 'settings',
    '👥': 'users',
    '📢': 'megaphone',
    '🔍': 'search',
    '⭐': 'star',
    '🚪': 'logout',
    '💬': 'message',
    '📞': 'phone',
    '🎤': 'mic',
    '📹': 'video',
    '🎥': 'video',
    '📎': 'paperclip',
    '🖼️': 'image',
    '🖼': 'image',
    '🗑️': 'trash',
    '🗑': 'trash',
    '🔁': 'rotate',
    '🎉': 'sparkle',
    '✨': 'sparkle',
    '⏳': 'clock',
    '🕐': 'clock',
    '⚠️': 'alert-circle',
    '⚠': 'alert-circle',
    '❌': 'x-circle',
    '✅': 'check',
    '💾': 'database',
    '🤖': 'bot',
    '📤': 'send',
    '📥': 'download',
    '🔔': 'bell',
    '👁️': 'eye',
    '👁': 'eye',
    '📋': 'copy',
    '🔗': 'link',
    '💡': 'zap',
    '🧩': 'layout',
    '←': 'arrow-left',
    '→': 'arrow-right',
    '🔁': 'rotate'
  };

  // Где автоматически заменяем эмодзи в тексте на иконки.
  // Область чата и списка чатов исключена: там текст может быть пользовательским.
  const ICONIFY_SCOPE = [
    '#modal-content',
    '#toast-container',
    '.login-box',
    '.folder-bar',
    '.sticker-picker',
    '.public-access',
    '.mobile-nav',
    '.side-menu-items'
  ].join(', ');

  const EMOJI_SPLIT_RE = new RegExp(
    '(' + Object.keys(EMOJI_ICONS)
      .sort((a, b) => b.length - a.length)
      .map((e) => e.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('|') + ')',
    'g'
  );

  function iconifyTextNode(node) {
    if (!node || node.nodeType !== 3) return;
    const parent = node.parentElement;
    if (!parent) return;
    if (parent.closest('svg, .mq-emoji, .folder-emoji, .rc-count')) return;
    const raw = node.nodeValue || '';
    if (!raw) return;
    EMOJI_SPLIT_RE.lastIndex = 0;
    if (!EMOJI_SPLIT_RE.test(raw)) return;
    EMOJI_SPLIT_RE.lastIndex = 0;

    const frag = document.createDocumentFragment();
    let last = 0;
    let m;
    while ((m = EMOJI_SPLIT_RE.exec(raw)) !== null) {
      if (m.index > last) frag.appendChild(document.createTextNode(raw.slice(last, m.index)));
      const name = EMOJI_ICONS[m[1]];
      const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      icon.setAttribute('class', 'mq-icon mq-icon--sm mq-inline-icon');
      icon.setAttribute('aria-hidden', 'true');
      icon.setAttribute('focusable', 'false');
      const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
      use.setAttribute('href', '#mq-i-' + name);
      icon.appendChild(use);
      frag.appendChild(icon);
      last = m.index + m[1].length;
    }
    if (last < raw.length) frag.appendChild(document.createTextNode(raw.slice(last)));
    parent.replaceChild(frag, node);
  }

  function iconifyRoot(root) {
    if (!root || !root.querySelectorAll) return;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const nodes = [];
    let n;
    while ((n = walker.nextNode())) nodes.push(n);
    nodes.forEach(iconifyTextNode);
  }

  let iconifyObserver = null;
  function startIconify() {
    if (iconifyObserver || typeof MutationObserver === 'undefined' || !document.body) return;
    iconifyObserver = new MutationObserver((records) => {
      for (const r of records) {
        r.addedNodes.forEach((node) => {
          if (node.nodeType === 3) {
            if (node.parentElement && node.parentElement.closest(ICONIFY_SCOPE)) {
              iconifyTextNode(node);
            }
            return;
          }
          if (node.nodeType !== 1) return;
          if (node.closest && node.closest(ICONIFY_SCOPE)) iconifyRoot(node);
        });
      }
    });
    iconifyObserver.observe(document.body, { childList: true, subtree: true, characterData: true });
  }

  // ==================== API ====================
  const SPRITE_ID = 'mq-icon-sprite';

  function buildSprite() {
    if (document.getElementById(SPRITE_ID)) return;
    const svgNS = 'http://www.w3.org/2000/svg';
    const sprite = document.createElementNS(svgNS, 'svg');
    sprite.setAttribute('id', SPRITE_ID);
    sprite.setAttribute('aria-hidden', 'true');
    sprite.setAttribute('focusable', 'false');
    sprite.setAttribute('class', 'mq-sprite');
    Object.keys(PATHS).forEach((name) => {
      const symbol = document.createElementNS(svgNS, 'symbol');
      symbol.setAttribute('id', 'mq-i-' + name);
      symbol.setAttribute('viewBox', '0 0 24 24');
      symbol.setAttribute('fill', 'none');
      symbol.setAttribute('stroke', 'currentColor');
      symbol.setAttribute('stroke-width', '2');
      symbol.setAttribute('stroke-linecap', 'round');
      symbol.setAttribute('stroke-linejoin', 'round');
      symbol.innerHTML = PATHS[name];
      sprite.appendChild(symbol);
    });
    document.body.insertBefore(sprite, document.body.firstChild);
  }

  // Разметка иконки: <svg class="mq-icon"><use href="#mq-i-NAME"/></svg>
  function svg(name, opts) {
    const o = opts || {};
    const cls = ['mq-icon'];
    if (o.className) cls.push(o.className);
    if (o.size) cls.push('mq-icon-' + o.size);
    const href = '#mq-i-' + name;
    const label = o.label ? ' role="img" aria-label="' + String(o.label).replace(/"/g, '&quot;') + '"' : ' aria-hidden="true"';
    return '<svg class="' + cls.join(' ') + '"' + label + ' focusable="false"' +
      (o.title ? ' title="' + String(o.title).replace(/"/g, '&quot;') + '"' : '') +
      '><use href="' + href + '"></use></svg>';
  }

  function el(name, opts) {
    const wrap = document.createElement('div');
    wrap.innerHTML = svg(name, opts);
    return wrap.firstElementChild;
  }

  // Иконка для эмодзи-реакции (если есть в карте — рисуем SVG, иначе сам эмодзи)
  function reactionMarkup(emoji, extraClass) {
    const name = REACTION_ICONS[emoji];
    if (!name) return '<span class="mq-emoji">' + String(emoji).replace(/[<>&]/g, '') + '</span>';
    return svg(name, { className: 'mq-icon--reaction ' + (extraClass || '') });
  }

  const Icons = {
    svg,
    el,
    buildSprite,
    reactionMarkup,
    iconifyTextNode,
    iconifyRoot,
    startIconify,
    PATHS,
    REACTION_ICONS,
    EMOJI_ICONS,
    STICKERS,
    SPRITE_ID
  };

  if (typeof window !== 'undefined') {
    window.Icons = Icons;
    if (document.body) {
      buildSprite();
      startIconify();
    } else {
      document.addEventListener('DOMContentLoaded', () => {
        buildSprite();
        startIconify();
      });
    }
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      PATHS,
      REACTION_ICONS,
      EMOJI_ICONS,
      STICKERS,
      SPRITE_ID,
      svg,
      el,
      reactionMarkup,
      iconifyTextNode,
      iconifyRoot
    };
  }
})();
