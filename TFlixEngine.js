/**
 * TFlixEngine v1.2.0 — Robust edition
 * Spatial navigation for cineby.at / cineby.gd
 * TizenBrew module + desktop testing
 */

(function () {
  'use strict';

  const FOCUS_CLASS = 'tflix-focus';
  const KEY_THROTTLE_MS = 100;
  const MUTATION_DEBOUNCE_MS = 200;
  const RECOVERY_INTERVAL_MS = 280;
  const CROSS_AXIS_WEIGHT = 2.3;

  const KEYCODES = Object.freeze({
    LEFT: 37, UP: 38, RIGHT: 39, DOWN: 40,
    ENTER: 13, TIZEN_OK: 29443,
    BACK: 8, ESCAPE: 27, TIZEN_BACK: 10009,
    PLAY_PAUSE: 10252, PLAY: 415, PAUSE: 19,
    STOP: 413, FF: 417, RW: 412,
  });

  const DPAD_KEYS = new Set([KEYCODES.LEFT, KEYCODES.UP, KEYCODES.RIGHT, KEYCODES.DOWN]);
  const SELECT_KEYS = new Set([KEYCODES.ENTER, KEYCODES.TIZEN_OK]);
  const BACK_KEYS = new Set([KEYCODES.BACK, KEYCODES.ESCAPE, KEYCODES.TIZEN_BACK]);

  const DIRECTION_MAP = {
    [KEYCODES.LEFT]: 'left',
    [KEYCODES.UP]: 'up',
    [KEYCODES.RIGHT]: 'right',
    [KEYCODES.DOWN]: 'down',
  };

  const NAV_SELECTORS = [
    'a[href*="/movie/"]',
    'a[href*="/tv/"]',
    'a[href*="/anime/"]',
    'a[href*="/watch/"]',
    'a[href*="/search"]',
    'a[href]',
    'button:not([disabled])',
    'input:not([disabled])',
    'select:not([disabled])',
    '[role="button"]',
    '[role="link"]',
    '[role="menuitem"]',
    '[role="tab"]',
    '[tabindex]:not([tabindex="-1"])',
    '[data-tflix-nav]',
    '[onclick]',
    '[class*="card"]',
    '[class*="poster"]',
    '[class*="item"]',
    '[class*="tile"]',
    '[class*="thumbnail"]',
    '[class*="slide"]',
    'video',
  ].join(', ');


  class TFlixEngine {
    constructor() {
      this._focused = null;
      this._activeModal = null;
      this._observer = null;
      this._lastKeyTime = 0;
      this._initialized = false;
      this._mutationTimer = null;
      this._lastPathname = location.pathname;
      this._recoveryInterval = null;
      this._debug = false;
      this._markTimer = null;
    }

    // ── Public ───────────────────────────────────────────────────

    init() {
      if (this._initialized) return;
      this._initialized = true;

      this._injectStyles();
      this._registerTizenKeys();
      this._attachKeyHandler();
      this._startMutationObserver();
      this._startFocusRecoveryLoop();
      this._hookRouting();
      this._markAllCandidates();           // initial pass

      // Multiple delayed focus attempts (Next.js is slow)
      [500, 1200, 2200, 4000].forEach(ms => {
        setTimeout(() => this._acquireInitialFocus(), ms);
      });

      console.log('%c[TFlixEngine] v1.2.0 ready', 'color:#00E5FF;font-weight:bold');
    }

    destroy() {
      if (!this._initialized) return;
      window.removeEventListener('keydown', this._onKeyDown, true);
      if (this._observer) this._observer.disconnect();
      if (this._recoveryInterval) clearInterval(this._recoveryInterval);
      clearTimeout(this._markTimer);
      this._clearFocus();
      const style = document.getElementById('tflix-engine-styles');
      if (style) style.remove();
      const debug = document.getElementById('tflix-debug');
      if (debug) debug.remove();
      this._initialized = false;
    }

    toggleDebug() {
      this._debug = !this._debug;
      const el = document.getElementById('tflix-debug');
      if (el) el.style.display = this._debug ? 'block' : 'none';
      this._updateDebug();
    }

    // ── Styles ───────────────────────────────────────────────────

    _injectStyles() {
      if (document.getElementById('tflix-engine-styles')) return;

      const style = document.createElement('style');
      style.id = 'tflix-engine-styles';
      style.textContent = `
        .${FOCUS_CLASS} {
          outline: 5px solid #00E5FF !important;
          outline-offset: 3px !important;
          box-shadow: 0 0 0 4px rgba(0,229,255,0.30) !important;
          z-index: 999999 !important;
          position: relative !important;
          transition: outline-color 0.12s ease, transform 0.12s ease !important;
          transform: scale(1.04) !important;
        }
        .${FOCUS_CLASS}--pulse {
          animation: tflix-pulse 0.5s ease-in-out 1 !important;
        }
        @keyframes tflix-pulse {
          0%,100% { outline-color: #00E5FF; }
          50%     { outline-color: #76FF03; }
        }
        *:focus { outline: none !important; }

        #tflix-debug {
          position: fixed;
          bottom: 16px;
          right: 16px;
          background: rgba(0,0,0,0.85);
          color: #00E5FF;
          font: 12px/1.45 monospace;
          padding: 10px 14px;
          border-radius: 8px;
          z-index: 9999999;
          pointer-events: none;
          max-width: 380px;
          display: none;
          white-space: pre-wrap;
        }
      `;
      document.head.appendChild(style);

      const debug = document.createElement('div');
      debug.id = 'tflix-debug';
      document.body.appendChild(debug);
    }

    // ── Tizen ────────────────────────────────────────────────────

    _registerTizenKeys() {
      try {
        const api = window.tizen && window.tizen.tvinputdevice;
        if (!api || typeof api.registerKey !== 'function') return;

        const keys = [
          'Left','Up','Right','Down','Enter','Return',
          'MediaPlayPause','MediaPlay','MediaPause','MediaStop',
          'MediaFastForward','MediaRewind',
          'ColorF0Red','ColorF1Green','ColorF2Yellow','ColorF3Blue',
          'ChannelUp','ChannelDown','Info'
        ];
        const supported = api.getSupportedKeys().map(k => k.name);
        keys.forEach(k => {
          if (supported.includes(k)) {
            try { api.registerKey(k); } catch (_) {}
          }
        });
      } catch (_) {}
    }

    // ── Keys ─────────────────────────────────────────────────────

    _attachKeyHandler() {
      this._onKeyDown = this._handleKeyDown.bind(this);
      window.addEventListener('keydown', this._onKeyDown, { capture: true });
    }

    _handleKeyDown(e) {
      const code = e.keyCode || e.which;

      // Yellow key or F9 → debug
      if (code === 405 || code === 120) {
        e.preventDefault();
        this.toggleDebug();
        return;
      }

      if (DPAD_KEYS.has(code)) {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();

        const now = Date.now();
        if (now - this._lastKeyTime < KEY_THROTTLE_MS) return;
        this._lastKeyTime = now;

        this._navigate(DIRECTION_MAP[code]);
        return;
      }

      if (SELECT_KEYS.has(code)) {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        this._activateFocused();
        return;
      }

      if (BACK_KEYS.has(code)) {
        if (this._activeModal) {
          e.preventDefault();
          this._dismissModal();
          return;
        }
        if (this._focused && (this._focused.tagName === 'INPUT' || this._focused.tagName === 'TEXTAREA')) {
          e.preventDefault();
          this._focused.blur();
          return;
        }
        if (location.pathname.includes('/watch/')) {
          e.preventDefault();
          history.back();
          return;
        }
        return;
      }

      this._handleMediaKey(code, e);
    }

    _handleMediaKey(code, e) {
      const video = document.querySelector('video');
      if (!video) return false;

      switch (code) {
        case KEYCODES.PLAY_PAUSE:
          e.preventDefault();
          video.paused ? video.play() : video.pause();
          return true;
        case KEYCODES.PLAY:
          e.preventDefault(); video.play(); return true;
        case KEYCODES.PAUSE:
          e.preventDefault(); video.pause(); return true;
        case KEYCODES.STOP:
          e.preventDefault();
          video.pause();
          video.currentTime = 0;
          return true;
        case KEYCODES.FF:
          e.preventDefault();
          video.currentTime = Math.min(video.duration || 99999, video.currentTime + 10);
          return true;
        case KEYCODES.RW:
          e.preventDefault();
          video.currentTime = Math.max(0, video.currentTime - 10);
          return true;
      }
      return false;
    }

    // ── Navigation ───────────────────────────────────────────────

    _navigate(direction) {
      // Always re-mark in case new cards appeared
      this._markAllCandidates();

      if (!this._focused || !this._isAttached(this._focused) || !this._isVisible(this._focused)) {
        this._recoverFocus(direction);
        return;
      }

      // Re-apply class if Next.js stripped it
      if (!this._focused.classList.contains(FOCUS_CLASS)) {
        this._focused.classList.add(FOCUS_CLASS);
      }

      const candidates = this._getCandidates();
      if (!candidates.length) return;

      const origin = this._getCenter(this._focused);
      const best = this._findBestCandidate(origin, candidates, direction);

      if (best) this._setFocus(best);
      this._updateDebug();
    }

    _getCandidates() {
      const root = this._activeModal || document;
      const nodes = root.querySelectorAll(NAV_SELECTORS);
      const list = [];

      for (const el of nodes) {
        if (el === this._focused) continue;
        if (!this._isVisible(el) || !this._isInteractable(el)) continue;
        list.push(el);
      }
      return list;
    }

    _markAllCandidates() {
      const nodes = document.querySelectorAll(NAV_SELECTORS);
      for (const el of nodes) {
        if (!this._isVisible(el) || !this._isInteractable(el)) continue;
        if (!el.hasAttribute('tabindex') || el.getAttribute('tabindex') === '-1') {
          el.setAttribute('tabindex', '0');
        }
        el.setAttribute('data-tflix-nav', '1');
      }
    }

    _getCenter(el) {
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2, rect: r };
    }

    _findBestCandidate(origin, candidates, direction) {
      let best = null;
      let bestScore = Infinity;

      for (const el of candidates) {
        const c = this._getCenter(el);
        const dx = c.x - origin.x;
        const dy = c.y - origin.y;

        let main, cross, ok;
        switch (direction) {
          case 'left':  ok = dx < -8; main = Math.abs(dx); cross = Math.abs(dy); break;
          case 'right': ok = dx >  8; main = Math.abs(dx); cross = Math.abs(dy); break;
          case 'up':    ok = dy < -8; main = Math.abs(dy); cross = Math.abs(dx); break;
          case 'down':  ok = dy >  8; main = Math.abs(dy); cross = Math.abs(dx); break;
        }
        if (!ok) continue;

        const score = main + cross * CROSS_AXIS_WEIGHT;
        if (score < bestScore) {
          bestScore = score;
          best = el;
        }
      }
      return best;
    }

    // ── Focus ────────────────────────────────────────────────────

    _setFocus(el, pulse = false) {
      if (!el) return;
      this._clearFocus();

      el.classList.add(FOCUS_CLASS);
      if (pulse) {
        el.classList.add(`${FOCUS_CLASS}--pulse`);
        setTimeout(() => el.classList.remove(`${FOCUS_CLASS}--pulse`), 550);
      }

      try { el.focus({ preventScroll: true }); } catch (_) {}

      this._scrollIntoView(el);
      this._focused = el;
      this._updateDebug();
    }

    _clearFocus() {
      if (this._focused) {
        this._focused.classList.remove(FOCUS_CLASS, `${FOCUS_CLASS}--pulse`);
      }
      document.querySelectorAll(`.${FOCUS_CLASS}`).forEach(el => {
        el.classList.remove(FOCUS_CLASS, `${FOCUS_CLASS}--pulse`);
      });
    }

    _activateFocused() {
      if (!this._focused || !this._isAttached(this._focused)) {
        this._recoverFocus('down');
        return;
      }

      const el = this._focused;

      if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') {
        el.focus();
        el.click();
        return;
      }

      if (el.tagName === 'VIDEO') {
        el.paused ? el.play() : el.pause();
        return;
      }

      el.click();
      try {
        el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
      } catch (_) {}
    }

    _recoverFocus(direction = 'down') {
      this._markAllCandidates();
      const candidates = this._getCandidates();
      if (!candidates.length) return;

      const scored = candidates.map(el => {
        const r = el.getBoundingClientRect();
        return { el, x: r.left + r.width / 2, y: r.top + r.height / 2 };
      });

      scored.sort((a, b) => {
        switch (direction) {
          case 'up':    return b.y - a.y || a.x - b.x;
          case 'left':  return a.x - b.x || a.y - b.y;
          case 'right': return b.x - a.x || a.y - b.y;
          default:      return a.y - b.y || a.x - b.x;
        }
      });

      const inView = scored.find(s =>
        s.y > 30 && s.y < innerHeight - 30 &&
        s.x > 15 && s.x < innerWidth - 15
      );

      this._setFocus((inView || scored[0]).el, true);
    }

    _acquireInitialFocus() {
      if (this._activeModal) {
        this._recoverFocusInModal();
        return;
      }

      this._markAllCandidates();

      const priority = [
        'a[href*="/movie/"]',
        'a[href*="/tv/"]',
        'a[href*="/anime/"]',
        'a[href*="/watch/"]',
        '[data-tflix-nav]',
        'input[type="search"]',
        'input[type="text"]',
      ];

      for (const sel of priority) {
        for (const el of document.querySelectorAll(sel)) {
          if (this._isVisible(el) && this._isInteractable(el)) {
            this._setFocus(el, true);
            return;
          }
        }
      }

      this._recoverFocus('down');
    }

    _recoverFocusInModal() {
      if (!this._activeModal) return;
      const nodes = this._activeModal.querySelectorAll(NAV_SELECTORS);
      for (const el of nodes) {
        if (this._isVisible(el) && this._isInteractable(el)) {
          this._setFocus(el, true);
          return;
        }
      }
    }

    // ── Recovery & routing ───────────────────────────────────────

    _startFocusRecoveryLoop() {
      this._recoveryInterval = setInterval(() => {
        // Route change
        if (location.pathname !== this._lastPathname) {
          this._lastPathname = location.pathname;
          this._clearFocus();
          this._focused = null;
          this._activeModal = null;
          setTimeout(() => this._acquireInitialFocus(), 450);
          return;
        }

        // Focus was destroyed by React
        if (this._focused) {
          if (!this._isAttached(this._focused) || !this._isVisible(this._focused)) {
            this._clearFocus();
            this._focused = null;
          } else if (!this._focused.classList.contains(FOCUS_CLASS)) {
            // Class was stripped – put it back
            this._focused.classList.add(FOCUS_CLASS);
          }
        }
      }, RECOVERY_INTERVAL_MS);
    }

    _hookRouting() {
      const self = this;
      const wrap = (original) => function (...args) {
        const result = original.apply(this, args);
        self._onRouteChange();
        return result;
      };
      history.pushState = wrap(history.pushState);
      history.replaceState = wrap(history.replaceState);
      window.addEventListener('popstate', () => this._onRouteChange());
    }

    _onRouteChange() {
      this._clearFocus();
      this._focused = null;
      this._activeModal = null;
      this._lastPathname = location.pathname;
      setTimeout(() => this._acquireInitialFocus(), 550);
      setTimeout(() => this._acquireInitialFocus(), 1400);
    }

    // ── Mutation observer ────────────────────────────────────────

    _startMutationObserver() {
      this._observer = new MutationObserver(() => {
        clearTimeout(this._mutationTimer);
        this._mutationTimer = setTimeout(() => {
          this._markAllCandidates();   // keep new cards focusable
          this._scanForModals();
        }, MUTATION_DEBOUNCE_MS);
      });

      this._observer.observe(document.body, {
        childList: true,
        subtree: true,
      });
    }

    _scanForModals() {
      if (this._activeModal) {
        if (!this._isAttached(this._activeModal) || !this._isVisible(this._activeModal)) {
          this._activeModal = null;
          this._acquireInitialFocus();
        }
        return;
      }

      const candidates = document.querySelectorAll(
        '[role="dialog"], [role="alertdialog"], [class*="modal"], [class*="overlay"], ' +
        '[class*="popup"], [id*="turnstile"], [class*="captcha"], ' +
        'iframe[src*="turnstile"], iframe[src*="captcha"]'
      );

      for (const el of candidates) {
        if (this._isVisible(el) && this._looksLikeModal(el)) {
          this._trapModal(el);
          return;
        }
      }
    }

    _looksLikeModal(el) {
      const style = getComputedStyle(el);
      const isOverlay = style.position === 'fixed' || style.position === 'absolute';
      const big = el.offsetWidth > 120 && el.offsetHeight > 120;
      const text = (el.textContent || '').toLowerCase();
      const keywords = ['robot', 'confirm', 'verify', 'captcha', 'challenge', 'turnstile'];
      const hasKeyword = keywords.some(k => text.includes(k));
      const attrs = ((el.className || '') + ' ' + (el.id || '')).toLowerCase();
      const hasAttr = /modal|dialog|overlay|captcha|turnstile|challenge/.test(attrs);
      return isOverlay && big && (hasKeyword || hasAttr);
    }

    _trapModal(el) {
      if (this._activeModal === el) return;
      this._activeModal = el;
      this._clearFocus();
      this._focused = null;
      setTimeout(() => this._recoverFocusInModal(), 160);
    }

    _dismissModal() {
      if (!this._activeModal) return;
      const close = this._activeModal.querySelector(
        '[aria-label*="close" i], [aria-label*="Close"], button[class*="close"], .close, [data-dismiss]'
      );
      if (close) close.click();
      this._activeModal = null;
      this._clearFocus();
      this._focused = null;
      setTimeout(() => this._acquireInitialFocus(), 280);
    }

    // ── Utilities ────────────────────────────────────────────────

    _isAttached(el) {
      return el && document.body.contains(el);
    }

    _isVisible(el) {
      if (!el || !el.getBoundingClientRect) return false;
      const r = el.getBoundingClientRect();
      if (r.width < 6 || r.height < 6) return false;
      const s = getComputedStyle(el);
      if (s.display === 'none' || s.visibility === 'hidden' || parseFloat(s.opacity) === 0) return false;
      if (el.getAttribute('aria-hidden') === 'true') return false;
      return true;
    }

    _isInteractable(el) {
      if (el.disabled || el.getAttribute('aria-disabled') === 'true') return false;
      return true;
    }

    _scrollIntoView(el) {
      try {
        el.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' });
      } catch (_) {
        const r = el.getBoundingClientRect();
        scrollTo({ top: scrollY + r.top - innerHeight / 2 + r.height / 2, behavior: 'smooth' });
      }
      this._scrollParents(el);
    }

    _scrollParents(el) {
      let parent = el.parentElement;
      let depth = 0;
      while (parent && parent !== document.body && depth < 12) {
        const s = getComputedStyle(parent);
        const canX = (s.overflowX === 'auto' || s.overflowX === 'scroll') && parent.scrollWidth > parent.clientWidth;
        const canY = (s.overflowY === 'auto' || s.overflowY === 'scroll') && parent.scrollHeight > parent.clientHeight;

        if (canX || canY) {
          const pr = parent.getBoundingClientRect();
          const er = el.getBoundingClientRect();
          if (canX) {
            parent.scrollTo({
              left: parent.scrollLeft + (er.left - pr.left) - pr.width / 2 + er.width / 2,
              behavior: 'smooth'
            });
          }
          if (canY) {
            parent.scrollTo({
              top: parent.scrollTop + (er.top - pr.top) - pr.height / 2 + er.height / 2,
              behavior: 'smooth'
            });
          }
        }
        parent = parent.parentElement;
        depth++;
      }
    }

    _updateDebug() {
      if (!this._debug) return;
      const el = document.getElementById('tflix-debug');
      if (!el) return;
      const f = this._focused;
      el.textContent =
        `Focused: ${f ? f.tagName + (f.className ? '.' + String(f.className).split(' ')[0] : '') : 'none'}\n` +
        `Path: ${location.pathname}\n` +
        `Candidates: ${this._getCandidates().length}\n` +
        `Modal: ${this._activeModal ? 'yes' : 'no'}`;
    }
  }

  // ── Boot ───────────────────────────────────────────────────────

  const engine = new TFlixEngine();
  window.TFlixEngine = engine;

  function boot() {
    if (document.readyState === 'complete' || document.readyState === 'interactive') {
      engine.init();
    } else {
      document.addEventListener('DOMContentLoaded', () => engine.init());
    }
  }

  boot();
})();