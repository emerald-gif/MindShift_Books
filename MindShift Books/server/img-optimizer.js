// server/img-optimizer.js
// On-the-fly image optimizer — the "just make big images load fast" piece.
//
//   GET /_img?src=/tda.jpg&w=480
//
// Resizes the picture to (at most) the width the page actually needs, re-encodes it as WebP (or a
// lighter JPEG/PNG for browsers without WebP) and caches the result on disk, so every later request
// is just a file read. Nothing has to be pre-generated: add any image to /public, anywhere, and it
// is optimized the first time somebody asks for it. Edit or replace the original and the cache
// refreshes itself (the cache key includes the file's size + modified time).
//
// It can never break an image: bad request, missing file, sharp not installed, any error → the
// request is redirected to the original file, exactly like before.
//
// Two ways in (both wired up in server.js):
//   1. /_img?src=…&w=…   — an exact size, used by the book API (coverSm / coverMd) for small cards.
//   2. AUTOMATIC          — every plain request for a local .jpg/.png (<img src="/tda.jpg">, CSS backgrounds, emails …) goes through
//                           here too, capped at 1440px wide + WebP. No page needs to change, and any image you add later is covered.
//                           (Add ?raw=1 to a URL to get the untouched original.)
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

let sharp = null;
try { sharp = require('sharp'); }
catch (e) { console.warn('[img] "sharp" is not installed — images are served unchanged. Run: npm install'); }

const WIDTHS = [160, 240, 320, 480, 640, 800, 1080, 1440, 1920];   // only these sizes exist, so the cache can't be flooded
const QUALITY = 78;
const SKIP_BELOW = 30 * 1024;                                       // already small? serve as-is
const MAX_PARALLEL = 2;                                             // keeps memory low on small servers

function snapWidth(w) {
  w = parseInt(w, 10);
  if (!w || w < 1) return 640;
  for (const s of WIDTHS) if (s >= w) return s;
  return WIDTHS[WIDTHS.length - 1];
}

module.exports = function imageOptimizer({ publicDir, cacheDir }) {
  try { fs.mkdirSync(cacheDir, { recursive: true }); } catch (e) { /* made on first write instead */ }
  const root = path.resolve(publicDir);
  const inflight = new Map();      // key -> Promise (two people asking for the same image share one job)
  let running = 0; const waiting = [];
  const slot = () => new Promise(r => { if (running < MAX_PARALLEL) { running++; r(); } else waiting.push(r); });
  const release = () => { const n = waiting.shift(); if (n) n(); else running--; };

  async function build(file, out, width, fmt) {
    await slot();
    try {
      let img = sharp(file, { failOn: 'none' }).rotate().resize({ width, withoutEnlargement: true });
      if (fmt === 'webp') img = img.webp({ quality: QUALITY, effort: 4 });
      else if (fmt === 'png') img = img.png({ compressionLevel: 9, palette: true, quality: 80 });
      else img = img.jpeg({ quality: QUALITY, mozjpeg: true });
      const tmp = out + '.' + process.pid + '.' + Date.now() + '.tmp';
      await img.toFile(tmp);
      fs.renameSync(tmp, out);
    } finally { release(); }
  }

  return async function (req, res, next) {
    const auto = !!req._imgAuto;                                   // automatic mode: on ANY problem, hand over to express.static
    const original = rel => (auto && next) ? next() : res.redirect(302, rel || '/');
    try {
      let rel = String(req.query.src || '');
      try { rel = decodeURIComponent(rel); } catch (e) { return auto ? next() : res.status(400).end(); }
      if (!rel.startsWith('/') || rel.includes('\0')) return auto ? next() : res.status(400).end();
      rel = path.posix.normalize(rel);
      const file = path.resolve(root, '.' + rel);
      const ext = path.extname(file).toLowerCase();
      if (!file.startsWith(root + path.sep) || !/^\.(jpe?g|png)$/.test(ext)) return auto ? next() : res.status(400).end();
      let st; try { st = fs.statSync(file); } catch (e) { return auto ? next() : res.status(404).end(); }
      if (!st.isFile()) return auto ? next() : res.status(404).end();

      const asIs = () => { if (auto && next) return next(); res.set('Cache-Control', 'public, max-age=86400, stale-while-revalidate=604800'); return res.sendFile(file); };
      if (!sharp || st.size < SKIP_BELOW) return asIs();

      const width = snapWidth(req.query.w);
      const wantsWebp = /image\/webp/.test(req.headers.accept || '');
      const fmt = wantsWebp ? 'webp' : (ext === '.png' ? 'png' : 'jpeg');
      const key = crypto.createHash('sha1').update([rel, st.size, Math.round(st.mtimeMs), width, fmt].join('|')).digest('hex').slice(0, 20);
      const etag = '"' + key + '"';
      res.set({ 'ETag': etag, 'Vary': 'Accept', 'Cache-Control': 'public, max-age=604800, stale-while-revalidate=2592000' });
      if (req.headers['if-none-match'] === etag) return res.status(304).end();

      const out = path.join(cacheDir, key + (fmt === 'webp' ? '.webp' : fmt === 'png' ? '.png' : '.jpg'));
      if (!fs.existsSync(out)) {
        if (!inflight.has(key)) inflight.set(key, build(file, out, width, fmt).finally(() => inflight.delete(key)));
        await inflight.get(key);
      }
      return res.sendFile(out);
    } catch (e) {
      if (res.headersSent) return;
      if (e && e.code === 'ENOENT') return auto && next ? next() : res.status(404).end();   // no such picture: a plain 404, like the original URL gives
      console.warn('[img] fell back to the original:', e && e.message);
      const rel = String(req.query.src || '');
      return original(/^\/[^/]/.test(rel) && !rel.startsWith('//') ? rel : '/');
    }
  };
};
