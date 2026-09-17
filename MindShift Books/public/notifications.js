// public/notifications.js
//
// Single shared implementation of the notification bell + panel, used by
// every article-ecosystem page that has the acct-nav-slot header (articles,
// article-read, profile, and any future page that gets the shared header).
// Previously this ~150-line system was pasted into articles.html only —
// which is exactly the "scattered" problem to avoid: one page had a working
// bell, the rest had none. Now there's exactly one copy; every page just
// calls initNotificationUI() and wires two lines into its own auth listener.
//
// Usage (inside a page's own <script type="module">, which already has its
// own `db` and already imported these exact Firestore functions for its own
// use — passed in here rather than re-imported, so there's only ever one
// Firestore SDK import per page):
//
//   import { initNotificationUI } from '/notifications.js';
//   const notif = initNotificationUI({
//     db,
//     getCurrentUser: () => currentUser,
//     getMyProfile:   () => myProfile,
//     fs: { collection, query, where, onSnapshot, getDocs, getCountFromServer, orderBy, limit, addDoc, writeBatch, serverTimestamp }
//   });
//
//   onAuthStateChanged(auth, user => {
//     if (user) notif.initNotifications(user.uid);
//     else notif.clearNotifications();
//   });
//
//   // wherever a like actually happens on that page:
//   notif.notifyArticleLike(article);
//
// The bell markup itself (<div class="notif-wrap" id="notifWrap">...) still
// lives in each page's shared header block, same as before — this module
// only injects the CSS and the slide-in panel, and wires the behavior.

let cssInjected = false;
let panelInjected = false;

function injectStylesOnce() {
  if (cssInjected) return;
  cssInjected = true;
  const style = document.createElement('style');
  style.textContent = `
.notif-wrap{position:relative;flex-shrink:0}
.notif-badge{position:absolute;top:2px;right:2px;background:var(--red,#ef4444);color:#fff;font-size:10px;font-weight:800;min-width:16px;height:16px;border-radius:99px;display:none;align-items:center;justify-content:center;padding:0 3px;border:2px solid #fff;line-height:1;pointer-events:none}
.notif-sheet{position:fixed;inset:0;z-index:2500;background:var(--bg,#fff);display:flex;flex-direction:column;overflow:hidden;transform:translateX(100%);transition:transform .3s cubic-bezier(.32,0,.15,1)}
.notif-sheet.on{transform:none}
.notif-sheet-top{display:flex;align-items:center;gap:12px;padding:14px 20px 12px;flex-shrink:0;border-bottom:1px solid var(--border,#e5e7eb)}
.notif-sheet-title{font-size:16px;font-weight:900;color:var(--txt,#0f172a);flex:1}
.notif-mark-all-btn{font-size:12px;font-weight:700;color:var(--p,#4f46e5);background:none;border:none;cursor:pointer;padding:6px 10px;border-radius:8px}
.notif-mark-all-btn:hover{background:#eef2ff}
.notif-list{flex:1;overflow-y:auto;-webkit-overflow-scrolling:touch;padding-bottom:24px}
.notif-empty{text-align:center;padding:52px 24px 40px}
.notif-empty-ico{margin:0 auto 14px;display:flex;align-items:center;justify-content:center}
.notif-empty-ttl{font-size:15px;font-weight:800;color:var(--txt,#0f172a);margin-bottom:6px}
.notif-empty-sub{font-size:13px;color:var(--mute,#9ca3af);line-height:1.6}
.notif-item{display:flex;align-items:flex-start;gap:12px;padding:13px 20px 13px 16px;cursor:pointer;transition:background .15s;position:relative;border-bottom:1px solid #eef2ff}
.notif-item:active{background:#eef2ff}
.notif-item.unread{background:#eef2ff}
.notif-unread-dot{width:6px;height:6px;border-radius:50%;background:var(--p,#4f46e5);flex-shrink:0;margin-top:7px}
.notif-unread-dot.invisible{visibility:hidden}
.notif-av{width:44px;height:44px;border-radius:50%;background:var(--g,linear-gradient(90deg,#4f46e5,#06b6d4));display:flex;align-items:center;justify-content:center;font-size:16px;font-weight:800;color:#fff;flex-shrink:0;overflow:hidden;border:2px solid var(--border,#e5e7eb)}
.notif-av img{width:100%;height:100%;object-fit:cover;display:block}
.notif-av-stack{display:flex;flex-shrink:0;width:60px;height:44px;position:relative}
.notif-av-stack .notif-av-stacked{position:absolute;top:6px;width:34px;height:34px;border:2px solid #fff}
.notif-av-stack .notif-av-stacked:nth-child(1){left:26px;z-index:3}
.notif-av-stack .notif-av-stacked:nth-child(2){left:13px;z-index:2}
.notif-av-stack .notif-av-stacked:nth-child(3){left:0;z-index:1}
.notif-body{flex:1;min-width:0;padding-top:2px}
.notif-msg{font-size:13.5px;color:var(--txt,#0f172a);line-height:1.46}
.notif-msg strong{font-weight:800}
.notif-time{font-size:11px;color:var(--mute,#9ca3af);margin-top:3px;font-weight:600}
.notif-spinner-wrap{display:flex;flex-direction:column;align-items:center;justify-content:center;padding:48px;gap:12px;color:var(--mute,#9ca3af);font-size:13px;font-weight:600}
.notif-spinner{width:26px;height:26px;border:3px solid var(--border2,#e2e8f0);border-top-color:var(--p,#4f46e5);border-radius:50%;animation:nspin .7s linear infinite}
@keyframes nspin{0%{transform:rotate(0deg)}100%{transform:rotate(360deg)}}
`;
  document.head.appendChild(style);
}

function injectPanelOnce() {
  if (panelInjected) return;
  panelInjected = true;
  const wrap = document.createElement('div');
  wrap.innerHTML = `
<div class="notif-sheet" id="notifSheet">
  <div class="notif-sheet-top">
    <button onclick="closeNotifPanel()" aria-label="Back" style="background:none;border:none;padding:4px 8px 4px 0;cursor:pointer;display:flex;align-items:center;color:var(--txt)"><svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg></button>
    <span class="notif-sheet-title">Notifications</span>
    <button class="notif-mark-all-btn" id="notifMarkAllBtn" onclick="markAllRead()" style="display:none">Mark all read</button>
  </div>
  <div class="notif-list" id="notifList">
    <div class="notif-empty">
      <div class="notif-empty-ico"><svg width="44" height="44" fill="none" viewBox="0 0 24 24" stroke="#9ca3af" stroke-width="1.5"><path stroke-linecap="round" stroke-linejoin="round" d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9"/></svg></div>
      <div class="notif-empty-ttl">No notifications yet</div>
      <div class="notif-empty-sub">When someone likes your article, follows you, or views your profile, you&#39;ll see it here.</div>
    </div>
  </div>
</div>`;
  document.body.appendChild(wrap.firstElementChild);
}

function nEsc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'); }
function nTrunc(s, n) { return s.length > n ? s.slice(0, n) + '…' : s; }
function nTimeAgo(ts) {
  if (!ts) return '';
  const date = ts.toDate ? ts.toDate() : new Date(ts);
  const sec = (Date.now() - date.getTime()) / 1000;
  if (sec < 60) return 'just now';
  if (sec < 3600) return Math.floor(sec / 60) + 'm ago';
  if (sec < 86400) return Math.floor(sec / 3600) + 'h ago';
  if (sec < 604800) return Math.floor(sec / 86400) + 'd ago';
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}
// Likes/follows/reposts pile up fast when something takes off — nobody
// wants 15 separate "X liked your post" rows. Grouped types render as
// "Alice liked your post" for one person, "Alice and Bob liked your post"
// for two, "Alice, Bob and 6 others liked your post" beyond that — using
// however many actor names the bucket actually has on hand (capped at 5,
// see upsertGrouped) plus the real total count for the "N others" part.
// Comments deliberately never go through this — a comment has real
// content worth seeing on its own line, collapsing it into a headcount
// would just hide the thing you'd actually want to read.
function actorListText(n) {
  const names = (Array.isArray(n.actorNames) && n.actorNames.length) ? n.actorNames : [n.actorName || 'Someone'];
  const total = n.totalCount || names.length;
  if (total <= 1) return `<strong>${nEsc(names[0] || 'Someone')}</strong>`;
  if (total === 2) return `<strong>${nEsc(names[0])}</strong> and <strong>${nEsc(names[1] || names[0])}</strong>`;
  const others = total - 2;
  return `<strong>${nEsc(names[0])}</strong>, <strong>${nEsc(names[1] || names[0])}</strong> and ${others} other${others === 1 ? '' : 's'}`;
}
function notifMessage(n) {
  const name = actorListText(n);
  const title = n.targetTitle ? ` <strong>${nEsc(nTrunc(n.targetTitle, 45))}</strong>` : '';
  switch (n.type) {
    case 'follow':       return `${name} started following you`;
    case 'article_like': return `${name} liked your ${n.targetType==='post'?'post':'article'}${title}`;
    case 'comment_like': return `${name} liked your comment on${title}`;
    case 'new_comment':  return `${name} commented on your ${n.targetType==='post'?'post':'article'}${title}`;
    case 'comment_reply':return `${name} replied to your comment on${title}`;
    case 'repost':       return `${name} reposted your ${n.targetType==='post'?'post':'article'}${title}`;
    case 'repost_quote': return `${name} reposted your ${n.targetType==='post'?'post':'article'} with a caption${title}`;
    case 'admin_message':    return `<strong>${nEsc(n.title || 'Message from MindShift Books')}</strong>${n.message ? ' — ' + nEsc(n.message) : ''}`;
    case 'article_approved': return `<strong>${nEsc(n.title || 'Your article was approved!')}</strong>${n.message ? ' — ' + nEsc(n.message) : ''}`;
    case 'article_rejected': return `<strong>${nEsc(n.title || 'Article update')}</strong>${n.message ? ' — ' + nEsc(n.message) : ''}`;
    case 'article_removed': case 'post_removed': return `<strong>${nEsc(n.title || 'Content removed')}</strong>${n.message ? ' — ' + nEsc(n.message) : ''}`;
    default:              return `${name} interacted with you`;
  }
}
function buildNotifItem(id, n) {
  const unread = !n.read, msg = notifMessage(n), time = nTimeAgo(n.lastAt || n.createdAt);
  const photos = Array.isArray(n.actorPhotos) ? n.actorPhotos.filter(Boolean) : [];
  let avHtml;
  if (photos.length > 1) {
    // Stacked avatars for a grouped bucket — most recent actor on top,
    // capped at 3 shown regardless of how many are actually in the bucket.
    const shown = photos.slice(-3).reverse();
    avHtml = `<div class="notif-av-stack">${shown.map(p => `<div class="notif-av notif-av-stacked"><img src="${nEsc(p)}" alt="" onerror="this.style.display='none'"></div>`).join('')}</div>`;
  } else {
    const init = (n.actorName || '?').charAt(0).toUpperCase();
    const avInner = n.actorPhoto ? `<img src="${nEsc(n.actorPhoto)}" alt="" onerror="this.style.display='none'">` : init;
    avHtml = `<div class="notif-av">${avInner}</div>`;
  }
  return `<div class="notif-item ${unread ? 'unread' : ''}" onclick="handleNotifTap('${nEsc(id)}')"><span class="notif-unread-dot ${unread ? '' : 'invisible'}"></span>${avHtml}<div class="notif-body"><div class="notif-msg">${msg}</div><div class="notif-time">${time}</div></div></div>`;
}

export function initNotificationUI({ db, getCurrentUser, getMyProfile, fs }) {
  injectStylesOnce();
  injectPanelOnce();

  const { collection, query, where, onSnapshot, getDocs, getCountFromServer, orderBy, limit, addDoc, writeBatch, serverTimestamp, doc, getDoc, setDoc, runTransaction } = fs;
  const notifCache = new Map();

  // Likes, follows, and reposts land in a shared 3-hour bucket per
  // (type, target-or-recipient) instead of one doc per event — see the
  // module-level notes above for the full reasoning. The window number is
  // just current-time-divided-by-3-hours, so two people acting near each
  // other compute the SAME bucket id independently, with no lookup query
  // needed to find "the open one".
  const GROUP_WINDOW_MS = 3 * 60 * 60 * 1000;
  function groupWindowIndex() { return Math.floor(Date.now() / GROUP_WINDOW_MS); }

  // Reads the bucket and decides, in one transaction, whether this actor is
  // starting it, joining it, or (if they already acted in this window)
  // being ignored — a like→unlike→like within the same window shouldn't
  // duplicate them in the list or re-open something they already caused.
  // Joining an existing bucket always sets read:false, even if the
  // recipient had already seen the earlier version — a new person showing
  // up is new information and deserves to resurface, not stay buried under
  // a dot they already dismissed.
  async function upsertGrouped(bucketId, info) {
    const ref = doc(db, 'notifications', bucketId);
    try {
      await runTransaction(db, async (tx) => {
        const snap = await tx.get(ref);
        if (!snap.exists()) {
          tx.set(ref, {
            recipientUid: info.recipientUid, type: info.type,
            targetId: info.targetId || null, targetTitle: info.targetTitle || '', targetType: info.targetType || 'post',
            actorUid: info.actorUid, actorName: info.actorName, actorPhoto: info.actorPhoto, actorUsername: info.actorUsername || '',
            actorUids: [info.actorUid], actorNames: [info.actorName], actorPhotos: [info.actorPhoto],
            totalCount: 1, grouped: true,
            read: false, createdAt: serverTimestamp(), lastAt: serverTimestamp()
          });
          return;
        }
        const data = snap.data();
        const actorUids = Array.isArray(data.actorUids) ? data.actorUids : (data.actorUid ? [data.actorUid] : []);
        if (actorUids.includes(info.actorUid)) return; // already counted this person in this window
        tx.update(ref, {
          actorUids: [...actorUids, info.actorUid].slice(-5),
          actorNames: [...(data.actorNames || [data.actorName]).filter(Boolean), info.actorName].slice(-5),
          actorPhotos: [...(data.actorPhotos || [data.actorPhoto]).filter(Boolean), info.actorPhoto].slice(-5),
          actorUid: info.actorUid, actorName: info.actorName, actorPhoto: info.actorPhoto, actorUsername: info.actorUsername || '',
          totalCount: (data.totalCount || actorUids.length || 1) + 1,
          read: false, lastAt: serverTimestamp()
        });
      });
    } catch (e) {}
  }

  function updateBadge(count) {
    const badge = document.getElementById('notifBadge');
    const wrap = document.getElementById('notifWrap');
    if (wrap) wrap.style.display = 'block';
    if (!badge) return;
    if (count > 0) { badge.textContent = count > 9 ? '9+' : String(count); badge.style.display = 'flex'; }
    else badge.style.display = 'none';
  }

  // Was a live onSnapshot query listener, re-attached from scratch on every
  // single page load (this is a multi-page site, not an SPA — the whole
  // module re-runs on every navigation). Firestore bills a fresh read for
  // every matching unread doc on that first snapshot, with an unbounded
  // query and zero benefit from "live" updates since the page unloads on
  // the next click anyway. Swapped for a single getCountFromServer() call:
  // one aggregation read per page load instead of one read per unread
  // notification, and no lingering listener to unsubscribe.
  function initNotifications(uid) {
    const q = query(collection(db, 'notifications'), where('recipientUid', '==', uid), where('read', '==', false));
    getCountFromServer(q).then(snap => updateBadge(snap.data().count)).catch(() => {});
  }

  function clearNotifications() {
    const badge = document.getElementById('notifBadge');
    if (badge) badge.style.display = 'none';
    const wrap = document.getElementById('notifWrap');
    if (wrap) wrap.style.display = 'none';
  }

  async function loadNotifications() {
    const currentUser = getCurrentUser();
    if (!currentUser) return;
    const listEl = document.getElementById('notifList');
    listEl.innerHTML = '<div class="notif-spinner-wrap"><div class="notif-spinner"></div>Loading…</div>';
    try {
      const q = query(collection(db, 'notifications'), where('recipientUid', '==', currentUser.uid), orderBy('lastAt', 'desc'), limit(40));
      const snap = await getDocs(q);
      notifCache.clear();
      snap.docs.forEach(d => notifCache.set(d.id, d.data()));
      if (snap.empty) {
        listEl.innerHTML = '<div class="notif-empty"><div class="notif-empty-ico"><svg width="44" height="44" fill="none" viewBox="0 0 24 24" stroke="#9ca3af" stroke-width="1.5"><path stroke-linecap="round" stroke-linejoin="round" d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9"/></svg></div><div class="notif-empty-ttl">No notifications yet</div><div class="notif-empty-sub">When someone likes your article, follows you, or views your profile, you&#39;ll see it here.</div></div>';
        document.getElementById('notifMarkAllBtn').style.display = 'none';
        return;
      }
      const hasUnread = snap.docs.some(d => !d.data().read);
      document.getElementById('notifMarkAllBtn').style.display = hasUnread ? 'block' : 'none';
      listEl.innerHTML = snap.docs.map(d => buildNotifItem(d.id, d.data())).join('');
    } catch (e) {
      listEl.innerHTML = '<div class="notif-empty"><div class="notif-empty-ico"><svg width="44" height="44" fill="none" viewBox="0 0 24 24" stroke="#9ca3af" stroke-width="1.5"><path stroke-linecap="round" stroke-linejoin="round" d="M12 9v3.75m0 3.75h.008M10.29 3.86l-8.18 14.18A1.5 1.5 0 003.42 20.5h17.16a1.5 1.5 0 001.31-2.46L13.71 3.86a1.5 1.5 0 00-2.42 0z"/></svg></div><div class="notif-empty-ttl">Couldn&#39;t load</div><div class="notif-empty-sub">Check your connection and try again.</div></div>';
    }
  }

  window.openNotifPanel = function () {
    document.getElementById('notifSheet').classList.add('on');
    document.body.style.overflow = 'hidden';
    loadNotifications();
  };
  window.closeNotifPanel = function () {
    document.getElementById('notifSheet').classList.remove('on');
    document.body.style.overflow = '';
    window.markAllRead();
  };
  window.handleNotifTap = function (id) {
    const n = notifCache.get(id); if (!n) return;
    window.closeNotifPanel();
    switch (n.type) {
      case 'follow':
        // actorUid is stable forever; actorUsername is a snapshot taken when
        // the notification was created and goes stale the moment the actor
        // renames (their old usernames/{handle} reservation gets deleted on
        // rename, so the @handle route 404s with "no profile found"). uid
        // is the reliable route — username is not used here on purpose.
        if (n.actorUid) location.href = `/profile?uid=${encodeURIComponent(n.actorUid)}`;
        else if (n.actorUsername) location.href = `/profile/@${encodeURIComponent(n.actorUsername)}`;
        break;
      case 'article_like': case 'new_comment': case 'comment_like': case 'comment_reply': case 'repost': case 'repost_quote':
        if (n.targetId) location.href = (n.targetType === 'post' ? '/post-read' : '/article-read') + `?id=${n.targetId}`;
        break;
      case 'article_approved':
        if (n.articleId) location.href = `/article-read?id=${n.articleId}`; break;
      case 'article_rejected': case 'admin_message': case 'article_removed': case 'post_removed':
        location.href = `/profile`; break;
    }
  };
  window.markAllRead = async function () {
    const currentUser = getCurrentUser();
    if (!currentUser) return;
    try {
      const q = query(collection(db, 'notifications'), where('recipientUid', '==', currentUser.uid), where('read', '==', false));
      const snap = await getDocs(q);
      if (snap.empty) return;
      const batch = writeBatch(db);
      snap.docs.forEach(d => batch.update(d.ref, { read: true }));
      await batch.commit();
      const btn = document.getElementById('notifMarkAllBtn');
      if (btn) btn.style.display = 'none';
      // Free client-side update — we already know everything just got
      // marked read, no need to pay for another getCountFromServer read.
      updateBadge(0);
    } catch (e) {}
  };

  // `kind` tells us whether the liked item is a 'post' or an 'article', since
  // the two live in separate Firestore collections and the notification tap
  // handler needs to know which read-page to route to. Callers that already
  // carry a `.type` field on the item (articles.html, profile.html feeds)
  // don't need to pass it — it's inferred. Callers on a page dedicated to one
  // content type only (article-read.html, post-read.html) should pass it
  // explicitly, since the article/post object built there has no `.type`.
  async function notifyArticleLike(art, kind) {
    const currentUser = getCurrentUser();
    if (!currentUser || !art) return;
    if (!art.authorUid || art.authorUid === currentUser.uid) return;
    const targetType = kind || (art.type === 'post' ? 'post' : 'article');
    const myProfile = getMyProfile ? getMyProfile() : null;
    const actorName = myProfile?.name || 'Someone', actorPhoto = myProfile?.photo || '', actorUsername = myProfile?.username || '';
    const bucketId = `like_${art.id}_${groupWindowIndex()}`;
    await upsertGrouped(bucketId, {
      recipientUid: art.authorUid, type: 'article_like', targetId: art.id, targetTitle: art.title || '', targetType,
      actorUid: currentUser.uid, actorName, actorPhoto, actorUsername
    });
  }

  async function notifyFollow(targetUid) {
    const currentUser = getCurrentUser();
    if (!currentUser || !targetUid || targetUid === currentUser.uid) return;
    const myProfile = getMyProfile ? getMyProfile() : null;
    const actorName = myProfile?.name || 'Someone', actorPhoto = myProfile?.photo || '', actorUsername = myProfile?.username || '';
    const bucketId = `follow_${targetUid}_${groupWindowIndex()}`;
    await upsertGrouped(bucketId, {
      recipientUid: targetUid, type: 'follow', targetId: null, targetTitle: '', targetType: '',
      actorUid: currentUser.uid, actorName, actorPhoto, actorUsername
    });
  }

  // Covers all three comment-related notification types in one place — new
  // top-level comment on an article, a reply to a comment, and a like on a
  // comment. Unlike notifyArticleLike/notifyFollow, the recipient is passed
  // in explicitly rather than derived from the article: a reply's recipient
  // is the parent comment's author, not necessarily the article's author, so
  // the caller (which already knows the comment tree) resolves that and just
  // tells this function who to notify.
  async function notifyComment({ type, recipientUid, articleId, articleTitle, commentId, contentType }) {
    const currentUser = getCurrentUser();
    if (!currentUser || !recipientUid || recipientUid === currentUser.uid) return;
    const myProfile = getMyProfile ? getMyProfile() : null;
    const actorName = myProfile?.name || 'Someone', actorPhoto = myProfile?.photo || '', actorUsername = myProfile?.username || '';
    const payload = {
      recipientUid, type, actorUid: currentUser.uid, actorName, actorPhoto, actorUsername,
      targetId: articleId || null, targetTitle: articleTitle || '', commentId: commentId || null,
      targetType: contentType || 'article',
      read: false, createdAt: serverTimestamp(), lastAt: serverTimestamp()
    };
    if (type === 'comment_like' && commentId) {
      // Deterministic doc ID: liking/unliking the same comment repeatedly
      // re-sends the same doc ID (one getDoc) instead of ever piling up
      // duplicate "X liked your comment" notifications.
      const dedupId = `clike_${currentUser.uid}_${commentId}`;
      try {
        const existing = await getDoc(doc(db, 'notifications', dedupId));
        if (existing.exists()) return;
        await setDoc(doc(db, 'notifications', dedupId), payload);
      } catch (e) {}
      return;
    }
    try { await addDoc(collection(db, 'notifications'), payload); } catch (e) {}
  }

  // Covers both repost kinds — the recipient is always whoever's content
  // got directly reposted (the target passed in), matching the "point at
  // what you directly reposted, not the root" rule: reposting a repost
  // notifies the reposter, not the original author further back.
  async function notifyRepost({ recipientUid, targetId, targetTitle, targetType, kind }) {
    const currentUser = getCurrentUser();
    if (!currentUser || !recipientUid || recipientUid === currentUser.uid) return;
    const myProfile = getMyProfile ? getMyProfile() : null;
    const actorName = myProfile?.name || 'Someone', actorPhoto = myProfile?.photo || '', actorUsername = myProfile?.username || '';
    const type = kind === 'quote' ? 'repost_quote' : 'repost';
    const bucketId = `${type}_${targetId}_${groupWindowIndex()}`;
    await upsertGrouped(bucketId, {
      recipientUid, type, targetId: targetId || null, targetTitle: targetTitle || '', targetType: targetType || 'post',
      actorUid: currentUser.uid, actorName, actorPhoto, actorUsername
    });
  }

  // Profile views are analytics, not an actionable alert — nobody needs a
  // bell notification every time someone looks at their profile, but an
  // author does want to know their view count on Insights.
  //
  // This used to write straight to Firestore from the client — a direct
  // increment of profileViewCount on the PROFILE OWNER's user doc, from
  // whoever happened to be viewing it. That's very likely why the counter
  // was stuck at 0: most Firestore rule setups only let a user write their
  // own users/{uid} doc, so a viewer incrementing someone else's counter
  // was probably being rejected every time — and the old code caught and
  // silently dropped that error, so the failure never surfaced anywhere.
  // Now it just calls the server, which does the write with the Admin SDK
  // (always bypasses security rules) and actually logs failures.
  async function trackProfileView(targetUid) {
    const currentUser = getCurrentUser();
    if (!currentUser || !targetUid || targetUid === currentUser.uid) return;
    // Cheap client-side skip: once this browser tab has already sent a view
    // for this profile, don't call the server again for the rest of the
    // session — cuts most of the repeat-request cost from someone
    // re-visiting or refreshing the same profile several times in one
    // sitting. This is purely a cost optimization, not the real dedup — the
    // server is still the source of truth (one count per viewer per
    // calendar day), so it's fine that this resets on a new tab or session.
    const skipKey = `msb_pv_${targetUid}`;
    try { if (sessionStorage.getItem(skipKey)) return; } catch (e) {}
    try {
      const idToken = await currentUser.getIdToken();
      const resp = await fetch('/api/profile/track-view', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${idToken}` },
        body: JSON.stringify({ targetUid })
      });
      if (!resp.ok) { console.error('trackProfileView: server rejected the view', resp.status, await resp.text().catch(()=>'')); return; }
      try { sessionStorage.setItem(skipKey, '1'); } catch (e) {}
    } catch (e) {
      console.error('trackProfileView failed:', e);
    }
  }

  return { initNotifications, clearNotifications, notifyArticleLike, notifyFollow, notifyComment, notifyRepost, trackProfileView };
}
