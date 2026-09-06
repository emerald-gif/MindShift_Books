// public/author-live.js
//
// WHY THIS EXISTS
// Articles, posts, and comments each save a *snapshot* of the author's
// name/photo at the moment they're created (authorName / authorPhoto).
// That snapshot is what lets a feed render instantly without a join.
// But it means editing your profile later never touches old content —
// only new posts pick up the new name/photo, because they copy it fresh
// at write time.
//
// This file fixes that on the read side: after any card/comment/header
// is painted with its snapshot values (for instant first paint), we look
// up the author's CURRENT profile from `users/{uid}` and swap the name
// and photo in place if they've changed. One read per distinct author
// per page load, cached, no matter how many cards they appear on.
//
// USAGE
//   1. Any element showing an author's name/photo gets a wrapping element
//      with data-author-uid="<uid>", plus children marked
//      data-author-name and/or data-author-photo.
//   2. After inserting HTML into the DOM, call:
//        window.MSBAuthorLive.refresh(db, { doc, getDoc }, container)
//      where `container` is the element you just filled (or document).
//
(function () {
  const cache = new Map(); // uid -> Promise<{name, photo} | null>

  function fetchLiveAuthor(db, docFns, uid) {
    if (!uid) return Promise.resolve(null);
    if (cache.has(uid)) return cache.get(uid);
    const { doc, getDoc } = docFns;
    const p = getDoc(doc(db, 'users', uid))
      .then((snap) => {
        if (!snap.exists()) return null;
        const d = snap.data() || {};
        return { name: d.name || null, photo: d.photo || null };
      })
      .catch(() => null);
    cache.set(uid, p);
    return p;
  }

  async function refresh(db, docFns, root) {
    const scope = root || document;
    const nodes = scope.querySelectorAll('[data-author-uid]');
    const uids = new Set();
    nodes.forEach((n) => {
      const uid = n.getAttribute('data-author-uid');
      if (uid) uids.add(uid);
    });
    if (!uids.size) return;

    await Promise.all(
      Array.from(uids).map(async (uid) => {
        const live = await fetchLiveAuthor(db, docFns, uid);
        if (!live) return;
        scope.querySelectorAll(`[data-author-uid="${CSS.escape(uid)}"]`).forEach((wrap) => {
          if (live.name) {
            const nameEl = wrap.querySelector('[data-author-name]');
            if (nameEl) nameEl.textContent = live.name;
          }
          if (live.photo) {
            const photoEl = wrap.querySelector('[data-author-photo]');
            if (photoEl) { photoEl.src = live.photo; photoEl.style.display = ''; }
          }
        });
      })
    );
  }

  // Call this once (e.g. right after a profile save succeeds) to make sure
  // a later refresh() on this same page re-fetches instead of reusing a
  // stale cached value for that uid.
  function invalidate(uid) {
    if (uid) cache.delete(uid);
    else cache.clear();
  }

  window.MSBAuthorLive = { refresh, invalidate };
})();
