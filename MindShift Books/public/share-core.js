/* share-core.js — the ONE place that knows how to send a post / article card into chats.
 * Used by the Share drawer (share-drawer.js) and by /share-to-chat.js, so both send the exact same card the exact same way.
 *
 *   const core = await import('/share-core.js');
 *   core.makeCard({ kind, id, title, snippet, image, author, authorPhoto })   -> clean card object
 *   core.loadPeople()                 -> [{ uid, name, photo, username, group }]  (recent chats, then people you follow)
 *   core.searchPeople('ada')          -> [{ uid, name, photo, username }]          (anyone on the platform)
 *   core.sendCard(card, people, note) -> { ok, bad, results }
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
export const MAX_PICK = 10;

let app, auth, db, me = null;
function boot(){
  if(app) return;
  app = getApps().length ? getApp() : initializeApp(CONFIG);
  auth = getAuth(app);
  db = getFirestore(app, 'default');
}
const waitUser = () => new Promise(res => { const off = onAuthStateChanged(auth, u => { off(); res(u); }); });
export async function currentUser(){ boot(); return auth.currentUser || await waitUser(); }

const cidOf = (a, b) => [a, b].sort().join('_');
const clip = (s, n) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);
const httpsUrl = u => (typeof u === 'string' && /^https:\/\//.test(u) && u.length <= 500) ? u : '';

const absUrl = u => { try{ return typeof u === 'string' && u ? new URL(u, location.origin).href : ''; }catch(e){ return ''; } };

export function makeCard(item){
  item = item || {};
  const kind = item.kind === 'article' ? 'article' : 'post';
  const id = String(item.id || '').trim().slice(0, 64);
  let title = clip(item.title, 160), snippet = clip(item.snippet, 600);
  if(kind === 'post' && !title && snippet){         // a post has no headline: its first line / sentence becomes the title, the rest is the preview
    const full = String(item.snippet || '').trim();
    const cut = full.search(/[\n.!?](\s|$)/);
    let head;
    if(cut >= 12 && cut < 90) head = full.slice(0, cut + 1);
    else { head = full.slice(0, 80); if(full.length > 80){ const sp = head.lastIndexOf(' '); if(sp > 40) head = head.slice(0, sp); } }
    title = clip(head, 90) + (head.length < full.length && !/[.!?]$/.test(head.trim()) ? '…' : '');
    snippet = clip(full.slice(head.length), 240);
  }
  return {
    sk:kind, sid:id,
    st:clip(title, 160) || (kind === 'article' ? 'Article' : 'Post'),
    sx:clip(snippet, 240), sa:clip(item.author, 80),
    si:httpsUrl(absUrl(item.image)), sp:httpsUrl(absUrl(item.authorPhoto))
  };
}

async function fetchProfiles(ids){
  const out = [];
  for(let i = 0; i < ids.length; i += 10){
    const snap = await getDocs(query(collection(db, 'users'), where(documentId(), 'in', ids.slice(i, i + 10))));
    snap.docs.forEach(d => { const x = d.data(); out.push({ uid:d.id, name:x.name || '', photo:x.photo || x.photoURL || '', username:x.username || '' }); });
  }
  return out;
}

/* people already in my inbox first, then people I follow. Two small queries, done once per drawer open. */
export async function loadPeople(){
  const user = await currentUser(); if(!user) return [];
  const seen = new Set([user.uid]), list = [];
  try{
    const ts = await getDocs(query(collection(db, 'inbox', user.uid, 'threads'), orderBy('lastAt', 'desc'), limit(30)));
    ts.docs.forEach(d => { const x = d.data(), uid = x.otherUid || d.id; if(x.deleted === true || seen.has(uid) || uid === 'official') return; seen.add(uid); list.push({ uid, name:x.name || '', photo:x.photo || '', username:'', group:'Recent chats' }); });
  }catch(e){}
  try{
    const fs = await getDocs(query(collection(db, 'follows'), where('followerId', '==', user.uid), limit(40)));
    const ids = [...new Set(fs.docs.map(d => d.data().followingId).filter(id => id && !seen.has(id) && id !== 'official' && !id.includes('_')))];
    if(ids.length) (await fetchProfiles(ids)).forEach(p => { if(p.name && !seen.has(p.uid)){ seen.add(p.uid); list.push({ ...p, group:'People you follow' }); } });
  }catch(e){}
  return list;
}

/* anyone on the platform, by @username or name (same prefix search the "new message" screen uses) */
export async function searchPeople(text){
  const user = await currentUser(); if(!user) return [];
  const q = String(text || '').trim().replace(/^@/, '');
  if(q.length < 2) return [];
  const title = q.replace(/\b\w/g, c => c.toUpperCase());
  const range = (field, v) => getDocs(query(collection(db, 'users'), where(field, '>=', v), where(field, '<=', v + '\uf8ff'), limit(8))).catch(() => null);
  const [u1, n1, n2] = await Promise.all([range('username', q.toLowerCase()), range('name', q), title !== q ? range('name', title) : Promise.resolve(null)]);
  const seen = new Map();
  [u1, n1, n2].forEach(sn => sn && sn.docs.forEach(d => {
    if(d.id === user.uid || d.id === 'official' || seen.has(d.id)) return;
    const x = d.data(); if(!x.name) return;
    seen.set(d.id, { uid:d.id, name:x.name || '', photo:x.photo || x.photoURL || '', username:x.username || '', group:'On MindShift' });
  }));
  return [...seen.values()].slice(0, 20);
}

/* the single sending routine: one message + both inbox rows per person, all-or-nothing per person */
export async function sendCard(card, people, note){
  const user = await currentUser(); if(!user) return { ok:0, bad:people.length, results:[] };
  if(!card || !card.sid) return { ok:0, bad:people.length, results:[] };
  if(!me || me.uid !== user.uid){
    let name = '', photo = '';
    try{ const u = await getDoc(doc(db, 'users', user.uid)); if(u.exists()){ const x = u.data(); name = x.name || ''; photo = x.photo || x.photoURL || ''; } }catch(e){}
    me = { uid:user.uid, name:name || user.displayName || 'MindShift Books User', photo };
  }
  const text = '🔗 Shared ' + (card.sk === 'article' ? 'an article' : 'a post');
  const cap = clip(note, 400);
  const results = await Promise.allSettled(people.slice(0, MAX_PICK).map(async p => {
    const ref = doc(collection(db, 'conversations', cidOf(user.uid, p.uid), 'messages'));
    const payload = { senderUid:user.uid, text, createdAt:serverTimestamp(), type:'share', sk:card.sk, sid:card.sid, st:card.st };
    if(card.sx) payload.sx = card.sx; if(card.sa) payload.sa = card.sa; if(card.si) payload.si = card.si; if(card.sp) payload.sp = card.sp; if(cap) payload.cap = cap;
    const b = writeBatch(db);
    b.set(ref, payload);
    b.set(doc(db, 'inbox', user.uid, 'threads', p.uid), { otherUid:p.uid, name:p.name || '', photo:p.photo || '', lastText:text, lastAt:serverTimestamp(), lastSender:user.uid, unread:0, accepted:true }, { merge:true });
    b.set(doc(db, 'inbox', p.uid, 'threads', user.uid), { otherUid:user.uid, name:me.name, photo:me.photo, lastText:text, lastAt:serverTimestamp(), lastSender:user.uid, unread:increment(1) }, { merge:true });
    await b.commit();
    return p;
  }));
  const ok = results.filter(r => r.status === 'fulfilled').length;
  return { ok, bad:results.length - ok, results };
}
