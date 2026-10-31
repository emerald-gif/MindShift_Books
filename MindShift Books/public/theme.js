/* ═══════════════════════════════════════════════════════════════════════
   MindShift Books — theme.js  (dark / light / system)
   Load as the FIRST script in <head>, as a plain blocking script, so the right theme is on <html>
   before the first paint (no white flash). Everything else is in /theme.css.

   The saved choice is 'system' | 'light' | 'dark' (default 'system' = follow the phone).
   Pages never need their own dark-mode code: they use the shared colour variables, and this file just
   flips   <html data-theme="dark|light">   and tells the browser (color-scheme + theme-color bar).

   API (for the Settings page and the sidebar):
     MSBTheme.get()        -> 'system' | 'light' | 'dark'   (what the person chose)
     MSBTheme.resolved()   -> 'light' | 'dark'              (what is actually showing)
     MSBTheme.set(choice)  -> saves, applies, and fires a 'msb-theme' event on window
   ═══════════════════════════════════════════════════════════════════════ */
(function () {
  var KEY = 'msb_theme';
  var BAR = { light: '#ffffff', dark: '#0f1217' };
  var mq = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;

  function read() {
    try { var v = localStorage.getItem(KEY); return (v === 'light' || v === 'dark') ? v : 'system'; }
    catch (e) { return 'system'; }
  }
  function resolve(choice) {
    if (choice === 'light' || choice === 'dark') return choice;
    return (mq && mq.matches) ? 'dark' : 'light';
  }
  function apply() {
    var t = resolve(read());
    var root = document.documentElement;
    root.setAttribute('data-theme', t);
    root.style.colorScheme = t;                       // native inputs, scrollbars, overscroll
    var m = document.querySelector('meta[name="theme-color"]');
    if (!m) { m = document.createElement('meta'); m.name = 'theme-color'; document.head.appendChild(m); }
    m.setAttribute('content', BAR[t]);                // phone's top bar colour
    return t;
  }

  apply();

  // follow the phone while the choice is 'system'
  if (mq) {
    var onSys = function () { if (read() === 'system') { apply(); fire(); } };
    if (mq.addEventListener) mq.addEventListener('change', onSys); else if (mq.addListener) mq.addListener(onSys);
  }
  // another open tab changed it
  window.addEventListener('storage', function (e) { if (e.key === KEY) { apply(); fire(); } });

  function fire() {
    try { window.dispatchEvent(new CustomEvent('msb-theme', { detail: { choice: read(), resolved: resolve(read()) } })); } catch (e) {}
  }

  window.MSBTheme = {
    get: read,
    resolved: function () { return resolve(read()); },
    set: function (choice) {
      if (choice !== 'light' && choice !== 'dark') choice = 'system';
      try { if (choice === 'system') localStorage.removeItem(KEY); else localStorage.setItem(KEY, choice); } catch (e) {}
      var root = document.documentElement;
      root.classList.add('msb-theme-anim');                 // cross-fade only for a deliberate switch
      apply(); fire();
      setTimeout(function () { root.classList.remove('msb-theme-anim'); }, 420);
    }
  };
})();

/* ═══════════════════════════════════════════════════════════════════════
   AVATAR FALLBACK (same file so every page gets it, nothing to wire up per page)
   A missing or broken profile picture used to show the browser's broken-image icon + alt text.
   Now it shows the person's initials on a colour picked from their name — the same person is always the
   same colour everywhere in the app.

   What counts as an avatar:  <img data-author-photo>, or a small round picture (≤ 200px, circular).
   Initials come from  data-name → alt → the name text next to the picture → otherwise a neutral person icon.
   If the real picture loads later (e.g. a live profile update), the initials step aside automatically.
   ═══════════════════════════════════════════════════════════════════════ */
(function () {
  var PALETTE = [
    ['#4f46e5', '#06b6d4'], ['#7c3aed', '#ec4899'], ['#f97316', '#f43f5e'], ['#059669', '#22d3ee'], ['#2563eb', '#7c3aed'],
    ['#db2777', '#f59e0b'], ['#0891b2', '#4f46e5'], ['#65a30d', '#10b981'], ['#e11d48', '#7c3aed'], ['#d97706', '#ef4444']
  ];
  var GENERIC = /^(author|user|logo|image|photo|avatar|profile|profile photo|profile picture|mindshift books user)$/i;
  var ICON = '<svg viewBox="0 0 24 24" width="55%" height="55%" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="8.5" r="3.6"/><path d="M4.8 20c.9-3.6 3.8-5.4 7.2-5.4s6.3 1.8 7.2 5.4"/></svg>';

  function hash(str) { var h = 5381; for (var i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0; return Math.abs(h); }
  function initialsOf(name) {
    var words = String(name || '').replace(/[^\p{L}\p{N}\s'-]/gu, ' ').trim().split(/\s+/).filter(Boolean);
    if (!words.length) return '';
    var a = Array.from(words[0])[0] || '';
    var b = words.length > 1 ? (Array.from(words[words.length - 1])[0] || '') : '';
    return (a + b).toUpperCase();
  }
  function nameFor(img) {
    var n = img.getAttribute('data-name') || (img.parentElement && img.parentElement.getAttribute('data-name')) || img.getAttribute('alt') || img.getAttribute('title') || '';
    n = String(n).trim();
    if (n && !GENERIC.test(n)) return n;
    // the name written next to the picture, if any. Only inside a row that holds just this one picture,
    // so a list of many people can never lend its names to the wrong face.
    var row = img.parentElement, tries = 0;
    while (row && tries < 2) {
      if (row.querySelectorAll('img').length === 1) {
        var el = row.querySelector('[class*="name"],[class*="author"] b,[class*="author"] strong');
        if (el && !el.contains(img)) { var t = (el.textContent || '').trim(); if (t.length > 0 && t.length <= 60 && !GENERIC.test(t)) return t; }
      }
      row = row.parentElement; tries++;
    }
    return '';
  }
  function isAvatar(img) {
    if (img.hasAttribute('data-author-photo')) return true;
    var r = img.getBoundingClientRect(), w = r.width || img.width || 0, h = r.height || img.height || 0;
    if (!w || !h || Math.max(w, h) > 200 || Math.min(w, h) < 14) return false;
    var round = function (el) {
      var cs = getComputedStyle(el), br = parseFloat(cs.borderTopLeftRadius) || 0;
      return /%/.test(cs.borderTopLeftRadius) ? br >= 40 : br >= Math.min(w, h) * 0.4;
    };
    return round(img) || (img.parentElement && round(img.parentElement) && getComputedStyle(img.parentElement).overflow !== 'visible');
  }
  var styled = false;
  function addStyle() {
    if (styled) return; styled = true;
    var st = document.createElement('style');
    st.textContent = '.msb-avatar-fb{display:inline-flex;align-items:center;justify-content:center;overflow:hidden;flex-shrink:0;box-sizing:border-box;' +
      'color:#fff;font-weight:800;letter-spacing:.02em;line-height:1;text-transform:uppercase;user-select:none;-webkit-user-select:none;' +
      'font-family:inherit;box-shadow:inset 0 0 0 1px rgba(255,255,255,.16)}' +
      '.msb-avatar-fb.neutral{background:linear-gradient(135deg,#94a3b8,#64748b)!important}';
    document.head.appendChild(st);
  }
  function showFallback(img) {
    if (!img || img.dataset.msbFb === '1' || !img.parentNode) return;
    if (!isAvatar(img)) return;
    addStyle();
    var r = img.getBoundingClientRect(), cs = getComputedStyle(img);
    var size = Math.round(r.width || parseFloat(cs.width) || img.width || 36), hgt = Math.round(r.height || parseFloat(cs.height) || img.height || size);
    var name = nameFor(img), ini = initialsOf(name);
    var span = document.createElement('span');
    span.className = (img.className ? img.className + ' ' : '') + 'msb-avatar-fb' + (ini ? '' : ' neutral');
    span.setAttribute('role', 'img'); span.setAttribute('aria-label', name || 'Profile picture');
    span.style.cssText = 'width:' + size + 'px;height:' + hgt + 'px;border-radius:' + (cs.borderTopLeftRadius && cs.borderTopLeftRadius !== '0px' ? cs.borderTopLeftRadius : '50%') +
      ';font-size:' + Math.max(10, Math.round(Math.min(size, hgt) * (ini.length > 1 ? 0.38 : 0.46))) + 'px;background:linear-gradient(135deg,' +
      (function () { var p = PALETTE[hash((name || 'x').toLowerCase()) % PALETTE.length]; return p[0] + ',' + p[1]; })() + ')';
    if (ini) span.textContent = ini; else span.innerHTML = ICON;
    img.dataset.msbFb = '1'; img.style.display = 'none';
    img.parentNode.insertBefore(span, img.nextSibling);
    img._msbFb = span;
  }
  function restore(img) {          // the real picture arrived later → drop the placeholder
    if (!img._msbFb) return;
    try { img._msbFb.remove(); } catch (e) {}
    img._msbFb = null; img.dataset.msbFb = ''; img.style.display = '';
  }
  document.addEventListener('error', function (e) { var t = e.target; if (t && t.tagName === 'IMG') showFallback(t); }, true);
  document.addEventListener('load', function (e) { var t = e.target; if (t && t.tagName === 'IMG' && t.dataset && t.dataset.msbFb === '1' && t.naturalWidth > 0) restore(t); }, true);

  // pictures that had already failed before this script ran, and "no picture" cases that quietly use the site logo
  var LOGO = /(^|\/)logo\.jpg(\?|$)/i;
  function check(img) {
    if (!img || img.tagName !== 'IMG') return;
    if (img.complete && img.naturalWidth === 0 && img.getAttribute('src')) { showFallback(img); return; }
    if (img.hasAttribute('data-author-photo') && LOGO.test(img.getAttribute('src') || '')) {
      var alt = (img.getAttribute('alt') || '').trim();
      if (alt && !GENERIC.test(alt) && !/^mindshift\s*books?$/i.test(alt)) showFallback(img);   // a real person with no picture, not the official account
    }
  }
  function scan(root) { var list = (root.querySelectorAll ? root.querySelectorAll('img') : []); for (var i = 0; i < list.length; i++) check(list[i]); }
  function start() {
    scan(document);
    try {
      new MutationObserver(function (muts) {
        for (var i = 0; i < muts.length; i++) {
          var added = muts[i].addedNodes;
          for (var j = 0; j < added.length; j++) { var n = added[j]; if (n.nodeType !== 1) continue; if (n.tagName === 'IMG') check(n); else scan(n); }
        }
      }).observe(document.documentElement, { childList: true, subtree: true });
    } catch (e) {}
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();

/* ═══════════════════════════════════════════════════════════════════════
   SWIPE-TO-DISMISS for full-screen viewers (same gesture as Instagram / X / Photos)
   Drag the picture up or down: it follows your finger while the dark background fades out.
   Let go past about 110px, or flick quickly, and the viewer closes. Let go early and it springs back.
   Sideways swipes are left alone (they still move between photos), and two-finger gestures are ignored.

     MSBSwipeDismiss.attach(rootEl, { content, fade, skip, onClose })
       content  element that follows the finger (default: the first <img> / track inside root)
       fade     elements that fade while dragging (close button, counter, bottom bar …)
       skip     CSS selector for areas that must NOT start a drag (e.g. the action bar)
       onClose  called when the viewer should close
   The old viewers that share <div id="imgViewerBg"> (profile, post, article pages) are attached automatically.
   ═══════════════════════════════════════════════════════════════════════ */
(function () {
  if (window.MSBSwipeDismiss) return;
  var CLOSE_DIST = 110, FLICK_V = 0.4, FLICK_MIN = 40, AXIS_LOCK = 8;

  function parseRgba(c) {
    var m = /rgba?\(([^)]+)\)/.exec(c || ''); if (!m) return [10, 8, 20, 0.95];
    var p = m[1].split(',').map(function (x) { return parseFloat(x); });
    return [p[0] || 0, p[1] || 0, p[2] || 0, p.length > 3 ? p[3] : 1];
  }

  function attach(root, opts) {
    if (!root || root._msbSwipe) return; root._msbSwipe = true; opts = opts || {};
    try { root.style.touchAction = 'pan-x'; } catch (e) {}
    var sx = 0, sy = 0, dy = 0, mode = '', base = null, samples = [], t0 = 0, tid = 0;

    function content() { return typeof opts.content === 'function' ? opts.content() : (opts.content || root.querySelector('#imgViewerImg,#imgViewerTrack,.iv-track,img')); }
    function fades() { var f = typeof opts.fade === 'function' ? opts.fade() : (opts.fade || []); return f.filter(Boolean); }
    function apply(d, animate) {
      var c = content(); if (!c) return;
      var prog = Math.min(Math.abs(d) / (window.innerHeight * 0.45), 1);
      var tr = animate ? 'transform .22s cubic-bezier(.2,.8,.3,1),opacity .22s,background-color .22s' : 'none';
      c.style.transition = tr; c.style.willChange = 'transform';
      c.style.transform = 'translate3d(0,' + d + 'px,0) scale(' + (1 - Math.min(Math.abs(d) / 1400, 0.16)) + ')';
      root.style.transition = animate ? 'background-color .22s, opacity .2s' : 'none';
      root.style.backgroundColor = 'rgba(' + base[0] + ',' + base[1] + ',' + base[2] + ',' + (base[3] * (1 - prog)).toFixed(3) + ')';
      var o = Math.max(0, 1 - prog * 1.6);
      fades().forEach(function (e) { e.style.transition = animate ? 'opacity .2s' : 'none'; e.style.opacity = o; });
    }
    function reset() {
      var c = content(); clearTimeout(tid);
      if (c) { c.style.transition = ''; c.style.transform = ''; c.style.willChange = ''; }
      root.style.transition = ''; root.style.backgroundColor = '';
      fades().forEach(function (e) { e.style.transition = ''; e.style.opacity = ''; });
      mode = ''; dy = 0;
    }

    root.addEventListener('touchstart', function (e) {
      if (e.touches.length !== 1) { mode = 'ignore'; return; }
      if (opts.skip && e.target.closest && e.target.closest(opts.skip)) { mode = 'ignore'; return; }
      var t = e.touches[0]; sx = t.clientX; sy = t.clientY; t0 = Date.now(); samples = [{ y: sy, t: t0 }]; dy = 0; mode = '';
      base = parseRgba(getComputedStyle(root).backgroundColor);
    }, { passive: true });

    root.addEventListener('touchmove', function (e) {
      if (mode === 'ignore' || mode === 'h') return;
      if (e.touches.length !== 1) { if (mode === 'v') { apply(0, true); } mode = 'ignore'; return; }
      var t = e.touches[0], ddx = t.clientX - sx, ddy = t.clientY - sy;
      if (!mode) {
        if (Math.abs(ddx) < AXIS_LOCK && Math.abs(ddy) < AXIS_LOCK) return;
        mode = (Math.abs(ddy) > Math.abs(ddx) * 1.15) ? 'v' : 'h';
        if (mode === 'h') return;
      }
      e.preventDefault();
      dy = ddy;
      var now = Date.now(); samples.push({ y: t.clientY, t: now }); while (samples.length > 2 && now - samples[0].t > 120) samples.shift();
      apply(dy, false);
    }, { passive: false });

    function end() {
      if (mode !== 'v') { mode = ''; return; }
      var vel = 0, a = samples[0], z = samples[samples.length - 1];            // speed over the last ~120ms of the drag
      if (a && z && samples.length > 1) vel = (z.y - a.y) / Math.max(z.t - a.t, 16);
      var dur = Date.now() - t0;                                               // a short, quick swipe counts as a flick even if it ends slowly
      if (dur < 300) { var avg = dy / Math.max(dur, 16); if (Math.abs(avg) > Math.abs(vel)) vel = avg; }
      var far = Math.abs(dy) > CLOSE_DIST || (Math.abs(vel) > FLICK_V && Math.abs(dy) > FLICK_MIN);
      if (far) {
        var dir = (dy < 0 || (dy === 0 && vel < 0)) ? -1 : 1;
        apply(dir * window.innerHeight, true);
        tid = setTimeout(function () {
          if (opts.onClose) opts.onClose();
          setTimeout(reset, 350);                  // reset only once the viewer is fully hidden, so nothing flashes back
        }, 200);
      } else { apply(0, true); tid = setTimeout(reset, 260); }
      mode = '';
    }
    root.addEventListener('touchend', end, { passive: true });
    root.addEventListener('touchcancel', end, { passive: true });
  }

  window.MSBSwipeDismiss = { attach: attach };

  // viewers that share the old markup (profile photo/cover, post pages, article pages)
  function auto() {
    var bg = document.getElementById('imgViewerBg');
    if (bg) attach(bg, {
      fade: function () { return [].slice.call(bg.querySelectorAll('.img-viewer-close,.img-viewer-count')); },
      onClose: function () { if (typeof window.closeImageViewer === 'function') window.closeImageViewer(); }
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', auto); else auto();
})();
