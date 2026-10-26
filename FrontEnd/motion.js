/* =========================================================
   CipherTalk Motion System — движок анимаций
   Внешний файл (CSP: script-src 'self'), без inline-кода.
   API: Motion.init(), Motion.ripple(), Motion.stagger(),
        Motion.reveal(), Motion.withTransition(), Motion.pulse()
   ========================================================= */
(function (global) {
  'use strict';

  var Motion = {
    enabled: true,
    reduced: false,
    level: 'normal'
  };

  function prefersReduced() {
    try {
      return global.matchMedia && global.matchMedia('(prefers-reduced-motion: reduce)').matches;
    } catch (e) {
      return false;
    }
  }

  Motion.init = function () {
    Motion.reduced = prefersReduced();
    Motion.syncLevel();

    if (!Motion.enabled) return Motion;

    // Ripple по нажатию
    document.addEventListener('pointerdown', onPointerDown, { passive: true });
    // Наблюдатель для «появления» элементов
    Motion._revealObserver = createRevealObserver();

    // Пересчёт уровня анимаций при смене настроек
    var mo = global.MutationObserver ? new MutationObserver(function () {
      Motion.syncLevel();
    }) : null;
    if (mo && document.documentElement) {
      mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-anim'] });
    }

    return Motion;
  };

  // Уровень анимаций берётся из html[data-anim]: off | normal | full
  Motion.syncLevel = function () {
    var html = document.documentElement;
    var level = (html && html.getAttribute('data-anim')) || 'normal';
    Motion.level = level;
    Motion.enabled = level !== 'off' && !Motion.reduced;
    document.documentElement.classList.toggle('mq-reduced', Motion.reduced);
  };

  Motion.setReduced = function (value) {
    Motion.reduced = !!value;
    Motion.syncLevel();
  };

  /* ---------------- Ripple ---------------- */
  function onPointerDown(ev) {
    if (!Motion.enabled) return;
    var el = ev.target;
    while (el && el !== document.body) {
      if (el.matches && el.matches('.mq-press, .chat-item, .menu-btn, button, .anim-chip, .send-btn, .attach-btn')) break;
      el = el.parentNode;
    }
    if (!el || el === document.body) return;
    Motion.ripple(el, ev);
  }

  Motion.ripple = function (el, ev) {
    if (!el || !Motion.enabled) return;
    if (!el.classList.contains('mq-ripple-host')) el.classList.add('mq-ripple-host');
    var rect = el.getBoundingClientRect ? el.getBoundingClientRect() : { width: 40, height: 40, left: 0, top: 0 };
    var size = Math.max(rect.width, rect.height) * 1.6;
    var ripple = document.createElement('span');
    ripple.className = 'mq-ripple';
    var x = ev && ev.clientX !== undefined ? ev.clientX - rect.left : rect.width / 2;
    var y = ev && ev.clientY !== undefined ? ev.clientY - rect.top : rect.height / 2;
    ripple.style.width = size + 'px';
    ripple.style.height = size + 'px';
    ripple.style.left = (x - size / 2) + 'px';
    ripple.style.top = (y - size / 2) + 'px';
    el.appendChild(ripple);
    setTimeout(function () {
      if (ripple.remove) ripple.remove();
      else if (ripple.parentNode) ripple.parentNode.removeChild(ripple);
    }, 460);
  };

  /* ---------------- Stagger ---------------- */
  Motion.stagger = function (container, opts) {
    if (!container || !Motion.enabled) return;
    var options = opts || {};
    var max = options.max || 24;
    var step = options.step || 1;
    var children = container.children || [];
    for (var i = 0; i < children.length; i++) {
      var idx = Math.floor(i / (step || 1));
      children[i].style.setProperty('--mq-i', Math.min(idx, max));
    }
    container.classList.add(options.fast ? 'mq-stagger-fast' : 'mq-stagger');
  };

  Motion.clearStagger = function (container) {
    if (!container) return;
    container.classList.remove('mq-stagger', 'mq-stagger-fast');
    var children = container.children || [];
    for (var i = 0; i < children.length; i++) {
      children[i].style.removeProperty('--mq-i');
    }
  };

  /* ---------------- Reveal при появлении в зоне видимости ---------------- */
  function createRevealObserver() {
    if (!global.IntersectionObserver) return null;
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          entry.target.classList.add('in-view');
          io.unobserve(entry.target);
        }
      });
    }, { threshold: 0.05, rootMargin: '0px 0px -40px 0px' });
    return io;
  }

  Motion.reveal = function (el) {
    if (!el) return;
    if (!Motion._revealObserver || !Motion.enabled) {
      el.classList.add('in-view');
      return;
    }
    el.classList.add('mq-reveal');
    Motion._revealObserver.observe(el);
  };

  /* ---------------- Переходы темы (View Transitions API) ---------------- */
  Motion.withTransition = function (update) {
    if (typeof update !== 'function') return;
    if (!Motion.enabled || typeof document.startViewTransition !== 'function') {
      update();
      return;
    }
    document.documentElement.classList.add('theme-anim');
    var vt = document.startViewTransition(function () { update(); });
    var done = function () { document.documentElement.classList.remove('theme-anim'); };
    if (vt && vt.finished && vt.finished.then) vt.finished.then(done, done);
    else done();
  };

  /* ---------------- Импульсные эффекты ---------------- */
  Motion.pulse = function (el, className) {
    if (!el || !Motion.enabled) return;
    var cls = className || 'mq-flash';
    el.classList.remove(cls);
    // reflow — чтобы анимация перезапустилась
    void el.offsetWidth;
    el.classList.add(cls);
    setTimeout(function () { el.classList.remove(cls); }, 460);
  };

  Motion.shake = function (el) {
    Motion.pulse(el, 'mq-shake');
  };

  /* ---------------- Скелетоны ---------------- */
  Motion.skeleton = function (container, opts) {
    if (!container) return;
    var options = opts || {};
    var rows = options.rows || 6;
    container.innerHTML = '';
    for (var i = 0; i < rows; i++) {
      var wrap = document.createElement('div');
      wrap.className = 'mq-skeleton-wrap';
      var bubble = document.createElement('div');
      bubble.className = 'mq-skeleton mq-skeleton-bubble';
      bubble.style.width = (48 + (i % 3) * 16) + '%';
      if (i % 2) bubble.style.marginLeft = 'auto';
      var line = document.createElement('div');
      line.className = 'mq-skeleton mq-skeleton-line';
      line.style.width = '70%';
      wrap.appendChild(bubble);
      wrap.appendChild(line);
      container.appendChild(wrap);
    }
  };

  Motion.clearSkeleton = function (container) {
    if (container) container.innerHTML = '';
  };

  /* ---------------- Плавное обновление чисел ---------------- */
  Motion.countUp = function (el, to, dur) {
    if (!el) return;
    if (!Motion.enabled) { el.textContent = String(to); return; }
    var from = parseInt(String(el.textContent).replace(/\D/g, ''), 10) || 0;
    var duration = dur || 420;
    var start = null;
    function step(ts) {
      if (start === null) start = ts;
      var p = Math.min(1, (ts - start) / duration);
      var eased = 1 - Math.pow(1 - p, 3);
      el.textContent = String(Math.round(from + (to - from) * eased));
      if (p < 1 && global.requestAnimationFrame) global.requestAnimationFrame(step);
    }
    if (global.requestAnimationFrame) global.requestAnimationFrame(step);
    else el.textContent = String(to);
  };

  /* ---------------- Перезапуск CSS-анимации ---------------- */
  Motion.restart = function (el, className) {
    if (!el) return;
    var cls = className || 'mq-bubble-in';
    el.classList.remove(cls);
    void el.offsetWidth;
    el.classList.add(cls);
  };

  global.Motion = Motion;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { Motion.init(); });
  } else {
    Motion.init();
  }
})(window);
