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
  // Exact conversion at the live rate (to the cent). The free-ebook voucher is the one
  // fixed display: ₦2,000 always shows as $1 in dollars, whatever the rate does.
  var VOUCHER_USD = { 2000: 1 };
  function toUsd(ngn) { return (Number(ngn) || 0) / rate; }
  function voucherUsd(ngn) { return VOUCHER_USD[ngn] != null ? VOUCHER_USD[ngn] : toUsd(ngn); }

  // opts.voucher -> fixed voucher display ($1) instead of the live conversion
  // opts.plain   -> leave off the leading "\u2248 " (e.g. when you add your own "\u2212" sign)
  function fmt(ngn, opts) {
    ngn = Number(ngn) || 0;
    if (!ngn) return 'Free';
    if (current === 'USD') {
      if (opts && opts.voucher && VOUCHER_USD[ngn] != null) return '$' + VOUCHER_USD[ngn];
      return (opts && opts.plain ? '' : '\u2248 ') + '$' + toUsd(ngn).toFixed(2);
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
      el.textContent = fmt(el.getAttribute('data-ngn'), { voucher: el.hasAttribute('data-voucher') });
    });
    var host = document.getElementById('msbRateCredit');
    if (host) host.classList.toggle('usd', current === 'USD');
  }

  function apply(c, explicit) {
    current = c;
    if (explicit) setS(KEY, c);
    render();
    listeners.forEach(function (fn) { try { fn(c); } catch (e) {} });
    try { window.dispatchEvent(new CustomEvent('msb-currency-changed', { detail: c })); } catch (e) {}
  }

  /* ---------- RATE CREDIT + STYLES ---------- */
  var css =
    '#msbRateCredit{display:none;text-align:center;padding:12px 0 80px}' +
    '#msbRateCredit.usd{display:block}' +
    '#msbRateCredit a{font-size:10px;color:#6b7280;text-decoration:none}' +
    '.msb-cs-scrim{position:fixed;inset:0;background:rgba(17,24,39,.5);z-index:8000;display:flex;align-items:flex-end;justify-content:center;animation:msbFade .2s ease}' +
    '.msb-cs{background:#fff;width:100%;max-width:440px;border-radius:20px 20px 0 0;padding:22px 20px calc(20px + env(safe-area-inset-bottom));animation:msbUp .25s ease}' +
    '.msb-cs h3{margin:0 0 8px;font-size:18px;color:#111827}' +
    '.msb-cs p{margin:0 0 18px;font-size:14px;line-height:1.55;color:#4b5563}' +
    '.msb-cs .go{display:block;width:100%;border:0;border-radius:12px;padding:13px;font-weight:600;font-size:15px;font-family:inherit;color:#fff;background:linear-gradient(135deg,#4f46e5,#06b6d4);cursor:pointer}' +
    '.msb-cs .no{display:block;width:100%;border:0;background:none;padding:12px;font-weight:500;font-size:14px;font-family:inherit;color:#6b7280;cursor:pointer}' +
    '@keyframes msbFade{from{opacity:0}to{opacity:1}}' +
    '@keyframes msbUp{from{transform:translateY(24px);opacity:0}to{transform:none;opacity:1}}' +
    '@media(min-width:600px){.msb-cs-scrim{align-items:center}.msb-cs{border-radius:20px}}' +
    '@media(prefers-reduced-motion:reduce){.msb-cs-scrim,.msb-cs{animation:none}}';

  // The ₦/$ switch lives in the sidebar (sidebar-nav.js). This only adds the
  // rate-source credit their free tier asks for — at the end of the page, and
  // only while the visitor is viewing in dollars.
  function mountCredit() {
    var st = document.createElement('style');
    st.textContent = css;
    document.head.appendChild(st);

    var host = document.createElement('div');
    host.id = 'msbRateCredit';
    host.innerHTML = '<a href="https://www.exchangerate-api.com" target="_blank" rel="noopener">Rates by ExchangeRate-API</a>';
    document.body.appendChild(host);
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

  function ready() { mountCredit(); render(); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', ready);
  else ready();

  window.MSBCurrency = {
    get: function () { return current; },
    set: function (c) { if (c === 'NGN' || c === 'USD') apply(c, true); },
    fmt: fmt,
    toUsd: toUsd,
    voucherUsd: voucherUsd,
    fmtTotal: fmtTotal,
    refresh: render,
    guardCheckout: guardCheckout,
    onChange: function (fn) { listeners.push(fn); }
  };
})();
