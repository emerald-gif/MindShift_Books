// server/link-preview.js
// GET /api/link-preview?url=https://...   (signed-in users only)
//
// Fetches a web page ON THE SERVER (browsers can't — CORS) and returns the small bit of
// "what is this link?" data that Open Graph / Twitter-card / <title> tags publish:
//   { ok: true, preview: { url, title, description, image, siteName, domain } | null }
//
// Because this makes the server request a URL a user typed, it is written defensively (SSRF):
//   • http(s) only, standard ports only, no user:pass@ in the URL
//   • every address the hostname resolves to is checked AT CONNECT TIME (defeats DNS rebinding),
//     and private / loopback / link-local / cloud-metadata ranges are refused
//   • redirects are followed by hand (max 4) and every hop is re-validated
//   • hard limits: 8s total, ~350KB of HTML read (stops at </head>), HTML content-types only
//   • results cached in memory (6h; failures 10 min) so a viral link isn't re-fetched again and again
// Any failure returns { ok: true, preview: null } — the composer simply shows no card.
const express = require('express');
const fetch = require('node-fetch');
const http = require('http');
const https = require('https');
const dns = require('dns');
const net = require('net');
const rateLimit = require('express-rate-limit');
const { requireUser } = require('./shared');

const MAX_REDIRECTS = 4;
const TOTAL_TIMEOUT_MS = 8000;
const MAX_HTML_BYTES = 350 * 1024;
const OK_TTL_MS = 6 * 60 * 60 * 1000;
const FAIL_TTL_MS = 10 * 60 * 1000;
const CACHE_MAX = 500;
const ALLOWED_PORTS = new Set(['', '80', '443', '8080', '8443']);
const USER_AGENT = 'Mozilla/5.0 (compatible; MindShiftBooksLinkPreview/1.0; +https://mindshiftbooks.shop)';

/* ───────────────────────── address safety ───────────────────────── */

function ipv4ToInt(ip) {
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return null;
  return ((p[0] << 24) >>> 0) + (p[1] << 16) + (p[2] << 8) + p[3];
}
const V4_BLOCKS = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16],
  ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4]
].map(([base, bits]) => ({ base: ipv4ToInt(base), mask: bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0 }));

function isPrivateV4(ip) {
  const n = ipv4ToInt(ip);
  if (n === null) return true;                       // unparseable → treat as unsafe
  return V4_BLOCKS.some(b => ((n & b.mask) >>> 0) === (b.base & b.mask) >>> 0);
}

function isPrivateIp(ip) {
  ip = String(ip || '').trim().toLowerCase().replace(/^\[|\]$/g, '').split('%')[0];
  if (net.isIPv4(ip)) return isPrivateV4(ip);
  if (!net.isIPv6(ip)) return true;
  if (ip === '::' || ip === '::1') return true;
  // IPv4-mapped (::ffff:1.2.3.4 or ::ffff:7f00:1) and NAT64 (64:ff9b::/96) carry a v4 address
  let m = /^(?:::ffff:|64:ff9b::)(\d+\.\d+\.\d+\.\d+)$/.exec(ip);
  if (m) return isPrivateV4(m[1]);
  m = /^(?:::ffff:|64:ff9b::)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(ip);
  if (m) {
    const hi = parseInt(m[1], 16), lo = parseInt(m[2], 16);
    return isPrivateV4([hi >> 8, hi & 255, lo >> 8, lo & 255].join('.'));
  }
  const first = parseInt(ip.split(':')[0] || '0', 16);
  if ((first & 0xfe00) === 0xfc00) return true;      // fc00::/7  unique-local
  if ((first & 0xffc0) === 0xfe80) return true;      // fe80::/10 link-local
  if ((first & 0xff00) === 0xff00) return true;      // ff00::/8  multicast
  if (ip.startsWith('2001:db8:') || ip === '2001:db8::') return true;   // documentation
  return false;
}

// Checks the hostname's addresses at the moment the socket connects.
function makeSafeLookup(allowPrivate) {
  return function safeLookup(hostname, options, cb) {
    if (typeof options === 'function') { cb = options; options = {}; }
    dns.lookup(hostname, { all: true, verbatim: true }, (err, addrs) => {
      if (err) return cb(err);
      if (!addrs || !addrs.length) return cb(new Error('no address'));
      if (!allowPrivate && addrs.some(a => isPrivateIp(a.address))) return cb(new Error('blocked address'));
      if (options && options.all) return cb(null, addrs);
      cb(null, addrs[0].address, addrs[0].family);
    });
  };
}

function parseSafeUrl(raw, allowPrivate) {
  let u;
  try { u = new URL(String(raw || '').trim()); } catch (_) { throw new Error('bad url'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('bad protocol');
  if (u.username || u.password) throw new Error('credentials in url');
  if (!allowPrivate && !ALLOWED_PORTS.has(u.port)) throw new Error('bad port');
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!host || host.length > 253) throw new Error('bad host');
  if (!allowPrivate) {
    if (net.isIP(host)) { if (isPrivateIp(host)) throw new Error('private address'); }
    else {
      if (!host.includes('.')) throw new Error('single-label host');
      if (/(^|\.)(localhost|local|internal|intranet|lan|home|corp|localdomain)$/.test(host)) throw new Error('internal host');
    }
  }
  u.hash = '';
  return u;
}

/* ───────────────────────── fetching ───────────────────────── */

function readCapped(res, cap) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0, done = false;
    const finish = () => {
      if (done) return; done = true;
      try { res.body.destroy(); } catch (_) {}
      resolve(Buffer.concat(chunks));
    };
    res.body.on('data', c => {
      if (done) return;
      chunks.push(c); size += c.length;
      if (size >= cap) return finish();
      const recent = Buffer.concat(chunks.slice(-2)).toString('latin1');   // </head> may straddle two chunks
      if (/<\/head\s*>/i.test(recent)) finish();
    });
    res.body.on('end', finish);
    res.body.on('error', e => { if (!done) { done = true; reject(e); } });
  });
}

async function fetchHtml(startUrl, allowPrivate) {
  const lookup = makeSafeLookup(allowPrivate);
  const httpAgent = new http.Agent({ lookup, keepAlive: false });
  const httpsAgent = new https.Agent({ lookup, keepAlive: false });
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TOTAL_TIMEOUT_MS);
  try {
    let url = parseSafeUrl(startUrl, allowPrivate);
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const res = await fetch(url.href, {
        redirect: 'manual',
        signal: ctrl.signal,
        agent: url.protocol === 'https:' ? httpsAgent : httpAgent,
        headers: { 'User-Agent': USER_AGENT, 'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5', 'Accept-Language': 'en;q=0.9' }
      });
      const loc = res.headers.get('location');
      if (res.status >= 300 && res.status < 400 && loc) {
        try { res.body.destroy(); } catch (_) {}
        url = parseSafeUrl(new URL(loc, url.href).href, allowPrivate);   // every hop re-validated
        continue;
      }
      if (!res.ok) { try { res.body.destroy(); } catch (_) {} throw new Error('http ' + res.status); }
      const type = String(res.headers.get('content-type') || '').toLowerCase();
      if (!/text\/html|application\/xhtml/.test(type)) { try { res.body.destroy(); } catch (_) {} throw new Error('not html'); }
      const buf = await readCapped(res, MAX_HTML_BYTES);
      return { buf, type, finalUrl: url.href };
    }
    throw new Error('too many redirects');
  } finally {
    clearTimeout(timer);
    httpAgent.destroy(); httpsAgent.destroy();
  }
}

/* ───────────────────────── parsing ───────────────────────── */

const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '\u2013', mdash: '\u2014', hellip: '\u2026', rsquo: '\u2019', lsquo: '\u2018', rdquo: '\u201d', ldquo: '\u201c', copy: '\u00a9', middot: '\u00b7' };
function decodeEntities(s) {
  return String(s).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, e) => {
    if (e[0] === '#') {
      const code = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      try { return code > 0 && code < 0x110000 ? String.fromCodePoint(code) : ''; } catch (_) { return ''; }
    }
    return Object.prototype.hasOwnProperty.call(NAMED, e.toLowerCase()) ? NAMED[e.toLowerCase()] : all;
  });
}
function clean(s, max) {
  s = decodeEntities(s || '').replace(/[\u0000-\u001f\u007f\u200b-\u200f\u2028\u2029\ufeff]/g, ' ').replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max - 1).trimEnd() + '\u2026' : s;
}

function decodeBuffer(buf, contentType) {
  let label = (/charset=["']?([\w-]+)/i.exec(contentType || '') || [])[1];
  if (!label) label = (/<meta[^>]+charset=["']?([\w-]+)/i.exec(buf.slice(0, 4096).toString('latin1')) || [])[1];
  try { return new TextDecoder(label || 'utf-8').decode(buf); }
  catch (_) { return buf.toString('utf8'); }
}

function parseMeta(html) {
  const end = html.search(/<\/head\s*>/i);
  const head = end > 0 ? html.slice(0, end) : html.slice(0, 200 * 1024);
  const metas = {};
  const metaRe = /<meta\b((?:[^>"']|"[^"]*"|'[^']*')*)>/gi;
  const attrRe = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g;
  let m;
  while ((m = metaRe.exec(head))) {
    const attrs = {}; let a;
    attrRe.lastIndex = 0;
    while ((a = attrRe.exec(m[1]))) attrs[a[1].toLowerCase()] = a[2] !== undefined ? a[2] : a[3] !== undefined ? a[3] : a[4];
    const key = String(attrs.property || attrs.name || attrs.itemprop || '').toLowerCase();
    if (key && attrs.content != null && !(key in metas)) metas[key] = attrs.content;
  }
  const t = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(head);
  return { metas, title: t ? t[1] : '' };
}

function buildPreview(html, finalUrl, requestedUrl) {
  const { metas, title: docTitle } = parseMeta(html);
  const pick = (...keys) => { for (const k of keys) if (metas[k] && String(metas[k]).trim()) return metas[k]; return ''; };
  const title = clean(pick('og:title', 'twitter:title') || docTitle, 200);
  if (!title) return null;
  const description = clean(pick('og:description', 'twitter:description', 'description'), 300);
  let image = '';
  const rawImg = decodeEntities(pick('og:image:secure_url', 'og:image', 'og:image:url', 'twitter:image', 'twitter:image:src')).trim();
  if (rawImg) {
    try {
      const iu = new URL(rawImg, finalUrl);
      if (iu.protocol === 'http:' && new URL(finalUrl).protocol === 'https:') iu.protocol = 'https:';   // avoid mixed content
      if (iu.protocol === 'https:' && iu.href.length <= 2000) image = iu.href;
    } catch (_) {}
  }
  const domain = new URL(requestedUrl).hostname.replace(/^www\./i, '');
  return {
    url: requestedUrl,
    title, description, image,
    siteName: clean(pick('og:site_name', 'application-name'), 80) || domain,
    domain
  };
}

/* ───────────────────────── cache + route ───────────────────────── */

const cache = new Map();   // url -> { at, ttl, data }
function cacheGet(k) {
  const e = cache.get(k);
  if (!e) return undefined;
  if (Date.now() - e.at > e.ttl) { cache.delete(k); return undefined; }
  return e.data;
}
function cacheSet(k, data, ttl) {
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);   // oldest first
  cache.set(k, { at: Date.now(), ttl, data });
}

async function getPreview(rawUrl, opts) {
  const allowPrivate = !!(opts && opts.allowPrivate);
  const u = parseSafeUrl(rawUrl, allowPrivate);          // throws on anything unsafe
  const key = u.href;
  const hit = cacheGet(key);
  if (hit !== undefined) return hit;
  try {
    const { buf, type, finalUrl } = await fetchHtml(key, allowPrivate);
    const preview = buildPreview(decodeBuffer(buf, type), finalUrl, key);
    cacheSet(key, preview, preview ? OK_TTL_MS : FAIL_TTL_MS);
    return preview;
  } catch (err) {
    cacheSet(key, null, FAIL_TTL_MS);
    return null;
  }
}

const router = express.Router();
const limiter = rateLimit({
  windowMs: 60 * 1000, max: 20,
  message: { error: 'Too many link lookups — wait a moment.' },
  standardHeaders: true, legacyHeaders: false
});

router.get('/api/link-preview', limiter, requireUser, async (req, res) => {
  const raw = String(req.query.url || '').slice(0, 2000);
  let normalized;
  try { normalized = parseSafeUrl(raw, false).href; }
  catch (_) { return res.status(400).json({ error: 'That link can\u2019t be previewed.' }); }
  try {
    const preview = await getPreview(normalized, { allowPrivate: false });
    res.set('Cache-Control', 'private, max-age=600');
    return res.json({ ok: true, preview });
  } catch (err) {
    console.error('/api/link-preview error', err && err.message);
    return res.json({ ok: true, preview: null });
  }
});

module.exports = router;
module.exports._internals = { makeSafeLookup, fetchHtml, isPrivateIp, parseSafeUrl, parseMeta, buildPreview, decodeEntities, clean, getPreview, cache };
