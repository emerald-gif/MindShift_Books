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
  async function signInGoogle() {
    const provider = new firebase.auth.GoogleAuthProvider();
    const box = document.getElementById('authError');
    try {
      const result = await auth.signInWithPopup(provider);
      await initAccountOnServer(result.user.displayName || null);
      maybeLeaveAuthPage();
    } catch (err) {
      const code = err && err.code;
      const fallbackCodes = [
        'auth/popup-blocked',
        'auth/operation-not-supported-in-this-environment',
        'auth/popup-closed-by-user'
      ];
      if (code === 'auth/popup-blocked' || code === 'auth/operation-not-supported-in-this-environment') {
        // Popup genuinely can't open here — fall back to redirect.
        return auth.signInWithRedirect(provider);
      }
      if (fallbackCodes.includes(code)) return; // user closed it — no error needed
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
  function renderNavSlot(user) {
    document.querySelectorAll('.acct-nav-slot').forEach(slot => {
      if (!user) {
        slot.innerHTML = `<a href="/login" class="sign-in-link">Sign In</a>`;
        return;
      }
      const email = user.email || '';
      slot.innerHTML = `
        <div class="acct-menu">
          <span class="sign-in-link" id="acctTrigger">My Account ▾</span>
          <div class="acct-dropdown" id="acctDropdown">
            <div class="acct-email">${email.replace(/</g, '&lt;')}</div>
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
    .acct-dropdown{position:absolute;right:0;top:calc(100% + 8px);background:#fff;border-radius:12px;box-shadow:0 10px 30px rgba(0,0,0,0.15);min-width:180px;padding:8px;display:none;z-index:50;}
    .acct-dropdown.show{display:block;}
    .acct-dropdown a, .acct-dropdown button{display:block;width:100%;text-align:left;padding:9px 10px;border-radius:8px;border:none;background:none;font-size:0.85rem;font-weight:600;color:#334155;cursor:pointer;text-decoration:none;}
    .acct-dropdown a:hover, .acct-dropdown button:hover{background:#f1f5f9;}
    .acct-dropdown .acct-email{padding:8px 10px;font-size:0.72rem;color:#94a3b8;border-bottom:1px solid #f1f5f9;margin-bottom:4px;font-weight:600;word-break:break-all;}
    .sign-in-link{font-size:0.85rem;font-weight:700;color:#4f46e5;cursor:pointer;padding:8px 12px;white-space:nowrap;text-decoration:none;}
  `;
  document.head.appendChild(style);

  auth.onAuthStateChanged(user => {
    renderNavSlot(user);
    if (user) {
      initAccountOnServer(user.displayName || null);
      // Safety net for the getRedirectResult() quirk above: if we're on
      // /login or /signup and the SDK now says we're signed in, leave.
      maybeLeaveAuthPage();
    }
    resumeCheckoutIfPending();
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
    getReturnTo
  };
})();
