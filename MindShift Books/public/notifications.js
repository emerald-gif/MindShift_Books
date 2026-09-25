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
.notif-badge{position:absolute;top:2px;right:2px;background:linear-gradient(135deg,#f43f5e,#ef4444);color:#fff;font-size:10px;font-weight:800;min-width:17px;height:17px;border-radius:99px;display:none;align-items:center;justify-content:center;padding:0 4px;border:2px solid #fff;line-height:1;pointer-events:none;box-shadow:0 2px 6px rgba(239,68,68,.4);animation:nbadgepop .35s cubic-bezier(.34,1.56,.64,1)}
@keyframes nbadgepop{0%{transform:scale(0)}100%{transform:scale(1)}}

.notif-sheet{position:fixed;inset:0;z-index:2500;background:var(--bg,#f8fafc);display:flex;flex-direction:column;overflow:hidden;transform:translateX(100%);transition:transform .32s cubic-bezier(.32,0,.15,1);visibility:hidden}
.notif-sheet.on{transform:none;visibility:visible}

.notif-sheet-top{display:flex;align-items:center;gap:12px;padding:calc(12px + env(safe-area-inset-top,0px)) 16px 12px;flex-shrink:0;background:rgba(255,255,255,.88);-webkit-backdrop-filter:saturate(180%) blur(14px);backdrop-filter:saturate(180%) blur(14px);border-bottom:1px solid rgba(15,23,42,.06);position:relative;z-index:2}
.notif-back-btn{width:38px;height:38px;border-radius:50%;background:#f1f5f9;border:none;cursor:pointer;display:flex;align-items:center;justify-content:center;color:var(--txt,#0f172a);flex-shrink:0;transition:background .15s,transform .15s}
.notif-back-btn:active{transform:scale(.92);background:#e2e8f0}
.notif-sheet-titles{flex:1;min-width:0;display:flex;flex-direction:column;gap:1px}
.notif-sheet-title{font-size:19px;font-weight:900;color:var(--txt,#0f172a);letter-spacing:-.3px;line-height:1.15}
.notif-sheet-sub{font-size:12px;font-weight:700;color:var(--p,#4f46e5);display:none}
.notif-mark-all-btn{font-size:12px;font-weight:800;color:var(--p,#4f46e5);background:#eef2ff;border:none;cursor:pointer;padding:8px 13px;border-radius:99px;white-space:nowrap;transition:background .15s,transform .15s}
.notif-mark-all-btn:hover{background:#e0e7ff}
.notif-mark-all-btn:active{transform:scale(.95)}

.notif-list{flex:1;overflow-y:auto;-webkit-overflow-scrolling:touch;padding:4px 0 calc(28px + env(safe-area-inset-bottom,0px));overscroll-behavior:contain}
.notif-group-label{font-size:11.5px;font-weight:800;letter-spacing:.7px;text-transform:uppercase;color:var(--mute,#94a3b8);padding:18px 20px 8px}

.notif-empty{text-align:center;padding:72px 32px 40px}
.notif-empty-ico{width:84px;height:84px;margin:0 auto 18px;display:flex;align-items:center;justify-content:center;border-radius:50%;background:linear-gradient(135deg,#eef2ff,#e0f2fe);box-shadow:0 8px 24px rgba(79,70,229,.12)}
.notif-empty-ico svg{stroke:var(--p,#4f46e5)!important}
.notif-empty-ttl{font-size:17px;font-weight:900;color:var(--txt,#0f172a);margin-bottom:8px;letter-spacing:-.2px}
.notif-empty-sub{font-size:13.5px;color:var(--mute,#94a3b8);line-height:1.65;max-width:280px;margin:0 auto}

.notif-item{display:flex;align-items:flex-start;gap:13px;margin:4px 12px;padding:13px 14px;cursor:pointer;transition:background .15s,transform .15s,box-shadow .15s;position:relative;background:#fff;border-radius:16px;border:1px solid rgba(15,23,42,.05);animation:nitemin .35s ease both;-webkit-tap-highlight-color:transparent}
.notif-item:active{transform:scale(.985);background:#f8fafc}
.notif-item.unread{background:linear-gradient(90deg,#eef2ff 0%,#f5f8ff 100%);border-color:rgba(79,70,229,.14);box-shadow:0 2px 10px rgba(79,70,229,.07)}
.notif-item.unread::before{content:'';position:absolute;left:0;top:14px;bottom:14px;width:3px;border-radius:0 3px 3px 0;background:var(--p,#4f46e5)}
@keyframes nitemin{0%{opacity:0;transform:translateY(8px)}100%{opacity:1;transform:none}}

.notif-unread-dot{position:absolute;top:16px;right:14px;width:9px;height:9px;border-radius:50%;background:var(--p,#4f46e5);box-shadow:0 0 0 3px rgba(79,70,229,.16)}
.notif-unread-dot.invisible{display:none}

.notif-lead{position:relative;flex-shrink:0}
.notif-av{width:46px;height:46px;border-radius:50%;background:var(--g,linear-gradient(90deg,#4f46e5,#06b6d4));display:flex;align-items:center;justify-content:center;font-size:17px;font-weight:800;color:#fff;flex-shrink:0;overflow:hidden;border:2px solid #fff;box-shadow:0 1px 4px rgba(15,23,42,.12)}
.notif-av img{width:100%;height:100%;object-fit:cover;display:block}
.notif-av-stack{display:flex;flex-shrink:0;width:62px;height:46px;position:relative}
.notif-av-stack .notif-av-stacked{position:absolute;top:6px;width:34px;height:34px;border:2px solid #fff;font-size:13px}
.notif-av-stack .notif-av-stacked:nth-child(1){left:28px;z-index:3}
.notif-av-stack .notif-av-stacked:nth-child(2){left:14px;z-index:2}
.notif-av-stack .notif-av-stacked:nth-child(3){left:0;z-index:1}

.notif-type{position:absolute;right:-3px;bottom:-3px;width:21px;height:21px;border-radius:50%;display:flex;align-items:center;justify-content:center;border:2px solid #fff;color:#fff;z-index:5}
.notif-type svg{width:11px;height:11px;fill:none;stroke:currentColor;stroke-width:2.6;stroke-linecap:round;stroke-linejoin:round}
.notif-type.like{background:#ef4444}.notif-type.like svg{fill:currentColor;stroke:none}
.notif-type.follow{background:#4f46e5}
.notif-type.comment{background:#0ea5e9}
.notif-type.repost{background:#10b981}
.notif-type.ok{background:#10b981}
.notif-type.warn{background:#f59e0b}
.notif-type.info{background:#64748b}
.notif-type.mention{background:#7c3aed}
.notif-snip{color:#64748b}
.notif-item.unread .notif-snip{color:#475569}

.notif-body{flex:1;min-width:0;padding-top:1px;padding-right:14px}
.notif-msg{font-size:14px;color:#334155;line-height:1.5;word-wrap:break-word;overflow-wrap:anywhere}
.notif-msg strong{font-weight:800;color:var(--txt,#0f172a)}
.notif-item.unread .notif-msg{color:var(--txt,#0f172a)}
.notif-time{font-size:11.5px;color:var(--mute,#94a3b8);margin-top:4px;font-weight:700}
.notif-item.unread .notif-time{color:var(--p,#4f46e5)}

.notif-spinner-wrap{display:flex;flex-direction:column;align-items:center;justify-content:center;padding:48px;gap:12px;color:var(--mute,#9ca3af);font-size:13px;font-weight:600}
.notif-spinner{width:26px;height:26px;border:3px solid var(--border2,#e2e8f0);border-top-color:var(--p,#4f46e5);border-radius:50%;animation:nspin .7s linear infinite}
@keyframes nspin{0%{transform:rotate(0deg)}100%{transform:rotate(360deg)}}

.notif-skel{display:flex;gap:13px;margin:4px 12px;padding:14px;background:#fff;border-radius:16px;border:1px solid rgba(15,23,42,.05)}
.notif-skel-av,.notif-skel-l1,.notif-skel-l2{background:linear-gradient(90deg,#eef2f7 25%,#f8fafc 50%,#eef2f7 75%);background-size:200% 100%;animation:nshimmer 1.3s linear infinite}
.notif-skel-av{width:46px;height:46px;border-radius:50%;flex-shrink:0}
.notif-skel-lines{flex:1;display:flex;flex-direction:column;gap:9px;padding-top:6px}
.notif-skel-l1{height:11px;border-radius:6px;width:88%}
.notif-skel-l2{height:9px;border-radius:6px;width:34%}
@keyframes nshimmer{0%{background-position:200% 0}100%{background-position:-200% 0}}

@media (min-width:720px){
  .notif-sheet{left:auto;width:440px;box-shadow:-12px 0 40px rgba(15,23,42,.14)}
}
@media (prefers-reduced-motion:reduce){
  .notif-item,.notif-badge{animation:none}
  .notif-sheet{transition:none}
}
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
    <button class="notif-back-btn" onclick="closeNotifPanel()" aria-label="Back"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg></button>
    <div class="notif-sheet-titles">
      <span class="notif-sheet-title">Notifications</span>
      <span class="notif-sheet-sub" id="notifSheetSub"></span>
    </div>
    <button class="notif-mark-all-btn" id="notifMarkAllBtn" onclick="markAllRead()" style="display:none">Mark all read</button>
  </div>
  <div class="notif-list" id="notifList">
    <div class="notif-empty"><div class="notif-empty-ico"><svg width="38" height="38" fill="none" viewBox="0 0 24 24" stroke-width="1.6"><path stroke-linecap="round" stroke-linejoin="round" d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9"/></svg></div><div class="notif-empty-ttl">You&#39;re all caught up</div><div class="notif-empty-sub">Likes, follows, comments and reposts on your work will show up here.</div></div>
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
    case 'mention':      return `${name} mentioned you in ${n.targetType==='article'?'an article':'a post'}${n.targetTitle ? `<span class="notif-snip">: “${nEsc(nTrunc(n.targetTitle, 60))}”</span>` : ''}`;
    case 'repost':       return `${name} reposted your ${n.targetType==='post'?'post':'article'}${title}`;
    case 'repost_quote': return `${name} reposted your ${n.targetType==='post'?'post':'article'} with a caption${title}`;
    case 'admin_message':    return `<strong>${nEsc(n.title || 'Message from MindShift Books')}</strong>${n.message ? ' — ' + nEsc(n.message) : ''}`;
    case 'founding_creator_earned': return `<strong>${nEsc(n.title || 'You earned the Founding Creator badge!')}</strong>${n.message ? ' — ' + nEsc(n.message) : ''}`;
    case 'ebook_voucher_earned':    return `<strong>${nEsc(n.title || 'Your voucher is ready')}</strong>${n.message ? ' — ' + nEsc(n.message) : ''}`;
    case 'article_approved': return `<strong>${nEsc(n.title || 'Your article was approved!')}</strong>${n.message ? ' — ' + nEsc(n.message) : ''}`;
    case 'article_rejected': return `<strong>${nEsc(n.title || 'Article update')}</strong>${n.message ? ' — ' + nEsc(n.message) : ''}`;
    case 'article_removed': case 'post_removed': return `<strong>${nEsc(n.title || 'Content removed')}</strong>${n.message ? ' — ' + nEsc(n.message) : ''}`;
    default:              return `${name} interacted with you`;
  }
}
// Small coloured badge on the avatar so the kind of notification reads at a glance.
const N_ICONS = {
  heart:   '<svg viewBox="0 0 24 24"><path d="M20.84 4.61a5.5 5.5 0 00-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 00-7.78 7.78L12 21.23l8.84-8.84a5.5 5.5 0 000-7.78z"/></svg>',
  user:    '<svg viewBox="0 0 24 24"><path d="M16 21v-2a4 4 0 00-4-4H6a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/><line x1="19" y1="8" x2="19" y2="14"/><line x1="22" y1="11" x2="16" y2="11"/></svg>',
  comment: '<svg viewBox="0 0 24 24"><path d="M21 11.5a8.4 8.4 0 01-.9 3.8 8.5 8.5 0 01-7.6 4.7 8.4 8.4 0 01-3.8-.9L3 21l1.9-5.7a8.4 8.4 0 01-.9-3.8 8.5 8.5 0 014.7-7.6 8.4 8.4 0 013.8-.9h.5a8.5 8.5 0 018 8z"/></svg>',
  repost:  '<svg viewBox="0 0 24 24"><path d="M17 1l4 4-4 4"/><path d="M3 11V9a4 4 0 014-4h14"/><path d="M7 23l-4-4 4-4"/><path d="M21 13v2a4 4 0 01-4 4H3"/></svg>',
  check:   '<svg viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"/></svg>',
  alert:   '<svg viewBox="0 0 24 24"><line x1="12" y1="8" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
  at:      '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="4"/><path d="M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-3.92 7.94"/></svg>',
  bell:    '<svg viewBox="0 0 24 24"><path d="M18 8A6 6 0 006 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 01-3.46 0"/></svg>'
};
function nTypeBadge(type) {
  switch (type) {
    case 'article_like': case 'comment_like': return ['like', N_ICONS.heart];
    case 'follow':                            return ['follow', N_ICONS.user];
    case 'mention':                           return ['mention', N_ICONS.at];
    case 'new_comment': case 'comment_reply': return ['comment', N_ICONS.comment];
    case 'repost': case 'repost_quote':       return ['repost', N_ICONS.repost];
    case 'article_approved':                  return ['ok', N_ICONS.check];
    case 'founding_creator_earned': case 'ebook_voucher_earned': return ['ok', N_ICONS.check];
    case 'article_rejected': case 'article_removed': case 'post_removed': return ['warn', N_ICONS.alert];
    default:                                  return ['info', N_ICONS.bell];
  }
}
function nGroupLabel(ts) {
  if (!ts) return 'Earlier';
  const d = ts.toDate ? ts.toDate() : new Date(ts);
  const startToday = new Date(); startToday.setHours(0, 0, 0, 0);
  const diffDays = Math.floor((startToday.getTime() - d.getTime()) / 86400000) + 1;
  if (d >= startToday) return 'Today';
  if (diffDays <= 1) return 'Yesterday';
  if (diffDays <= 7) return 'This week';
  return 'Earlier';
}
function buildNotifItem(id, n, idx) {
  const unread = !n.read, msg = notifMessage(n), time = nTimeAgo(n.lastAt || n.createdAt);
  const photos = Array.isArray(n.actorPhotos) ? n.actorPhotos.filter(Boolean) : [];
  let avHtml;
  if (photos.length > 1) {
    // Stacked avatars for a grouped bucket — most recent actor on top,
    // capped at 3 shown regardless of how many are actually in the bucket.
    const shown = photos.slice(-3).reverse();
    avHtml = `<div class="notif-av-stack">${shown.map(p => `<div class="notif-av notif-av-stacked"><img src="${nEsc(p)}" alt="" onerror="this.style.display='none'"></div>`).join('')}</div>`;
  } else {
    const init = (n.actorName || 'M').charAt(0).toUpperCase(); // system messages (no actor) show an M for MindShift
    const avInner = n.actorPhoto ? `<img src="${nEsc(n.actorPhoto)}" alt="" onerror="this.style.display='none'">`
      : n.type === 'ebook_voucher_earned' ? `<span style="font-size:20px">🎁</span>`
      : init;
    avHtml = `<div class="notif-av">${avInner}</div>`;
  }
  const [kind, icon] = nTypeBadge(n.type);
  const delay = Math.min(idx || 0, 12) * 25;
  return `<div class="notif-item ${unread ? 'unread' : ''}" style="animation-delay:${delay}ms" onclick="handleNotifTap('${nEsc(id)}')"><span class="notif-unread-dot ${unread ? '' : 'invisible'}"></span><div class="notif-lead">${avHtml}<span class="notif-type ${kind}">${icon}</span></div><div class="notif-body"><div class="notif-msg">${msg}</div><div class="notif-time">${time}</div></div></div>`;
}
function buildNotifList(docs) {
  let last = '', idx = 0;
  return docs.map(d => {
    const data = d.data();
    const label = nGroupLabel(data.lastAt || data.createdAt);
    const head = label !== last ? `<div class="notif-group-label">${label}</div>` : '';
    last = label;
    return head + buildNotifItem(d.id, data, idx++);
  }).join('');
}
function notifSkeleton() {
  const row = '<div class="notif-skel"><div class="notif-skel-av"></div><div class="notif-skel-lines"><div class="notif-skel-l1"></div><div class="notif-skel-l2"></div></div></div>';
  return row.repeat(5);
}

import { retryRead } from '/resilient.js';

// Sends one "X mentioned you" notification per mentioned person. Standalone on purpose: the composer
// page has no bell/panel, so it can't use initNotificationUI. The doc id is deterministic
// (mention_<type>_<targetId>_<recipient>), so editing a post never notifies the same person twice —
// only people newly added to the post get a notification.
export async function sendMentionNotifications({ db, fs, currentUser, profile, mentions, targetId, targetType, snippet }) {
  const { doc, getDoc, setDoc, serverTimestamp } = fs;
  if (!currentUser || !targetId || !Array.isArray(mentions) || !mentions.length) return;
  const actorName = (profile && profile.name) || currentUser.displayName || 'Someone';
  const actorPhoto = (profile && profile.photo) || currentUser.photoURL || '';
  const actorUsername = (profile && profile.username) || '';
  const title = String(snippet || '').replace(/\s+/g, ' ').trim().slice(0, 80);
  await Promise.all(mentions.slice(0, 10).map(async m => {
    if (!m || !m.uid || m.uid === currentUser.uid) return;
    const id = `mention_${targetType || 'post'}_${targetId}_${m.uid}`;
    try {
      const ref = doc(db, 'notifications', id);
      if ((await getDoc(ref)).exists()) return;
      await setDoc(ref, {
        recipientUid: m.uid, type: 'mention', actorUid: currentUser.uid, actorName, actorPhoto, actorUsername,
        targetId, targetTitle: title, targetType: targetType || 'post',
        read: false, createdAt: serverTimestamp(), lastAt: serverTimestamp()
      });
    } catch (e) { console.warn('mention notification failed for', m.uid, e && e.code); }
  }));
}

export function initNotificationUI({ db, getCurrentUser, getMyProfile, fs }) {
  injectStylesOnce();
  injectPanelOnce();

  const { collection, query, where, onSnapshot, getDocs, getCountFromServer, orderBy, limit, addDoc, writeBatch, serverTimestamp, doc, getDoc, setDoc, runTransaction } = fs;
  const notifCache = new Map();

  // Short-lived list cache: reopening the panel within a minute re-uses the list
  // already fetched (0 reads) instead of querying Firestore again. Expires on its
  // own, is dropped on sign-out, and is updated in place by markAllRead.
  const LIST_CACHE_MS = 60 * 1000;
  let listDocs = null, listUid = null, listAt = 0;
  // null = not known yet. Lets closing the panel skip the "mark all read" query
  // when we already know nothing is unread.
  let badgeCount = null, listUnread = null;

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
    badgeCount = count;
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
    listDocs = null; listUid = null; listAt = 0; badgeCount = null; listUnread = null;
    const badge = document.getElementById('notifBadge');
    if (badge) badge.style.display = 'none';
    const wrap = document.getElementById('notifWrap');
    if (wrap) wrap.style.display = 'none';
  }

  function renderList(docs) {
    const listEl = document.getElementById('notifList');
      if (!docs.length) {
        listEl.innerHTML = '<div class="notif-empty"><div class="notif-empty-ico"><svg width="38" height="38" fill="none" viewBox="0 0 24 24" stroke-width="1.6"><path stroke-linecap="round" stroke-linejoin="round" d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9"/></svg></div><div class="notif-empty-ttl">You&#39;re all caught up</div><div class="notif-empty-sub">Likes, follows, comments and reposts on your work will show up here.</div></div>';
        const subE = document.getElementById('notifSheetSub'); if (subE) subE.style.display = 'none';
        document.getElementById('notifMarkAllBtn').style.display = 'none';
        listUnread = 0;
        return;
      }
      const unreadCount = docs.filter(d => !d.data().read).length;
      document.getElementById('notifMarkAllBtn').style.display = unreadCount ? 'block' : 'none';
      const subEl = document.getElementById('notifSheetSub');
      if (subEl) { subEl.textContent = unreadCount + ' new'; subEl.style.display = unreadCount ? 'block' : 'none'; }
      listUnread = unreadCount;
      listEl.innerHTML = buildNotifList(docs);
  }

  async function loadNotifications() {
    const currentUser = getCurrentUser();
    if (!currentUser) return;
    // Fresh enough? Show what we already have — no query, no skeleton flash.
    if (listDocs && listUid === currentUser.uid && Date.now() - listAt < LIST_CACHE_MS) {
      renderList(listDocs);
      return;
    }
    const listEl = document.getElementById('notifList');
    listEl.innerHTML = notifSkeleton();
    try {
      const q = query(collection(db, 'notifications'), where('recipientUid', '==', currentUser.uid), orderBy('lastAt', 'desc'), limit(40));
      // Timeout + retry: a dead connection used to leave this spinner forever.
      const snap = await retryRead(() => getDocs(q), { tries: 2, timeoutMs: 10000 });
      notifCache.clear();
      snap.docs.forEach(d => notifCache.set(d.id, d.data()));
      // Plain copies so the cache can be edited (marked read) without another read.
      listDocs = snap.docs.map(d => { const data = d.data(); return { id: d.id, data: () => data }; });
      listUid = currentUser.uid; listAt = Date.now();
      renderList(listDocs);
    } catch (e) {
      listEl.innerHTML = '<div class="notif-empty"><div class="notif-empty-ico"><svg width="44" height="44" fill="none" viewBox="0 0 24 24" stroke="#9ca3af" stroke-width="1.5"><path stroke-linecap="round" stroke-linejoin="round" d="M12 9v3.75m0 3.75h.008M10.29 3.86l-8.18 14.18A1.5 1.5 0 003.42 20.5h17.16a1.5 1.5 0 001.31-2.46L13.71 3.86a1.5 1.5 0 00-2.42 0z"/></svg></div><div class="notif-empty-ttl">Couldn&#39;t load</div><div class="notif-empty-sub">Check your connection and try again.</div><button onclick="retryNotifs()" style="margin-top:14px;background:linear-gradient(135deg,#4f46e5,#6366f1);color:#fff;border:none;padding:10px 24px;border-radius:99px;font-size:13px;font-weight:800;cursor:pointer;box-shadow:0 4px 14px rgba(79,70,229,.3)">Try again</button></div>';
    }
  }

  window.retryNotifs = function () { listAt = 0; loadNotifications(); };

  window.openNotifPanel = function () {
    document.getElementById('notifSheet').classList.add('on');
    document.body.style.overflow = 'hidden';
    loadNotifications();
  };
  window.closeNotifPanel = function () {
    document.getElementById('notifSheet').classList.remove('on');
    document.body.style.overflow = '';
    if (badgeCount === 0 && listUnread === 0) return; // nothing unread — skip the query
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
      case 'article_like': case 'new_comment': case 'comment_like': case 'comment_reply': case 'repost': case 'repost_quote': case 'mention':
        if (n.targetId) location.href = (n.targetType === 'post' ? '/post-read' : '/article-read') + `?id=${n.targetId}`;
        break;
      case 'article_approved':
        if (n.articleId) location.href = `/article-read?id=${n.articleId}`; break;
      case 'article_rejected': case 'admin_message': case 'article_removed': case 'post_removed':
        location.href = `/profile`; break;
      case 'founding_creator_earned':
        location.href = `/founding-creator`; break;
      case 'ebook_voucher_earned':
        location.href = `/books`; break;
    }
  };
  window.markAllRead = async function () {
    const currentUser = getCurrentUser();
    if (!currentUser) return;
    try {
      const q = query(collection(db, 'notifications'), where('recipientUid', '==', currentUser.uid), where('read', '==', false));
      const snap = await getDocs(q);
      if (snap.empty) { listUnread = 0; return; }
      const batch = writeBatch(db);
      snap.docs.forEach(d => batch.update(d.ref, { read: true }));
      await batch.commit();
      if (listDocs) listDocs.forEach(d => { d.data().read = true; });
      listUnread = 0;
      const btn = document.getElementById('notifMarkAllBtn');
      if (btn) btn.style.display = 'none';
      const subM = document.getElementById('notifSheetSub'); if (subM) subM.style.display = 'none';
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
    const currentUser = getCurrentUser();           // may be null — logged-out visitors count too
    if (!targetUid || (currentUser && targetUid === currentUser.uid)) return;
    // Cheap client-side skip: one request per profile per tab session. The server
    // is the real dedup (one count per viewer per profile per calendar day).
    const skipKey = `msb_pv_${targetUid}`;
    try { if (sessionStorage.getItem(skipKey)) return; } catch (e) {}
    try {
      const headers = { 'Content-Type': 'application/json' };
      const body = { targetUid };
      if (currentUser) {
        headers.Authorization = `Bearer ${await currentUser.getIdToken()}`;
      } else {
        let anonId = '';
        try { anonId = localStorage.getItem('msb_anon_id') || ''; } catch (e) {}
        if (!anonId) {
          anonId = (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2) + Date.now()).replace(/[^A-Za-z0-9_-]/g, '');
          try { localStorage.setItem('msb_anon_id', anonId); } catch (e) {}
        }
        body.anonId = anonId;
      }
      const resp = await fetch('/api/profile/track-view', { method: 'POST', headers, body: JSON.stringify(body) });
      if (!resp.ok) { console.error('trackProfileView: server rejected the view', resp.status); return; }
      try { sessionStorage.setItem(skipKey, '1'); } catch (e) {}
    } catch (e) {
      console.error('trackProfileView failed:', e);
    }
  }

  return { initNotifications, clearNotifications, notifyArticleLike, notifyFollow, notifyComment, notifyRepost, trackProfileView };
}
