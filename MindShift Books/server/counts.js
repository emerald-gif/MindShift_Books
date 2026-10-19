// server/counts.js
// GET /api/counts?c=<collection>&ids=<id>,<id>,...        (public — these counters are already world-readable in Firestore)
//
// Why this exists: every feed card shows a like / repost / comment count, and each count is its own Firestore document.
// Fetched straight from the phone that is one billed read per card per person, every time the feed opens
// (~360 reads for a full page). Here the SERVER reads each counter once and shares it with everyone who asks
// for the next 45 seconds, so the Firestore bill stops growing with the number of people looking at the same posts.
//
//   → { ok: true, counts: { "<id>": { count: 12 } } }          articleLikes, repostCounts
//   → { ok: true, counts: { "<id>": { commentCount: 3 } } }    postMeta, articleMeta
// Ids with no document are simply left out (the client reads that as 0). Any failure answers 5xx and the page falls
// back to reading the documents directly, exactly as it did before — so this can only make things cheaper, never break counts.
const express = require('express');
const rateLimit = require('express-rate-limit');
const { db } = require('./shared');

const FIELD_OF = { articleLikes: 'count', repostCounts: 'count', postMeta: 'commentCount', articleMeta: 'commentCount' };
const TTL_MS = 45 * 1000;
const MAX_IDS = 100;
const CACHE_MAX = 30000;
const ID_RE = /^[A-Za-z0-9_.\-]{1,100}$/;

const cache = new Map();      // "coll/id" -> { v: number|null, t: ms }      (null = document doesn't exist)
const inflight = new Map();   // "coll/id" -> Promise<number|null>           (two people asking at once share one read)

function remember(key, v) {
  if (cache.size >= CACHE_MAX) {                       // drop the oldest ~10% instead of growing forever
    let n = Math.ceil(CACHE_MAX / 10);
    for (const k of cache.keys()) { cache.delete(k); if (--n <= 0) break; }
  }
  cache.set(key, { v, t: Date.now() });
}

async function readMany(coll, ids) {
  const field = FIELD_OF[coll];
  const refs = ids.map(id => db.collection(coll).doc(id));
  const snaps = await db.getAll(...refs, { fieldMask: [field] });
  return snaps.map(s => {
    if (!s.exists) return null;
    const n = Number((s.data() || {})[field]);
    return Number.isFinite(n) ? n : 0;
  });
}

async function lookup(coll, ids) {
  const out = {};
  const need = [];
  const now = Date.now();
  const waits = [];
  for (const id of ids) {
    const key = coll + '/' + id;
    const hit = cache.get(key);
    if (hit && now - hit.t < TTL_MS) { out[id] = hit.v; continue; }
    if (inflight.has(key)) { waits.push(inflight.get(key).then(v => { out[id] = v; })); continue; }
    need.push(id);
  }
  if (need.length) {
    const batch = readMany(coll, need);
    for (let i = 0; i < need.length; i++) {
      const id = need[i], key = coll + '/' + id;
      const p = batch.then(vals => vals[i]);
      inflight.set(key, p);
      p.then(v => remember(key, v)).catch(() => {}).finally(() => inflight.delete(key));
      waits.push(p.then(v => { out[id] = v; }));
    }
  }
  await Promise.all(waits);
  return out;
}

const router = express.Router();
// Its own limit (not the shared 100-per-15-minutes /api/ one): many phones share one mobile-network address,
// and the feed legitimately calls this a few times per open.
const limiter = rateLimit({
  windowMs: 60 * 1000, max: 240,
  message: { error: 'Too many requests — slow down a little.' },
  standardHeaders: true, legacyHeaders: false
});

router.get('/api/counts', limiter, async (req, res) => {
  const coll = String(req.query.c || '');
  if (!FIELD_OF[coll]) return res.status(400).json({ error: 'unknown collection' });
  const ids = [...new Set(String(req.query.ids || '').split(',').filter(Boolean))];
  if (!ids.length || ids.length > MAX_IDS) return res.status(400).json({ error: 'give 1–' + MAX_IDS + ' ids' });
  if (ids.some(id => !ID_RE.test(id) || id === '.' || id === '..')) return res.status(400).json({ error: 'bad id' });
  try {
    const found = await lookup(coll, ids);
    const field = FIELD_OF[coll], counts = {};
    for (const id of ids) if (found[id] !== null && found[id] !== undefined) counts[id] = { [field]: found[id] };
    res.set('Cache-Control', 'public, max-age=15');
    return res.json({ ok: true, counts });
  } catch (err) {
    console.error('/api/counts error', err && err.message);
    return res.status(502).json({ error: 'counts unavailable' });
  }
});

module.exports = router;
module.exports._internals = { cache, inflight, lookup, FIELD_OF };
