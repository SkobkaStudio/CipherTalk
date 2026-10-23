/* =========================================================
   CipherTalk Cursor — кастомная векторная стрелка.
   Внешний файл (CSP: script-src 'self'), без inline-кода.

   Сами курсоры (SVG-стрелка и «рука» в цвет каждой темы)
   нарисованы в cursor.css. Здесь только логика:
     - включение/выключение через html[data-custom-cursor];
     - на устройствах без мыши (pointer: coarse/none) курсор
       всегда системный;
     - настройка хранится в appearance.customCursor (app.js),
       значение приходит через Cursor.setEnabled().
   ========================================================= */
(function (global) {
  'use strict';

  var doc = global.document;
  if (!doc || !doc.documentElement) return;
  var root = doc.documentElement;

  // Желаемое состояние (из настроек пользователя). По умолчанию включено.
  var desired = true;

  function mq(query) {
    try { return global.matchMedia ? global.matchMedia(query) : null; } catch (e) { return null; }
  }

  /**
   * Есть ли у устройства настоящий указатель. Некоторые окружения
   * (headless, тач-планшет с мышью) указывают primary pointer неверно,
   * поэтому смотрим и на любой точный указатель в системе.
   */
  function pointerFine() {
    var anyFine = mq('(any-pointer: fine)') || mq('(any-hover: hover)');
    if (anyFine && anyFine.matches) return true;
    var coarse = mq('(pointer: coarse)');
    if (coarse && coarse.matches) return false;
    var none = mq('(pointer: none)');
    if (none && none.matches) return false;
    var fine = mq('(pointer: fine)');
    if (fine && fine.matches) return true;
    var touch = false;
    try {
      touch = ('ontouchstart' in global) ||
        (global.navigator && global.navigator.maxTouchPoints > 0);
    } catch (e) { touch = false; }
    return !touch;
  }

  function apply() {
    var active = desired && pointerFine();
    root.setAttribute('data-custom-cursor', active ? 'on' : 'off');
    return active;
  }

  var Cursor = {
    /**
     * Включает/выключает кастомный курсор (из настроек).
     * На тач-устройствах атрибут всё равно станет "off".
     */
    setEnabled: function (on) {
      desired = on !== false;
      return apply();
    },

    isEnabled: function () {
      return root.getAttribute('data-custom-cursor') === 'on';
    },

    pointerFine: pointerFine,

    /** Переприменяет состояние (например, при смене типа указателя). */
    sync: apply,

    init: function () {
      apply();
      var pm = mq('(pointer: fine)');
      if (pm && pm.addEventListener) {
        pm.addEventListener('change', function () { apply(); });
      }
      var pc = mq('(pointer: coarse)');
      if (pc && pc.addEventListener) {
        pc.addEventListener('change', function () { apply(); });
      }
      return Cursor;
    }
  };

  Cursor.init();

  global.Cursor = Cursor;
})(window);
