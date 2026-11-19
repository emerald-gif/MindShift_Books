/* Top announcement bar for the storefront header.
   Slides down on load; the whole bar is a link.
   Add the data-dismissible attribute to the <script> tag to show a ✕ that
   hides it for the rest of that day (used on the feed; the store has no ✕).
   To change the message/link later, edit MSG / HREF below.
   Pages with a <body > header> (store, feed): the bar lives INSIDE that header
   so it hides/shows with it on scroll and the page keeps clear of it.
   Pages without one (e.g. Free eBooks): the bar is the first thing in <main>
   and simply scrolls away with the page. */
(function () {
  var BAR_H = 36, KEY = 'msb_promo_student_day_v1';
  var cs = document.currentScript;
  var DISMISS = !!(cs && cs.hasAttribute('data-dismissible'));
  var HREF = '/student-resources';
  var MSG = 'Student Resources: learn, grow &amp; stay ahead';

  if (location.pathname.indexOf('/student-resources') === 0) return;
  if (DISMISS) {
    try {
      if (localStorage.getItem(KEY) === new Date().toDateString()) return; // dismissed today
    } catch (e) {}
  }

  // books.html's ResizeObserver only watches the header's content box, so the
  // padding animation below never triggers it — re-run its padding sync ourselves.
  function syncMain(ms) {
    var end = Date.now() + ms;
    (function tick() {
      if (typeof window.adjustMainPadding === 'function') window.adjustMainPadding();
      else window.dispatchEvent(new Event('resize')); // feed re-measures its sticky header on resize
      if (Date.now() < end) requestAnimationFrame(tick);
    })();
  }

  function init() {
    var h = document.querySelector('body > header');
    var m = !h && document.querySelector('main');
    if ((!h && !m) || document.querySelector('.msb-promo')) return;

    var css = document.createElement('style');
    css.textContent =
      'header.msb-has-promo{--promo-h:0px;padding-top:calc(var(--promo-h) + 12px);' +
      'transition:transform .28s ease,padding-top .45s cubic-bezier(.22,1,.36,1)}' +
      '.msb-promo{position:absolute;top:0;left:0;right:0;height:var(--promo-h);overflow:hidden;' +
      'background:linear-gradient(90deg,#1e40af,#2563eb 55%,#1d4ed8);color:#fff;' +
      'transition:height .45s cubic-bezier(.22,1,.36,1)}' +
      '.msb-promo-link{display:flex;align-items:center;justify-content:center;gap:8px;height:' + BAR_H + 'px;' +
      'padding:0 ' + (DISMISS ? 42 : 14) + 'px 0 14px;color:#fff;text-decoration:none;font-size:13px;font-weight:600;' +
      'letter-spacing:.1px;white-space:nowrap;-webkit-tap-highlight-color:transparent}' +
      '.msb-promo.msb-promo-flow{position:relative;top:auto;left:auto;right:auto;margin:0 -16px}' +
      '.msb-promo-txt{overflow:hidden;text-overflow:ellipsis;min-width:0}' +
      '.msb-promo-arrow{flex-shrink:0;transition:transform .2s ease}' +
      '.msb-promo-link:hover .msb-promo-arrow{transform:translateX(3px)}' +
      (DISMISS ? '.msb-promo-x{position:absolute;top:0;right:0;width:40px;height:' + BAR_H + 'px;display:flex;' +
      'align-items:center;justify-content:center;background:none;border:0;color:#fff;opacity:.8;cursor:pointer}' +
      '.msb-promo-x:hover{opacity:1}' : '') +
      '@media (prefers-reduced-motion:reduce){header.msb-has-promo,.msb-promo{transition:none}}';
    document.head.appendChild(css);

    var bar = document.createElement('div');
    bar.className = 'msb-promo';
    bar.setAttribute('role', 'region');
    bar.setAttribute('aria-label', 'Announcement');
    bar.innerHTML =
      '<a class="msb-promo-link" href="' + HREF + '">' +
        '<span aria-hidden="true">🎓</span>' +
        '<span class="msb-promo-txt">' + MSG + '</span>' +
        '<svg class="msb-promo-arrow" viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg>' +
      '</a>' +
      (DISMISS ? '<button type="button" class="msb-promo-x" aria-label="Dismiss announcement">' +
        '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/></svg>' +
      '</button>' : '');

    // holder carries the --promo-h variable: the header, or the bar itself in flow mode
    var holder = h || bar;
    if (h) {
      h.insertBefore(bar, h.firstChild);
      h.classList.add('msb-has-promo');
    } else {
      bar.classList.add('msb-promo-flow');
      bar.style.setProperty('--promo-h', '0px');
      m.insertBefore(bar, m.firstChild);
    }
    // two frames so the browser paints the closed state first, then slides down
    requestAnimationFrame(function () {
      requestAnimationFrame(function () { holder.style.setProperty('--promo-h', BAR_H + 'px'); if (h) syncMain(700); });
    });

    if (DISMISS) bar.querySelector('.msb-promo-x').addEventListener('click', function () {
      try { localStorage.setItem(KEY, new Date().toDateString()); } catch (e) {}
      holder.style.setProperty('--promo-h', '0px');
      if (h) syncMain(700);
      setTimeout(function () {
        if (bar.parentNode) bar.parentNode.removeChild(bar);
        if (h) {
          h.classList.remove('msb-has-promo');
          h.style.removeProperty('--promo-h');
          syncMain(50);
        }
      }, 480);
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
