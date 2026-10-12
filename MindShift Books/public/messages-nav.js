/* messages-nav.js — adds "Messages" (with an unread badge) to the shared side menu.
   Load AFTER /sidebar-nav.js on any page that has the menu:
     <script type="module" src="/messages-nav.js?v=1"></script>
   It clones the existing "My Profile" row, so it picks up the menu's own styling, and shows/hides the new row
   together with it (signed-in users only). Unread count = ONE aggregate read (counts as 1 read), cached for 90s,
   and cleared by the Messages page whenever something is read — so it never costs more than ~1 read a minute. */
import { getApps } from 'https://www.gstatic.com/firebasejs/10.11.0/firebase-app.js';
import { getAuth, onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/10.11.0/firebase-auth.js';
import { getFirestore, collection, query, where, getCountFromServer, doc, setDoc, serverTimestamp } from 'https://www.gstatic.com/firebasejs/10.11.0/firebase-firestore.js';

const CACHE_KEY = 'msb_unread_v1';
const CHAT_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.38 8.38 0 01-.9 3.8 8.5 8.5 0 01-7.6 4.7 8.38 8.38 0 01-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 01-.9-3.8 8.5 8.5 0 014.7-7.6 8.38 8.38 0 013.8-.9h.5a8.48 8.48 0 018 8v.5z"/></svg>';

let unread = 0, row = null, badge = null, dot = null;

function paint(){
  if(badge){ badge.textContent = unread > 99 ? '99+' : String(unread); badge.style.display = unread > 0 ? 'inline-flex' : 'none'; }
  const tgl = document.getElementById('sidebarToggle');
  if(tgl){
    if(!dot){
      dot = document.createElement('span');
      dot.style.cssText = 'position:absolute;top:6px;right:6px;width:10px;height:10px;border-radius:50%;background:#ef4444;border:2px solid #fff;display:none;pointer-events:none';
      if(getComputedStyle(tgl).position === 'static') tgl.style.position = 'relative';
      tgl.appendChild(dot);
    }
    dot.style.display = unread > 0 ? 'block' : 'none';
  }
}

function findRow(){
  // the menu row whose label is exactly "My Profile": climb until the parent also contains "My Insights"
  // (so we land on the row itself, a direct child of the menu group — whatever classes it uses)
  for(const el of document.body.querySelectorAll('*')){
    if(el.children.length || el.textContent.trim() !== 'My Profile') continue;
    let r = el;
    while(r.parentElement && r.parentElement !== document.body && !r.parentElement.textContent.includes('My Insights')) r = r.parentElement;
    if(r.parentElement && r.parentElement !== document.body && r.parentElement.textContent.includes('My Insights')) return r;
  }
  return null;
}

function install(){
  if(document.querySelector('[data-msb-messages]')) return true;
  const src = findRow();
  if(!src) return false;
  const clone = src.cloneNode(true);
  clone.setAttribute('data-msb-messages', '1');
  clone.removeAttribute('id');
  clone.querySelectorAll('[id]').forEach(n => n.removeAttribute('id'));
  clone.removeAttribute('onclick');
  clone.querySelectorAll('[onclick]').forEach(n => n.removeAttribute('onclick'));
  if(clone.tagName === 'A') clone.setAttribute('href', '/messages');
  clone.querySelectorAll('a').forEach(a => a.setAttribute('href', '/messages'));
  // label
  const lab = [...clone.querySelectorAll('*')].find(n => n.children.length === 0 && n.textContent.trim() === 'My Profile');
  if(lab) lab.textContent = 'Messages';
  // icon: keep the original svg's size/class, swap its drawing
  const svgs = clone.querySelectorAll('svg');
  if(svgs[0]){
    const tmp = document.createElement('div'); tmp.innerHTML = CHAT_ICON;
    const ns = tmp.firstChild;
    ['class','width','height','style'].forEach(a => { if(svgs[0].hasAttribute(a)) ns.setAttribute(a, svgs[0].getAttribute(a)); });
    svgs[0].replaceWith(ns);
  }
  // unread pill right after the label
  badge = document.createElement('span');
  badge.style.cssText = 'display:none;min-width:20px;height:20px;padding:0 6px;margin-left:8px;border-radius:99px;background:linear-gradient(135deg,#4f46e5,#06b6d4);color:#fff;font-size:11.5px;font-weight:800;align-items:center;justify-content:center;flex-shrink:0';
  (lab ? lab.parentElement : clone).insertBefore(badge, lab ? lab.nextSibling : null);
  clone.addEventListener('click', e => { e.preventDefault(); location.href = '/messages'; });
  src.parentElement.insertBefore(clone, src.nextSibling);
  // follow the original row's visibility (the menu shows it for signed-in users only)
  const mirror = () => { clone.style.display = src.style.display; };
  mirror();
  new MutationObserver(mirror).observe(src, { attributes:true, attributeFilter:['style','class','hidden'] });
  paint();
  return true;
}

// "Active now": one tiny write at most every 5 minutes (shared across tabs via localStorage), only while visible.
function pingActive(user){
  if(!user || document.hidden) return;
  try{
    const last = Number(localStorage.getItem('msb_ping_v1') || 0);
    if(Date.now() - last < 300000) return;
    localStorage.setItem('msb_ping_v1', String(Date.now()));
  }catch(e){}
  try{
    const app = getApps()[0]; if(!app) return;
    setDoc(doc(getFirestore(app, 'default'), 'presence', user.uid), { lastActive: serverTimestamp() }).catch(() => {});
  }catch(e){}
}

async function refreshCount(user){
  try{
    const c = JSON.parse(sessionStorage.getItem(CACHE_KEY));
    if(c && c.uid === user.uid && Date.now() - c.t < 90000){ unread = c.n; paint(); return; }
  }catch(e){}
  try{
    const app = getApps()[0]; if(!app) return;
    const db = getFirestore(app, 'default');
    const snap = await getCountFromServer(query(collection(db, 'inbox', user.uid, 'threads'), where('unread', '>', 0)));
    unread = snap.data().count || 0;
    try{ sessionStorage.setItem(CACHE_KEY, JSON.stringify({ uid:user.uid, n:unread, t:Date.now() })); }catch(e){}
    paint();
  }catch(e){ /* messages not enabled yet (rules) or offline — just no badge */ }
}

// wait for the page's own Firebase app + the menu to exist (the menu may be built later, so keep watching —
// lightly: debounced, and given up on after 30s)
let done = false;
function attempt(){
  if(done || !getApps().length) return;
  if(!install()) return;
  done = true;
  if(obs) obs.disconnect();
  // warm the Messages page so tapping it opens from cache
  (window.requestIdleCallback || (f => setTimeout(f, 1500)))(() => {
    try{ const l = document.createElement('link'); l.rel = 'prefetch'; l.href = '/messages'; l.as = 'document'; document.head.appendChild(l); }catch(e){}
  });
  onAuthStateChanged(getAuth(getApps()[0]), user => {
    if(user){
      refreshCount(user); pingActive(user);
      setInterval(() => pingActive(getAuth(getApps()[0]).currentUser), 300000);
      document.addEventListener('visibilitychange', () => pingActive(getAuth(getApps()[0]).currentUser));
    } else {
      unread = 0; paint();
      try{ Object.keys(localStorage).filter(k => k.startsWith('msb_inbox_v1_') || k.startsWith('msb_chat_v1_') || k.startsWith('msb_silent_v1_') || k === 'msb_chat_idx').forEach(k => localStorage.removeItem(k)); }catch(e){}
    }
  });
}
let timer = null;
const obs = new MutationObserver(() => { clearTimeout(timer); timer = setTimeout(attempt, 250); });
obs.observe(document.documentElement, { childList:true, subtree:true });
attempt();
setTimeout(() => { if(!done) obs.disconnect(); }, 30000);
