// server/seo.js
// ─────────────────────────────────────────────────────────────────────────────
// Link previews + sitemap.
//
// WHY: post-read.html / article-read.html / profile.html set their title and
// content in the browser with JavaScript. WhatsApp, X, Facebook, Telegram and
// Google's first pass DON'T run JavaScript — they read the raw HTML the server
// sends. So every shared link showed the same generic card. This file makes the
// SERVER look the post / article / profile up in Firestore and write the right
// <title> + Open Graph / Twitter tags into the HTML before sending it. The page
// itself behaves exactly as before for real visitors.
//
// Also replaces the static public/sitemap.xml with a live one that includes
// published articles, posts and public profiles (the store pages from the
// static file are kept).
//
// Safe by design: ANY failure (Firestore hiccup, missing doc, odd data) falls
// back to sending the normal page untouched — previews are a bonus, never a
// reason for a page to break.
// ─────────────────────────────────────────────────────────────────────────────
const fs = require('fs');
const path = require('path');

const TTL_MS = 60 * 1000;          // per-item metadata cache (crawlers hit the same link in bursts)
const MAX_CACHE = 400;           // entries now also hold the page's content, so keep the count modest
const PRELOAD_MAX = 150 * 1024;  // bigger documents just skip the preload (the page fetches them itself)
const SITEMAP_TTL_MS = 60 * 60 * 1000;
const SITEMAP_LIMIT = 2000;        // newest N articles / posts, plus all usernames up to PROFILE_LIMIT
const PROFILE_LIMIT = 5000;

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function clean(s, max) {
  const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max - 1).trimEnd() + '…' : t;
}


// ── Instant-load helpers ───────────────────────────────────────────────────
// The article/post pages used to wait for the Firebase SDK to download, connect and fetch the document before
// showing anything. We already read the document here (for link previews), so we ALSO:
//   1) paint a plain first screen straight into the HTML (title, author, picture, first lines — text only), and
//   2) embed the document itself, so the page can render without asking Firestore again.
// Everything below is escaped / text-only: nothing user-written is ever put into the page as raw HTML.
function toPlain(html) {
  return String(html == null ? '' : html)
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ').trim();
}
function safeUrl(u) {
  const t = String(u == null ? '' : u).trim();
  return /^https?:\/\//i.test(t) || /^\/[^/]/.test(t) ? t : '';
}
// Firestore Timestamp → {__ts: ms}; the page turns it back into something with toDate().
function plainDoc(v) {
  if (v == null) return v;
  if (typeof v.toMillis === 'function') return { __ts: v.toMillis() };
  if (Array.isArray(v)) return v.map(plainDoc);
  if (typeof v === 'object') { const o = {}; for (const k of Object.keys(v)) o[k] = plainDoc(v[k]); return o; }
  return v;
}
function preloadScript(kind, id, data, extra) {
  try {
    const json = JSON.stringify(Object.assign({ kind, id, data: plainDoc(data) }, extra || {}));
    if (json.length > PRELOAD_MAX) return '';
    return json.replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
  } catch (_) { return ''; }
}
function authorRowHtml(name, photo, meta, badge) {
  return '<div class="author-row-wrap"><div class="author-row"><img class="author-logo" data-author-photo src="' + esc(safeUrl(photo) || 'logo.jpg') + '" alt="' + esc(name) + '">' +
    '<div><div class="author-name"><span>' + esc(name) + '</span></div><div class="author-meta">' + esc(meta) + '</div></div></div></div>';
}
function articleFirstPaint(x) {
  const paras = String(x.body || '').split('</p>').map(toPlain).filter(Boolean).slice(0, 2);
  const body = (paras.length ? paras : [toPlain(x.body).slice(0, 400)].filter(Boolean)).map((t) => '<p>' + esc(t) + '</p>').join('');
  const hero = safeUrl(x.cover || x.img);
  return '<div class="art-wrap"><span class="art-cat">' + esc(x.cat || '') + '</span><h1 class="art-title">' + esc(x.title || '') + '</h1>' +
    authorRowHtml(x.authorName || 'MindShift Books', x.authorPhoto, x.readTime || x.read || '') +
    (hero ? '<img class="art-hero" src="' + esc(hero) + '" alt="">' : '') + '<div class="art-body">' + body + '</div></div>';
}
function postFirstPaint(x) {
  const img = safeUrl((Array.isArray(x.images) && x.images[0]) || x.thumbnailUrl);
  return '<div class="art-wrap">' + authorRowHtml(x.authorName || 'MindShift Books User', x.authorPhoto, '') +
    (x.text ? '<div class="post-text">' + esc(x.text) + '</div>' : '') +
    (img ? '<div class="post-single"><img src="' + esc(img) + '" alt=""></div>' : '') + '</div>';
}

// Profile first screen: swap the grey placeholders for the real name / picture / cover. Each swap is an exact
// string match, so if profile.html's markup is ever edited the swap quietly does nothing and the page behaves as before.
function profileSwaps(x) {
  const name = String(x.name || 'MindShift Books User');
  const photo = safeUrl(x.photo), cover = safeUrl(x.cover);
  const sw = [];
  sw.push(['<div class="skel skel-name" id="nameSkel"></div>', '<span id="nameSkel">' + esc(name) + '</span>']);
  sw.push(['<div class="skel skel-avatar" id="avatarSkel" style="border:3px solid var(--card)"></div>',
    '<div class="avatar-photo-wrap" id="avatarSkel">' + (photo ? '<img src="' + esc(photo) + '" alt="">' : '<span>' + esc(name.slice(0, 1).toUpperCase() || 'U') + '</span>') + '</div>']);
  if (cover) sw.push(['<img id="coverImg" src="" alt="" style="display:none">', '<img id="coverImg" src="' + esc(cover) + '" alt="" style="display:block">']);
  return sw;
}

function registerSeo(app, { publicDir }) {
  let shared = null;
  const getShared = () => (shared || (shared = require('./shared')));
  const site = () => String(getShared().PUBLIC_SITE_URL || 'https://mindshiftbooks.shop').replace(/\/$/, '');
  const abs = (u) => {
    if (!u) return '';
    u = String(u).trim();
    if (/^https?:\/\//i.test(u)) return u;
    if (u.startsWith('//')) return 'https:' + u;
    return site() + '/' + u.replace(/^\//, '');
  };

  // ── tiny TTL cache ────────────────────────────────────────────────────────
  const cache = new Map();
  const cget = (k) => { const v = cache.get(k); if (v && v.exp > Date.now()) return v.val; cache.delete(k); return undefined; };
  const cset = (k, val, ttl) => {
    if (cache.size >= MAX_CACHE) cache.delete(cache.keys().next().value);
    cache.set(k, { val, exp: Date.now() + (ttl || TTL_MS) });
  };
  // "Not found / not published" is remembered only briefly, so a post that has just been published
  // doesn't keep answering "not found" for a minute.
  const NEG_TTL_MS = 5 * 1000;

  // Forget what we saved for one item so the very next visit reads it fresh. Returns how many entries went.
  function invalidate(kind, id) {
    let n = 0;
    if (kind === 'all') { n = cache.size; cache.clear(); return n; }
    if (kind === 'article' || kind === 'post') {
      const k = (kind === 'article' ? 'article-read.html' : 'post-read.html') + '|' + JSON.stringify(id);
      if (cache.delete(k)) n++;
    } else if (kind === 'profile') {
      // a profile can be cached under its username AND its uid, so match on the uid inside
      for (const [k, v] of cache) {
        if (k.startsWith('profile.html|') && v.val && v.val.uid === id) { cache.delete(k); n++; }
      }
    }
    return n;
  }
  // ── Several server copies ───────────────────────────────────────────────────
  // Each running copy of the server keeps its own saved pages. So a change is also written as a tiny note in
  // Firestore (seoInvalidations), and every copy listens for new notes and clears its own saved page. With one
  // server this costs one extra write per edit; with more it keeps them all in step.
  const INSTANCE_ID = Math.random().toString(36).slice(2) + Date.now().toString(36);
  function forget(kind, id) {                       // clear here AND tell the other copies
    const n = invalidate(kind, id);
    try {
      const { db, admin } = getShared();
      if (db && admin) {
        const key = (kind === 'all' ? 'all' : kind + '__' + id).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 200);
        db.collection('seoInvalidations').doc(key).set({
          kind, id: String(id || ''), by: INSTANCE_ID, at: admin.firestore.FieldValue.serverTimestamp()
        }).catch((e) => console.warn('[seo] could not post invalidation:', e.message));
      }
    } catch (_) {}
    return n;
  }
  app.locals.seoInvalidate = forget;               // other server code (admin tools, crons) can call this too

  function listenForInvalidations() {
    try {
      const { db, admin } = getShared();
      if (!db || !admin) return;
      const since = admin.firestore.Timestamp.fromMillis(Date.now() - 10000);
      db.collection('seoInvalidations').where('at', '>=', since).onSnapshot((snap) => {
        snap.docChanges().forEach((c) => {
          if (c.type === 'removed') return;
          const d = c.doc.data() || {};
          if (d.by === INSTANCE_ID) return;        // we already cleared our own
          invalidate(d.kind, d.id);
        });
      }, (err) => {
        console.warn('[seo] invalidation listener stopped, retrying in 30s:', err && err.message);
        setTimeout(listenForInvalidations, 30000).unref();
      });
      // tidy up old notes once in a while
      setInterval(async () => {
        try {
          const old = await db.collection('seoInvalidations')
            .where('at', '<', admin.firestore.Timestamp.fromMillis(Date.now() - 24 * 3600 * 1000)).limit(200).get();
          if (old.empty) return;
          const batch = db.batch(); old.docs.forEach((d) => batch.delete(d.ref)); await batch.commit();
        } catch (_) {}
      }, 6 * 3600 * 1000).unref();
    } catch (e) { console.warn('[seo] listener not started:', e.message); }
  }
  setTimeout(listenForInvalidations, 3000).unref();

  // ── HTML template (re-read only when the file changes) ───────────────────
  const tpl = {};
  function template(file) {
    const p = path.join(publicDir, file);
    const st = fs.statSync(p);
    if (!tpl[file] || tpl[file].mtime !== st.mtimeMs) tpl[file] = { mtime: st.mtimeMs, html: fs.readFileSync(p, 'utf8') };
    return tpl[file].html;
  }

  function inject(html, m) {
    const image = m.image ? abs(m.image) : abs('/og-image.jpg');
    const hasRealImage = !!m.image;
    const lines = [
      `<title>${esc(m.title)}</title>`,
      `<meta name="description" content="${esc(m.description)}">`,
      `<link rel="canonical" href="${esc(m.url)}">`,
      `<meta property="og:site_name" content="MindShift Books">`,
      `<meta property="og:type" content="${esc(m.type || 'article')}">`,
      `<meta property="og:title" content="${esc(m.title)}">`,
      `<meta property="og:description" content="${esc(m.description)}">`,
      `<meta property="og:url" content="${esc(m.url)}">`,
      `<meta property="og:image" content="${esc(image)}">`,
      `<meta name="twitter:card" content="${hasRealImage ? 'summary_large_image' : 'summary'}">`,
      `<meta name="twitter:title" content="${esc(m.title)}">`,
      `<meta name="twitter:description" content="${esc(m.description)}">`,
      `<meta name="twitter:image" content="${esc(image)}">`
    ];
    if (m.publishedTime) lines.push(`<meta property="article:published_time" content="${esc(m.publishedTime)}">`);
    const stripped = html
      .replace(/<title>[\s\S]*?<\/title>\s*/i, '')
      .replace(/<meta\s+(?:property|name)=["'](?:og:[^"']+|twitter:[^"']+|description)["'][^>]*>\s*/gi, '')
      .replace(/<link\s+rel=["']canonical["'][^>]*>\s*/gi, '');
    return stripped.replace(/<head[^>]*>/i, (h) => h + '\n' + lines.join('\n') + '\n');
  }

  function iso(ts) {
    try {
      const d = ts && ts.toDate ? ts.toDate() : (ts ? new Date(ts) : null);
      return d && !isNaN(d) ? d.toISOString() : '';
    } catch (_) { return ''; }
  }

  // ── metadata lookups (return null → serve the page untouched) ────────────
  async function postMeta(id) {
    const { db } = getShared();
    const snap = await db.collection('posts').doc(id).get();
    if (!snap.exists) return null;
    const x = snap.data();
    if (x.status !== 'published') return null;
    const name = x.authorName || 'MindShift Books User';
    const text = clean(x.text, 200);
    const isVideo = !!x.videoUrl;
    const image = (Array.isArray(x.images) && x.images[0]) || x.thumbnailUrl || '';
    // Polls: say it's a poll and show the choices, so the link itself invites a vote.
    const pollOpts = (x.poll && Array.isArray(x.poll.options))
      ? x.poll.options.map((o) => clean(o && o.text, 40)).filter(Boolean).slice(0, 4) : [];
    const isPoll = pollOpts.length >= 2;
    let description = text || (isVideo ? `Watch ${name}'s video on MindShift Books.` : `See ${name}'s post on MindShift Books.`);
    if (isPoll) {
      const tail = ' \u2014 ' + pollOpts.join(' \u00b7 ');
      const q = clean(x.text, Math.max(40, 200 - tail.length));
      description = `Poll: ${q || 'Cast your vote'}${tail}`;
      if (description.length > 200) description = description.slice(0, 199).trimEnd() + '\u2026';
    }
    return {
      title: isPoll ? `Poll by ${name} on MindShift Books` : `${name} on MindShift Books`,
      description,
      image, type: isVideo ? 'video.other' : 'article',
      url: `${site()}/post-read?id=${encodeURIComponent(id)}`,
      publishedTime: iso(x.publishedAt || x.createdAt),
      firstPaint: postFirstPaint(x), preload: preloadScript('post', id, x)
    };
  }
  async function articleMeta(id) {
    const { db } = getShared();
    const snap = await db.collection('articles').doc(id).get();
    if (!snap.exists) return null;
    const x = snap.data();
    if (x.status !== 'published') return null;
    return {
      title: `${clean(x.title, 110) || 'Article'} · MindShift Books`,
      description: clean(x.brief, 200) || `Read this article by ${x.authorName || 'MindShift Books'} on MindShift Books.`,
      image: x.cover || x.img || '', type: 'article',
      url: `${site()}/article-read?id=${encodeURIComponent(id)}`,
      publishedTime: iso(x.publishedAt || x.createdAt),
      firstPaint: articleFirstPaint(x), preload: preloadScript('article', id, x)
    };
  }
  async function profileMeta({ username, uid }) {
    const { db } = getShared();
    let u = (username || '').toLowerCase();
    let theUid = uid || '';
    if (!theUid && u) {
      const un = await db.collection('usernames').doc(u).get();
      if (!un.exists) return null;
      theUid = un.data().uid;
    }
    if (!theUid) return null;
    const us = await db.collection('users').doc(theUid).get();
    if (!us.exists) return null;
    const x = us.data();
    const name = x.name || 'MindShift Books creator';
    const handle = x.username || u;
    return {
      title: `${name}${handle ? ` (@${handle})` : ''} · MindShift Books`,
      description: clean(x.bio, 200) || `Follow ${name} on MindShift Books for articles, posts and videos.`,
      image: x.photo || '', type: 'profile',
      url: handle ? `${site()}/profile/@${encodeURIComponent(handle)}` : `${site()}/profile?uid=${encodeURIComponent(theUid)}`,
      uid: theUid,
      swaps: profileSwaps(x),
      preload: preloadScript('profile', theUid, x, { username: String(handle || u || '').toLowerCase() })
    };
  }

  // One handler factory: look metadata up (cached), inject, send. Any problem → plain page.
  function route(file, getKey, lookup) {
    return async (req, res, next) => {
      try {
        const key = getKey(req);
        if (!key) return next();
        const ck = file + '|' + JSON.stringify(key);
        let meta = cget(ck);
        if (meta === undefined) { meta = await lookup(key); cset(ck, meta || null, meta ? 0 : NEG_TTL_MS); }
        if (!meta) return next();            // nothing found / not public → normal page
        res.set('Content-Type', 'text/html; charset=utf-8');
        res.set('Cache-Control', 'no-cache');
        let out = inject(template(file), meta);
        if (meta.firstPaint) {
          // function replacement on purpose: a "$" in a post must not be read as a replace pattern
          out = out.replace('<div id="artContent"></div>', () =>
            '<div id="artContent">' + meta.firstPaint + '</div>' +
            (meta.preload ? '<script>window.__PRELOAD__=' + meta.preload + ';</script>' : ''));
        }
        if (meta.swaps) {
          for (const [from, to] of meta.swaps) out = out.replace(from, () => to);
          if (meta.preload) out = out.replace('</head>', () => '<script>window.__PRELOAD__=' + meta.preload + ';</script></head>');
        }
        return res.send(out);
      } catch (e) {
        console.warn('[seo] preview skipped:', file, e && e.message);
        return next();
      }
    };
  }
  const idOf = (req) => {
    const id = String(req.query.id || '').trim();
    return /^[A-Za-z0-9_-]{4,128}$/.test(id) ? id : '';
  };

  app.get('/post-read', route('post-read.html', idOf, postMeta));
  app.get('/article-read', route('article-read.html', idOf, articleMeta));
  app.get('/profile/@:username', route('profile.html',
    (req) => ({ username: String(req.params.username || '').slice(0, 40) }), profileMeta));
  app.get('/profile', route('profile.html', (req) => {
    const uid = String(req.query.uid || '').trim(), username = String(req.query.username || '').trim();
    if (/^[A-Za-z0-9_-]{6,128}$/.test(uid)) return { uid };
    if (/^[A-Za-z0-9_]{3,20}$/.test(username)) return { username };
    return null;                              // own profile (no params) → normal page
  }, profileMeta));


  // ── "I just edited this" ──────────────────────────────────────────────────
  // The pages call this right after a save. Only the owner may refresh an item, and each person is limited,
  // so it can't be used to make the server re-read things over and over.
  const refreshHits = new Map();   // uid -> [timestamps]
  app.post('/api/seo/refresh', (req, res, next) => getShared().requireUser(req, res, next), async (req, res) => {
    try {
      const now = Date.now();
      const hits = (refreshHits.get(req.uid) || []).filter((t) => now - t < 60000);
      if (hits.length >= 30) return res.status(429).json({ ok: false });
      hits.push(now); refreshHits.set(req.uid, hits);
      if (refreshHits.size > 5000) refreshHits.delete(refreshHits.keys().next().value);

      const kind = String((req.body && req.body.kind) || '');
      const id = String((req.body && req.body.id) || '').trim();
      if (!/^[A-Za-z0-9_-]{4,128}$/.test(id)) return res.status(400).json({ ok: false });
      if (kind === 'profile') {
        if (id !== req.uid) return res.status(403).json({ ok: false });
        return res.json({ ok: true, cleared: forget('profile', id) });
      }
      if (kind !== 'article' && kind !== 'post') return res.status(400).json({ ok: false });
      const { db } = getShared();
      const snap = await db.collection(kind === 'article' ? 'articles' : 'posts').doc(id).get();
      // a deleted item has no owner left to check, and clearing its entry is harmless
      if (snap.exists && (snap.data().authorUid || snap.data().userId) !== req.uid) return res.status(403).json({ ok: false });
      return res.json({ ok: true, cleared: forget(kind, id) });
    } catch (e) {
      return res.status(500).json({ ok: false });
    }
  });

  // ── dynamic sitemap ───────────────────────────────────────────────────────
  let sm = { xml: '', exp: 0 };
  function staticUrlBlocks() {
    try {
      const x = fs.readFileSync(path.join(publicDir, 'sitemap.xml'), 'utf8');
      return (x.match(/<url>[\s\S]*?<\/url>/g) || []);
    } catch (_) { return []; }
  }
  async function buildSitemap() {
    const { db } = getShared();
    const base = site();
    const out = staticUrlBlocks();
    const have = new Set(out.map((b) => (b.match(/<loc>([^<]+)<\/loc>/) || [])[1]));
    const add = (loc, lastmod, freq, prio) => {
      if (have.has(loc)) return; have.add(loc);
      out.push(`  <url>\n    <loc>${esc(loc)}</loc>${lastmod ? `\n    <lastmod>${lastmod}</lastmod>` : ''}\n    <changefreq>${freq}</changefreq>\n    <priority>${prio}</priority>\n  </url>`);
    };
    const safe = async (fn) => { try { return await fn(); } catch (e) { console.warn('[seo] sitemap section skipped:', e && e.message); return null; } };

    const arts = await safe(() => db.collection('articles').where('status', '==', 'published').orderBy('publishedAt', 'desc').limit(SITEMAP_LIMIT).get());
    if (arts) arts.forEach((d) => add(`${base}/article-read?id=${encodeURIComponent(d.id)}`, iso(d.data().publishedAt).slice(0, 10), 'monthly', '0.7'));
    const posts = await safe(() => db.collection('posts').where('status', '==', 'published').orderBy('publishedAt', 'desc').limit(SITEMAP_LIMIT).get());
    if (posts) posts.forEach((d) => add(`${base}/post-read?id=${encodeURIComponent(d.id)}`, iso(d.data().publishedAt).slice(0, 10), 'monthly', '0.5'));
    const names = await safe(() => db.collection('usernames').limit(PROFILE_LIMIT).get());
    if (names) names.forEach((d) => add(`${base}/profile/@${encodeURIComponent(d.id)}`, '', 'weekly', '0.6'));

    return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${out.join('\n')}\n</urlset>\n`;
  }
  app.get('/sitemap.xml', async (req, res, next) => {
    try {
      if (sm.xml && sm.exp > Date.now()) { res.type('application/xml'); return res.send(sm.xml); }
      const xml = await buildSitemap();
      sm = { xml, exp: Date.now() + SITEMAP_TTL_MS };
      res.type('application/xml'); res.set('Cache-Control', 'public, max-age=3600');
      return res.send(xml);
    } catch (e) {
      console.warn('[seo] sitemap fell back to static file:', e && e.message);
      return next();                          // express.static serves the old public/sitemap.xml
    }
  });
}

module.exports = registerSeo;
module.exports._esc = esc;
