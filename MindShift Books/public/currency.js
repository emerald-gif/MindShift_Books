/* MindShift Books — currency.js (v1)
 * Auto-detects ₦ vs $, lets the visitor switch, and stops USD checkout with a friendly message.
 * Charging always stays in NGN — this file only changes what is DISPLAYED.
 */
(function () {
  'use strict';

  /* ---------- CONFIG (edit these) ---------- */
  var NGN_PER_USD = 1500;   // fallback only — used if the live rate can't be loaded
  var RATE_URL = 'https://open.er-api.com/v6/latest/USD'; // free, no key, updates daily
  var RATE_TTL = 12 * 60 * 60 * 1000; // re-fetch at most twice a day (also avoids their rate limit)
  var RATE_KEY = 'msbRate';
  var rate = NGN_PER_USD;

  var KEY = 'msbCurrency';      // visitor's explicit choice (always wins)
  var AUTO = 'msbCurrencyAuto'; // cached auto-detect result
  var current = 'NGN';
  var listeners = [];

  function getS(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function setS(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }

  /* ---------- DETECTION ---------- */
  function tzGuess() {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone === 'Africa/Lagos' ? 'NGN' : 'USD';
    } catch (e) { return 'NGN'; }
  }

  function detect() {
    return new Promise(function (resolve) {
      var done = false;
      var t = setTimeout(function () { if (!done) { done = true; resolve(null); } }, 2500);
      fetch('https://api.country.is/')
        .then(function (r) { return r.json(); })
        .then(function (d) {
          if (done) return;
          done = true; clearTimeout(t);
          resolve(d && d.country ? (d.country === 'NG' ? 'NGN' : 'USD') : null);
        })
        .catch(function () { if (!done) { done = true; clearTimeout(t); resolve(null); } });
    });
  }

  /* ---------- LIVE RATE ---------- */
  function loadRate() {
    var cached = null;
    try { cached = JSON.parse(getS(RATE_KEY)); } catch (e) {}
    if (cached && cached.r > 0) {
      rate = cached.r; // use cached (even if stale) right away
      if (Date.now() - cached.t < RATE_TTL) return Promise.resolve();
    }
    return fetch(RATE_URL)
      .then(function (r) { return r.json(); })
      .then(function (d) {
        var n = d && d.result === 'success' && d.rates && d.rates.NGN;
        if (n > 0) { rate = n; setS(RATE_KEY, JSON.stringify({ r: n, t: Date.now() })); }
      })
      .catch(function () {});
  }

  /* ---------- FORMATTING ---------- */
  // Approximate USD: converted from naira at the live rate, rounded to the nearest $0.50 (never below $0.50)
  function approxUsd(ngn) {
    if (!ngn) return 0;
    return Math.max(0.5, Math.round((ngn / rate) * 2) / 2);
  }

  // opts.exact -> true conversion to the cent (use for fixed amounts like vouchers, so they are not rounded up)
  // opts.plain -> leave off the leading "\u2248 " (e.g. when you add your own "\u2212" sign)
  function fmt(ngn, opts) {
    ngn = Number(ngn) || 0;
    if (!ngn) return 'Free';
    if (current === 'USD') {
      var usd = opts && opts.exact ? ngn / rate : approxUsd(ngn);
      return (opts && opts.plain ? '' : '\u2248 ') + '$' + usd.toFixed(2);
    }
    return '\u20A6' + ngn.toLocaleString('en-NG');
  }

  // items: [{ ngn: 5000, qty: 1 }]
  function fmtTotal(items) {
    var n = 0;
    (items || []).forEach(function (i) { n += (Number(i.ngn) || 0) * (i.qty || 1); });
    return fmt(n);
  }

  /* ---------- RENDER ---------- */
  function render(root) {
    (root || document).querySelectorAll('[data-ngn]').forEach(function (el) {
      el.textContent = fmt(el.getAttribute('data-ngn'), { exact: el.hasAttribute('data-exact') });
    });
    var host = document.getElementById('currencyToggle');
    if (host) host.classList.toggle('usd', current === 'USD');
    if (host) host.querySelectorAll('[data-cur]').forEach(function (b) {
      b.classList.toggle('on', b.getAttribute('data-cur') === current);
      b.setAttribute('aria-pressed', b.getAttribute('data-cur') === current ? 'true' : 'false');
    });
  }

  function apply(c, explicit) {
    current = c;
    if (explicit) setS(KEY, c);
    render();
    listeners.forEach(function (fn) { try { fn(c); } catch (e) {} });
  }

  /* ---------- TOGGLE UI ---------- */
  var css =
    '.msb-cur-float{position:fixed;left:12px;bottom:86px;z-index:900}' +
    '.msb-cur{display:inline-flex;background:#111827;border-radius:999px;padding:3px;box-shadow:0 4px 14px rgba(0,0,0,.18)}' +
    '.msb-cur button{border:0;background:transparent;color:#9ca3af;font:600 13px/1 inherit;font-family:inherit;min-width:34px;height:28px;border-radius:999px;cursor:pointer;transition:background .2s,color .2s}' +
    '.msb-cur button.on{background:linear-gradient(135deg,#4f46e5,#06b6d4);color:#fff}' +
    '.msb-cur button:focus-visible{outline:2px solid #06b6d4;outline-offset:2px}' +
    '.msb-attr{display:none;margin-top:4px;font-size:10px;color:#6b7280;text-decoration:none;text-align:center}' +
    '#currencyToggle.usd .msb-attr{display:block}' +
    '#currencyToggle.msb-attr-only{display:none}' +
    '#currencyToggle.msb-attr-only.usd{display:block;text-align:center;padding:12px 0 80px}' +
    '.msb-cs-scrim{position:fixed;inset:0;background:rgba(17,24,39,.5);z-index:2000;display:flex;align-items:flex-end;justify-content:center;animation:msbFade .2s ease}' +
    '.msb-cs{background:#fff;width:100%;max-width:440px;border-radius:20px 20px 0 0;padding:22px 20px calc(20px + env(safe-area-inset-bottom));animation:msbUp .25s ease}' +
    '.msb-cs h3{margin:0 0 8px;font-size:18px;color:#111827}' +
    '.msb-cs p{margin:0 0 18px;font-size:14px;line-height:1.55;color:#4b5563}' +
    '.msb-cs .go{display:block;width:100%;border:0;border-radius:12px;padding:13px;font:600 15px inherit;font-family:inherit;color:#fff;background:linear-gradient(135deg,#4f46e5,#06b6d4);cursor:pointer}' +
    '.msb-cs .no{display:block;width:100%;border:0;background:none;padding:12px;font:500 14px inherit;font-family:inherit;color:#6b7280;cursor:pointer}' +
    '@keyframes msbFade{from{opacity:0}to{opacity:1}}' +
    '@keyframes msbUp{from{transform:translateY(24px);opacity:0}to{transform:none;opacity:1}}' +
    '@media(min-width:600px){.msb-cs-scrim{align-items:center}.msb-cs{border-radius:20px}}' +
    '@media(prefers-reduced-motion:reduce){.msb-cs-scrim,.msb-cs{animation:none}}';

  function mountToggle() {
    var st = document.createElement('style');
    st.textContent = css;
    document.head.appendChild(st);

    var host = document.getElementById('currencyToggle');
    // Pages that only need prices converted (feed, profile) set MSB_CURRENCY_NO_TOGGLE:
    // no switcher there — just the rate credit, shown only while viewing in dollars.
    if (window.MSB_CURRENCY_NO_TOGGLE) {
      if (!host) {
        host = document.createElement('div');
        host.id = 'currencyToggle';
        host.className = 'msb-attr-only';
        document.body.appendChild(host);
      }
      host.innerHTML = '<a class="msb-attr" href="https://www.exchangerate-api.com" target="_blank" rel="noopener">Rates by ExchangeRate-API</a>';
      return;
    }
    if (!host) {
      host = document.createElement('div');
      host.id = 'currencyToggle';
      host.className = 'msb-cur-float';
      document.body.appendChild(host);
    }
    host.innerHTML =
      '<div class="msb-cur" role="group" aria-label="Currency">' +
      '<button type="button" data-cur="NGN" aria-label="Naira">\u20A6</button>' +
      '<button type="button" data-cur="USD" aria-label="US dollars">$</button></div>' +
      '<a class="msb-attr" href="https://www.exchangerate-api.com" target="_blank" rel="noopener">Rates by ExchangeRate-API</a>';
    host.addEventListener('click', function (e) {
      var b = e.target.closest('[data-cur]');
      if (b) apply(b.getAttribute('data-cur'), true);
    });
  }

  /* ---------- CHECKOUT GUARD ---------- */
  function closeSheet() {
    var s = document.getElementById('msbCurSheet');
    if (s) s.remove();
    document.removeEventListener('keydown', onKey);
  }
  function onKey(e) { if (e.key === 'Escape') closeSheet(); }

  function showSheet() {
    if (document.getElementById('msbCurSheet')) return;
    var s = document.createElement('div');
    s.id = 'msbCurSheet';
    s.className = 'msb-cs-scrim';
    s.innerHTML =
      '<div class="msb-cs" role="dialog" aria-modal="true" aria-labelledby="msbCsT">' +
      '<h3 id="msbCsT">USD payments aren\u2019t available yet</h3>' +
      '<p>We\u2019re working on it. In the meantime you can switch to \u20A6 and pay by card \u2014 international cards may work, and your bank converts the amount.</p>' +
      '<button type="button" class="go">Switch to \u20A6</button>' +
      '<button type="button" class="no">Not now</button></div>';
    s.addEventListener('click', function (e) {
      if (e.target === s || e.target.classList.contains('no')) closeSheet();
      else if (e.target.classList.contains('go')) { apply('NGN', true); closeSheet(); }
    });
    document.body.appendChild(s);
    document.addEventListener('keydown', onKey);
  }

  // Call before starting payment. Returns true if OK to continue.
  function guardCheckout() {
    if (current !== 'USD') return true;
    showSheet();
    return false;
  }

  /* ---------- INIT ---------- */
  var saved = getS(KEY);
  if (saved === 'NGN' || saved === 'USD') {
    current = saved;
  } else {
    var cached = getS(AUTO);
    current = cached === 'NGN' || cached === 'USD' ? cached : tzGuess();
    if (!cached) {
      detect().then(function (c) {
        if (!c) return;
        setS(AUTO, c);
        if (!getS(KEY) && c !== current) apply(c, false);
      });
    }
  }

  // Load the live rate; when it arrives, refresh any USD prices already on screen
  loadRate().then(function () {
    if (current !== 'USD') return;
    render();
    listeners.forEach(function (fn) { try { fn(current); } catch (e) {} });
  });

  // Re-render when the store injects new price elements (Firestore-rendered cards, cart rows)
  var queued = false;
  new MutationObserver(function (muts) {
    if (queued) return;
    var hit = muts.some(function (m) {
      return Array.prototype.some.call(m.addedNodes, function (n) {
        return n.nodeType === 1 && (n.hasAttribute('data-ngn') || n.querySelector('[data-ngn]'));
      });
    });
    if (!hit) return;
    queued = true;
    requestAnimationFrame(function () { queued = false; render(); });
  }).observe(document.documentElement, { childList: true, subtree: true });

  function ready() { mountToggle(); render(); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', ready);
  else ready();

  window.MSBCurrency = {
    get: function () { return current; },
    set: function (c) { if (c === 'NGN' || c === 'USD') apply(c, true); },
    fmt: fmt,
    fmtTotal: fmtTotal,
    refresh: render,
    guardCheckout: guardCheckout,
    onChange: function (fn) { listeners.push(fn); }
  };
})();
