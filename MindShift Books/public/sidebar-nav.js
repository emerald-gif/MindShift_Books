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
  var SIDEBAR_HTML =
    '<aside class="sidebar" id="sidebar" aria-hidden="true" data-open="false">' +
      '<button type="button" class="sidebar-close-btn" onclick="toggleSidebar()" aria-label="Close menu">&times;</button>' +
      '<div class="logo-row">' +
        '<img src="/MINDSHIFT.jpg" alt="logo">' +
        '<div style="font-weight:700">MindShift Books</div>' +
      '</div>' +
      '<ul>' +
        '<li onclick="window.location.href=\'/books\'">Bookstore</li>' +
        '<li onclick="window.location.href=\'/\'">Articles</li>' +
        '<li onclick="msOpenCreate()">Create</li>' +
        '<li id="sbProfileLink" style="display:none" onclick="window.location.href=\'/profile\'">My Profile</li>' +
        '<li id="sbInsightsLink" style="display:none" onclick="window.location.href=\'/insights\'">My Insights</li>' +
        '<li id="sbLogoutLink" class="sidebar-logout" style="display:none" onclick="msLogout()">Log Out</li>' +
        '<li class="sidebar-divider" aria-hidden="true"></li>' +
        '<li id="sbSavedLink" style="display:none" onclick="msOpenSaved()">Saved Articles</li>' +
        '<li onclick="window.location.href=\'/wishlist\'">My Wishlist</li>' +
        '<li onclick="window.location.href=\'/free-ebooks\'">Free eBooks</li>' +
        '<li onclick="window.location.href=\'/affiliate\'">Become an Affiliate</li>' +
        '<li class="sidebar-divider" aria-hidden="true"></li>' +
        '<li onclick="window.location.href=\'/settings\'">Settings</li>' +
        '<li onclick="window.location.href=\'/support\'">Support</li>' +
        '<li onclick="window.location.href=\'/legal\'">Terms &amp; Privacy</li>' +
      '</ul>' +
      '<div class="sidebar-auth-cta" id="sidebarAuthCta" style="display:none;">' +
        '<div class="sidebar-auth-icon" aria-hidden="true">\u2728</div>' +
        '<div class="sidebar-auth-text">Sign up to write articles, follow authors, and get a feed picked for you.</div>' +
        '<a href="/signup" class="btn sidebar-auth-signup">Sign Up Free</a>' +
        '<a href="/login" class="btn sidebar-auth-login">Log In</a>' +
      '</div>' +
    '</aside>';

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
    if (!sidebar) return;
    var open = sidebar.getAttribute('data-open') === 'true';
    sidebar.setAttribute('data-open', open ? 'false' : 'true');
    sidebar.style.left = open ? '-300px' : '0px';
    sidebar.setAttribute('aria-hidden', open ? 'true' : 'false');
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
      if (el) el.style.display = isAuth ? 'block' : 'none';
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
