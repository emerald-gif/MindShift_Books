// server/shared.js
// Core infrastructure shared across every route module: Firebase Admin +
// Firestore init, Brevo/Cloudinary config, the requireUser auth
// middleware, and a few small cross-domain utilities (Lagos time, the
// admin dashboard's read cache). Moved out of server.js as-is — no logic
// changed, only relocated. Every domain file requires what it needs from
// here instead of redefining its own copy.
//
// IMPORTANT: this file calls admin.initializeApp() once, at require-time.
// server.js and every other file under server/ must get `admin` and `db`
// FROM HERE, never call admin.initializeApp() a second time anywhere else
// — Firebase throws if you do.
const admin = require('firebase-admin');
const fetch = require('node-fetch');
const crypto = require('crypto');

// Firebase admin init (SERVICE_ACCOUNT_JSON or ADC)
try {
  if (process.env.SERVICE_ACCOUNT_JSON) {
    const serviceAccount = JSON.parse(process.env.SERVICE_ACCOUNT_JSON);
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
    console.log('firebase-admin initialized from SERVICE_ACCOUNT_JSON, project_id =', serviceAccount.project_id);
  } else {
    admin.initializeApp();
    console.log('firebase-admin initialized from ADC/default credentials');
  }
} catch (e) {
  console.error('firebase-admin init FAILED:', e.message || e);
  console.error('Check that SERVICE_ACCOUNT_JSON is valid JSON with real newlines in private_key, and matches the mindshiftbooks-c4451 project.');
}

// Optionally target a non-default Firestore database.
const FIRESTORE_DATABASE_ID = process.env.FIRESTORE_DATABASE_ID || null;
const db = admin.apps.length
  ? (FIRESTORE_DATABASE_ID
      ? require('firebase-admin/firestore').getFirestore(admin.app(), FIRESTORE_DATABASE_ID)
      : admin.firestore())
  : null;
if (FIRESTORE_DATABASE_ID) {
  console.log('Firestore targeting non-default database:', FIRESTORE_DATABASE_ID);
}

// Brevo (formerly Sendinblue) transactional email — shared sender identity.
// Per-template IDs stay local to whichever domain file actually sends that
// template (e.g. BREVO_BANK_OTP_TEMPLATE_ID lives in server/affiliate.js).
const BREVO_API_KEY = process.env.BREVO_API_KEY || null;
const BREVO_SENDER_NAME = process.env.BREVO_SENDER_NAME || 'Mindshift Books';
const BREVO_SENDER_EMAIL = process.env.BREVO_SENDER_EMAIL || 'contact@mindshiftbooks.shop';
const PUBLIC_SITE_URL = process.env.PUBLIC_URL || 'https://mindshiftbooks.shop';

// Cloudinary — signed upload, no upload preset needed.
const CLOUDINARY_CLOUD_NAME = process.env.CLOUDINARY_CLOUD_NAME || null;
const CLOUDINARY_API_KEY = process.env.CLOUDINARY_API_KEY || null;
const CLOUDINARY_API_SECRET = process.env.CLOUDINARY_API_SECRET || null;

// Validates a data URI is really an image by sniffing magic bytes, not the
// (spoofable) MIME label in its `data:image/xyz;base64,` prefix.
function extractImageBuffer(dataUrl) {
  const match = /^data:([^;]*);base64,(.+)$/s.exec(String(dataUrl || ''));
  if (!match) return null;
  let buf;
  try { buf = Buffer.from(match[2], 'base64'); } catch (e) { return null; }
  if (!buf.length) return null;

  const isPng  = buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47;
  const isJpeg = buf.length >= 3 && buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF;
  const isGif  = buf.length >= 6 && buf.toString('ascii', 0, 6).match(/^GIF8[79]a$/);
  const isWebp = buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP';
  if (!isPng && !isJpeg && !isGif && !isWebp) return null;

  return buf;
}

// Uploads a data:image/...;base64,... string to Cloudinary and returns its
// hosted https:// URL. `folder` defaults to the affiliate-broadcast one
// this was originally built for — other callers should pass their own.
async function uploadImageToCloudinary(dataUrl, folder = 'affiliate-broadcasts') {
  if (!CLOUDINARY_CLOUD_NAME || !CLOUDINARY_API_KEY || !CLOUDINARY_API_SECRET) {
    return { ok: false, error: 'Image hosting is not configured (missing Cloudinary credentials).' };
  }
  const timestamp = Math.round(Date.now() / 1000);
  const signaturePayload = `folder=${folder}&timestamp=${timestamp}${CLOUDINARY_API_SECRET}`;
  const signature = crypto.createHash('sha1').update(signaturePayload).digest('hex');

  const form = new URLSearchParams();
  form.set('file', dataUrl);
  form.set('api_key', CLOUDINARY_API_KEY);
  form.set('timestamp', String(timestamp));
  form.set('folder', folder);
  form.set('signature', signature);

  try {
    const uploadRes = await fetch(`https://api.cloudinary.com/v1_1/${CLOUDINARY_CLOUD_NAME}/image/upload`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form.toString()
    });
    const json = await uploadRes.json().catch(() => null);
    if (!uploadRes.ok || !json || !json.secure_url) {
      const msg = (json && json.error && json.error.message) || `Cloudinary ${uploadRes.status}`;
      return { ok: false, error: msg };
    }
    return { ok: true, url: json.secure_url };
  } catch (e) {
    return { ok: false, error: (e.message || String(e)).slice(0, 160) };
  }
}
// Old name kept as an alias — some call sites use this name.
const uploadBannerImageToCloudinary = uploadImageToCloudinary;

// ── Customer account auth (Firebase ID tokens) ──────────────────────────────
// The client signs in with Firebase Auth and sends the resulting ID token
// on requests tied to an account. Browsing/previews/reviews stay public.
async function requireUser(req, res, next) {
  try {
    const header = req.headers.authorization || '';
    const [scheme, token] = header.split(' ');
    if (scheme !== 'Bearer' || !token) return res.status(401).json({ error: 'Please sign in to continue.' });
    const decoded = await admin.auth().verifyIdToken(token);
    req.uid = decoded.uid;
    req.userEmail = (decoded.email || '').toLowerCase();
    req.userName = decoded.name || null;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Your session has expired. Please sign in again.' });
  }
}

// Lagos is UTC+1 year-round (no DST) — fixed-offset clock, no timezone
// library needed. Used by affiliate payouts and the digest crons alike.
function lagosNow() {
  return new Date(Date.now() + 60 * 60 * 1000);
}

const AFFILIATE_MIN_PAYOUT = 5000; // ₦5,000 minimum balance to be queued for a Monday payout

// "Next Monday" label shown on the affiliate dashboard. If it's currently
// Monday in Lagos, this still points at *next* Monday, since this week's
// batch (if any) has already been generated by the time anyone reads it.
function nextMondayISO() {
  const now = lagosNow();
  const day = now.getUTCDay();
  let daysAhead = (8 - day) % 7;
  if (daysAhead === 0) daysAhead = 7;
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + daysAhead));
  return next.toISOString().slice(0, 10);
}

// Admin dashboard's short-lived read cache. A couple of affiliate routes
// invalidate specific keys here right after a write so the dashboard
// doesn't wait out the TTL to see it. The cachedAdminRead() helper that
// actually reads/populates it stays with the admin routes — this Map is
// exported so any module can invalidate a key without needing that helper.
const _adminReadCache = new Map(); // key -> { data, expiresAt }

module.exports = {
  admin, db,
  BREVO_API_KEY, BREVO_SENDER_NAME, BREVO_SENDER_EMAIL, PUBLIC_SITE_URL,
  CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET,
  extractImageBuffer, uploadImageToCloudinary, uploadBannerImageToCloudinary,
  requireUser,
  lagosNow, nextMondayISO, AFFILIATE_MIN_PAYOUT,
  _adminReadCache
};
