// public/auth.js
// Firebase auth (email/password + Google) for MindShift Books.
// Sign-in/sign-up now live on their own pages (/login, /signup) instead of a
// modal. This file handles: session state, the header nav slot (Sign In link
// vs My Account menu), and the "resume checkout after login" handoff so
// someone who tapped Proceed to Payment while signed out lands right back in
// their cart once they're signed in.

(function () {
  const FIREBASE_CONFIG = {
    apiKey: "AIzaSyDTn70s1_uIiSOR6lPLY_nKh8Ff1FViFCs",
    authDomain: "mindshiftbooks-c4451.firebaseapp.com",
    projectId: "mindshiftbooks-c4451",
    storageBucket: "mindshiftbooks-c4451.firebasestorage.app",
    messagingSenderId: "388697987853",
    appId: "1:388697987853:web:f023df9412c22285012e44",
    measurementId: "G-CHPJDQ4W08"
  };
  if (!firebase.apps.length) firebase.initializeApp(FIREBASE_CONFIG);
  const auth = firebase.auth();

  let accountInitDone = false;

  async function initAccountOnServer(name) {
    if (accountInitDone) return;
    try {
      const token = await auth.currentUser.getIdToken();
      await fetch('/api/account/init', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ name: name || null })
      });
      accountInitDone = true;
    } catch (e) { /* non-fatal — account page will retry on load */ }
  }

  function friendlyAuthError(err) {
    const code = err && err.code;
    const map = {
      'auth/email-already-in-use': "That email already has an account — try signing in instead.",
      'auth/invalid-email': "That email address doesn't look right.",
      'auth/weak-password': 'Password should be at least 6 characters.',
      'auth/user-not-found': 'No account found with that email.',
      'auth/wrong-password': 'Incorrect password.',
      'auth/invalid-credential': 'Incorrect email or password.',
      'auth/too-many-requests': 'Too many attempts. Please wait a moment and try again.',
      'auth/popup-closed-by-user': 'Sign-in was cancelled.',
      'auth/cancelled-popup-request': 'Sign-in was cancelled.'
    };
    return (code && map[code]) || (err && err.message) || 'Something went wrong. Please try again.';
  }

  // ---------------- Public sign-in / sign-up actions (used by /login, /signup) ----------------
  async function signInEmail(email, password) {
    await auth.signInWithEmailAndPassword(email, password);
    await initAccountOnServer(null);
  }

  async function signUpEmail(email, password, name) {
    const cred = await auth.createUserWithEmailAndPassword(email, password);
    if (name) await cred.user.updateProfile({ displayName: name });
    await initAccountOnServer(name || null);
  }

  // Popup is now the primary path. Redirect requires shuttling the auth
  // result back from the authDomain (mindshiftbooks-c4451.firebaseapp.com)
  // into this site's storage (mindshiftbooks.shop) via a hidden iframe —
  // browsers that partition storage between top-level sites (Safari ITP,
  // Chrome storage partitioning, Brave, many Android in-app WebViews) block
  // that hand-off silently. Google's side completes fine, but the result
  // never reaches the app — no error, just a permanent stall on /login or
  // /signup. Popup talks back to the opener tab directly and doesn't hit
  // this. Redirect is kept only as a fallback for the embedded in-app
  // browsers (Instagram/TikTok/Facebook) that block popups outright.
  //
  // 'auth/popup-blocked' is NOT treated as a signal to fall back to
  // redirect: on a normal mobile browser it usually just means the
  // browser's popup blocker caught it (or the popup got closed before it
  // could report back), and routing that into redirect walks the user
  // straight into the storage-partitioning dead end above — the exact
  // "stuck on /login forever" bug. Only 'auth/operation-not-supported-in-
  // this-environment' (Firebase's own signal that popups genuinely can't
  // work here — the actual in-app-webview case) falls back to redirect.
  function isLikelyInAppWebview() {
    const ua = navigator.userAgent || '';
    return /Instagram|FBAN|FBAV|FB_IAB|Line\/|TikTok|MicroMessenger/i.test(ua);
  }

  // Popup, not redirect, is the right default even on mobile browsers.
  // Redirect has to shuttle the auth result back from the authDomain
  // (mindshiftbooks-c4451.firebaseapp.com) to this site (mindshiftbooks.shop)
  // through storage, and modern mobile Chrome partitions storage between
  // different sites — that hand-off gets silently dropped, which is the
  // "bounces back to /login and just sits there" stall confirmed on-device.
  // Popup instead talks straight back to the opener tab via postMessage, so
  // it isn't subject to that storage partitioning at all. Redirect is kept
  // only as a genuine last resort for in-app webviews that block popups
  // outright — and even there it can strand the user; see the stall
  // detector below.
  async function signInGoogle() {
    const provider = new firebase.auth.GoogleAuthProvider();
    const box = document.getElementById('authError');

    if (isLikelyInAppWebview()) {
      try { sessionStorage.setItem('msb_google_redirect_pending', '1'); } catch (e) {}
      return auth.signInWithRedirect(provider);
    }

    try {
      const result = await auth.signInWithPopup(provider);
      await initAccountOnServer(result.user.displayName || null);
      maybeLeaveAuthPage();
    } catch (err) {
      const code = err && err.code;
      if (code === 'auth/operation-not-supported-in-this-environment') {
        try { sessionStorage.setItem('msb_google_redirect_pending', '1'); } catch (e) {}
        return auth.signInWithRedirect(provider);
      }
      if (code === 'auth/popup-closed-by-user' || code === 'auth/cancelled-popup-request') {
        // Some mobile Chrome builds auto-close the popup tab right after
        // the account is picked — Firebase reports that as
        // 'popup-closed-by-user' even when sign-in actually completed on
        // Google's side. Give onAuthStateChanged a brief window to catch
        // up before concluding the user genuinely cancelled; only show an
        // error if they're still signed out after that.
        setTimeout(() => {
          if (!auth.currentUser && box) {
            box.textContent = "The Google sign-in window closed before finishing. Please try again — and avoid switching apps or tabs while the Google screen is open.";
            box.style.display = 'block';
          }
        }, 1200);
        return;
      }
      if (code === 'auth/popup-blocked') {
        if (box) {
          box.textContent = "Your browser blocked the Google sign-in popup. Please allow popups for this site and try again, or sign in with email below.";
          box.style.display = 'block';
        }
        return;
      }
      if (box) { box.textContent = friendlyAuthError(err); box.style.display = 'block'; }
    }
  }

  function getReturnTo() {
    const params = new URLSearchParams(window.location.search);
    return params.get('returnTo') || '/';
  }

  function redirectAfterAuth() {
    window.location.href = getReturnTo();
  }

  // Guards against redirecting twice — getRedirectResult() and
  // onAuthStateChanged() can both fire for the same sign-in.
  let authRedirectHandled = false;
  function maybeLeaveAuthPage() {
    if (authRedirectHandled) return;
    if (window.location.pathname === '/login' || window.location.pathname === '/signup') {
      authRedirectHandled = true;
      try { sessionStorage.removeItem('msb_google_redirect_pending'); } catch (e) {}
      redirectAfterAuth();
    }
  }

  // Handles the bounce-back from signInWithRedirect (Google). Safe to call on
  // every page — resolves to null if this load isn't a redirect return.
  //
  // Known Firebase quirk: getRedirectResult() can resolve with result=null
  // even when the Google sign-in actually succeeded (seen in some mobile/
  // in-app browsers where storage partitioning delays this promise past the
  // point the SDK already consumed the redirect). When that happens the user
  // gets stuck on the sign-up/sign-in page even though they're signed in.
  // onAuthStateChanged() below is the reliable fallback — it fires once the
  // SDK has actually finished processing auth state, redirect or not — so we
  // no longer rely on getRedirectResult() alone to send people onward.
  auth.getRedirectResult().then(async result => {
    if (result && result.user) {
      await initAccountOnServer(result.user.displayName || null);
      maybeLeaveAuthPage();
    }
  }).catch(err => {
    const box = document.getElementById('authError');
    if (box) { box.textContent = friendlyAuthError(err); box.style.display = 'block'; }
  });

  // Stall detector for the redirect path. If signInGoogle() had to fall
  // back to signInWithRedirect() (see above) and the storage hand-off gets
  // silently swallowed, the user lands back on /login or /signup signed
  // out with no error — otherwise a permanent, unexplained stall. Give
  // them an explicit way out instead.
  if (window.location.pathname === '/login' || window.location.pathname === '/signup') {
    let redirectPending = false;
    try { redirectPending = sessionStorage.getItem('msb_google_redirect_pending') === '1'; } catch (e) {}
    if (redirectPending) {
      setTimeout(() => {
        if (authRedirectHandled) return; // it worked — we've already left the page
        try { sessionStorage.removeItem('msb_google_redirect_pending'); } catch (e) {}
        const box = document.getElementById('authError');
        if (box) {
          box.textContent = "Google sign-in didn't complete in this browser. Please try email/password below, or open this site in Chrome or Safari instead of an in-app browser.";
          box.style.display = 'block';
        }
      }, 6000);
    }
  }

  // ---------------- Checkout gate ----------------
  // Called from main.js before letting someone pay. If signed out, remembers
  // that a checkout was in progress and sends them to /login; once signed in,
  // resumeCheckoutIfPending() (called after auth state resolves) picks it
  // back up automatically.
  function requireSignIn() {
    if (auth.currentUser) return true;
    try { sessionStorage.setItem('msb_resume_action', 'checkout'); } catch (e) {}
    window.location.href = '/login?returnTo=' + encodeURIComponent(window.location.pathname);
    return false;
  }

  function resumeCheckoutIfPending() {
    let pending = null;
    try { pending = sessionStorage.getItem('msb_resume_action'); } catch (e) {}
    if (pending === 'checkout' && auth.currentUser) {
      try { sessionStorage.removeItem('msb_resume_action'); } catch (e) {}
      if (typeof window.msbResumeCheckout === 'function') window.msbResumeCheckout();
    }
  }

  // ---------------- Header nav slot ----------------
  // Icon-only account button (matches the cart/wishlist icon buttons) —
  // avoids the "My Account ▾" text link crowding the header on narrow
  // screens and pushing the hamburger menu off-screen.
  const ACCOUNT_ICON_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" width="22" height="22"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path><circle cx="12" cy="7" r="4"></circle></svg>`;

  function renderNavSlot(user) {
    document.querySelectorAll('.acct-nav-slot').forEach(slot => {
      if (!user) {
        slot.innerHTML = `<a href="/login" class="icon-btn acct-icon-btn" aria-label="Sign in">${ACCOUNT_ICON_SVG}</a>`;
        return;
      }
      slot.innerHTML = `
        <div class="acct-menu">
          <button type="button" class="icon-btn acct-icon-btn" id="acctTrigger" aria-label="My Account">${ACCOUNT_ICON_SVG}</button>
          <div class="acct-dropdown" id="acctDropdown">
            <div class="acct-email">${(user.email || '').replace(/</g, '&lt;')}</div>
            <a href="/account#orders">Order History</a>
            <a href="/account#details">My Details</a>
            <button type="button" id="acctSignOutBtn">Sign Out</button>
          </div>
        </div>`;
      const trigger = document.getElementById('acctTrigger');
      const dropdown = document.getElementById('acctDropdown');
      trigger?.addEventListener('click', (e) => { e.stopPropagation(); dropdown.classList.toggle('show'); });
      document.addEventListener('click', () => dropdown && dropdown.classList.remove('show'));
      document.getElementById('acctSignOutBtn')?.addEventListener('click', () => auth.signOut());
    });
  }

  // Minimal CSS for the nav slot + dropdown (pages don't need to define this themselves)
  const style = document.createElement('style');
  style.textContent = `
    .acct-menu{position:relative;display:inline-block;}
    .acct-icon-btn{color:#1e293b;}
    .acct-dropdown{position:absolute;right:0;top:calc(100% + 8px);background:#fff;border-radius:12px;box-shadow:0 10px 30px rgba(0,0,0,0.15);min-width:180px;padding:8px;display:none;z-index:50;}
    .acct-dropdown.show{display:block;}
    .acct-dropdown a, .acct-dropdown button{display:block;width:100%;text-align:left;padding:9px 10px;border-radius:8px;border:none;background:none;font-size:0.85rem;font-weight:600;color:#334155;cursor:pointer;text-decoration:none;}
    .acct-dropdown a:hover, .acct-dropdown button:hover{background:#f1f5f9;}
    .acct-dropdown .acct-email{padding:8px 10px;font-size:0.72rem;color:#94a3b8;border-bottom:1px solid #f1f5f9;margin-bottom:4px;font-weight:600;word-break:break-all;}
  `;
  document.head.appendChild(style);

  // ---------------- Auth-ready promise ----------------
  // onAuthStateChanged() fires exactly once for the *first* resolution of
  // sign-in state, and that can happen as early as a microtask right after
  // this script finishes running (e.g. when Firebase's cached persistence
  // resolves fast on a warm IndexedDB). Pages that gate their first render
  // on the 'msb-auth-changed' event race that: if the event fires before
  // their own <script> block (further down the page) has attached its
  // listener, it's lost forever and the page is stuck on its skeleton with
  // nothing left to unstick it. authReady sidesteps the race — it's a
  // promise that's safe to consume whether auth already resolved (resolves
  // next microtask) or hasn't yet (resolves when it does).
  let authStateKnown = false;
  let resolveAuthReady;
  const authReadyPromise = new Promise(resolve => { resolveAuthReady = resolve; });

  auth.onAuthStateChanged(user => {
    renderNavSlot(user);
    if (user) {
      initAccountOnServer(user.displayName || null);
      // Safety net for the getRedirectResult() quirk above: if we're on
      // /login or /signup and the SDK now says we're signed in, leave.
      maybeLeaveAuthPage();
    }
    resumeCheckoutIfPending();
    authStateKnown = true;
    resolveAuthReady(user);
    window.dispatchEvent(new CustomEvent('msb-auth-changed', { detail: { user } }));
  });

  window.MSBAuth = {
    getUser: () => auth.currentUser,
    getIdToken: () => auth.currentUser ? auth.currentUser.getIdToken() : Promise.resolve(null),
    signOut: () => auth.signOut(),
    requireSignIn,
    signInEmail,
    signUpEmail,
    signInGoogle,
    friendlyAuthError,
    redirectAfterAuth,
    getReturnTo,
    isAuthStateKnown: () => authStateKnown,
    // Fires once, with the user (or null), whether auth already resolved
    // before this was called or resolves later. Use this instead of (or
    // alongside) the 'msb-auth-changed' event for a page's *first* render
    // decision — the event alone can be missed by late listeners.
    onAuthReady: (cb) => { authReadyPromise.then(cb); }
  };
})();
