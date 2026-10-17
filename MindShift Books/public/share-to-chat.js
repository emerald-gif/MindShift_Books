/* share-to-chat.js — "Send in message" for posts and articles.
 *
 * Put this file in /public (it is served as /share-to-chat.js). From any page — a post, an article, the feed —
 * add a "Send in message" button and call:
 *
 *   import('/share-to-chat.js').then(m => m.openShareToChat({
 *     kind:    'post',                 // or 'article'
 *     id:      POST_ID,                // the document id in posts / articles
 *     title:   'Why habits beat goals',// card headline (a post can use its first line)
 *     snippet: 'Short preview text…',  // optional, 1–2 lines
 *     image:   'https://…',            // optional cover / first image (https only)
 *     author:  'Ada Okafor'            // optional
 *   }));
 *
 * It opens a sheet with the person's recent chats and the people they follow, lets them pick one or more,
 * add a note, and send. The recipient sees a card in the chat; tapping it opens the post / article.
 * Works with the same Firebase project and the same message rules as /messages.
 */
import { initializeApp, getApps, getApp } from 'https://www.gstatic.com/firebasejs/10.11.0/firebase-app.js';
import { getAuth, onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/10.11.0/firebase-auth.js';
import { getFirestore, doc, getDoc, getDocs, collection, query, where, orderBy, limit, writeBatch,
         serverTimestamp, increment, documentId } from 'https://www.gstatic.com/firebasejs/10.11.0/firebase-firestore.js';

const CONFIG = {
  apiKey:'AIzaSyDTn70s1_uIiSOR6lPLY_nKh8Ff1FViFCs',
  authDomain:'mindshiftbooks-c4451.firebaseapp.com',
  projectId:'mindshiftbooks-c4451',
  storageBucket:'mindshiftbooks-c4451.firebasestorage.app',
  messagingSenderId:'388697987853',
  appId:'1:388697987853:web:f023df9412c22285012e44'
};
const MAX_PICK = 10;

let app, auth, db, openState = null;
function boot(){
  if(app) return;
  app = getApps().length ? getApp() : initializeApp(CONFIG);
  auth = getAuth(app);
  db = getFirestore(app, 'default');
}
const waitUser = () => new Promise(res => { const off = onAuthStateChanged(auth, u => { off(); res(u); }); });
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
const cidOf = (a, b) => [a, b].sort().join('_');
const clip = (s, n) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);

const CSS = `
.stc-bg{position:fixed;inset:0;z-index:2147483000;background:rgba(15,23,42,.5);opacity:0;transition:opacity .2s}
.stc-bg.on{opacity:1}
.stc{position:fixed;left:0;right:0;bottom:0;z-index:2147483001;max-width:560px;margin:0 auto;height:min(86dvh,640px);background:#fff;border-radius:24px 24px 0 0;display:flex;flex-direction:column;transform:translateY(100%);transition:transform .26s cubic-bezier(.2,.9,.3,1);font-family:'Segoe UI',system-ui,-apple-system,Roboto,sans-serif;color:#0f172a;-webkit-font-smoothing:antialiased}
.stc.on{transform:none}
.stc *{box-sizing:border-box;margin:0;padding:0;-webkit-tap-highlight-color:transparent}
.stc button{font:inherit;color:inherit;border:0;background:none;cursor:pointer}
.stc-grab{width:40px;height:5px;border-radius:3px;background:#d8dbe5;margin:9px auto 4px;flex:none}
.stc-head{display:flex;align-items:center;justify-content:space-between;padding:4px 18px 10px;flex:none}
.stc-head h2{font-size:18px;font-weight:800;letter-spacing:-.01em}
.stc-x{width:36px;height:36px;border-radius:50%;display:flex;align-items:center;justify-content:center;background:#f1f3f9}
.stc-x svg{width:18px;height:18px;fill:none;stroke:currentColor;stroke-width:2.4;stroke-linecap:round}
.stc-prev{display:flex;gap:12px;align-items:center;margin:0 16px 10px;padding:10px;border-radius:14px;background:#f5f6fb;flex:none}
.stc-prev img{width:54px;height:54px;border-radius:10px;object-fit:cover;flex:none;background:#e5e7eb}
.stc-prev div{min-width:0}
.stc-prev small{display:block;font-size:11.5px;font-weight:800;color:#4f46e5}
.stc-prev b{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;font-size:14px;line-height:1.3;margin-top:1px}
.stc-search{margin:0 16px 6px;flex:none}
.stc-search input{width:100%;height:42px;border-radius:21px;border:1.5px solid transparent;background:#f1f3f9;padding:0 16px;font:inherit;font-size:16px;outline:0;color:inherit}
.stc-search input:focus{background:#fff;border-color:#a5b4fc}
.stc-list{flex:1;min-height:0;overflow-y:auto;padding:2px 8px 6px;overscroll-behavior:contain}
.stc-row{display:flex;align-items:center;gap:12px;width:100%;padding:9px 10px;border-radius:14px;text-align:left}
.stc-row:active{background:#f4f5fa}
.stc-av{width:44px;height:44px;border-radius:50%;background:#e5e7eb;object-fit:cover;flex:none;display:flex;align-items:center;justify-content:center;font-weight:800;color:#fff;font-size:16px;background-image:linear-gradient(135deg,#6366f1,#06b6d4)}
.stc-nm{flex:1;min-width:0}
.stc-nm b{display:block;font-size:15px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.stc-nm small{display:block;font-size:12.5px;color:#6b7280}
.stc-ck{width:24px;height:24px;border-radius:50%;border:2px solid #cbd0dc;flex:none;display:flex;align-items:center;justify-content:center;transition:all .12s}
.stc-row.on .stc-ck{background:#4f46e5;border-color:#4f46e5}
.stc-row.on .stc-ck::after{content:'';width:6px;height:11px;border:solid #fff;border-width:0 2.5px 2.5px 0;transform:rotate(45deg) translate(-1px,-1px)}
.stc-hd{font-size:12.5px;font-weight:700;color:#6b7280;padding:10px 12px 4px}
.stc-empty{padding:34px 24px;text-align:center;color:#6b7280;font-size:14.5px;line-height:1.5}
.stc-sk{height:60px;margin:6px 10px;border-radius:14px;background:linear-gradient(90deg,#f1f3f9,#e8ebf4,#f1f3f9);background-size:200% 100%;animation:stcSk 1.2s infinite}
@keyframes stcSk{to{background-position:-200% 0}}
.stc-foot{flex:none;display:flex;gap:10px;align-items:center;padding:10px 14px calc(12px + env(safe-area-inset-bottom));border-top:1px solid #eceef5;background:#fff}
.stc-foot input{flex:1;min-width:0;height:44px;border-radius:22px;border:1.5px solid transparent;background:#f1f3f9;padding:0 16px;font:inherit;font-size:16px;outline:0;color:inherit}
.stc-foot input:focus{background:#fff;border-color:#a5b4fc}
.stc-send{height:44px;padding:0 22px;border-radius:22px;background:linear-gradient(135deg,#4f46e5,#06b6d4);color:#fff!important;font-weight:800;font-size:15px;white-space:nowrap}
.stc-send:disabled{opacity:.4}
.stc-toast{position:fixed;left:50%;bottom:calc(28px + env(safe-area-inset-bottom));transform:translateX(-50%);z-index:2147483002;background:#0f172a;color:#fff;padding:11px 18px;border-radius:99px;font:600 14px 'Segoe UI',system-ui,sans-serif;max-width:88vw;text-align:center}
`;
function toast(t){
  const el = document.createElement('div'); el.className = 'stc-toast'; el.textContent = t; document.body.appendChild(el);
  setTimeout(() => el.remove(), 2800);
}

async function fetchProfiles(ids){
  const out = [];
  for(let i = 0; i < ids.length; i += 10){
    const snap = await getDocs(query(collection(db, 'users'), where(documentId(), 'in', ids.slice(i, i + 10))));
    snap.docs.forEach(d => { const x = d.data(); out.push({ uid:d.id, name:x.name || '', photo:x.photo || x.photoURL || '', username:x.username || '' }); });
  }
  return out;
}
async function loadPeople(meUid){
  const seen = new Set([meUid]), list = [];
  // recent chats first
  try{
    const ts = await getDocs(query(collection(db, 'inbox', meUid, 'threads'), orderBy('lastAt', 'desc'), limit(30)));
    ts.docs.forEach(d => { const x = d.data(), uid = x.otherUid || d.id; if(x.deleted === true || seen.has(uid) || uid === 'official') return; seen.add(uid); list.push({ uid, name:x.name || '', photo:x.photo || '', group:'Recent' }); });
  }catch(e){}
  // then people I follow
  try{
    const fs = await getDocs(query(collection(db, 'follows'), where('followerId', '==', meUid), limit(40)));
    const ids = [...new Set(fs.docs.map(d => d.data().followingId).filter(id => id && !seen.has(id) && id !== 'official' && !id.includes('_')))];
    if(ids.length) (await fetchProfiles(ids)).forEach(p => { if(p.name && !seen.has(p.uid)){ seen.add(p.uid); list.push({ ...p, group:'People you follow' }); } });
  }catch(e){}
  return list;
}

export async function openShareToChat(item){
  boot();
  if(openState) return;
  const kind = item && item.kind === 'article' ? 'article' : 'post';
  const id = item && String(item.id || '').trim();
  if(!id){ toast('Nothing to share yet'); return; }
  const user = auth.currentUser || await waitUser();
  if(!user){ location.href = '/signup?returnTo=' + encodeURIComponent(location.pathname + location.search); return; }

  const card = {
    sk:kind, sid:id.slice(0, 64),
    st:clip(item.title, 160) || (kind === 'article' ? 'Article' : 'Post'),
    sx:clip(item.snippet, 240), sa:clip(item.author, 80),
    si:(typeof item.image === 'string' && /^https:\/\//.test(item.image) && item.image.length <= 500) ? item.image : ''
  };

  if(!document.getElementById('stc-css')){ const st = document.createElement('style'); st.id = 'stc-css'; st.textContent = CSS; document.head.appendChild(st); }
  const bg = document.createElement('div'); bg.className = 'stc-bg';
  const sh = document.createElement('div'); sh.className = 'stc'; sh.setAttribute('role', 'dialog'); sh.setAttribute('aria-label', 'Send in message');
  sh.innerHTML = `<div class="stc-grab"></div>
    <div class="stc-head"><h2>Send in message</h2><button class="stc-x" aria-label="Close"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg></button></div>
    <div class="stc-prev">${card.si ? '<img src="' + esc(card.si) + '" alt="" referrerpolicy="no-referrer">' : ''}<div><small>${kind === 'article' ? 'Article' : 'Post'}</small><b>${esc(card.st)}</b></div></div>
    <div class="stc-search"><input type="search" placeholder="Search people" aria-label="Search people" autocomplete="off"></div>
    <div class="stc-list"><div class="stc-sk"></div><div class="stc-sk"></div><div class="stc-sk"></div></div>
    <div class="stc-foot"><input type="text" maxlength="400" placeholder="Add a message (optional)" aria-label="Add a message"><button class="stc-send" disabled>Send</button></div>`;
  document.body.append(bg, sh);
  const prevOverflow = document.documentElement.style.overflow; document.documentElement.style.overflow = 'hidden';
  requestAnimationFrame(() => { bg.classList.add('on'); sh.classList.add('on'); });
  const list = sh.querySelector('.stc-list'), search = sh.querySelector('.stc-search input'), note = sh.querySelector('.stc-foot input'), sendBtn = sh.querySelector('.stc-send');
  const picked = new Map(); let people = [], sending = false;
  openState = { close };
  function close(){
    if(!openState) return; openState = null;
    document.documentElement.style.overflow = prevOverflow;
    bg.classList.remove('on'); sh.classList.remove('on');
    setTimeout(() => { bg.remove(); sh.remove(); }, 260);
    document.removeEventListener('keydown', onKey);
  }
  const onKey = e => { if(e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  bg.onclick = close; sh.querySelector('.stc-x').onclick = close;

  function paintBtn(){ sendBtn.disabled = !picked.size || sending; sendBtn.textContent = sending ? 'Sending…' : picked.size > 1 ? 'Send to ' + picked.size : 'Send'; }
  function paint(){
    const q = search.value.trim().toLowerCase();
    const rows = people.filter(p => !q || (p.name + ' ' + (p.username || '')).toLowerCase().includes(q));
    if(!rows.length){ list.innerHTML = '<div class="stc-empty">' + (people.length ? 'No one matches “' + esc(search.value.trim()) + '”.' : 'No chats yet. Follow someone, or message them first, and they’ll show up here.') + '</div>'; return; }
    let html = '', grp = '';
    rows.forEach(p => {
      if(p.group !== grp){ grp = p.group; html += '<div class="stc-hd">' + esc(grp) + '</div>'; }
      const av = p.photo ? '<img class="stc-av" src="' + esc(p.photo) + '" alt="" referrerpolicy="no-referrer">' : '<span class="stc-av">' + esc((p.name || '?').trim().charAt(0).toUpperCase()) + '</span>';
      html += '<button class="stc-row' + (picked.has(p.uid) ? ' on' : '') + '" data-uid="' + esc(p.uid) + '">' + av + '<span class="stc-nm"><b>' + esc(p.name || 'MindShift Books User') + '</b>' + (p.username ? '<small>@' + esc(p.username) + '</small>' : '') + '</span><span class="stc-ck"></span></button>';
    });
    list.innerHTML = html;
  }
  list.addEventListener('click', e => {
    const b = e.target.closest('.stc-row'); if(!b || sending) return;
    const uid = b.dataset.uid, p = people.find(x => x.uid === uid); if(!p) return;
    if(picked.has(uid)) picked.delete(uid);
    else { if(picked.size >= MAX_PICK){ toast('You can send to up to ' + MAX_PICK + ' people at once'); return; } picked.set(uid, p); }
    b.classList.toggle('on', picked.has(uid)); paintBtn();
  });
  search.addEventListener('input', paint);

  // my own name / photo (shown to the other person in their inbox)
  let meName = '', mePhoto = '';
  try{ const u = await getDoc(doc(db, 'users', user.uid)); if(u.exists()){ const x = u.data(); meName = x.name || ''; mePhoto = x.photo || x.photoURL || ''; } }catch(e){}
  if(!meName) meName = user.displayName || 'MindShift Books User';
  people = await loadPeople(user.uid);
  if(openState) paint();

  sendBtn.onclick = async () => {
    if(sending || !picked.size) return;
    sending = true; paintBtn();
    const text = '🔗 Shared ' + (kind === 'article' ? 'an article' : 'a post');
    const cap = clip(note.value, 400);
    const results = await Promise.allSettled([...picked.values()].map(async p => {
      const cid = cidOf(user.uid, p.uid), ref = doc(collection(db, 'conversations', cid, 'messages'));
      const payload = { senderUid:user.uid, text, createdAt:serverTimestamp(), type:'share', sk:card.sk, sid:card.sid, st:card.st };
      if(card.sx) payload.sx = card.sx; if(card.sa) payload.sa = card.sa; if(card.si) payload.si = card.si; if(cap) payload.cap = cap;
      const b = writeBatch(db);
      b.set(ref, payload);
      b.set(doc(db, 'inbox', user.uid, 'threads', p.uid), { otherUid:p.uid, name:p.name || '', photo:p.photo || '', lastText:text, lastAt:serverTimestamp(), lastSender:user.uid, unread:0, accepted:true }, { merge:true });
      b.set(doc(db, 'inbox', p.uid, 'threads', user.uid), { otherUid:user.uid, name:meName, photo:mePhoto, lastText:text, lastAt:serverTimestamp(), lastSender:user.uid, unread:increment(1) }, { merge:true });
      await b.commit();
      return p;
    }));
    const ok = results.filter(r => r.status === 'fulfilled').length, bad = results.length - ok;
    sending = false;
    close();
    if(!bad) toast(ok === 1 ? 'Sent to ' + [...picked.values()][0].name : 'Sent to ' + ok + ' people');
    else if(ok) toast('Sent to ' + ok + ', but ' + bad + ' couldn’t be reached');
    else toast('Couldn’t send. Check your connection and try again.');
  };
  paintBtn();
}
if(typeof window !== 'undefined') window.openShareToChat = openShareToChat;
