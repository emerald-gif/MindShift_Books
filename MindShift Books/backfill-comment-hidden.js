// One-time fix: old comments have no `hidden` field, so the new
// where('hidden','==',false) query skips them. This sets hidden:false
// on every comment that's missing it.
//
// Run from the project root (same env as your server, so SERVICE_ACCOUNT_JSON
// and FIRESTORE_DATABASE_ID are picked up):
//   node backfill-comment-hidden.js
//
// Safe to run more than once. It never touches comments that already
// have a hidden value (so it won't un-hide anything you hid).

require('dotenv').config();
const { db } = require('./server/shared');

(async () => {
  if (!db) { console.error('No Firestore db — check credentials/env.'); process.exit(1); }

  let fixed = 0, scanned = 0, last = null;
  const PAGE = 400;

  while (true) {
    let q = db.collection('comments').orderBy('__name__').limit(PAGE);
    if (last) q = q.startAfter(last);
    const snap = await q.get();
    if (snap.empty) break;

    const batch = db.batch();
    let inBatch = 0;
    snap.docs.forEach(d => {
      scanned++;
      if (d.get('hidden') === undefined) {
        batch.update(d.ref, { hidden: false });
        inBatch++;
      }
    });
    if (inBatch) { await batch.commit(); fixed += inBatch; }

    last = snap.docs[snap.docs.length - 1];
    console.log(`scanned ${scanned}, fixed ${fixed}`);
  }

  console.log(`Done. Scanned ${scanned} comments, set hidden:false on ${fixed}.`);
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
