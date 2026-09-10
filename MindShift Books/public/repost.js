// public/repost.js
//
// Single shared implementation of the Repost feature — the bottom-sheet
// drawer (plain repost / repost with caption), the actual Firestore writes,
// and the small "embedded card" renderer used everywhere a repost needs to
// show what it's reposting. Used by articles.html (feed), post-read.html,
// and article-read.html, same pattern as notifications.js: one copy, each
// page just imports it and wires its own Repost button to it.
//
// DATA MODEL
//   reposts/{id} — one doc per repost, either kind:
//     - reposterUid/reposterName/reposterPhoto/reposterUsername
//     - kind: 'plain' | 'quote'
//     - targetType: 'article' | 'post'   (the thing DIRECTLY reposted —
//       this can itself be another user's quote-repost post id; a repost
//       always points at what it directly reposted, never straight to the
//       root, so nesting is just a one-link-at-a-time chain — see the
//       Repost Card spec section for why)
//     - targetId
//     - targetSnapshot: {...denormalized preview, used for plain-repost
//       feed rendering so it never needs an extra read}
//     - quotePostId: string|null — for kind:'quote', the posts/{id} doc
//       that actually holds the caption + embed (so quote reposts ride on
//       all the existing post infrastructure: comments, likes, its own
//       read page — this doc is just the lightweight pointer used to list
//       "reposts by this user" later, e.g. on a profile tab)
//     - createdAt
//   Plain reposts use a DETERMINISTIC id (plain_<uid>_<type>_<id>) so
//   reposting/un-reposting is a simple setDoc/deleteDoc toggle, same
//   pattern as a like. Quote reposts use a random id — the same target can
//   be quote-reposted more than once with different captions.
//
//   posts/{id} — a quote repost is a completely normal post doc (same
//   fields as any other post: authorUid/authorName/authorPhoto, text is
//   the caption, publishedAt, commentsOff, hideLikeCount) plus:
//     - quotedFrom: { type:'article'|'post', id }
//     - quotedSnapshot: {...denormalized preview of the quoted content}
//
//   repostCounts/{targetId} — { count } — a denormalized counter,
//   incremented on whatever was directly reposted (same "point at what
//   you directly reposted" rule), mirroring the existing articleLikes/{id}
//   counter-doc pattern already used for likes.
//
// USAGE (inside a page's own <script type="module">):
//   import { initRepost } from '/repost.js';
//   const repost = initRepost({
//     db,
//     getCurrentUser: () => currentUser,
//     getMyProfile:   () => myProfile,
//     notif,   // the object returned by initNotificationUI()
//     fs: { doc, getDoc, setDoc, deleteDoc, addDoc, collection, updateDoc,
//           increment, serverTimestamp, query, where, orderBy, limit, getDocs },
//     openAuth: () => openAuth()   // page's existing "please sign in" sheet
//   });
//
//   // Repost button in an action bar:
//   <button onclick="window.MSBRepost.open({targetType:'post', targetId:p.id, snapshot:{...}, recipientUid:p.authorUid})">
//
//   // Feed / read-page embed of a quoted/reposted item:
//   repost.buildEmbedCardHtml(snapshot)

let cssInjected = false;
let sheetInjected = false;

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function trunc(s, n) { s = String(s || ''); return s.length > n ? s.slice(0, n - 1) + '…' : s; }

function injectStylesOnce() {
  if (cssInjected) return;
  cssInjected = true;
  const style = document.createElement('style');
  style.textContent = `
.rp-sheet{position:fixed;left:0;right:0;bottom:0;z-index:302;background:#fff;border-radius:24px 24px 0 0;padding:10px 20px 34px;transform:translateY(100%);transition:transform .3s cubic-bezier(.32,0,.15,1);max-height:82vh;overflow-y:auto;box-sizing:border-box}
.rp-sheet.on{transform:none}
.rp-sheet .sheet-bar{width:36px;height:4px;border-radius:99px;background:#e5e7eb;margin:0 auto 14px}
.rp-sheet h4{font-size:15px;font-weight:800;text-align:center;margin:0 0 16px;color:#0f172a}
.rp-opt{display:flex;align-items:center;gap:12px;width:100%;padding:13px 12px;border:none;background:none;text-align:left;cursor:pointer;border-radius:14px;transition:background .15s;font-family:inherit}
.rp-opt:active{background:#f4f4f6}
.rp-opt-ico{font-size:20px;width:38px;height:38px;flex-shrink:0;display:flex;align-items:center;justify-content:center;background:#eef2ff;border-radius:50%}
.rp-opt-txt{display:flex;flex-direction:column;gap:2px}
.rp-opt-txt b{font-size:14px;font-weight:700;color:#0f172a}
.rp-opt-txt small{font-size:12px;color:#9ca3af;font-weight:500}
.rp-cancel{display:block;text-align:center;margin-top:8px;padding:12px;font-size:13px;color:#9ca3af;cursor:pointer;font-weight:600}
.rp-caption{width:100%;min-height:90px;border:1.5px solid #e5e7eb;border-radius:14px;padding:12px 14px;font-size:14px;font-family:inherit;resize:none;margin-bottom:12px;box-sizing:border-box;color:#0f172a}
.rp-caption:focus{outline:none;border-color:#4f46e5}
.rp-submit{width:100%;display:flex;align-items:center;justify-content:center;gap:8px;padding:14px;border-radius:14px;border:none;background:linear-gradient(135deg,#4f46e5,#06b6d4);color:#fff;font-size:14.5px;font-weight:800;cursor:pointer;font-family:inherit}
.rp-submit:disabled{opacity:.55;cursor:wait}
.rp-back{text-align:center;margin-top:12px;font-size:13px;color:#9ca3af;cursor:pointer;font-weight:600}
.rp-embed{border:1.5px solid #e5e7eb;border-radius:14px;overflow:hidden;cursor:pointer;background:#fff;margin:4px 0 2px}
.rp-embed-author{display:flex;align-items:center;gap:8px;padding:10px 12px 6px}
.rp-embed-author img{width:22px;height:22px;border-radius:50%;object-fit:cover;flex-shrink:0}
.rp-embed-author span{font-size:12.5px;font-weight:700;color:#0f172a}
.rp-embed-title{font-size:13.5px;font-weight:700;color:#0f172a;padding:0 12px 8px;line-height:1.4}
.rp-embed-text{font-size:13px;color:#374151;padding:0 12px 10px;line-height:1.5;white-space:pre-wrap}
.rp-embed-img{width:100%;max-height:220px;overflow:hidden;background:#f4f4f6}
.rp-embed-img img{width:100%;height:100%;object-fit:cover;display:block;max-height:220px}
.rp-embed-more{font-size:11.5px;color:#9ca3af;padding:0 12px 10px;font-weight:600}
.rp-label{display:flex;align-items:center;gap:6px;font-size:12px;font-weight:700;color:#6b7280;margin-bottom:6px}
.rp-label svg{width:14px;height:14px}
.act-repost.reposted{color:#059669}
.act-repost.reposted svg{fill:#059669;stroke:#059669}
`;
  document.head.appendChild(style);
}

function injectSheetOnce() {
  if (sheetInjected) return;
  sheetInjected = true;
  const wrap = document.createElement('div');
  wrap.innerHTML = `
<div class="rp-sheet" id="rpSheet">
  <div class="sheet-bar"></div>
  <div id="rpChoiceView">
    <h4>Repost</h4>
    <button type="button" class="rp-opt" id="rpPlainBtn">
      <span class="rp-opt-ico">🔁</span>
      <span class="rp-opt-txt"><b id="rpPlainLabel">Repost</b><small id="rpPlainSub">Instantly share to your followers</small></span>
    </button>
    <button type="button" class="rp-opt" id="rpQuoteBtn">
      <span class="rp-opt-ico">✍️</span>
      <span class="rp-opt-txt"><b>Repost with caption</b><small>Add your own thoughts first</small></span>
    </button>
    <div class="rp-cancel" id="rpCancelBtn">Cancel</div>
  </div>
  <div id="rpQuoteView" style="display:none">
    <h4>Add a caption</h4>
    <textarea class="rp-caption" id="rpCaptionInput" placeholder="What's on your mind?" maxlength="500"></textarea>
    <div id="rpQuotePreview"></div>
    <button type="button" class="rp-submit" id="rpQuoteSubmitBtn">Post</button>
    <div class="rp-back" id="rpBackBtn">Back</div>
  </div>
</div>`;
  document.body.appendChild(wrap.firstElementChild);
}

export function initRepost({ db, fs, getCurrentUser, getMyProfile, notif, openAuth, showToast }) {
  injectStylesOnce();
  injectSheetOnce();
  const { doc, getDoc, setDoc, deleteDoc, addDoc, collection, updateDoc, increment, serverTimestamp } = fs;
  const toast = (msg) => { if (typeof showToast === 'function') showToast(msg); };

  let _target = null; // { targetType, targetId, snapshot, recipientUid, onSuccess }

  function plainId(uid, targetType, targetId) { return `plain_${uid}_${targetType}_${targetId}`; }

  function openOverlay() {
    const ov = document.getElementById('authOverlay');
    if (ov) ov.classList.add('on');
    document.getElementById('rpSheet').classList.add('on');
    document.body.style.overflow = 'hidden';
  }
  function closeSheet() {
    const ov = document.getElementById('authOverlay');
    if (ov) ov.classList.remove('on');
    document.getElementById('rpSheet').classList.remove('on');
    document.body.style.overflow = '';
    showChoiceView();
  }
  function showChoiceView() {
    document.getElementById('rpChoiceView').style.display = 'block';
    document.getElementById('rpQuoteView').style.display = 'none';
    const input = document.getElementById('rpCaptionInput');
    if (input) input.value = '';
  }
  function showQuoteView() {
    document.getElementById('rpChoiceView').style.display = 'none';
    document.getElementById('rpQuoteView').style.display = 'block';
    document.getElementById('rpQuotePreview').innerHTML = buildEmbedCardHtml(_target?.snapshot);
    document.getElementById('rpCaptionInput').focus();
  }

  async function isReposted(targetType, targetId) {
    const u = getCurrentUser();
    if (!u) return false;
    try {
      const snap = await getDoc(doc(db, 'reposts', plainId(u.uid, targetType, targetId)));
      return snap.exists();
    } catch (e) { return false; }
  }

  async function getRepostCount(targetId) {
    try {
      const snap = await getDoc(doc(db, 'repostCounts', targetId));
      return snap.exists() ? (snap.data().count || 0) : 0;
    } catch (e) { return 0; }
  }

  async function bumpRepostCount(targetId, delta) {
    try { await setDoc(doc(db, 'repostCounts', targetId), { count: increment(delta) }, { merge: true }); } catch (e) {}
  }

  async function submitPlain() {
    const u = getCurrentUser();
    if (!u) { closeSheet(); openAuth && openAuth(); return; }
    if (!_target) return;
    const { targetType, targetId, snapshot, recipientUid, onSuccess } = _target;
    const id = plainId(u.uid, targetType, targetId);
    const btn = document.getElementById('rpPlainBtn');
    if (btn) btn.style.opacity = '.6';
    try {
      const already = await isReposted(targetType, targetId);
      if (already) {
        await deleteDoc(doc(db, 'reposts', id));
        await bumpRepostCount(targetId, -1);
        toast('Repost removed');
        onSuccess && onSuccess({ kind: 'plain', reposted: false });
      } else {
        const mp = getMyProfile ? getMyProfile() : null;
        await setDoc(doc(db, 'reposts', id), {
          reposterUid: u.uid, reposterName: mp?.name || u.displayName || 'Someone',
          reposterPhoto: mp?.photo || u.photoURL || '', reposterUsername: mp?.username || '',
          kind: 'plain', targetType, targetId, targetSnapshot: snapshot || null,
          createdAt: serverTimestamp()
        });
        await bumpRepostCount(targetId, 1);
        notif && notif.notifyRepost && notif.notifyRepost({ recipientUid, targetId, targetTitle: snapshot?.title || snapshot?.text || '', targetType, kind: 'plain' });
        toast('Reposted to your followers');
        onSuccess && onSuccess({ kind: 'plain', reposted: true });
      }
    } catch (e) { toast('Could not repost — try again.'); }
    if (btn) btn.style.opacity = '';
    closeSheet();
  }

  async function submitQuote() {
    const u = getCurrentUser();
    if (!u) { closeSheet(); openAuth && openAuth(); return; }
    if (!_target) return;
    const caption = (document.getElementById('rpCaptionInput').value || '').trim();
    if (!caption) { toast('Add a caption first'); return; }
    const { targetType, targetId, snapshot, recipientUid, onSuccess } = _target;
    const submitBtn = document.getElementById('rpQuoteSubmitBtn');
    submitBtn.disabled = true; submitBtn.textContent = 'Posting…';
    try {
      const mp = getMyProfile ? getMyProfile() : null;
      const postRef = await addDoc(collection(db, 'posts'), {
        text: caption, images: [], videoUrl: '', thumbnailUrl: '', duration: 0,
        authorUid: u.uid, authorName: mp?.name || u.displayName || 'Someone',
        authorPhoto: mp?.photo || u.photoURL || '', authorUsername: mp?.username || '',
        commentsOff: false, hideLikeCount: false,
        quotedFrom: { type: targetType, id: targetId },
        quotedSnapshot: snapshot || null,
        status: 'published', publishedAt: serverTimestamp(), createdAt: serverTimestamp()
      });
      await setDoc(doc(db, 'reposts', `quote_${postRef.id}`), {
        reposterUid: u.uid, reposterName: mp?.name || u.displayName || 'Someone',
        reposterPhoto: mp?.photo || u.photoURL || '', reposterUsername: mp?.username || '',
        kind: 'quote', targetType, targetId, quotePostId: postRef.id,
        createdAt: serverTimestamp()
      });
      await bumpRepostCount(targetId, 1);
      notif && notif.notifyRepost && notif.notifyRepost({ recipientUid, targetId, targetTitle: snapshot?.title || snapshot?.text || '', targetType, kind: 'quote' });
      toast('Posted');
      onSuccess && onSuccess({ kind: 'quote', reposted: true, postId: postRef.id });
      closeSheet();
      location.href = `/post-read?id=${postRef.id}`;
    } catch (e) {
      toast('Could not post — try again.');
      submitBtn.disabled = false; submitBtn.textContent = 'Post';
    }
  }

  document.getElementById('rpPlainBtn').addEventListener('click', submitPlain);
  document.getElementById('rpQuoteBtn').addEventListener('click', showQuoteView);
  document.getElementById('rpCancelBtn').addEventListener('click', closeSheet);
  document.getElementById('rpBackBtn').addEventListener('click', showChoiceView);
  document.getElementById('rpQuoteSubmitBtn').addEventListener('click', submitQuote);

  // targetType/snapshot.type describe what's being embedded; navigation
  // needs to know which read page owns that id.
  function goToEmbedded(snap) {
    if (!snap || !snap.id) return;
    location.href = (snap.type === 'article' ? '/article-read?id=' : '/post-read?id=') + snap.id;
  }
  window._msbRepostGoEmbed = goToEmbedded; // used by the onclick strings below (inline handlers can't close over `snap` otherwise)

  // The one place every "here's what's being reposted/quoted" card is
  // built — feed cards, the read-page embed, and the quote-composer
  // preview all call this. Deliberately shallow: it never recurses into
  // whatever the embedded item itself might be quoting (see spec — a card
  // shows at most one embedded card, however deep the real chain is).
  function buildEmbedCardHtml(snap) {
    if (!snap) return `<div class="rp-embed" style="padding:14px;color:#9ca3af;font-size:12.5px">Original post unavailable</div>`;
    const idx = (window._msbRepostSnaps = window._msbRepostSnaps || []).push(snap) - 1;
    const clickAttr = `onclick="event.stopPropagation();window._msbRepostGoEmbed(window._msbRepostSnaps[${idx}])"`;
    const authorRow = `<div class="rp-embed-author"><img src="${esc(snap.avatar || 'logo.jpg')}" alt="" onerror="this.style.background='linear-gradient(135deg,#4f46e5,#06b6d4)'"><span>${esc(snap.author || 'MindShift Books')}</span></div>`;
    if (snap.type === 'article') {
      return `<div class="rp-embed" ${clickAttr}>
        ${authorRow}
        <div class="rp-embed-title">${esc(trunc(snap.title || '', 120))}</div>
        ${snap.img ? `<div class="rp-embed-img"><img src="${esc(snap.img)}" alt="" loading="lazy"></div>` : ''}
      </div>`;
    }
    const media = snap.img ? `<div class="rp-embed-img"><img src="${esc(snap.img)}" alt="" loading="lazy"></div>` : '';
    return `<div class="rp-embed" ${clickAttr}>
      ${authorRow}
      ${snap.text ? `<div class="rp-embed-text">${esc(trunc(snap.text, 220))}</div>` : ''}
      ${media}
    </div>`;
  }

  function open({ targetType, targetId, snapshot, recipientUid, onSuccess }) {
    const u = getCurrentUser();
    if (!u) { openAuth && openAuth(); return; }
    _target = { targetType, targetId, snapshot, recipientUid, onSuccess };
    showChoiceView();
    isReposted(targetType, targetId).then(already => {
      const label = document.getElementById('rpPlainLabel');
      const sub = document.getElementById('rpPlainSub');
      if (label) label.textContent = already ? 'Remove repost' : 'Repost';
      if (sub) sub.textContent = already ? "You've already reposted this" : 'Instantly share to your followers';
    });
    openOverlay();
  }

  const api = { open, close: closeSheet, buildEmbedCardHtml, isReposted, getRepostCount };
  window.MSBRepost = api;
  return api;
}
