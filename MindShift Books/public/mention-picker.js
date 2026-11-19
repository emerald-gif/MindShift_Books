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
.msb-mpop{position:fixed;z-index:100000;width:340px;max-width:calc(100vw - 16px);max-height:324px;overflow-y:auto;overscroll-behavior:contain;-webkit-overflow-scrolling:touch;touch-action:pan-y;background:var(--c-bg,#fff);color:var(--c-ink,#0f172a);border:1px solid var(--c-line,#e8ecf3);border-radius:16px;box-shadow:0 18px 50px -12px rgba(15,23,42,.30),0 2px 6px rgba(15,23,42,.05);padding-bottom:6px;display:none;font-family:'Inter',system-ui,sans-serif;box-sizing:border-box}
.msb-mpop.in{animation:msbmpop .14s ease-out}
@keyframes msbmpop{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}
/* phone: a sheet that sits flush on top of the comment bar (same look as the composer's drawer), so the box you type in stays visible */
.msb-mpop.dock{left:0;right:0;width:auto;max-width:none;border:none;border-top:1px solid var(--c-line,#eef1f6);border-radius:20px 20px 0 0;box-shadow:0 -12px 32px -14px rgba(15,23,42,.28);padding-bottom:6px}
.msb-mgrab{width:36px;height:4px;border-radius:99px;background:var(--c-line,#d8dde8);margin:8px auto 0}
.msb-mhint{padding:12px 18px 6px;font-size:11px;font-weight:800;letter-spacing:.7px;text-transform:uppercase;color:var(--c-mute,#94a3b8)}
.msb-mrow{position:relative;display:flex;align-items:center;gap:11px;margin:1px 8px;padding:7px 10px;min-height:54px;border-radius:12px;cursor:pointer;-webkit-tap-highlight-color:transparent;transition:background .12s}
.msb-mrow.active{background:var(--c-tonal,#f4f6ff)}
.msb-mrow:active{background:var(--c-tonal,#e9edff)}
.msb-mav{width:40px;height:40px;border-radius:50%;flex-shrink:0;overflow:hidden;background:linear-gradient(135deg,#4f46e5,#06b6d4);color:#fff;display:flex;align-items:center;justify-content:center;font-weight:800;font-size:15px;box-shadow:0 0 0 2px var(--c-bg,#fff),0 0 0 3px var(--c-line,#e8ecf3)}
.msb-mav img{width:100%;height:100%;object-fit:cover;display:block}
.msb-mtxt{min-width:0;flex:1;display:flex;flex-direction:column;gap:1px}
.msb-mname{font-size:14.5px;font-weight:700;letter-spacing:-.1px;color:var(--c-ink,#0f172a);line-height:1.25;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.msb-muser b{font-weight:800;color:var(--c-ind,#4f46e5)}
.msb-muser{font-size:13px;color:var(--c-sub2,#64748b);line-height:1.25;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.msb-mflw{flex-shrink:0;font-size:11px;font-weight:700;color:var(--c-ind,#4f46e5);background:var(--c-tonal,#eef2ff);padding:3px 9px;border-radius:99px}
.msb-mempty{padding:18px 16px;font-size:14px;color:var(--c-sub2,#64748b);text-align:center}
@media (prefers-reduced-motion:reduce){.msb-mpop.in{animation:none}}
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

  let curQ = '', pop = null, activeTa = null, list = [], activeIdx = 0, range = null, seq = 0, timer = null, interacting = false;

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
    pop.style.display = 'none'; pop.classList.remove('in'); pop.innerHTML = ''; list = []; range = null; seq++;
  }
  // The fixed bar the textarea lives in (the post page's bottom comment bar), if any.
  function fixedBarOf(ta) {
    let el = ta.parentElement;
    for (let n = 0; el && el !== document.body && n < 4; n++, el = el.parentElement) {
      if (getComputedStyle(el).position === 'fixed') return el;
    }
    return null;
  }
  function place() {
    if (!pop || pop.style.display === 'none' || !activeTa) return;
    const vv = window.visualViewport;
    const vTop = vv ? vv.offsetTop : 0, vLeft = vv ? vv.offsetLeft : 0;
    const vH = vv ? vv.height : window.innerHeight, vW = vv ? vv.width : window.innerWidth;
    const GAP = 6, EDGE = 8, MAXH = 324;
    const phone = matchMedia('(pointer:coarse)').matches;
    const bar = phone ? fixedBarOf(activeTa) : null;
    const r = (bar || activeTa).getBoundingClientRect();        // the box the list attaches to
    const dock = !!bar;
    pop.classList.toggle('dock', dock);
    // width / left
    let w;
    if (dock) { pop.style.width = ''; pop.style.left = (vLeft) + 'px'; pop.style.right = 'auto'; w = vW; pop.style.width = vW + 'px'; }
    else {
      pop.style.right = 'auto';
      w = phone ? vW - EDGE * 2 : Math.min(340, vW - EDGE * 2);
      pop.style.width = w + 'px';
      pop.style.left = Math.max(vLeft + EDGE, Math.min(phone ? vLeft + EDGE : r.left, vLeft + vW - w - EDGE)) + 'px';
    }
    // height: natural height, fitted into the free room above / below the box
    pop.style.maxHeight = 'none';
    const natural = Math.min(pop.scrollHeight, MAXH);
    const gap = dock ? 0 : GAP;
    const above = r.top - vTop - gap - EDGE;
    const below = vTop + vH - r.bottom - gap - EDGE;
    let useBelow;
    if (dock) useBelow = false;
    else if (phone) useBelow = natural <= below && below >= above;
    else useBelow = natural <= below || below >= above;
    const room = Math.max(120, useBelow ? below : above);
    const h = Math.min(natural, room);
    pop.style.maxHeight = h + 'px';
    pop.style.bottom = '';
    pop.style.top = (useBelow ? r.bottom + gap : Math.max(vTop + EDGE, r.top - gap - h)) + 'px';
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
    const wasHidden = p.style.display !== 'block';
    const reveal = () => { p.style.display = 'block'; place(); if (wasHidden) { p.classList.remove('in'); void p.offsetWidth; p.classList.add('in'); } };
    const grab = document.createElement('div'); grab.className = 'msb-mgrab'; grab.style.display = 'none'; p.appendChild(grab);
    if (!items.length) {
      if (!emptyMsg) { hide(); return; }
      list = [];
      const e = document.createElement('div'); e.className = 'msb-mempty'; e.textContent = emptyMsg;
      p.appendChild(e); reveal(); return;
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
      const un = document.createElement('span'); un.className = 'msb-muser';
      un.appendChild(document.createTextNode('@'));
      if (curQ && u.username.startsWith(curQ)) { const m = document.createElement('b'); m.textContent = curQ; un.appendChild(m); un.appendChild(document.createTextNode(u.username.slice(curQ.length))); }
      else un.appendChild(document.createTextNode(u.username));
      tx.appendChild(nm); tx.appendChild(un); row.appendChild(av); row.appendChild(tx);
      if (u.following) { const f = document.createElement('span'); f.className = 'msb-mflw'; f.textContent = 'Following'; row.appendChild(f); }
      let y0 = 0, moved = false;
      row.addEventListener('pointerdown', e => { y0 = e.clientY; moved = false; });
      row.addEventListener('pointermove', e => { if (Math.abs(e.clientY - y0) > 8) moved = true; });
      row.addEventListener('pointerup', e => { if (moved) return; e.preventDefault(); choose(i); });
      p.appendChild(row);
    });
    reveal();
    grab.style.display = p.classList.contains('dock') ? 'block' : 'none';
    place();   // re-fit now that the grabber is counted
  }

  function update(ta) {
    activeTa = ta;
    const trig = trigger(ta);
    if (!trig) { hide(); return; }
    range = trig; curQ = trig.q;
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
          render(items, 'Mention someone', trig.q.length >= 2 ? 'No one found for “@' + trig.q + '”' : '');
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
