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
const MAX_CACHE = 800;
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
  const cset = (k, val) => {
    if (cache.size >= MAX_CACHE) cache.delete(cache.keys().next().value);
    cache.set(k, { val, exp: Date.now() + TTL_MS });
  };

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
      publishedTime: iso(x.publishedAt || x.createdAt)
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
      publishedTime: iso(x.publishedAt || x.createdAt)
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
      url: handle ? `${site()}/profile/@${encodeURIComponent(handle)}` : `${site()}/profile?uid=${encodeURIComponent(theUid)}`
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
        if (meta === undefined) { meta = await lookup(key); cset(ck, meta || null); }
        if (!meta) return next();            // nothing found / not public → normal page
        res.set('Content-Type', 'text/html; charset=utf-8');
        res.set('Cache-Control', 'no-cache');
        return res.send(inject(template(file), meta));
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
