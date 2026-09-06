/* ══════════════════════════════════════════════════════════════════════
   SHARED MINDSHIFT SIDEBAR
   ──────────────────────────────────────────────────────────────────────
   One canonical copy of the slide-out nav menu, used by every page.
   Before this file existed, each .html page had its own hand-copied
   <aside class="sidebar">...</aside> block, so they'd all drifted apart
   (different items, different order, some missing "Bookstore", some
   missing "My Profile", etc). Now every page just drops:

       <div id="sidebar-slot"></div>
       <script src="/sidebar-nav.js"></script>

   where the old <aside> used to live, and this file renders the real
   thing into that slot. Change the menu ONCE, here, and it updates
   everywhere.

   The CSS for the sidebar is also injected from here (a <style> tag,
   appended once). It used to be copy-pasted into 9 separate page files
   (articles.html, profile.html, article-read.html, post-read.html,
   insights.html, settings.html, affiliate-dashboard.html, my-order.html,
   payout.html) — all nine had drifted into slightly different versions.
   Centralizing it here means a future visual change happens once. Every
   color below has a hardcoded fallback (var(--x, #hex)) rather than
   relying on the host page defining --p/--txt/etc., since a few of those
   nine pages (affiliate-dashboard.html, payout.html, my-order.html)
   don't define the same variable set the others do.

   Auth state (which items show, whether it's "Log In / Sign Up" or
   "Log Out") is read from window.MSBAuth — the single shared auth
   controller already used by the header account menu on every page and
   by /login and /signup themselves (see auth.js). This sidebar doesn't
   run its own separate Firebase listener; it just listens to the same
   'msb-auth-changed' event everything else does, so logging in or out
   anywhere on the site — login.html, signup.html, the header menu, or
   this sidebar's own Log Out link — updates every page's sidebar the
   same way, the moment auth.js knows about it.
   ══════════════════════════════════════════════════════════════════════ */
(function () {
  var ICONS = {
    book: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 3h6a4 4 0 014 4v14a3 3 0 00-3-3H2z"/><path d="M22 3h-6a4 4 0 00-4 4v14a3 3 0 013-3h7z"/></svg>',
    file: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="8" y1="13" x2="16" y2="13"/><line x1="8" y1="17" x2="13" y2="17"/></svg>',
    plusCircle: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="16"/><line x1="8" y1="12" x2="16" y2="12"/></svg>',
    user: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>',
    trending: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/><polyline points="17 6 23 6 23 12"/></svg>',
    bookmark: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21l-7-5-7 5V5a2 2 0 012-2h10a2 2 0 012 2z"/></svg>',
    logout: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>',
    heart: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.84 4.61a5.5 5.5 0 00-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 00-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 000-7.78z"/></svg>',
    gift: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 12 20 22 4 22 4 12"/><rect x="2" y="7" width="20" height="5"/><line x1="12" y1="22" x2="12" y2="7"/><path d="M12 7H7.5a2.5 2.5 0 010-5C11 2 12 7 12 7z"/><path d="M12 7h4.5a2.5 2.5 0 000-5C13 2 12 7 12 7z"/></svg>',
    share: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg>',
    gear: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 11-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 11-2.83-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 112.83-2.83l.06.06a1.65 1.65 0 001.82.33H9a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 112.83 2.83l-.06.06a1.65 1.65 0 00-.33 1.82V9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z"/></svg>',
    help: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 115.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
    shield: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>',
    chevron: '<svg class="sb-chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>'
  };

  function item(id, icon, label, onclick, extra) {
    return (
      '<li' + (id ? ' id="' + id + '"' : '') + (extra || '') + ' onclick="' + onclick + '">' +
        '<span class="sb-ico">' + icon + '</span>' +
        '<span class="sb-label">' + label + '</span>' +
        ICONS.chevron +
      '</li>'
    );
  }

  var SIDEBAR_HTML =
    '<div class="sidebar-overlay" id="sidebarOverlay" onclick="toggleSidebar()" aria-hidden="true"></div>' +
    '<aside class="sidebar" id="sidebar" aria-hidden="true" data-open="false">' +
      '<div class="sb-top">' +
        '<div class="logo-row">' +
          '<img src="/MINDSHIFT.jpg" alt="logo">' +
          '<div class="sb-brand">MindShift Books</div>' +
        '</div>' +
        '<button type="button" class="sidebar-close-btn" onclick="toggleSidebar()" aria-label="Close menu">' +
          '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>' +
        '</button>' +
      '</div>' +
      '<div class="sb-scroll">' +
        '<ul class="sb-group">' +
          item(null, ICONS.book, 'Bookstore', "window.location.href='/books'") +
          item(null, ICONS.file, 'Articles', "window.location.href='/'") +
          item(null, ICONS.plusCircle, 'Create', 'msOpenCreate()') +
        '</ul>' +

        '<ul class="sb-group" id="sbAccountGroup">' +
          item('sbProfileLink', ICONS.user, 'My Profile', "window.location.href='/profile'", ' style="display:none"') +
          item('sbInsightsLink', ICONS.trending, 'My Insights', "window.location.href='/insights'", ' style="display:none"') +
          item('sbSavedLink', ICONS.bookmark, 'Saved Articles', 'msOpenSaved()', ' style="display:none"') +
          item('sbLogoutLink', ICONS.logout, 'Log Out', 'msLogout()', ' class="sidebar-logout" style="display:none"') +
        '</ul>' +

        '<div class="sb-section-label">Discover</div>' +
        '<ul class="sb-group">' +
          item(null, ICONS.heart, 'My Wishlist', "window.location.href='/wishlist'") +
          item(null, ICONS.gift, 'Free eBooks', "window.location.href='/free-ebooks'") +
          item(null, ICONS.share, 'Become an Affiliate', "window.location.href='/affiliate'") +
        '</ul>' +

        '<div class="sb-section-label">About</div>' +
        '<ul class="sb-group">' +
          item(null, ICONS.gear, 'Settings', "window.location.href='/settings'") +
          item(null, ICONS.help, 'Support', "window.location.href='/support'") +
          item(null, ICONS.shield, 'Terms &amp; Privacy', "window.location.href='/legal'") +
        '</ul>' +

        '<div class="sidebar-auth-cta" id="sidebarAuthCta" style="display:none;">' +
          '<div class="sidebar-auth-icon" aria-hidden="true">\u2728</div>' +
          '<div class="sidebar-auth-text">Sign up to write articles, follow authors, and get a feed picked for you.</div>' +
          '<a href="/signup" class="btn sidebar-auth-signup">Sign Up Free</a>' +
          '<a href="/login" class="btn sidebar-auth-login">Log In</a>' +
        '</div>' +
      '</div>' +
    '</aside>';

  var SIDEBAR_CSS =
    '.sidebar-overlay{position:fixed;inset:0;background:rgba(15,23,42,.45);z-index:1999;opacity:0;pointer-events:none;transition:opacity .28s ease}' +
    '.sidebar-overlay.sb-show{opacity:1;pointer-events:all}' +
    '.sidebar{position:fixed;top:0;left:-300px;width:280px;height:100%;background:var(--card,#fff);transition:left .32s cubic-bezier(.32,0,.15,1);z-index:2000;box-shadow:2px 0 24px rgba(15,23,42,.12);color:var(--txt,#0f172a);display:flex;flex-direction:column;overflow:hidden}' +
    '.sidebar .sb-top{display:flex;align-items:center;justify-content:space-between;padding:18px 14px 14px 18px;border-bottom:1px solid var(--border,#e2e8f0);flex-shrink:0}' +
    '.sidebar .logo-row{display:flex;align-items:center;gap:10px}' +
    '.sidebar .logo-row img{width:32px;height:32px;border-radius:8px;object-fit:cover}' +
    '.sidebar .sb-brand{font-weight:800;font-size:14.5px;color:var(--txt,#0f172a)}' +
    '.sidebar-close-btn{width:32px;height:32px;border-radius:50%;border:none;background:var(--bg,#f8fafc);color:var(--sub,#6b7280);cursor:pointer;display:flex;align-items:center;justify-content:center;flex-shrink:0;-webkit-tap-highlight-color:transparent}' +
    '.sidebar-close-btn:active{background:var(--border,#e2e8f0)}' +
    '.sidebar-close-btn svg{width:16px;height:16px}' +
    '.sidebar .sb-scroll{flex:1;overflow-y:auto;padding:14px 12px 28px}' +
    '.sidebar .sb-group{list-style:none;background:var(--card,#fff);border:1px solid var(--border,#e2e8f0);border-radius:16px;overflow:hidden;margin-bottom:16px;box-shadow:0 1px 3px rgba(15,23,42,.04)}' +
    '.sidebar .sb-group li{display:flex;align-items:center;gap:12px;padding:14px 14px;font-weight:600;font-size:14px;color:var(--txt,#0f172a);cursor:pointer;border-bottom:1px solid var(--border,#e2e8f0);-webkit-tap-highlight-color:transparent;transition:background .15s}' +
    '.sidebar .sb-group li:last-child{border-bottom:none}' +
    '.sidebar .sb-group li:active{background:var(--bg,#f8fafc)}' +
    '.sidebar .sb-ico{display:flex;align-items:center;justify-content:center;width:20px;height:20px;flex-shrink:0;color:var(--sub,#6b7280)}' +
    '.sidebar .sb-ico svg{width:19px;height:19px}' +
    '.sidebar .sb-label{flex:1;min-width:0}' +
    '.sidebar .sb-chev{width:15px;height:15px;flex-shrink:0;color:var(--mute,#9ca3af)}' +
    '.sidebar .sidebar-logout{color:var(--red,#ef4444)}' +
    '.sidebar .sidebar-logout .sb-ico{color:var(--red,#ef4444)}' +
    '.sidebar .sb-section-label{font-size:11.5px;font-weight:800;letter-spacing:.04em;text-transform:uppercase;color:var(--mute,#9ca3af);padding:4px 8px 8px}' +
    '.sidebar-auth-cta{padding:16px;margin-top:4px;background:var(--bg,#f8fafc);border-radius:16px}' +
    '.sidebar-auth-icon{font-size:1.3rem;margin-bottom:4px}' +
    '.sidebar-auth-text{color:var(--sub,#6b7280);font-size:.78rem;line-height:1.4;margin-bottom:12px}' +
    '.sidebar-auth-cta .btn{display:block;width:100%;padding:10px 10px;font-size:.8rem;text-decoration:none;margin-bottom:8px;text-align:center;border-radius:10px;font-weight:700;box-sizing:border-box}' +
    '.sidebar-auth-cta .btn:last-child{margin-bottom:0}' +
    '.sidebar-auth-signup{background:var(--g,linear-gradient(90deg,#4f46e5,#06b6d4));color:#fff}' +
    '.sidebar-auth-login{background:#fff;color:var(--txt,#0f172a);border:1.5px solid var(--border,#e2e8f0)!important}' +
    '.sidebar-auth-login:hover{background:var(--bg,#f8fafc)}';

  var styleTag = document.createElement('style');
  styleTag.setAttribute('data-sidebar-nav', '');
  styleTag.textContent = SIDEBAR_CSS;
  document.head.appendChild(styleTag);

  var slot = document.getElementById('sidebar-slot');
  if (slot) {
    slot.outerHTML = SIDEBAR_HTML;
  } else {
    // No slot on this page (shouldn't normally happen) — bail out quietly
    // rather than injecting a floating sidebar nobody asked for.
    return;
  }

  // ── Open/close ──
  // Defined globally so old per-page copies (main.js, or a page's own
  // inline script) that also define toggleSidebar don't conflict —
  // they're functionally identical, last one to load just wins.
  window.toggleSidebar = function () {
    var sidebar = document.getElementById('sidebar');
    var overlay = document.getElementById('sidebarOverlay');
    if (!sidebar) return;
    var open = sidebar.getAttribute('data-open') === 'true';
    sidebar.setAttribute('data-open', open ? 'false' : 'true');
    sidebar.style.left = open ? '-300px' : '0px';
    sidebar.setAttribute('aria-hidden', open ? 'true' : 'false');
    if (overlay) overlay.classList.toggle('sb-show', !open);
    document.body.style.overflow = open ? '' : 'hidden';
  };

  // ── "Create" ──
  // Most pages load create-picker.js (adds window.openCreatePicker), but
  // a few don't. Fall back to the standalone create-post page instead of
  // throwing a JS error when it's missing.
  window.msOpenCreate = function () {
    if (typeof window.openCreatePicker === 'function') {
      window.openCreatePicker();
    } else {
      window.location.href = '/create-post';
    }
  };

  // ── "Saved Articles" ──
  // The real saved-articles sheet only exists on the articles feed page
  // (window.openSaved, defined in articles.html). From anywhere else,
  // send the user to the feed and ask it to open the sheet once it's
  // loaded (articles.html listens for ?saved=1).
  window.msOpenSaved = function () {
    if (typeof window.openSaved === 'function') {
      window.openSaved();
    } else {
      window.location.href = '/?saved=1';
    }
  };

  // ── "Log Out" ──
  // Goes through window.MSBAuth.signOut() — the same sign-out path as the
  // header account menu — which clears the session on this origin AND the
  // cross-domain relay cookie (see auth.js), so the affiliate subdomain
  // gets signed out too, not just this tab. Reload afterwards so every bit
  // of page state (not just the sidebar) reflects being signed out.
  window.msLogout = function () {
    if (window.MSBAuth && typeof window.MSBAuth.signOut === 'function') {
      window.MSBAuth.signOut().then(function () {
        window.location.href = '/';
      });
    } else {
      window.location.href = '/';
    }
  };

  // ── Auth-only items (My Profile / My Insights / Log Out / Saved Articles / sign-up CTA) ──
  // Reads state from window.MSBAuth instead of talking to Firebase directly,
  // so this sidebar always agrees with the header account menu and with
  // /login and /signup — they all share the one auth.js instance and its
  // 'msb-auth-changed' event. auth.js is usually included near the bottom
  // of the page (after this script runs up near the top), so poll briefly
  // until window.MSBAuth exists, then subscribe.
  function applyAuthState(user) {
    var isAuth = !!user;
    ['sbProfileLink', 'sbInsightsLink', 'sbLogoutLink', 'sbSavedLink'].forEach(function (id) {
      var el = document.getElementById(id);
      if (el) el.style.display = isAuth ? 'flex' : 'none';
    });
    var cta = document.getElementById('sidebarAuthCta');
    if (cta) cta.style.display = isAuth ? 'none' : 'block';
  }

  function wireAuth() {
    if (!window.MSBAuth || typeof window.MSBAuth.onAuthReady !== 'function') return false;
    window.MSBAuth.onAuthReady(applyAuthState); // first resolution (may already have happened)
    window.addEventListener('msb-auth-changed', function (e) {
      applyAuthState(e.detail && e.detail.user);
    });
    return true;
  }

  if (!wireAuth()) {
    var tries = 0;
    (function waitForAuth() {
      tries++;
      if (wireAuth()) return;
      if (tries < 100) setTimeout(waitForAuth, 100); // ~10s max
    })();
  }
})();
