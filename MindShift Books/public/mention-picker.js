/* Shared @mention picker — type "@" in any textarea and a suggestion list appears (people you follow
   first, then username search). Used by comment boxes, reply boxes and the repost-caption box; the
   post composer (create-post.html) keeps its own richer copy with the coloured-handle mirror layer.

   Usage:
     import { createMentionPicker } from '/mention-picker.js';
     const mp = createMentionPicker({ db, getCurrentUser: () => currentUser });
     mp.attach(textareaEl);                       // idempotent — safe to call on every focus
     const mentions = await mp.resolve(text);     // [{uid, username}] — verified, max 10, never yourself
     mp.seed('someone', 'uid123');                // tell it a handle→uid it already knows (e.g. reply pre-fill)

   Only handles that resolve to a real user are returned, so a stray "@word" never becomes a mention. */
import { collection, query, where, orderBy, limit, getDocs, getDoc, doc }
  from 'https://www.gstatic.com/firebasejs/10.11.0/firebase-firestore.js';

export const MENTION_MAX = 10;
const HANDLE_RE = /(^|[^a-z0-9_])@([a-z0-9_]{3,20})(?![a-z0-9_])/gi;

function injectCssOnce() {
  if (document.getElementById('msb-mpick-css')) return;
  const st = document.createElement('style'); st.id = 'msb-mpick-css';
  st.textContent = `
.msb-mpop{position:fixed;z-index:100000;width:340px;max-width:calc(100vw - 16px);max-height:300px;overflow-y:auto;overscroll-behavior:contain;-webkit-overflow-scrolling:touch;touch-action:pan-y;background:var(--c-bg,#fff);color:var(--c-ink,#0f172a);border:1px solid var(--c-line,#e2e8f0);border-radius:14px;box-shadow:0 14px 38px -12px rgba(15,23,42,.35);display:none;font-family:inherit;box-sizing:border-box}
.msb-mhint{padding:10px 14px 4px;font-size:12px;font-weight:800;letter-spacing:.4px;color:var(--c-mute,#94a3b8)}
.msb-mrow{display:flex;align-items:center;gap:10px;padding:7px 14px;min-height:52px;cursor:pointer;-webkit-tap-highlight-color:transparent}
.msb-mrow.active{background:var(--c-tonal,#eef2ff)}
.msb-mav{width:36px;height:36px;border-radius:50%;flex-shrink:0;overflow:hidden;background:linear-gradient(135deg,#4f46e5,#06b6d4);color:#fff;display:flex;align-items:center;justify-content:center;font-weight:800;font-size:15px}
.msb-mav img{width:100%;height:100%;object-fit:cover;display:block}
.msb-mtxt{min-width:0;flex:1;display:flex;flex-direction:column;gap:1px}
.msb-mname{font-size:14.5px;font-weight:800;color:var(--c-ink,#0f172a);line-height:1.25;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.msb-muser{font-size:13px;color:var(--c-sub2,#64748b);line-height:1.25;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.msb-mflw{flex-shrink:0;font-size:11.5px;font-weight:700;color:var(--c-sub2,#64748b);background:var(--c-surface,#f1f5f9);padding:3px 9px;border-radius:99px}
.msb-mempty{padding:16px;font-size:14px;color:var(--c-sub2,#64748b);text-align:center}
/* coloured @handles while typing: the textarea's own text is made invisible and this layer draws the same
   text on top (identical font/padding), with @handles in colour. The caret and selection still belong to the textarea. */
textarea[data-msb-hl]{-webkit-text-fill-color:transparent}
textarea[data-msb-hl]::placeholder{-webkit-text-fill-color:var(--c-mute,#94a3b8);color:var(--c-mute,#94a3b8);opacity:1}
.msb-mhl{position:absolute;pointer-events:none;overflow:hidden;box-sizing:border-box;border-style:solid;border-color:transparent}
.msb-mhl>div{white-space:pre-wrap;overflow-wrap:break-word;margin:0}
.msb-mn{color:var(--c-ind,#4f46e5);font-weight:700}`;
  document.head.appendChild(st);
}

function withTimeout(p, ms) {
  return Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);
}

export function createMentionPicker({ db, getCurrentUser, highlight = true }) {
  injectCssOnce();
  const attached = new WeakSet();
  const picked = new Map();            // username -> uid, for handles chosen from the list (or seeded)
  const searchCache = new Map();       // query -> results
  let following = null;                // cached "people you follow"
  const followingIds = new Set();

  let pop = null, activeTa = null, list = [], activeIdx = 0, range = null, seq = 0, timer = null, interacting = false;

  const me = () => { const u = getCurrentUser && getCurrentUser(); return u ? u.uid : null; };
  const toItem = (id, d) => ({
    uid: id, username: (d.username || '').toLowerCase(), name: d.name || d.displayName || '',
    photo: d.photo || d.photoURL || '', following: followingIds.has(id)
  });

  async function getFollowing() {
    if (following) return following;
    const uid = me(); if (!uid) return [];
    const snap = await withTimeout(getDocs(query(collection(db, 'follows'), where('followerId', '==', uid), limit(8))), 6000);
    const ids = snap.docs.map(d => d.data().followingId);
    ids.forEach(id => followingIds.add(id));
    const docs = await Promise.all(ids.map(id => getDoc(doc(db, 'users', id)).catch(() => null)));
    following = docs.filter(x => x && x.exists() && x.data().username).map(x => toItem(x.id, x.data()));
    return following;
  }
  async function search(q) {
    if (searchCache.has(q)) return searchCache.get(q);
    const [snap] = await Promise.all([
      withTimeout(getDocs(query(collection(db, 'users'), where('username', '>=', q), where('username', '<=', q + '\uf8ff'), orderBy('username'), limit(8))), 6000),
      getFollowing().catch(() => null)   // so people you follow can be ranked first
    ]);
    let out = snap.docs.filter(d => d.id !== me() && d.data().username).map(d => toItem(d.id, d.data()));
    out = out.filter(u => u.following).concat(out.filter(u => !u.following)).slice(0, 6);
    searchCache.set(q, out);
    return out;
  }

  function ensurePop() {
    if (pop) return pop;
    pop = document.createElement('div');
    pop.className = 'msb-mpop'; pop.setAttribute('role', 'listbox'); pop.setAttribute('aria-label', 'Mention suggestions');
    pop.addEventListener('mousedown', e => e.preventDefault());               // keep the textarea focused
    pop.addEventListener('pointerdown', () => { interacting = true; });
    const done = () => setTimeout(() => { interacting = false; }, 350);
    pop.addEventListener('pointerup', done); pop.addEventListener('pointercancel', done);
    document.body.appendChild(pop);
    return pop;
  }
  function hide() {
    if (!pop) return;
    pop.style.display = 'none'; pop.innerHTML = ''; list = []; range = null; seq++;
  }
  function place() {
    if (!pop || pop.style.display === 'none' || !activeTa) return;
    const vv = window.visualViewport;
    const vTop = vv ? vv.offsetTop : 0, vLeft = vv ? vv.offsetLeft : 0;
    const vH = vv ? vv.height : window.innerHeight, vW = vv ? vv.width : window.innerWidth;
    const r = activeTa.getBoundingClientRect();
    const GAP = 6, EDGE = 8, MAXH = 300;
    const phone = matchMedia('(pointer:coarse)').matches;
    // width
    const w = phone ? vW - EDGE * 2 : Math.min(340, vW - EDGE * 2);
    pop.style.width = w + 'px';
    pop.style.left = Math.max(vLeft + EDGE, Math.min(phone ? vLeft + EDGE : r.left, vLeft + vW - w - EDGE)) + 'px';
    // height: measure the list at its natural height, then fit it into the room above/below the box
    pop.style.maxHeight = 'none';
    const natural = Math.min(pop.scrollHeight, MAXH);
    const above = r.top - vTop - GAP - EDGE;
    const below = vTop + vH - r.bottom - GAP - EDGE;
    let useBelow;
    if (phone) useBelow = natural <= below && below >= above;      // phones: box is usually at the bottom, list goes above it
    else useBelow = natural <= below || below >= above;            // desktop: prefer under the box
    const room = Math.max(120, useBelow ? below : above);
    const h = Math.min(natural, room);
    pop.style.maxHeight = h + 'px';
    pop.style.bottom = '';
    pop.style.top = (useBelow ? r.bottom + GAP : Math.max(vTop + EDGE, r.top - GAP - h)) + 'px';
  }
  if (window.visualViewport) {
    visualViewport.addEventListener('resize', place);
    visualViewport.addEventListener('scroll', place);
  }
  window.addEventListener('scroll', e => { if (pop && e.target && (e.target === pop || (e.target.nodeType === 1 && pop.contains(e.target)))) return; place(); }, true);
  window.addEventListener('resize', place);

  function trigger(ta) {
    if (ta.selectionStart !== ta.selectionEnd) return null;
    const caret = ta.selectionStart;
    const m = /(^|[\s(])@([a-z0-9_]{0,20})$/i.exec(ta.value.slice(0, caret));
    if (!m) return null;
    const q = m[2].toLowerCase();
    return { q, start: caret - q.length - 1, end: caret };
  }

  function render(items, hint, emptyMsg) {
    const p = ensurePop(); p.innerHTML = '';
    if (!items.length) {
      if (!emptyMsg) { hide(); return; }
      list = [];
      const e = document.createElement('div'); e.className = 'msb-mempty'; e.textContent = emptyMsg;
      p.appendChild(e); p.style.display = 'block'; place(); return;
    }
    list = items; activeIdx = 0;
    if (hint) { const h = document.createElement('div'); h.className = 'msb-mhint'; h.textContent = hint; p.appendChild(h); }
    items.forEach((u, i) => {
      const row = document.createElement('div');
      row.className = 'msb-mrow' + (i === 0 ? ' active' : ''); row.setAttribute('role', 'option');
      const av = document.createElement('div'); av.className = 'msb-mav';
      if (u.photo) {
        const img = document.createElement('img'); img.alt = ''; img.src = u.photo;
        img.onerror = () => { img.remove(); av.textContent = (u.name || u.username || '?').charAt(0).toUpperCase(); };
        av.appendChild(img);
      } else av.textContent = (u.name || u.username || '?').charAt(0).toUpperCase();
      const tx = document.createElement('div'); tx.className = 'msb-mtxt';
      const nm = document.createElement('span'); nm.className = 'msb-mname'; nm.textContent = u.name || u.username;
      const un = document.createElement('span'); un.className = 'msb-muser'; un.textContent = '@' + u.username;
      tx.appendChild(nm); tx.appendChild(un); row.appendChild(av); row.appendChild(tx);
      if (u.following) { const f = document.createElement('span'); f.className = 'msb-mflw'; f.textContent = 'Following'; row.appendChild(f); }
      let y0 = 0, moved = false;
      row.addEventListener('pointerdown', e => { y0 = e.clientY; moved = false; });
      row.addEventListener('pointermove', e => { if (Math.abs(e.clientY - y0) > 8) moved = true; });
      row.addEventListener('pointerup', e => { if (moved) return; e.preventDefault(); choose(i); });
      p.appendChild(row);
    });
    p.style.display = 'block'; place();
  }

  function update(ta) {
    activeTa = ta;
    const trig = trigger(ta);
    if (!trig) { hide(); return; }
    range = trig;
    const my = ++seq;
    clearTimeout(timer);
    timer = setTimeout(async () => {
      try {
        if (trig.q === '') {
          const items = await getFollowing();
          if (my !== seq) return;
          if (!items.length) { render([], '', 'Type a name to find someone to mention'); return; }
          render(items, 'People you follow');
        } else {
          const items = await search(trig.q);
          if (my !== seq) return;                   // typing moved on — drop stale results
          render(items, '', trig.q.length >= 2 ? 'No one found for “@' + trig.q + '”' : '');
        }
      } catch (e) { if (my === seq) hide(); }
    }, trig.q === '' ? 0 : 140);
  }

  function choose(i) {
    const u = list[i], r = range, ta = activeTa;
    if (!u || !r || !ta) return;
    const ins = '@' + u.username + ' ';
    const next = ta.value.slice(0, r.start) + ins + ta.value.slice(r.end);
    if (ta.maxLength > 0 && next.length > ta.maxLength) { hide(); return; }
    ta.value = next;
    const pos = r.start + ins.length;
    try { ta.setSelectionRange(pos, pos); } catch (e) {}
    picked.set(u.username, u.uid);
    hide(); ta.focus();
    ta.dispatchEvent(new Event('input', { bubbles: true }));   // enables the Post button, grows the box
  }

  function escHtml(x) { return x.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
  function setupHighlight(ta) {
    if (typeof window.ResizeObserver !== 'function') return;     // very old browsers: just no colour while typing
    const ov = document.createElement('div'); ov.className = 'msb-mhl'; ov.setAttribute('aria-hidden', 'true');
    const inner = document.createElement('div'); ov.appendChild(inner);
    ta.setAttribute('data-msb-hl', '1');
    ta.after(ov);
    function sync() {
      if (!ta.isConnected) { ov.remove(); return; }
      if (!ta.offsetParent) { ov.style.display = 'none'; return; }       // hidden (e.g. closed reply box)
      const cs = getComputedStyle(ta), s = ov.style, i = inner.style;
      s.display = 'block';
      s.left = ta.offsetLeft + 'px'; s.top = ta.offsetTop + 'px';
      s.width = ta.offsetWidth + 'px'; s.height = ta.offsetHeight + 'px';
      s.paddingTop = cs.paddingTop; s.paddingRight = cs.paddingRight; s.paddingBottom = cs.paddingBottom; s.paddingLeft = cs.paddingLeft;
      s.borderTopWidth = cs.borderTopWidth; s.borderRightWidth = cs.borderRightWidth; s.borderBottomWidth = cs.borderBottomWidth; s.borderLeftWidth = cs.borderLeftWidth;
      ['fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'letterSpacing', 'lineHeight', 'textTransform', 'textIndent', 'wordSpacing', 'textAlign', 'direction', 'tabSize', 'wordBreak'].forEach(p => { i[p] = cs[p]; });
      i.color = cs.color;
      i.transform = 'translateY(' + (-ta.scrollTop) + 'px)';
      const v = ta.value;
      inner.innerHTML = escHtml(v).replace(/(^|[^a-z0-9_])@([a-z0-9_]{1,20})(?![a-z0-9_])/gi, (all, pre, h) => pre + '<span class="msb-mn">@' + h + '</span>')
        + (v.endsWith('\n') ? ' ' : '');
    }
    // programmatic changes (clearing the box after posting, the reply pre-fill) never fire "input" — catch them too
    const d = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value');
    if (d && d.set) Object.defineProperty(ta, 'value', { configurable: true, get() { return d.get.call(this); }, set(v) { d.set.call(this, v); sync(); } });
    ta.addEventListener('input', sync);
    ta.addEventListener('scroll', sync);
    ta.addEventListener('focus', sync);
    new ResizeObserver(sync).observe(ta);
    window.addEventListener('resize', sync);
    sync();
  }

  function attach(ta) {
    if (!ta || attached.has(ta)) return;
    attached.add(ta);
    if (highlight) { try { setupHighlight(ta); } catch (e) { ta.removeAttribute('data-msb-hl'); } }
    ta.addEventListener('input', () => update(ta));
    ta.addEventListener('click', () => update(ta));
    ta.addEventListener('keyup', e => { if (!['ArrowDown', 'ArrowUp', 'Enter', 'Tab', 'Escape'].includes(e.key)) update(ta); });
    ta.addEventListener('blur', () => setTimeout(() => { if (activeTa === ta && !interacting) hide(); }, 200));
    ta.addEventListener('keydown', e => {
      if (!pop || pop.style.display === 'none' || !list.length || activeTa !== ta) return;
      const rows = () => pop.querySelectorAll('.msb-mrow');
      const setActive = n => {
        activeIdx = (n + list.length) % list.length;
        rows().forEach((r, k) => r.classList.toggle('active', k === activeIdx));
        const cur = rows()[activeIdx]; if (cur && cur.scrollIntoView) cur.scrollIntoView({ block: 'nearest' });
      };
      if (e.key === 'ArrowDown') { e.preventDefault(); setActive(activeIdx + 1); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(activeIdx - 1); }
      else if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); choose(activeIdx); }
      else if (e.key === 'Escape') { e.preventDefault(); hide(); }
    });
  }

  // Turn every @handle in the text into a verified {uid, username}. Picked/seeded handles are already
  // known; hand-typed ones are looked up in usernames/{handle}. Unknown handles and yourself are dropped.
  async function resolve(text) {
    const seen = new Set(), handles = [];
    const re = new RegExp(HANDLE_RE.source, 'gi');
    let m;
    while ((m = re.exec(text || '')) && handles.length < MENTION_MAX) {
      const h = m[2].toLowerCase();
      if (!seen.has(h)) { seen.add(h); handles.push(h); }
    }
    const mine = me();
    const out = await Promise.all(handles.map(async h => {
      try {
        let uid = picked.get(h);
        if (!uid) { const s = await withTimeout(getDoc(doc(db, 'usernames', h)), 5000); uid = s.exists() ? s.data().uid : null; }
        return (uid && uid !== mine) ? { uid, username: h } : null;
      } catch (e) { return null; }
    }));
    return out.filter(Boolean);
  }

  function seed(username, uid) { if (username && uid) picked.set(String(username).toLowerCase(), uid); }

  return { attach, resolve, seed, hide };
}
