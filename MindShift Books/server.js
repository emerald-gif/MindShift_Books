// server.js
// MindShift Books - Single source of truth for products + Paystack endpoints
const express = require('express');
const path = require('path');
const fetch = require('node-fetch');
const cors = require('cors');
const bodyParser = require('body-parser');
const admin = require('firebase-admin');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const crypto = require('crypto');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

// Render (and most PaaS hosts) sit the app behind a reverse proxy, so the
// real client IP arrives via X-Forwarded-For rather than the raw socket.
// Without this, Express ignores X-Forwarded-For and express-rate-limit
// throws ERR_ERL_UNEXPECTED_X_FORWARDED_FOR — worse, every request would
// resolve to the proxy's IP, so all visitors would share one rate-limit
// bucket instead of being limited individually. `1` = trust the first
// hop (Render's own proxy) — correct for a single reverse proxy in front.
app.set('trust proxy', 1);

// ── Security headers (helmet) ──────────────────────────────────────────────
// crossOriginOpenerPolicy is explicitly disabled here: helmet's default
// ("same-origin") severs window.opener between this site and any popup it
// opens. Firebase's signInWithPopup() relies on window.opener to message
// the sign-in result back once the Google popup completes — with COOP
// left on its default, that message never arrives, the popup finishes
// successfully on Google's side, and the page is just left sitting there
// with no error and no way forward. This is the actual cause of the
// Google sign-in stall on /login and /signup.
app.use(helmet({
  contentSecurityPolicy: false, // CSP managed separately if needed
  crossOriginEmbedderPolicy: false,
  crossOriginOpenerPolicy: false
}));

// ── CORS — only allow our own domain ──────────────────────────────────────
const ALLOWED_ORIGINS = [
  'https://mindshiftbooks.shop',
  'https://www.mindshiftbooks.shop'
];
app.use(cors({
  origin: (origin, cb) => {
    // allow server-to-server (no origin) and our own domain
    if (!origin || ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
    cb(new Error('Not allowed by CORS'));
  },
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type']
}));

// ── Rate limiters ──────────────────────────────────────────────────────────
// Strict limit on the order-lookup endpoint (prevents email enumeration)
const ordersLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 20,
  message: { error: 'Too many requests, please try again later.' },
  standardHeaders: true,
  legacyHeaders: false
});

// Moderate limit on payment endpoints (prevents checkout spam)
const payLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  message: { error: 'Too many requests, please try again later.' },
  standardHeaders: true,
  legacyHeaders: false
});

// General API limit (catches everything else)
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: { error: 'Too many requests, please try again later.' },
  standardHeaders: true,
  legacyHeaders: false
});
app.use('/api/', apiLimiter);

// 400kb (not 100kb) because the affiliate broadcast composer's image-upload
// endpoint (/api/admin/affiliate-broadcast/upload-image) receives the banner
// image as a base64 data URI in the JSON body before forwarding it to
// Cloudinary. 180KB source image -> ~240KB base64 -> ~400kb gives headroom.
// Once uploaded, only the resulting short Cloudinary https:// link travels
// through the rest of the flow (preview, send), so every other endpoint —
// including the actual broadcast-send ones — still just sends small JSON.
app.use(bodyParser.json({ limit: '400kb' }));
app.use(bodyParser.urlencoded({ extended: true, limit: '400kb' }));

// Clean URLs: redirect any request that still ends in .html to the extension-less version
app.get(/\.html$/, (req, res, next) => {
  const clean = req.path.replace(/\.html$/, '') || '/';
  const qs = req.url.slice(req.path.length); // preserves ?query
  return res.redirect(301, clean + qs);
});

// Serve static assets (public folder only — /files is NOT served statically)
// Explicit Cache-Control here matters: without it, browsers fall back to
// *heuristic* caching (guessing a TTL from Last-Modified) and can silently
// keep serving an old CSS/HTML file after a deploy — which is exactly what
// caused the affiliate page swiper to look fixed one load and broken the
// next, on the same phone, same URL. 'no-cache' doesn't mean "don't cache",
// it means "always ask the server first" — the server replies 304 (cheap,
// no re-download) if the file hasn't changed, so this stays fast but never
// silently stale.
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: (res) => {
    res.setHeader('Cache-Control', 'no-cache');
  }
}));

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

// Optionally target a non-default Firestore database (e.g. a Standard-edition
// database created alongside an Enterprise-edition "(default)" one). Leave
// FIRESTORE_DATABASE_ID unset to use whatever Firestore considers "(default)".
const FIRESTORE_DATABASE_ID = process.env.FIRESTORE_DATABASE_ID || null;
const db = admin.apps.length
  ? (FIRESTORE_DATABASE_ID
      ? require('firebase-admin/firestore').getFirestore(admin.app(), FIRESTORE_DATABASE_ID)
      : admin.firestore())
  : null;
if (FIRESTORE_DATABASE_ID) {
  console.log('Firestore targeting non-default database:', FIRESTORE_DATABASE_ID);
}

// Paystack / email config
const PAYSTACK_BASE = 'https://api.paystack.co';
const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY || null;
const PAYSTACK_PUBLIC_KEY = process.env.PAYSTACK_PUBLIC_KEY || null;
const PUBLIC_PDF_URL = process.env.PUBLIC_PDF_URL || null;

// Brevo (formerly Sendinblue) transactional email config
const BREVO_API_KEY = process.env.BREVO_API_KEY || null; // set this in your environment
const BREVO_TEMPLATE_ID = Number(process.env.BREVO_TEMPLATE_ID || 1); // order receipt / delivery email
const BREVO_WELCOME_TEMPLATE_ID = Number(process.env.BREVO_WELCOME_TEMPLATE_ID || 2); // new-account welcome email
const BREVO_BANK_OTP_TEMPLATE_ID = Number(process.env.BREVO_BANK_OTP_TEMPLATE_ID || 3); // bank-details-change verification code
const BREVO_AFFILIATE_WELCOME_TEMPLATE_ID = Number(process.env.BREVO_AFFILIATE_WELCOME_TEMPLATE_ID || 4); // successful affiliate onboarding
const BREVO_AFFILIATE_BROADCAST_TEMPLATE_ID = Number(process.env.BREVO_AFFILIATE_BROADCAST_TEMPLATE_ID || 5); // one template for every affiliate announcement — which blocks render depends on which content fields are sent, not on which template
const BREVO_PROMO_KIT_TEMPLATE_ID = 6; // fixed-content "Wave 1" style promo kit email (slides + copy angles) — see promo-kit-template-6.html — matches Brevo template #6
const BREVO_SENDER_NAME = process.env.BREVO_SENDER_NAME || 'Mindshift Books';
const BREVO_SENDER_EMAIL = process.env.BREVO_SENDER_EMAIL || 'contact@mindshiftbooks.shop';
const PUBLIC_SITE_URL = process.env.PUBLIC_URL || 'https://mindshiftbooks.shop'; // reused below to build each affiliate's own ?ref= link

// Cloudinary — hosts the affiliate broadcast's banner image so the email
// carries a real https:// link instead of an embedded base64 data URI
// (Gmail and most other clients strip data: URIs from HTML email, which is
// why the banner was showing as a broken image). Signed upload: no upload
// preset needed, just these three values from the Cloudinary dashboard.
const CLOUDINARY_CLOUD_NAME = process.env.CLOUDINARY_CLOUD_NAME || null;
const CLOUDINARY_API_KEY = process.env.CLOUDINARY_API_KEY || null;
const CLOUDINARY_API_SECRET = process.env.CLOUDINARY_API_SECRET || null;

// Uploads a data:image/...;base64,... string to Cloudinary and returns its
// hosted https:// URL. Cloudinary's upload API accepts a base64 data URI
// directly as the `file` param over a plain form POST — no multipart
// encoding or extra dependency required. The signature is a sha1 of every
// non-file param (sorted, `key=value` joined by `&`) with the API secret
// appended, per Cloudinary's signed-upload spec.
async function uploadBannerImageToCloudinary(dataUrl) {
  if (!CLOUDINARY_CLOUD_NAME || !CLOUDINARY_API_KEY || !CLOUDINARY_API_SECRET) {
    return { ok: false, error: 'Image hosting is not configured (missing Cloudinary credentials).' };
  }
  const timestamp = Math.round(Date.now() / 1000);
  const folder = 'affiliate-broadcasts';
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

// Fires once, right after a brand-new account doc is created (see
// /api/account/init). Fire-and-forget — a failed welcome email should never
// block or fail account creation, so this always resolves quietly.
async function sendWelcomeEmail(email, name) {
  if (!BREVO_API_KEY || !email) return;
  try {
    const emailRes = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'api-key': BREVO_API_KEY,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        sender: { name: BREVO_SENDER_NAME, email: BREVO_SENDER_EMAIL },
        to: [{ email, name: name || undefined }],
        templateId: BREVO_WELCOME_TEMPLATE_ID,
        params: { name: name || 'there' }
      })
    });
    if (!emailRes.ok) {
      const txt = await emailRes.text().catch(() => null);
      console.error('Brevo welcome email error', emailRes.status, txt);
    }
  } catch (e) {
    console.warn('Brevo welcome email send failed', e.message || e);
  }
}

// Sends the 6-digit bank-details verification code. Not fire-and-forget —
// the caller needs to know whether it actually went out before telling the
// affiliate "check your email".
async function sendBankOtpEmail(email, name, code) {
  if (!BREVO_API_KEY || !email) return { ok: false, error: 'Email delivery is not configured.' };
  try {
    const emailRes = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'api-key': BREVO_API_KEY,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        sender: { name: BREVO_SENDER_NAME, email: BREVO_SENDER_EMAIL },
        to: [{ email, name: name || undefined }],
        templateId: BREVO_BANK_OTP_TEMPLATE_ID,
        params: { name: name || 'there', code }
      })
    });
    if (!emailRes.ok) {
      const txt = await emailRes.text().catch(() => null);
      console.error('Brevo bank-otp email error', emailRes.status, txt);
      return { ok: false, error: 'Could not send the verification code. Please try again.' };
    }
    return { ok: true };
  } catch (e) {
    console.warn('Brevo bank-otp email send failed', e.message || e);
    return { ok: false, error: 'Could not send the verification code. Please try again.' };
  }
}

// Fires once, right after a brand-new affiliate record is created (see
// /api/affiliate/apply). Fire-and-forget, same as the account welcome
// email — a failed send here shouldn't fail the application itself, since
// the affiliate record is already live either way.
async function sendAffiliateWelcomeEmail(email, name, code) {
  if (!BREVO_API_KEY || !email) return;
  try {
    const emailRes = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'api-key': BREVO_API_KEY,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        sender: { name: BREVO_SENDER_NAME, email: BREVO_SENDER_EMAIL },
        to: [{ email, name: name || undefined }],
        templateId: BREVO_AFFILIATE_WELCOME_TEMPLATE_ID,
        params: { name: name || 'there', code }
      })
    });
    if (!emailRes.ok) {
      const txt = await emailRes.text().catch(() => null);
      console.error('Brevo affiliate-welcome email error', emailRes.status, txt);
    }
  } catch (e) {
    console.warn('Brevo affiliate-welcome email send failed', e.message || e);
  }
}

// ---------------- Affiliate broadcast (announcements, launches, tips) ----------------
// One Brevo template handles every send. The admin dashboard composes
// `content` (headline + whichever optional blocks apply) and that's the
// only thing that changes — no new template, ever, per announcement.

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Plain textarea text -> safe paragraph HTML for the template's bodyHtml
// slot. A blank line starts a new paragraph; single line breaks become <br>.
function textToParagraphs(text) {
  return String(text || '')
    .split(/\n\s*\n/)
    .map(block => block.trim())
    .filter(Boolean)
    .map(block => `<p style="margin:0 0 14px;">${escapeHtml(block).replace(/\n/g, '<br>')}</p>`)
    .join('');
}

// Sends the broadcast to one affiliate. `content` is the shared payload
// built once per broadcast; affiliateName/affiliateLink are per-recipient.
async function sendAffiliateBroadcastEmail(affiliate, content) {
  if (!BREVO_API_KEY || !affiliate.email) return { ok: false, error: 'Missing Brevo API key or recipient email.' };
  try {
    const emailRes = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'api-key': BREVO_API_KEY,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        sender: { name: BREVO_SENDER_NAME, email: BREVO_SENDER_EMAIL },
        to: [{ email: affiliate.email, name: affiliate.name || undefined }],
        templateId: BREVO_AFFILIATE_BROADCAST_TEMPLATE_ID,
        params: {
          affiliateName: affiliate.name || 'there',
          affiliateLink: `${PUBLIC_SITE_URL}/?ref=${affiliate.code}`,
          ...content
        }
      })
    });
    if (!emailRes.ok) {
      const txt = await emailRes.text().catch(() => null);
      return { ok: false, error: `Brevo ${emailRes.status}: ${(txt || '').slice(0, 160)}` };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e.message || String(e)).slice(0, 160) };
  }
}

// ---------------- Affiliate promo kit (fixed-content asset drops) ----------------
// Unlike the generic broadcast above, a promo kit's content (copy angles,
// slide links) is fixed per campaign and lives in the Brevo template itself
// (template 6 — see promo-kit-template-6.html). Only per-recipient fields
// (name, tracking link, the 9 slide URLs which are the same for everyone
// but kept as params so they're easy to swap for the next campaign) are
// sent here.
const PROMO_KIT_ASSET_URLS = [
  'https://drive.google.com/file/d/1rU-eKj3uxqmdqfI8GmfVgC9OD9eU_xU3/view?usp=drivesdk',
  'https://drive.google.com/file/d/1ImSBSBHG8g4TCM0ZfZ4YQI1c06xsC5tq/view?usp=drivesdk',
  'https://drive.google.com/file/d/1bhjxpJq8x_I16AhzqNGLLozdvTNseQqA/view?usp=drivesdk',
  'https://drive.google.com/file/d/1E0--UVKC4Oq6U6Qs5HDUr2xd2wRufrIv/view?usp=drivesdk',
  'https://drive.google.com/file/d/1_VNJBeOnLlWQQsfLoixk25Mct7b4FoKq/view?usp=drivesdk',
  'https://drive.google.com/file/d/1vF3NlmbCj32H_pPEiqeMnHIVwz1v6J53/view?usp=drivesdk',
  'https://drive.google.com/file/d/1JVByoKIfsX7jVE-G2_5cgnEvFJQSkncH/view?usp=drivesdk',
  'https://drive.google.com/file/d/1ISp1dZZbf9KSvc5QA2ZQb4bXo5m1L6if/view?usp=drivesdk',
  'https://drive.google.com/file/d/16rWME3D8ULaVqZpT1fW6d5S3FBh4ycdH/view?usp=drivesdk'
];

async function sendAffiliatePromoKitEmail(affiliate) {
  if (!BREVO_API_KEY || !affiliate.email) return { ok: false, error: 'Missing Brevo API key or recipient email.' };
  try {
    const assetParams = {};
    PROMO_KIT_ASSET_URLS.forEach((url, i) => { assetParams[`asset${i + 1}Url`] = url; });
    const emailRes = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'api-key': BREVO_API_KEY,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        sender: { name: BREVO_SENDER_NAME, email: BREVO_SENDER_EMAIL },
        to: [{ email: affiliate.email, name: affiliate.name || undefined }],
        templateId: BREVO_PROMO_KIT_TEMPLATE_ID,
        params: {
          name: affiliate.name || 'there',
          affiliateLink: `${PUBLIC_SITE_URL}/?ref=${affiliate.code}`,
          ...assetParams
        }
      })
    });
    if (!emailRes.ok) {
      const txt = await emailRes.text().catch(() => null);
      return { ok: false, error: `Brevo ${emailRes.status}: ${(txt || '').slice(0, 160)}` };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e.message || String(e)).slice(0, 160) };
  }
}

// Validates the admin's form input and shapes it into the params object
// every recipient's email will share. Returns { error } if invalid.
function buildBroadcastContent(body) {
  body = body || {};
  const headline = String(body.headline || '').trim().slice(0, 200);
  const bodyText = String(body.bodyText || '').trim().slice(0, 4000);
  if (!headline) return { error: 'Headline is required.' };
  if (!bodyText) return { error: 'Message is required.' };

  const clean = (v, max) => { const s = String(v || '').trim().slice(0, max); return s || undefined; };
  const content = {
    headline,
    bodyHtml: textToParagraphs(bodyText),
    accentColor: /^#[0-9a-fA-F]{6}$/.test(body.accentColor || '') ? body.accentColor : '#e60023',
    bannerImageUrl: clean(body.bannerImageUrl, 500), // hosted Cloudinary https:// link, set via the upload-image endpoint
    bannerImageAlt: clean(body.bannerImageAlt, 200),
    ctaText: clean(body.ctaText, 60),
    ctaLink: clean(body.ctaLink, 500),
    captionText: clean(body.captionText, 2000),
    asset1Label: clean(body.asset1Label, 60),
    asset1Url: clean(body.asset1Url, 500),
    asset2Label: clean(body.asset2Label, 60),
    asset2Url: clean(body.asset2Url, 500),
    asset3Label: clean(body.asset3Label, 60),
    asset3Url: clean(body.asset3Url, 500)
  };
  // A CTA button needs both a label and a link, or neither.
  if (content.ctaText && !content.ctaLink) return { error: 'Add a link for the CTA button, or clear the CTA text.' };
  return { content };
}

// Admin dashboard credentials + session (cookie-based — no browser Basic Auth
// popup). Set ADMIN_PASSWORD as a Render env var — the dashboard refuses to
// serve anything until it's set, so there's no accidental "default password"
// exposure.
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || null;
if (!ADMIN_PASSWORD) {
  console.warn('ADMIN_PASSWORD not set — /admin dashboard is disabled until it is configured.');
}

// Session secret signs a short-lived cookie so admin/dashboard.html doesn't
// need to keep re-sending credentials on every request. Ephemeral fallback
// mirrors the DOWNLOAD_SECRET pattern below — set the env var on Render so
// admins don't get logged out on every restart.
const ADMIN_SESSION_SECRET = process.env.ADMIN_SESSION_SECRET || (() => {
  const s = crypto.randomBytes(32).toString('hex');
  console.warn('ADMIN_SESSION_SECRET not set — using an ephemeral secret. Set this env var on Render or admin logins will be forced to re-login on every restart.');
  return s;
})();
const ADMIN_SESSION_MAX_AGE = 60 * 60 * 24 * 7; // 7 days, in seconds

function mintAdminSession() {
  const expiry = Date.now() + ADMIN_SESSION_MAX_AGE * 1000;
  const payload = `admin|${expiry}`;
  const sig = crypto.createHmac('sha256', ADMIN_SESSION_SECRET).update(payload).digest('hex').slice(0, 32);
  return Buffer.from(`${payload}|${sig}`).toString('base64url');
}

function validateAdminSession(token) {
  try {
    const decoded = Buffer.from(token, 'base64url').toString('utf8');
    const parts = decoded.split('|');
    if (parts.length !== 3) return false;
    const [tag, expiryStr, sig] = parts;
    if (tag !== 'admin') return false;
    const expected = crypto.createHmac('sha256', ADMIN_SESSION_SECRET).update(`${tag}|${expiryStr}`).digest('hex').slice(0, 32);
    if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return false;
    const expiry = Number(expiryStr);
    return Number.isFinite(expiry) && Date.now() <= expiry;
  } catch { return false; }
}

function parseCookies(req) {
  const header = req.headers.cookie;
  const out = {};
  if (!header) return out;
  header.split(';').forEach(pair => {
    const idx = pair.indexOf('=');
    if (idx === -1) return;
    out[pair.slice(0, idx).trim()] = decodeURIComponent(pair.slice(idx + 1).trim());
  });
  return out;
}

function hasValidAdminSession(req) {
  if (!ADMIN_PASSWORD) return false;
  const cookies = parseCookies(req);
  return !!(cookies.ms_admin && validateAdminSession(cookies.ms_admin));
}

function checkAdminCredentials(user, pass) {
  const userBuf = Buffer.from(String(user || ''));
  const passBuf = Buffer.from(String(pass || ''));
  const expectedUserBuf = Buffer.from(ADMIN_USER);
  const expectedPassBuf = Buffer.from(ADMIN_PASSWORD || '');
  const userOk = userBuf.length === expectedUserBuf.length && crypto.timingSafeEqual(userBuf, expectedUserBuf);
  const passOk = passBuf.length === expectedPassBuf.length && crypto.timingSafeEqual(passBuf, expectedPassBuf);
  return userOk && passOk;
}

// Protects the /admin page: redirects to the branded login page if not signed in.
function requireAdminPage(req, res, next) {
  if (!ADMIN_PASSWORD) return res.status(503).type('text/plain').send('Admin dashboard not configured. Set ADMIN_PASSWORD on the server.');
  if (hasValidAdminSession(req)) return next();
  return res.redirect('/admin/login');
}

// Protects /api/admin/*: returns JSON so the dashboard's own JS can redirect on 401.
function requireAdminApi(req, res, next) {
  if (!ADMIN_PASSWORD) return res.status(503).json({ error: 'Admin dashboard not configured.' });
  if (hasValidAdminSession(req)) return next();
  return res.status(401).json({ error: 'Not authenticated' });
}

function toKobo(ngn) { return Math.round(Number(ngn) * 100); }

// ── Customer account auth (Firebase ID tokens) ──────────────────────────────
// The client signs in with Firebase Auth (email/password) and sends the
// resulting ID token on requests that need to be tied to an account —
// checkout and anything under /api/my-* or /api/account. Browsing, previews,
// and reviews stay fully public and never touch this.
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

// ---------------- Affiliate program ----------------
// One doc per affiliate, keyed by their own referral CODE (not their uid) —
// that makes "look up an affiliate by the code in a link" a single get()
// instead of a query, both for click tracking and for signup attribution.
function makeAffiliateCode(name) {
  const base = (name || 'FRIEND').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 8) || 'FRIEND';
  const suffix = crypto.randomInt(100, 999);
  return `${base}${suffix}`;
}

async function generateUniqueAffiliateCode(name) {
  for (let i = 0; i < 8; i++) {
    const code = makeAffiliateCode(name);
    const existing = await db.collection('affiliates').doc(code).get();
    if (!existing.exists) return code;
  }
  // Extremely unlikely fallback — fully random code.
  return `AFF${crypto.randomInt(100000, 999999)}`;
}

// GET /api/affiliate/code-info/:code — public, no auth. Used only to show
// "Referred by [Name]" on the signup page — deliberately returns just the
// display name, nothing else about the affiliate.
app.get('/api/affiliate/code-info/:code', async (req, res) => {
  try {
    if (!db) return res.json({ name: null });
    const code = String(req.params.code || '').toUpperCase().slice(0, 40);
    const doc = await db.collection('affiliates').doc(code).get();
    return res.json({ name: doc.exists ? (doc.data().name || null) : null });
  } catch (err) {
    return res.json({ name: null });
  }
});

app.post('/api/affiliate/apply', requireUser, async (req, res) => {
  try {
    if (!db) return res.status(500).json({ error: 'Database unavailable' });
    const { phone, bankName, accountNumber, accountName, platform, handle } = req.body || {};
    if (!phone || !String(phone).trim()) return res.status(400).json({ error: 'Phone number is required.' });
    if (!bankName || !String(bankName).trim()) return res.status(400).json({ error: 'Bank name is required.' });
    if (!accountNumber || !String(accountNumber).trim()) return res.status(400).json({ error: 'Account number is required.' });
    if (!accountName || !String(accountName).trim()) return res.status(400).json({ error: 'Account name is required.' });

    // Already an affiliate? Return their existing profile instead of making
    // a second one — this endpoint is safe to call more than once.
    const existingQuery = await db.collection('affiliates').where('uid', '==', req.uid).limit(1).get();
    if (!existingQuery.empty) {
      const doc = existingQuery.docs[0];
      return res.json({ code: doc.id, ...doc.data() });
    }

    const userDoc = await db.collection('users').doc(req.uid).get();
    const name = (userDoc.exists && userDoc.data().name) || req.userName || (req.userEmail || '').split('@')[0];
    const code = await generateUniqueAffiliateCode(name);

    const record = {
      uid: req.uid,
      name: name || 'Affiliate',
      email: req.userEmail,
      phone: String(phone).trim().slice(0, 30),
      bank: {
        bankName: String(bankName).trim().slice(0, 80),
        accountNumber: String(accountNumber).trim().slice(0, 20),
        accountName: String(accountName).trim().slice(0, 120)
      },
      platform: (platform && String(platform).trim().slice(0, 40)) || 'Other',
      handle: (handle && String(handle).trim().slice(0, 200)) || null,
      status: 'active',
      clicks: 0,
      signups: 0,
      sales: 0,
      earned: 0,
      paidOut: 0,
      createdAt: admin.firestore.Timestamp.now()
    };
    await db.collection('affiliates').doc(code).set(record);
    sendAffiliateWelcomeEmail(req.userEmail, record.name, code);
    return res.json({ code, ...record });
  } catch (err) {
    console.error('/api/affiliate/apply error', err);
    return res.status(500).json({ error: 'Could not set up your affiliate account. Please try again.' });
  }
});

app.get('/api/affiliate/me', requireUser, async (req, res) => {  try {
    if (!db) return res.status(500).json({ error: 'Database unavailable' });
    const q = await db.collection('affiliates').where('uid', '==', req.uid).limit(1).get();
    if (q.empty) return res.json({ affiliate: null });
    const doc = q.docs[0];
    const data = doc.data();

    // Recent people this affiliate referred, most recent first.
    const referredQuery = await db.collection('users').where('referredByCode', '==', doc.id).orderBy('createdAt', 'desc').limit(50).get().catch(() => null);
    const referred = referredQuery ? referredQuery.docs.map(d => ({
      name: d.data().name || null,
      email: d.data().email || null,
      joinedAt: d.data().createdAt || null
    })) : [];

    const earned = data.earned || 0;
    const paidOut = data.paidOut || 0;
    const pendingPayout = data.pendingPayout || 0;
    // Available = earned minus anything already paid, minus anything already
    // queued in an unresolved Monday payout (so it isn't queued twice).
    const availableBalance = Math.max(0, earned - paidOut - pendingPayout);

    return res.json({
      affiliate: {
        code: doc.id,
        name: data.name, platform: data.platform, handle: data.handle,
        phone: data.phone || null,
        bank: data.bank || null,
        clicks: data.clicks || 0, signups: data.signups || 0, sales: data.sales || 0,
        earned, paidOut, pendingPayout,
        outstanding: Math.max(0, earned - paidOut),
        availableBalance,
        minPayout: AFFILIATE_MIN_PAYOUT,
        nextPayoutDate: nextMondayISO(),
        createdAt: data.createdAt
      },
      referred
    });
  } catch (err) {
    console.error('/api/affiliate/me error', err);
    return res.status(500).json({ error: 'Could not load your affiliate dashboard. Please try again.' });
  }
});

// POST /api/affiliate/bank/otp — sends a 6-digit code to the affiliate's own
// account email, required before /api/affiliate/bank/otp/verify will let
// them in. Same lock as the update itself: no point sending a code if they
// can't actually use it yet.
const BANK_OTP_TTL_MS = 10 * 60 * 1000; // 10 minutes
const BANK_OTP_RESEND_COOLDOWN_MS = 60 * 1000; // 60 seconds between sends
const BANK_VERIFIED_TTL_MS = 5 * 60 * 1000; // window to actually save after verifying

function maskEmail(email) {
  const [user, domain] = String(email || '').split('@');
  if (!user || !domain) return email || '';
  const visible = user.slice(0, Math.min(2, user.length));
  return `${visible}${'*'.repeat(Math.max(1, user.length - visible.length))}@${domain}`;
}

app.post('/api/affiliate/bank/otp', requireUser, async (req, res) => {
  try {
    if (!db) return res.status(500).json({ error: 'Database unavailable' });
    const q = await db.collection('affiliates').where('uid', '==', req.uid).limit(1).get();
    if (q.empty) return res.status(404).json({ error: 'You are not registered as an affiliate.' });
    const doc = q.docs[0];
    const data = doc.data();

    if ((data.pendingPayout || 0) > 0) {
      return res.status(409).json({ error: 'You have a payout queued for this Monday, so your bank details are locked until it\'s paid out. You can update them right after.' });
    }

    const email = data.email || req.userEmail;
    if (!email) return res.status(400).json({ error: 'No email is on file for this account.' });

    const existingOtp = data.bankOtp;
    if (existingOtp && existingOtp.requestedAt) {
      const requestedMs = existingOtp.requestedAt.toMillis ? existingOtp.requestedAt.toMillis() : 0;
      const waitLeft = BANK_OTP_RESEND_COOLDOWN_MS - (Date.now() - requestedMs);
      if (waitLeft > 0) {
        return res.status(429).json({ error: `Please wait ${Math.ceil(waitLeft / 1000)}s before requesting another code.` });
      }
    }

    const code = String(crypto.randomInt(100000, 999999));
    const hash = crypto.createHash('sha256').update(code).digest('hex');
    const now = admin.firestore.Timestamp.now();

    const sent = await sendBankOtpEmail(email, data.name, code);
    if (!sent.ok) return res.status(502).json({ error: sent.error });

    // A fresh code request invalidates any previously-granted verified
    // session too — starting the flow over shouldn't leave an old session
    // still able to save.
    await doc.ref.update({
      bankOtp: {
        hash,
        expiresAt: admin.firestore.Timestamp.fromMillis(Date.now() + BANK_OTP_TTL_MS),
        requestedAt: now,
        attempts: 0
      },
      bankVerified: admin.firestore.FieldValue.delete()
    });

    return res.json({ ok: true, sentTo: maskEmail(email) });
  } catch (err) {
    console.error('/api/affiliate/bank/otp error', err);
    return res.status(500).json({ error: 'Could not send a verification code. Please try again.' });
  }
});

// POST /api/affiliate/bank/otp/verify — checks the emailed code. On success
// it does NOT save anything by itself; it opens a short (5-minute),
// server-side-only "verified" window during which /api/affiliate/bank will
// accept a save. This is deliberately a separate step from the save call so
// the dashboard can show "verify" and "edit details" as two distinct
// screens — but the security boundary is this endpoint, not the UI: the
// save endpoint below trusts nothing from the client except that this
// window is currently open, so there's no client-side path that skips it.
app.post('/api/affiliate/bank/otp/verify', requireUser, async (req, res) => {
  try {
    if (!db) return res.status(500).json({ error: 'Database unavailable' });
    const { otp } = req.body || {};
    if (!otp || !String(otp).trim()) return res.status(400).json({ error: 'Enter the verification code sent to your email.' });

    const q = await db.collection('affiliates').where('uid', '==', req.uid).limit(1).get();
    if (q.empty) return res.status(404).json({ error: 'You are not registered as an affiliate.' });
    const doc = q.docs[0];
    const data = doc.data();

    if ((data.pendingPayout || 0) > 0) {
      return res.status(409).json({ error: 'You have a payout queued for this Monday, so your bank details are locked until it\'s paid out. You can update them right after.' });
    }

    const bankOtp = data.bankOtp;
    if (!bankOtp || !bankOtp.hash) {
      return res.status(400).json({ error: 'Request a verification code first.' });
    }
    const expiresMs = bankOtp.expiresAt && bankOtp.expiresAt.toMillis ? bankOtp.expiresAt.toMillis() : 0;
    if (Date.now() > expiresMs) {
      return res.status(400).json({ error: 'That code has expired. Please request a new one.' });
    }
    if ((bankOtp.attempts || 0) >= 5) {
      return res.status(429).json({ error: 'Too many incorrect attempts. Please request a new code.' });
    }
    const suppliedHash = crypto.createHash('sha256').update(String(otp).trim()).digest('hex');
    if (suppliedHash !== bankOtp.hash) {
      await doc.ref.update({ 'bankOtp.attempts': admin.firestore.FieldValue.increment(1) });
      return res.status(400).json({ error: 'That code is incorrect. Please try again.' });
    }

    const until = admin.firestore.Timestamp.fromMillis(Date.now() + BANK_VERIFIED_TTL_MS);
    await doc.ref.update({
      bankVerified: { until },
      bankOtp: admin.firestore.FieldValue.delete()
    });

    return res.json({ ok: true, expiresInSeconds: Math.round(BANK_VERIFIED_TTL_MS / 1000) });
  } catch (err) {
    console.error('/api/affiliate/bank/otp/verify error', err);
    return res.status(500).json({ error: 'Could not verify that code. Please try again.' });
  }
});

// PUT /api/affiliate/bank — affiliate updates their own bank account details
// (used to receive Monday payouts). Does not touch balances.
// Locked while a payout is queued for them (pendingPayout > 0) — the amount
// owed was already snapshotted with the old bank details when Monday's
// batch ran, so editing now would silently desync from what the admin is
// about to send it to. They can edit again once that payout is marked paid.
// Also requires an active, server-granted "verified" window from
// /api/affiliate/bank/otp/verify above — this is checked purely off the
// affiliate's own doc, never off anything the client sends, so there's no
// request anyone can craft that skips the emailed code.
app.put('/api/affiliate/bank', requireUser, async (req, res) => {
  try {
    if (!db) return res.status(500).json({ error: 'Database unavailable' });
    const { bankName, accountName, accountNumber } = req.body || {};
    if (!bankName || !String(bankName).trim()) return res.status(400).json({ error: 'Bank name is required.' });
    if (!accountName || !String(accountName).trim()) return res.status(400).json({ error: 'Account name is required.' });
    if (!accountNumber || !String(accountNumber).trim()) return res.status(400).json({ error: 'Account number is required.' });

    const q = await db.collection('affiliates').where('uid', '==', req.uid).limit(1).get();
    if (q.empty) return res.status(404).json({ error: 'You are not registered as an affiliate.' });
    const doc = q.docs[0];
    const data = doc.data();

    if ((data.pendingPayout || 0) > 0) {
      return res.status(409).json({ error: 'You have a payout queued for this Monday, so your bank details are locked until it\'s paid out. You can update them right after.' });
    }

    const verifiedUntilMs = data.bankVerified && data.bankVerified.until && data.bankVerified.until.toMillis
      ? data.bankVerified.until.toMillis() : 0;
    if (Date.now() > verifiedUntilMs) {
      return res.status(401).json({ error: 'Please verify with the code sent to your email first.', needsVerification: true });
    }

    const bank = {
      bankName: String(bankName).trim().slice(0, 80),
      accountName: String(accountName).trim().slice(0, 120),
      accountNumber: String(accountNumber).trim().slice(0, 20)
    };
    // Single-use: the verified window is consumed the moment it's spent on
    // an actual save, so a second save attempt needs a fresh code again.
    await doc.ref.update({ bank, bankVerified: admin.firestore.FieldValue.delete() });
    return res.json({ ok: true, bank });
  } catch (err) {
    console.error('/api/affiliate/bank error', err);
    return res.status(500).json({ error: 'Could not update your bank details. Please try again.' });
  }
});




// GET /api/affiliate/payouts — this affiliate's own payout history
// (every Monday batch they were included in), most recent first.
app.get('/api/affiliate/payouts', requireUser, async (req, res) => {
  try {
    if (!db) return res.status(500).json({ error: 'Database unavailable' });
    const q = await db.collection('affiliates').where('uid', '==', req.uid).limit(1).get();
    if (q.empty) return res.json({ payouts: [] });
    const code = q.docs[0].id;
    // Filtered + sorted in JS rather than where()+orderBy() on different
    // fields, so this never needs a manually-created Firestore composite
    // index — fine at this scale (a handful of payouts per affiliate).
    const snap = await db.collection('payouts').where('affiliateCode', '==', code).limit(200).get().catch(() => null);
    const payouts = snap ? snap.docs.map(d => {
      const p = d.data();
      return {
        id: d.id,
        amount: p.amount || 0,
        status: p.status || 'pending',
        createdAt: p.createdAt ? (p.createdAt.toDate ? p.createdAt.toDate().toISOString() : p.createdAt) : null,
        paidAt: p.paidAt ? (p.paidAt.toDate ? p.paidAt.toDate().toISOString() : p.paidAt) : null,
        _sort: p.createdAt ? (p.createdAt.toMillis ? p.createdAt.toMillis() : 0) : 0
      };
    }).sort((a, b) => b._sort - a._sort).map(({ _sort, ...rest }) => rest) : [];
    return res.json({ payouts });
  } catch (err) {
    console.error('/api/affiliate/payouts error', err);
    return res.status(500).json({ error: 'Could not load your payout history. Please try again.' });
  }
});

/**
 * Get USD -> NGN exchange rate
 * Priority:
 *  1) process.env.FX_RATE (manual override, e.g. 1500)
 *  2) live lookup via exchangerate.host
 *  3) fallback to 1500
 */
async function getExchangeRate() {
  const FALLBACK = 1500;

  // 1) env override
  if (process.env.FX_RATE) {
    const v = Number(process.env.FX_RATE);
    if (!Number.isNaN(v) && v > 0) {
      console.log('[FX] using FX_RATE env override =>', v);
      return v;
    } else {
      console.warn('[FX] FX_RATE env var is invalid:', process.env.FX_RATE);
    }
  }

  // 2) live lookup
  try {
    console.log('[FX] attempting live lookup via exchangerate.host');
    const resp = await fetch('https://api.exchangerate.host/convert?from=USD&to=NGN');
    const json = await resp.json().catch(() => null);
    const rate = json && (json.info?.rate || json.result);
    if (rate && Number.isFinite(rate) && Number(rate) > 0) {
      console.log('[FX] live rate fetched =>', rate);
      return Number(rate);
    } else {
      console.warn('[FX] live lookup returned invalid rate:', json);
    }
  } catch (err) {
    console.warn('[FX] live lookup failed:', err.message || err);
  }

  // 3) fallback
  console.warn(`[FX] falling back to fixed rate => ${FALLBACK}`);
  return FALLBACK;
}

// ----------------- PRODUCTS (single source: edit here) -----------------
// Make sure coverPath starts with /images/... and pdfPath with files/...
// category: 'ours'     -> shown in the top "Our Books" section
// category: 'featured' -> shown in "Featured Books by Other Authors"
// author/description/genre power the Book Details page (review.html)
const PRODUCTS = {

  // ---------------- OUR BOOKS ----------------
  'the-discipline-advantage': {
    id: 'the-discipline-advantage',
    title: 'The Discipline Advantage',
    priceUSD: null,
    priceNGN: 4000,
    originalPriceNGN: 12000,
    coverPath: 'tda.jpg',
    pdfPath: 'public/files/The_Discipline_Advantage.pdf',
    previewUrl: '/tda-preview',
    reviewImages: [], // no reviews yet, add later
    category: 'ours',
    author: 'MindShift Books',
    genre: 'Personal Development',
    language: 'English',
    pages: 70,
    description: `THE DISCIPLINE ADVANTAGE

Why Talented People Never Finish What They Start — And How to Build the System That Makes Discipline Automatic

You know what you need to do. You may even be talented enough to do it well.

So why do you keep starting things and not finishing them?

The Discipline Advantage challenges the idea that inconsistency is simply a lack of motivation, willpower or ambition. It argues that the real problem often lies deeper—in the systems, identity, environment and behavioural patterns that take over when the initial excitement disappears.

This book explores the Discipline Advantage Gap: the distance between what you intend to do and what you consistently follow through on.

Inside, you'll explore:

Why willpower was never designed to carry your goals
The hidden scripts influencing your follow-through
Why talented people often start everything but finish nothing
The difference between comfort discipline and real discipline
How your identity influences what you can consistently sustain
Why progress can trigger self-sabotage
How to build systems that keep you moving even when motivation disappears
How to design your environment so the right action becomes easier
How to recover after falling off and avoid turning one missed day into a lost month

This is not a hustle-culture book about waking up at 5 AM or trying harder. It is a practical framework for understanding why your plans break down—and building a system that works even on the days you don't feel like showing up.

START LESS. FINISH MORE. BUILD WHAT LASTS.`
  },

  'getting-clients-without-ads': {
    id: 'getting-clients-without-ads',
    title: 'Getting Client Without Ads',
    priceUSD: null,
    priceNGN: 5000,
    originalPriceNGN: 15000,
    coverPath: 'gcwa.jpg',
    pdfPath: 'public/files/Getting_Clients_Without_Ads.pdf',
    previewUrl: '/gcwa-preview',
    reviewImages: [], // no reviews yet, add later
    category: 'ours',
    author: 'MindShift Books',
    genre: 'Business & Marketing',
    language: 'English',
    pages: 100,
    description: 'You have the skill. You do the work. And yet your pipeline is either empty, unpredictable, or completely dependent on who you happen to know that month. Getting Clients Without Ads is the full client acquisition playbook for freelancers, consultants, and agency owners who are done gambling on algorithms — with six interlocking engines covering positioning, offer building, outreach, content, referrals, and closing. No paid ads. No viral moments. No luck required.'
  },

  'escape-your-environment-or-become-it': {
    id: 'escape-your-environment-or-become-it',
    title: 'Escape Your Environment Or Become It',
    priceUSD: null,
    priceNGN: 5000,
    originalPriceNGN: 15000,
    coverPath: 'escape.jpg',
    pdfPath: 'public/files/Escape_Your_Environment_Or_Become_It.pdf',
    previewUrl: '/escape-preview',
    reviewImages: [], // no reviews yet, add later
    category: 'ours',
    author: 'MindShift Books',
    genre: 'Personal Development',
    language: 'English',
    pages: 105,
    description: `Escape Your Environment or Become It

Your Environment Is Shaping You. The Question Is: Is It Taking You Forward or Holding You Back?

You may think your lack of progress is a motivation problem. Maybe you think you need more discipline. More confidence. More willpower.

But what if the environment around you is quietly shaping your behavior, expectations, ambition, and even your perception of what is possible?

Escape Your Environment or Become It explores one of the most overlooked forces behind personal growth: the environment you live in.

Your friends. Your family dynamics. Your workplace. Your information diet. Your routines. Your physical surroundings. The expectations you have gradually accepted as normal.

Over time, these forces can either expand your capacity—or quietly shrink your vision of what you can become.

The Question This Book Forces You to Ask

Is your environment difficult because it is helping you grow—or limiting because it is preventing you from growing?

Not every uncomfortable environment is bad. A demanding job can develop you. A competitive environment can sharpen you. A difficult challenge can increase your capacity.

But a limiting environment is different. It doesn't simply challenge you. It narrows what you believe is possible.

Inside This Book, You'll Discover

How your environment influences your ambition, behavior, and expectations.
How to distinguish a difficult environment from a genuinely limiting environment.
The five major environmental forces that can shape your trajectory.
How the people around you can either expand or contract your belief in your own capability.
Why changing your environment can sometimes produce more progress than simply trying harder.
How scarcity, stress, and instability can consume the mental bandwidth needed to plan and build a better future.
How to diagnose exactly what in your environment is holding you back.
How to create an environment change map instead of making impulsive decisions.
How to leave a limiting environment without necessarily abandoning the relationships that genuinely matter.

You Will Also Learn How to Build Yourself From the Inside

Changing your environment isn't enough if you haven't developed the internal capacity to operate differently.

The book examines self-efficacy—your belief in your ability to successfully perform and handle challenging tasks—and explains how it can be deliberately strengthened through mastery experiences, observing others, credible encouragement, and managing the physiological response to challenging situations.

This Book Is For You If...

You constantly feel like:
You're capable of more than your current circumstances allow.
The people around you don't understand the direction you're trying to go.
Your surroundings have started to feel smaller than your ambitions.
You're repeatedly returning to the same patterns despite wanting to change.
You're working hard but your environment keeps consuming your energy.
You aren't sure whether you need more discipline—or a different environment.
You want to change your circumstances without losing yourself in the process.

The Real Cost of Staying

A limiting environment doesn't only take away opportunities. It can consume the attention, energy, and cognitive bandwidth required to recognize and pursue those opportunities.

And the longer you remain surrounded by the same expectations, limitations, and patterns, the easier it can become to mistake them for reality.

You don't just live in an environment. Eventually, you can start becoming it.

From Diagnosis to Escape

This book doesn't simply tell you to "leave." It gives you a framework for understanding what is actually holding you back, identifying the highest-leverage change, and deliberately constructing an environment that supports the person you are trying to become.

Understand Your Environment. Change What Limits You. Become Who You Were Capable of Becoming.`
  },

  'the-money-mindset-gap': {
    id: 'the-money-mindset-gap',
    title: 'The Money Mindset Gap',
    priceUSD: null,
    priceNGN: 4000,
    originalPriceNGN: 12000,
    coverPath: 'mmg.jpg',
    pdfPath: 'public/files/The_Money_Mindset_Gap.pdf',
    previewUrl: '/mmg-preview',
    reviewImages: [], // no reviews yet, add later
    category: 'ours',
    author: 'MindShift Books',
    genre: 'Personal Finance',
    language: 'English',
    pages: 70,
    description: `The Money Mindset Gap

Why Skilled People Stay Broke — And How to Finally Get Paid What You Are Worth

You work hard. You have the skills. You deliver real results.

So why does your income still feel disconnected from your ability?

The Money Mindset Gap explores the hidden psychological gap between what your work is actually worth and what you consistently allow yourself to earn.

This isn't another "work harder," "get rich quick," or "just charge more" book. It goes beneath the surface to examine the beliefs, money scripts, fear, identity, and habits that can quietly keep skilled professionals underpaid.

What You'll Discover

Inside the book, you'll learn how to:

Identify the beliefs about money and worth that may have been installed long before your career began.
Recognize the money scripts influencing your pricing and financial decisions without your conscious permission.
Understand why highly skilled people consistently undercharge.
Distinguish between fear pricing and value pricing.
Stop treating rejection as a reason to immediately lower your price.
Understand how scarcity thinking can create the financial instability it is trying to prevent.
Recognize the connection between self-image and your income ceiling.
Build greater confidence around pricing and negotiation.
Create a stronger financial architecture for independent earning.
Develop a long-term approach to building genuine financial independence.

The Problem Isn't Always Your Skill

One of the book's central ideas is simple:

Being better at what you do does not automatically mean you will earn more.

Two people can have comparable skills and produce comparable results while charging dramatically different prices. The difference can come down to how they perceive their value, communicate it, and respond when their price is challenged.

You may recognize yourself in the patterns:

You know you should charge more—but hesitate when it's time to say the number.

A client pushes back—and you discount before understanding why.

Your income reaches a certain level—and somehow keeps returning there.

You keep improving your skills, but your income doesn't seem to move with them.

These aren't necessarily signs that you need another qualification.

They may be signs that there is a Money Mindset Gap.

A Practical Journey From Diagnosis to Change

The book takes you through three stages:

1. The Diagnosis

Understand where your money beliefs came from and how they influence your decisions.

You'll explore the Worth Wound, Money Scripts, Undercharging Trap, and Humility Lie.

2. The Psychology

Understand the mechanisms that keep the gap in place.

You'll examine the Permission Problem, Fear Pricing vs Value Pricing, Scarcity Loop, and the relationship between Identity and Income.

3. Closing the Gap

Move from awareness into practical action.

You'll work through worth assessment, pricing confidence, negotiation, financial architecture, and the long game of building wealth independently.

This Book Is For You If...

You're a freelancer, consultant, creative, professional, entrepreneur, specialist, or independent service provider who:

Knows you're capable of more but isn't earning accordingly.
Struggles to confidently communicate your rates.
Frequently discounts when clients push back.
Feels uncomfortable charging premium prices.
Keeps taking low-paying work because saying no feels risky.
Wants to earn more without compromising the quality or purpose of their work.
Is ready to examine the beliefs behind their financial decisions.

The Shift

The goal isn't simply to convince you to charge more.

It is to help you understand why you charge what you charge, where that number came from, and what needs to change for your financial reality to better reflect the value you create.

Because the problem isn't always that you need to become more valuable.

Sometimes, you need to stop undervaluing the value you already create.

Know Your Worth. Charge Your Worth. Keep Your Worth.`
  },

  // ---------------- FEATURED BOOKS BY OTHER AUTHORS ----------------
  'mindshift-101': {
    id: 'mindshift-101',
    title: 'The Psychology of Persuasion',
    coverPath: 'The psychology of persuasion.jpg',
    externalUrl: 'https://www.amazon.com/s?k=influence+robert+cialdini',
    category: 'featured',
    author: 'Robert B. Cialdini',
    genre: 'Psychology',
    language: 'English',
    description: 'A landmark look at the psychological triggers — reciprocity, social proof, authority, and more — that quietly drive people to say yes, and how those triggers show up (and get used) in everyday persuasion.'
  },

  'mindshift-advanced': {
    id: 'mindshift-advanced',
    title: 'The Psychology Of Money',
    coverPath: 'The psychology of money.jpg',
    externalUrl: 'https://www.amazon.com/s?k=psychology+of+money+morgan+housel',
    category: 'featured',
    author: 'Morgan Housel',
    genre: 'Personal Finance',
    language: 'English',
    description: 'Makes the case that financial success is driven less by what you know and more by how you behave — using short, story-driven chapters to unpack the emotional side of saving, investing, and building wealth.'
  },

  'Games People Play': {
    id: 'Games People Play',
    title: 'Games People Play',
    coverPath: 'Games people play.jpg',
    externalUrl: 'https://www.amazon.com/s?k=games+people+play+eric+berne',
    category: 'featured',
    author: 'Eric Berne',
    genre: 'Psychology',
    language: 'English',
    description: 'A foundational work in transactional analysis that maps out the hidden social "games" and manipulative patterns people unconsciously play out in relationships, work, and everyday conversation.'
  },

  'Think And Grow Rich': {
    id: 'Think And Grow Rich',
    title: 'Think And Grow Rich',
    coverPath: 'Think and grow rich.jpg',
    externalUrl: 'https://www.amazon.com/s?k=think+and+grow+rich+napoleon+hill',
    category: 'featured',
    author: 'Napoleon Hill',
    genre: 'Personal Finance',
    language: 'English',
    description: 'One of the best-selling personal development books ever written, distilling interviews with self-made millionaires into core principles — desire, faith, persistence — for building wealth and achieving goals.'
  },

  'Rich Dad Poor Dad': {
    id: 'Rich Dad Poor Dad',
    title: 'Rich Dad Poor Dad',
    coverPath: 'Rich dad poor dad.jpg',
    externalUrl: 'https://www.amazon.com/s?k=rich+dad+poor+dad+kiyosaki',
    category: 'featured',
    author: 'Robert T. Kiyosaki',
    genre: 'Personal Finance',
    language: 'English',
    description: 'Contrasts two very different mindsets about money — drawn from the author\'s two father figures — to challenge conventional ideas about jobs, assets, and financial education.'
  },

  'Read People Like A Book': {
    id: 'Read People Like A Book',
    title: 'Read People Like A Book',
    coverPath: 'Read people like a book.jpg',
    externalUrl: 'https://www.amazon.com/s?k=read+people+like+a+book+patrick+king',
    category: 'featured',
    author: 'Patrick King',
    genre: 'Psychology',
    language: 'English',
    description: 'A practical guide to reading body language, speech patterns, and behavioral cues so you can better understand what people are really thinking and feeling beneath the surface.'
  },

  'The Art Of Seduction': {
    id: 'The Art Of Seduction',
    title: 'The Art Of Seduction',
    coverPath: 'The art of seduction.jpg',
    externalUrl: 'https://www.amazon.com/s?k=art+of+seduction+robert+greene',
    category: 'featured',
    author: 'Robert Greene',
    genre: 'Psychology',
    language: 'English',
    description: 'Examines the strategies and archetypes history\'s great seducers have used to attract and influence others, framed as a study of psychology and persuasion rather than just romance.'
  },

  'Atomic Habit': {
    id: 'Atomic Habit',
    title: 'Atomic Habit',
    coverPath: 'Atomic habit.jpg',
    externalUrl: 'https://www.amazon.com/s?k=atomic+habits+james+clear',
    category: 'featured',
    author: 'James Clear',
    genre: 'Self-Help & Productivity',
    language: 'English',
    description: 'A practical framework for building good habits and breaking bad ones, built on the idea that small, 1% improvements compound into remarkable results over time.'
  },

  'The Laws Of Human Nature': {
    id: 'The Laws Of Human Nature',
    title: 'The Laws Of Human Nature',
    coverPath: 'The laws of human nature.jpg',
    externalUrl: 'https://www.amazon.com/s?k=laws+of+human+nature+robert+greene',
    category: 'featured',
    author: 'Robert Greene',
    genre: 'Psychology',
    language: 'English',
    description: 'A deep dive into the recurring patterns of human behavior — envy, narcissism, denial, and more — written to help readers understand themselves and others more clearly.'
  }

  // add more products here (only change server.js)
};
// -----------------------------------------------------------------------

// ── Self-contained download tokens ─────────────────────────────────────────
// The productId is encoded inside the token itself (base64url), so /dl/ can
// validate and serve the file without any Firestore lookup.
// Security: tokens are HMAC-signed with DOWNLOAD_SECRET — impossible to forge
// without the secret. Tokens never expire so legitimate buyers can re-download
// any time. The secret must be set as a Render env var so it survives restarts.
const DOWNLOAD_SECRET = process.env.DOWNLOAD_SECRET || (() => {
  const s = require('crypto').randomBytes(32).toString('hex');
  console.warn('DOWNLOAD_SECRET not set — using ephemeral secret. Set this env var on Render or download links will break on restart.');
  return s;
})();

function mintDownloadToken(productId) {
  const rand = crypto.randomBytes(16).toString('hex');
  const payload = `${productId}|${rand}`;
  const sig = crypto.createHmac('sha256', DOWNLOAD_SECRET).update(payload).digest('hex').slice(0, 32);
  return Buffer.from(`${payload}|${sig}`).toString('base64url');
}

function validateDownloadToken(token) {
  try {
    const decoded = Buffer.from(token, 'base64url').toString('utf8');
    const lastPipe = decoded.lastIndexOf('|');
    const secondLastPipe = decoded.lastIndexOf('|', lastPipe - 1);
    if (lastPipe === -1 || secondLastPipe === -1) return null;
    const productId = decoded.slice(0, secondLastPipe);
    const rand = decoded.slice(secondLastPipe + 1, lastPipe);
    const givenSig = decoded.slice(lastPipe + 1);
    if (!productId || !rand || givenSig.length !== 32) return null;
    const expected = crypto.createHmac('sha256', DOWNLOAD_SECRET)
      .update(`${productId}|${rand}`)
      .digest('hex').slice(0, 32);
    if (!crypto.timingSafeEqual(Buffer.from(givenSig, 'hex'), Buffer.from(expected, 'hex'))) return null;
    return productId;
  } catch { return null; }
}

// Gated PDF download endpoint
app.get('/dl/:token', (req, res) => {
  const productId = validateDownloadToken(req.params.token);
  if (!productId) {
    return res.status(403).type('text/plain').send('Invalid download link. Go to My Orders to get a fresh one.');
  }
  const product = PRODUCTS[productId];
  if (!product || !product.pdfPath) {
    return res.status(404).type('text/plain').send('File not found.');
  }
  const filePath = path.join(__dirname, product.pdfPath);
  // Check the file exists before setting headers — prevents ERR_INVALID_RESPONSE
  const fs = require('fs');
  if (!fs.existsSync(filePath)) {
    console.error('PDF not found on disk:', filePath);
    return res.status(500).type('text/plain').send('File unavailable. Please contact support.');
  }
  // First-party analytics: log the download, fire-and-forget (never blocks the file).
  if (db) {
    db.collection('events').add({
      type: 'download',
      productId,
      createdAt: admin.firestore.Timestamp.now()
    }).catch(() => null);
  }
  res.setHeader('Content-Disposition', `attachment; filename="${path.basename(product.pdfPath)}"`);
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Cache-Control', 'no-store');
  return res.sendFile(filePath, { root: '/' }, err => {
    if (err && !res.headersSent) {
      console.error('sendFile error:', err.message);
      res.status(500).type('text/plain').send('Could not serve file.');
    }
  });
});

function derivePublicUrl(req) {
  if (process.env.PUBLIC_URL && process.env.PUBLIC_URL.trim()) return process.env.PUBLIC_URL.replace(/\/$/, '');
  const proto = req.headers['x-forwarded-proto'] || req.protocol || 'http';
  const host = req.get('host');
  return `${proto}://${host}`;
}

// Return minimal product info to clients (no pdfPath)
app.get('/api/products', (req, res) => {
  try {
    const out = Object.values(PRODUCTS).map(p => ({
      id: p.id,
      title: p.title,
      priceUSD: p.priceUSD || null,
      priceNGN: p.priceNGN || null,
      originalPriceNGN: p.originalPriceNGN || null,
      cover: p.coverPath,
      reviewImages: p.reviewImages || [],
      previewUrl: p.previewUrl || null,
      hasPdf: !!p.pdfPath,
      category: p.category || 'featured',
      author: p.author || null,
      genre: p.genre || null,
      language: p.language || 'English',
      pages: p.pages || null,
      externalUrl: p.externalUrl || null
    }));
    return res.json({ products: out });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Could not load products' });
  }
});

// Single product (for review page)
app.get('/api/product/:id', (req, res) => {
  try {
    const pid = req.params.id;
    const p = PRODUCTS[pid];
    if (!p) return res.status(404).json({ error: 'Product not found' });
    const out = {
      id: p.id,
      title: p.title,
      priceUSD: p.priceUSD || null,
      priceNGN: p.priceNGN || null,
      originalPriceNGN: p.originalPriceNGN || null,
      cover: p.coverPath,
      reviewImages: p.reviewImages || [],
      previewUrl: p.previewUrl || null,
      hasPdf: !!p.pdfPath,
      category: p.category || 'featured',
      author: p.author || null,
      genre: p.genre || null,
      language: p.language || 'English',
      pages: p.pages || null,
      description: p.description || null,
      externalUrl: p.externalUrl || null
    };
    return res.json({ product: out });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Server error' });
  }
});

// ---------------- FREE EBOOKS (Gutendex / Project Gutenberg catalog proxy) ----------------
// Thousands of real, actually-free public-domain books (Pride and Prejudice,
// Sherlock Holmes, Dracula, Moby Dick, Shakespeare, etc.) shown in our own
// UI. We never host or redistribute the files — "Read Free eBook" sends the
// reader straight to Project Gutenberg's own hosted HTML/EPUB/text file for
// that title. No API key, no approval, no country gating — every format URL
// is served directly off Gutenberg's own file host.
const GUTENDEX_API = 'https://gutendex.com/books';
const GUTENDEX_PAGE_SIZE = 32; // fixed by Gutendex, not configurable

const FREE_EBOOK_CATEGORIES = [
  { slug: 'all',        label: 'All',                topic: null }, // handled specially — see ALL_MIX_TOPICS below
  { slug: 'fiction',    label: 'Fiction',             topic: 'fiction' },
  { slug: 'self-help',  label: 'Self-Help',           topic: 'conduct of life' },
  { slug: 'business',   label: 'Business & Money',    topic: 'business' },
  { slug: 'psychology', label: 'Psychology',          topic: 'psychology' },
  { slug: 'romance',    label: 'Romance',             topic: 'love stories' },
  { slug: 'sci-fi',     label: 'Science Fiction',     topic: 'science fiction' },
  { slug: 'mystery',    label: 'Mystery & Thriller',  topic: 'detective' },
  { slug: 'history',    label: 'History',             topic: 'history' },
  { slug: 'biography',  label: 'Biography',           topic: 'biography' },
  { slug: 'classics',   label: 'Classics',            topic: 'literature' },
  { slug: 'poetry',     label: 'Poetry',              topic: 'poetry' }
];

// "All" rotates through these real topics so browsing stays a genuine mix
// instead of one giant, ID-ordered dump. Note: Gutendex's own default
// ordering (no topic/search) is already by popularity/download_count, so
// this is only needed to keep genre variety on the "All" tab specifically.
const ALL_MIX_TOPICS = [
  'fiction', 'conduct of life', 'business',
  'psychology', 'love stories', 'science fiction',
  'detective', 'history', 'biography',
  'literature', 'poetry'
];

// Simple in-memory cache, keyed per Gutendex page (32 books at a time) so
// repeat browsing doesn't re-hit Gutendex every time. Cleared on restart.
const freeEbooksCache = new Map();
const FREE_EBOOKS_CACHE_TTL = 60 * 60 * 1000; // 1 hour

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Pick the best "read in browser" link and cover image out of Gutendex's
// `formats` map (a mimetype -> URL dictionary). These are direct links to
// Gutenberg's own file host — no app, no account, no region check.
function pickReadLink(formats) {
  return formats['text/html; charset=utf-8']
    || formats['text/html']
    || formats['text/html; charset=us-ascii']
    || formats['application/epub+zip']
    || formats['text/plain; charset=utf-8']
    || formats['text/plain']
    || null;
}
function pickCover(formats) {
  return formats['image/jpeg'] || null;
}

function normalizeGutendexBook(item) {
  const formats = item.formats || {};
  const authors = (item.authors || []).map(a => a.name).filter(Boolean);
  return {
    id: item.id,
    title: item.title || 'Untitled',
    authors,
    author: authors[0] || 'Unknown Author',
    description: '', // Gutendex has no blurb field — detail panel falls back to subjects below
    cover: pickCover(formats),
    categories: (item.subjects || []).slice(0, 3),
    language: (item.languages && item.languages[0]) || 'en',
    pageCount: null, // not provided by Gutendex
    publishedDate: null, // not provided by Gutendex (these are old editions, not new releases)
    downloadCount: item.download_count || 0,
    // Stays on our own domain the whole time — /read/:id proxies + caches
    // the actual Gutenberg file server-side (see below). Download is
    // intentionally not wired up yet.
    readLink: `/read/${item.id}`
  };
}

async function fetchGutendexPageOnce(topicOrSearch, isSearch, page) {
  const params = new URLSearchParams();
  if (isSearch) params.set('search', topicOrSearch);
  else if (topicOrSearch) params.set('topic', topicOrSearch);
  params.set('languages', 'en'); // English-only — matches our audience and avoids untranslated results
  params.set('page', String(page));

  const url = `${GUTENDEX_API}?${params.toString()}`;
  const resp = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; MindShiftBooks/1.0; +https://mindshiftbooks.shop)',
      'Accept': 'application/json'
    }
  });
  if (!resp.ok) {
    const bodyText = await resp.text().catch(() => '');
    const err = new Error(`Gutendex API error: ${resp.status} ${resp.statusText} — ${bodyText.slice(0, 300)}`);
    err.status = resp.status;
    throw err;
  }
  return resp.json();
}

// Fetches one Gutendex page (32 books), with retry/backoff — Gutendex is a
// community-run free service and occasionally flakes or times out.
async function fetchGutendexPage(topicOrSearch, isSearch, page) {
  const cacheKey = `page::${isSearch ? 'search' : 'topic'}::${topicOrSearch || ''}::${page}`;
  const cached = freeEbooksCache.get(cacheKey);

  // Stale-while-revalidate: once a page has been fetched once, a visitor
  // never waits on a live Gutendex round-trip again — expired entries are
  // served immediately while a background refresh quietly tops up the
  // cache. Worst case someone sees a list that's a bit older than an hour;
  // best case (the common case) every request is instant from memory.
  if (cached) {
    if (cached.expires <= Date.now() && !cached.refreshing) {
      cached.refreshing = true;
      fetchGutendexPageOnce(topicOrSearch, isSearch, page)
        .then(json => {
          const data = { results: Array.isArray(json.results) ? json.results : [], count: json.count || 0 };
          if (data.results.length > 0) {
            freeEbooksCache.set(cacheKey, { data, expires: Date.now() + FREE_EBOOKS_CACHE_TTL });
          } else {
            cached.refreshing = false; // keep serving old data, try again next request
          }
        })
        .catch(e => {
          cached.refreshing = false; // refresh failed — keep serving stale data, retry next request
          console.warn(`[free-ebooks] background refresh failed for ${cacheKey}:`, e && e.message ? e.message : e);
        });
    }
    return cached.data;
  }

  let json;
  let lastErr;
  const delays = [500, 1200, 2500];
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    try {
      json = await fetchGutendexPageOnce(topicOrSearch, isSearch, page);
      lastErr = null;
      break;
    } catch (e) {
      lastErr = e;
      const retryable = e.status === 429 || (e.status && e.status >= 500) || !e.status;
      if (!retryable || attempt === delays.length) break;
      await sleep(delays[attempt]);
    }
  }
  if (lastErr) throw lastErr;

  const data = { results: Array.isArray(json.results) ? json.results : [], count: json.count || 0 };
  if (data.results.length === 0) {
    console.warn(`[free-ebooks] topic/search="${topicOrSearch}" page=${page} returned 0 items`);
    return data; // don't cache empty pages — could be a transient Gutendex hiccup
  }
  freeEbooksCache.set(cacheKey, { data, expires: Date.now() + FREE_EBOOKS_CACHE_TTL });
  return data;
}

// The front end still speaks in "startIndex" (an item offset) and requests
// 20 items at a time, so this stitches together however many 32-book
// Gutendex pages are needed to cover [startIndex, startIndex+20) and slices
// out exactly the requested window.
async function fetchGutendexRange(topicOrSearch, isSearch, startIndex, count) {
  const endIndexExclusive = startIndex + count;
  const startPage = Math.floor(startIndex / GUTENDEX_PAGE_SIZE) + 1;
  const endPage = Math.floor((endIndexExclusive - 1) / GUTENDEX_PAGE_SIZE) + 1;

  let stitched = [];
  let totalCount = 0;
  for (let page = startPage; page <= endPage; page++) {
    const pageData = await fetchGutendexPage(topicOrSearch, isSearch, page);
    totalCount = pageData.count;
    if (pageData.results.length === 0) break; // ran off the end of the catalog for this topic
    stitched = stitched.concat(pageData.results);
  }
  const offsetInFirstPage = startIndex - (startPage - 1) * GUTENDEX_PAGE_SIZE;
  const slice = stitched.slice(offsetInFirstPage, offsetInFirstPage + count);
  return { items: slice.map(normalizeGutendexBook), totalItems: totalCount };
}

app.get('/api/free-ebook-categories', (req, res) => {
  res.json({ categories: FREE_EBOOK_CATEGORIES.map(c => ({ slug: c.slug, label: c.label })) });
});

// List/browse endpoint — one category (or a free-text search) at a time,
// paginated via startIndex so the front end can "load more" indefinitely.
app.get('/api/free-ebooks', async (req, res) => {
  try {
    const slug = (req.query.category || 'all').toString();
    const q = (req.query.q || '').toString().trim();
    const startIndex = Math.max(0, parseInt(req.query.startIndex, 10) || 0);
    let data;
    if (q) {
      data = await fetchGutendexRange(q, true, startIndex, 20);
    } else if (slug === 'all') {
      // Rotate through a different real topic every page of 20, so
      // "Load more" keeps cycling through a genuine mix.
      const page = Math.floor(startIndex / 20);
      const topic = ALL_MIX_TOPICS[page % ALL_MIX_TOPICS.length];
      const localStart = Math.floor(page / ALL_MIX_TOPICS.length) * 20;
      const topicData = await fetchGutendexRange(topic, false, localStart, 20);
      // Report a large-but-plausible total so "load more" keeps working
      // indefinitely instead of stopping after one topic's count.
      data = { items: topicData.items, totalItems: Math.max(topicData.totalItems, 1000) };
    } else {
      const cat = FREE_EBOOK_CATEGORIES.find(c => c.slug === slug) || FREE_EBOOK_CATEGORIES[1];
      data = await fetchGutendexRange(cat.topic, false, startIndex, 20);
    }
    res.json(data);
  } catch (e) {
    console.error('[free-ebooks] list fetch failed:', e && e.message ? e.message : e);
    res.status(500).json({ error: 'Could not load free eBooks right now.' });
  }
});

// Single-book detail — used by the book detail panel. Gutendex has no
// dedicated /books/:id/description-style field, so we surface subjects and
// bookshelves as the "about" text instead of a blurb.
app.get('/api/free-ebooks/:id', async (req, res) => {
  try {
    const id = req.params.id;
    const cacheKey = `detail::${id}`;
    const cached = freeEbooksCache.get(cacheKey);
    if (cached && cached.expires > Date.now()) return res.json(cached.data);

    const resp = await fetch(`${GUTENDEX_API}/${encodeURIComponent(id)}`, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; MindShiftBooks/1.0; +https://mindshiftbooks.shop)',
        'Accept': 'application/json'
      }
    });
    if (!resp.ok) return res.status(404).json({ error: 'Book not found' });
    const json = await resp.json();
    const book = normalizeGutendexBook(json);
    book.description = (json.subjects || []).length
      ? `Subjects: ${(json.subjects || []).slice(0, 6).join(', ')}`
      : '';
    const data = { book };
    freeEbooksCache.set(cacheKey, { data, expires: Date.now() + FREE_EBOOKS_CACHE_TTL });
    res.json(data);
  } catch (e) {
    console.error('[free-ebooks] detail fetch failed', e);
    res.status(500).json({ error: 'Could not load this book right now.' });
  }
});

// ---------------- FREE EBOOKS — on-domain reader (/read/:id) ----------------
// Opens the actual book at mindshiftbooks.shop/read/:id, never
// gutenberg.org, by fetching Gutenberg's file server-side and caching it to
// local disk on first request. Every request after that is served straight
// off our own disk — fast, and doesn't hammer Gutenberg's free servers.
// Download is intentionally not exposed yet — this is read-only.
const GUTENBERG_CACHE_DIR = path.join(__dirname, 'cache', 'gutenberg-reads');

function ensureCacheDir() {
  try { fs.mkdirSync(GUTENBERG_CACHE_DIR, { recursive: true }); } catch (e) { /* already exists */ }
}
ensureCacheDir();

// Builds the branded, paginated reader shell that wraps a book's raw content
// (either Gutenberg's own HTML or plain text, already normalized to an inner
// HTML string by the caller). Pagination is done with plain CSS columns —
// the content is laid out as N screen-width columns and JS slides between
// them with a transform, no external reader library needed. Works with
// whatever markup Gutenberg's files happen to contain.
function buildReaderShell({ bookId, title, bodyInner, extraHeadHtml, baseTag }) {
  const safeTitle = (title || 'Reading').replace(/</g, '&lt;');
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
${baseTag || ''}
<title>${safeTitle} — MindShift Books</title>
<link rel="icon" type="image/jpeg" href="https://mindshiftbooks.shop/MINDSHIFT.jpg">
<link rel="shortcut icon" type="image/jpeg" href="https://mindshiftbooks.shop/MINDSHIFT.jpg">
${extraHeadHtml || ''}
<style>
  html,body{margin:0;padding:0;}
  body{font-family:Georgia,'Times New Roman',serif;background:#faf9f5;color:#1c1c1c;-webkit-text-size-adjust:100%;}
  a{color:#4f46e5;}
  img{max-width:100%;height:auto;}
  .msb-reader-header{
    position:sticky;top:0;left:0;right:0;z-index:1000;height:52px;
    display:flex;align-items:center;gap:10px;padding:0 14px;
    background:linear-gradient(90deg,#4f46e5,#06b6d4);color:#fff;
    font-family:'Inter',system-ui,-apple-system,sans-serif;
    box-shadow:0 1px 6px rgba(0,0,0,.18);
  }
  .msb-reader-header .back{color:#fff;text-decoration:none;opacity:.95;display:flex;align-items:center;flex-shrink:0;}
  .msb-reader-header .back svg{width:19px;height:19px;}
  .msb-reader-header .logo{width:22px;height:22px;border-radius:5px;flex-shrink:0;background:#fff;}
  .msb-reader-header .title{font-weight:700;font-size:0.86rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:1;}
  .msb-reader-content{
    max-width:720px;margin:0 auto;box-sizing:border-box;
    padding:26px 22px 60px;font-size:17px;line-height:1.75;
  }
  .msb-reader-content h1,.msb-reader-content h2,.msb-reader-content h3{line-height:1.3;}
</style>
</head>
<body>
<div class="msb-reader-header">
  <a class="back" href="https://mindshiftbooks.shop/free-ebooks" aria-label="Back to Free eBooks">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"></polyline></svg>
  </a>
  <img class="logo" src="https://mindshiftbooks.shop/MINDSHIFT.jpg" alt="">
  <div class="title">${safeTitle}</div>
</div>
<div class="msb-reader-content">${bodyInner}</div>
</body>
</html>`;
}

// Wraps Gutenberg's own HTML file for the reader shell above. Extracts any
// <style> the file itself ships with (Gutenberg's converter often adds
// classes like i{font-style:italic} or .chapter{...}) and keeps it, since
// dropping it would break formatting the book actually relies on. A <base>
// tag points back at the file's original Gutenberg directory so relative
// images inside the file still load (the page URL itself stays on our
// domain — only background asset requests touch gutenberg.org, same as any
// site embedding external images).
function wrapGutenbergHtml(rawHtml, sourceUrl, title, bookId) {
  const baseDir = sourceUrl.slice(0, sourceUrl.lastIndexOf('/') + 1);
  const baseTag = `<base href="${baseDir}">`;

  const headMatch = rawHtml.match(/<head[^>]*>([\s\S]*?)<\/head>/i);
  const styleTags = headMatch ? (headMatch[1].match(/<style[\s\S]*?<\/style>/gi) || []) : [];

  const bodyMatch = rawHtml.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  const bodyInner = bodyMatch ? bodyMatch[1] : rawHtml;

  return buildReaderShell({
    bookId,
    title,
    bodyInner,
    extraHeadHtml: styleTags.join('\n'),
    baseTag
  });
}

function wrapPlainTextAsHtml(rawText, title, bookId) {
  const safeBody = rawText.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const bodyInner = `<pre style="white-space:pre-wrap;font-family:inherit;font-size:inherit;line-height:inherit;margin:0;">${safeBody}</pre>`;
  return buildReaderShell({ bookId, title, bodyInner });
}


app.get('/read/:id', async (req, res) => {
  const id = req.params.id.replace(/[^0-9]/g, '');
  if (!id) return res.status(400).send('Invalid book id.');
  // v6 = adds a favicon link — the reader shell had no <link rel="icon">
  // at all, so browser tabs fell back to the default globe icon instead of
  // our logo. Bumping this suffix is how old cached pages get replaced —
  // no purge job needed, they just become orphaned and the next request
  // writes a fresh v6 file instead.
  const cachePath = path.join(GUTENBERG_CACHE_DIR, `${id}.v6.html`);

  try {
    if (fs.existsSync(cachePath)) {
      res.set('Content-Type', 'text/html; charset=utf-8');
      return fs.createReadStream(cachePath).pipe(res);
    }

    const detailResp = await fetch(`${GUTENDEX_API}/${id}`, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; MindShiftBooks/1.0; +https://mindshiftbooks.shop)',
        'Accept': 'application/json'
      }
    });
    if (!detailResp.ok) return res.status(404).send('Book not found.');
    const detail = await detailResp.json();
    const formats = detail.formats || {};
    const htmlUrl = formats['text/html; charset=utf-8'] || formats['text/html'] || formats['text/html; charset=us-ascii'] || null;
    const textUrl = formats['text/plain; charset=utf-8'] || formats['text/plain'] || null;
    const sourceUrl = htmlUrl || textUrl;

    if (!sourceUrl) {
      return res.status(404).send('This title is only available as a download file, which isn\u2019t supported here yet.');
    }

    const fileResp = await fetch(sourceUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; MindShiftBooks/1.0; +https://mindshiftbooks.shop)' }
    });
    if (!fileResp.ok) return res.status(502).send('Could not load this book right now. Please try again.');
    const rawText = await fileResp.text();

    const html = htmlUrl
      ? wrapGutenbergHtml(rawText, sourceUrl, detail.title, id)
      : wrapPlainTextAsHtml(rawText, detail.title, id);

    ensureCacheDir();
    fs.writeFile(cachePath, html, 'utf8', (err) => {
      if (err) console.error('[read] cache write failed:', err.message);
    });

    res.set('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  } catch (e) {
    console.error('[read] failed to serve book', id, e && e.message ? e.message : e);
    res.status(500).send('Could not load this book right now. Please try again.');
  }
});

// /config endpoint for client (Paystack public key + optional publicPdf fallback)
app.get('/config', (req, res) => {
  return res.json({ paystackPublicKey: PAYSTACK_PUBLIC_KEY || null, publicPdfUrl: PUBLIC_PDF_URL || null });
});

// ---------- /api/track - first-party page-view beacon (no third-party pixels) ----------
// Fires from a tiny snippet on each page. No cookies, no IP storage, no
// cross-site identifiers — just a type + path + optional productId, so the
// admin dashboard can show views/downloads/purchases per book.
const TRACK_TYPES = new Set(['home', 'review', 'preview', 'page', 'affiliate_click']);
const AFFILIATE_COMMISSION_RATE = 0.15; // 15% of the actual NGN price paid, "ours" books only

// ---------------- Affiliate payouts (weekly, Monday, manual bank transfer) ----------------
const AFFILIATE_MIN_PAYOUT = 5000; // ₦5,000 minimum balance to be queued for a Monday payout
const PAYOUT_TIMEZONE = 'Africa/Lagos';

// Lagos is UTC+1 year-round (no DST), so this is a fixed offset — no need
// for a timezone library just to answer "what's 'today' in Lagos right now".
function lagosNow() {
  return new Date(Date.now() + 60 * 60 * 1000);
}

// "Next Monday" label shown on the affiliate dashboard. If it's currently
// Monday in Lagos, this still points at *next* Monday, since this week's
// batch (if any) has already been generated by the time anyone reads it.
function nextMondayISO() {
  const now = lagosNow();
  const day = now.getUTCDay(); // 0=Sun..6=Sat, computed against the shifted "Lagos" clock
  let daysAhead = (8 - day) % 7;
  if (daysAhead === 0) daysAhead = 7;
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + daysAhead));
  return next.toISOString().slice(0, 10);
}

// ISO week key (e.g. "2026-W08") used to make sure the Monday batch job
// only ever runs once per week, even if the server restarts multiple times
// on a Monday or the hourly check ticks more than once.
function isoWeekKey(date) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(weekNo).padStart(2, '0')}`;
}

// Scans every affiliate, queues a pending payout for anyone whose available
// balance (earned - paidOut - already-pending) has reached the ₦5,000
// minimum, and marks that amount as pending on their record so it isn't
// queued a second time next week. Safe to call more than once — affiliates
// already at ₦0 available are simply skipped.
async function generateWeeklyPayouts() {
  if (!db) return { generated: 0, totalAmount: 0 };
  const snap = await db.collection('affiliates').get();
  let generated = 0, totalAmount = 0;
  const batch = db.batch();
  const now = admin.firestore.Timestamp.now();

  snap.docs.forEach(doc => {
    const a = doc.data();
    const earned = a.earned || 0;
    const paidOut = a.paidOut || 0;
    const pendingPayout = a.pendingPayout || 0;
    const available = earned - paidOut - pendingPayout;
    if (available < AFFILIATE_MIN_PAYOUT) return;

    const payoutRef = db.collection('payouts').doc();
    batch.set(payoutRef, {
      affiliateCode: doc.id,
      affiliateName: a.name || 'Affiliate',
      amount: available,
      bank: a.bank || null,
      status: 'pending',
      createdAt: now
    });
    batch.update(doc.ref, {
      pendingPayout: admin.firestore.FieldValue.increment(available)
    });
    generated += 1;
    totalAmount += available;
  });

  if (generated > 0) await batch.commit();
  return { generated, totalAmount };
}

// Hourly check: if it's Monday in Lagos and this week's batch hasn't run
// yet, run it. Backed by a Firestore doc (not just an in-memory flag) so a
// server restart on a Monday doesn't trigger a duplicate batch.
async function maybeRunWeeklyPayoutCheck() {
  if (!db) return;
  try {
    const now = lagosNow();
    if (now.getUTCDay() !== 1) return; // only Mondays (Lagos-shifted clock)
    const weekKey = isoWeekKey(now);
    const stateRef = db.collection('meta').doc('payoutSchedule');
    const stateDoc = await stateRef.get();
    if (stateDoc.exists && stateDoc.data().lastRunWeek === weekKey) return;

    const result = await generateWeeklyPayouts();
    await stateRef.set({ lastRunWeek: weekKey, lastRunAt: admin.firestore.Timestamp.now(), lastRunResult: result }, { merge: true });
    console.log('[payouts] Monday batch generated:', result);
  } catch (err) {
    console.error('[payouts] weekly check failed', err);
  }
}

// Check on boot (covers "server happened to restart mid-Monday") and then
// every hour on the hour, roughly.
if (db) {
  maybeRunWeeklyPayoutCheck();
  setInterval(maybeRunWeeklyPayoutCheck, 60 * 60 * 1000);
}

app.post('/api/track', (req, res) => {
  // Always respond fast; analytics must never slow down or break the page.
  res.status(204).end();
  if (!db) return;
  try {
    const { type, path: p, productId, ref, affCode } = req.body || {};
    if (!TRACK_TYPES.has(type)) return;
    const payload = {
      type,
      path: typeof p === 'string' ? p.slice(0, 200) : null,
      productId: (productId && PRODUCTS[productId]) ? productId : null,
      ref: typeof ref === 'string' ? ref.slice(0, 300) : null,
      createdAt: admin.firestore.Timestamp.now()
    };
    if (type === 'affiliate_click' && typeof affCode === 'string' && affCode.trim()) {
      const code = affCode.trim().toUpperCase().slice(0, 40);
      payload.affCode = code;
      // Best-effort click counter on the affiliate doc itself — doesn't block
      // the response above, and a missing/invalid code just no-ops.
      db.collection('affiliates').doc(code).update({
        clicks: admin.firestore.FieldValue.increment(1)
      }).catch(() => null);
    }
    db.collection('events').add(payload).catch(() => null);
  } catch { /* ignore malformed beacons */ }
});

// ---------- /api/orders - return orders for an email (enriched) ----------
app.get('/api/orders', ordersLimiter, async (req, res) => {
  try {
    const email = (req.query.email || '').trim().toLowerCase();
    if (!email) return res.status(400).json({ error: 'Email is required' });
    // Basic email format check
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Invalid email address' });
    if (!db) return res.status(500).json({ error: 'Order lookup unavailable' });

    // Query Firestore for orders matching email
    const snap = await db.collection('my_order').where('email', '==', email).orderBy('paidAt', 'desc').get();
    const publicBase = process.env.PUBLIC_URL ? process.env.PUBLIC_URL.replace(/\/$/, '') : derivePublicUrl(req);
    const rows = [];
    snap.forEach(doc => {
      const d = doc.data();

      // Every order is normalized to an `items` array, whether it was a
      // single-book purchase (legacy schema) or a multi-book cart checkout.
      let items;
      if (Array.isArray(d.items) && d.items.length) {
        items = d.items.map(it => {
          const product = it.productId && PRODUCTS[it.productId];
          return {
            productId: it.productId || null,
            title: (product && product.title) || it.title || null,
            pdfUrl: it.pdfUrl || null,
            coverUrl: (product && product.coverPath) ? `${publicBase}/${product.coverPath.replace(/^\/+/, '')}` : null,
            priceUSD: it.priceUSD || null
          };
        });
      } else if (d.productId) {
        // legacy single-item order saved before the cart system existed
        const product = PRODUCTS[d.productId];
        items = [{
          productId: d.productId,
          title: (product && product.title) || d.productTitle || null,
          pdfUrl: d.pdfUrl || null,
          coverUrl: (product && product.coverPath) ? `${publicBase}/${product.coverPath.replace(/^\/+/, '')}` : null,
          priceUSD: d.usd_price || null
        }];
      } else {
        items = [];
      }

      rows.push({
        id: doc.id,
        reference: d.reference || doc.id,
        buyerName: d.buyerName || null,
        ngn_amount: d.ngn_amount || null,
        paidAt: d.paidAt ? d.paidAt.toDate ? d.paidAt.toDate().toISOString() : d.paidAt : null,
        items: items.map(it => ({
          ...it,
          pdfUrl: it.pdfUrl || (it.productId ? `/dl/${mintDownloadToken(it.productId)}` : null)
        }))
      });
    });

    return res.json({ count: rows.length, rows });
  } catch (err) {
    console.error('/api/orders error', err);
    return res.status(500).json({ error: 'Could not retrieve orders. Please try again.' });
  }
});

// ---------- Account endpoints (require a signed-in Firebase user) ----------

// Called once right after sign-up / sign-in. Creates the users/{uid} profile
// doc if it doesn't exist yet, and "claims" any past orders placed with the
// same email before the account existed — so order history isn't empty for
// people who bought before accounts were a thing.
app.post('/api/account/init', requireUser, async (req, res) => {
  try {
    if (!db) return res.status(500).json({ error: 'Database unavailable' });
    const { name, affCode } = req.body || {};
    const userRef = db.collection('users').doc(req.uid);

    // Referral attribution — looked up *before* the create() call so it can
    // be written atomically as part of the same doc, rather than a
    // follow-up update. Only ever applied on a genuinely new account: an
    // existing user calling this again (e.g. a later sign-in) never has
    // their referral changed, and self-referral (affiliate visiting their
    // own link) is explicitly rejected.
    let referralFields = {};
    if (affCode && typeof affCode === 'string' && affCode.trim()) {
      const code = affCode.trim().toUpperCase().slice(0, 40);
      const affDoc = await db.collection('affiliates').doc(code).get();
      if (affDoc.exists && affDoc.data().uid !== req.uid) {
        referralFields = { referredByCode: code, referredByName: affDoc.data().name || null };
      }
    }

    // Atomic "create if absent" — .create() fails with ALREADY_EXISTS if the
    // doc is already there, instead of the old get()-then-set() pattern
    // (read, then write) which had a race window: two concurrent requests
    // for the same brand-new uid could both read "doesn't exist yet" before
    // either had written, both treat it as a new account, and both fire the
    // welcome email. With .create(), only one of two racing requests can
    // ever win — the other lands in the catch block below as an existing
    // account, so exactly one welcome email goes out no matter how the
    // requests overlap.
    let isNewAccount = true;
    try {
      await userRef.create({
        email: req.userEmail,
        name: (name && String(name).trim().slice(0, 120)) || req.userName || null,
        createdAt: admin.firestore.Timestamp.now(),
        ...referralFields
      });
    } catch (createErr) {
      if (createErr.code === 6 /* ALREADY_EXISTS */ || /already exists/i.test(createErr.message || '')) {
        isNewAccount = false;
        if (name && String(name).trim()) {
          const existing = await userRef.get();
          if (!existing.data().name) {
            await userRef.update({ name: String(name).trim().slice(0, 120) });
          }
        }
      } else {
        throw createErr;
      }
    }

    // Credit the affiliate's signup counter — only once, only for a genuine
    // new account with a valid (non-self) referral code.
    if (isNewAccount && referralFields.referredByCode) {
      db.collection('affiliates').doc(referralFields.referredByCode).update({
        signups: admin.firestore.FieldValue.increment(1)
      }).catch(() => null);
    }

    // Claim legacy orders: any past `my_order` doc with a matching email but
    // no uid yet gets tagged with this account.
    if (req.userEmail) {
      const legacySnap = await db.collection('my_order').where('email', '==', req.userEmail).get();
      const toClaim = legacySnap.docs.filter(d => !d.data().uid);
      await Promise.all(toClaim.map(d => d.ref.update({ uid: req.uid }).catch(() => null)));
    }

    // Welcome email — only on the very first account/init call for this uid.
    // Fired after the response is queued, not awaited, so a slow/failed
    // Brevo call never delays sign-up.
    if (isNewAccount && req.userEmail) {
      sendWelcomeEmail(req.userEmail, (name && String(name).trim()) || req.userName || null);
    }

    return res.json({ ok: true });
  } catch (err) {
    console.error('/api/account/init error', err);
    return res.status(500).json({ error: 'Could not set up your account. Please try again.' });
  }
});

app.get('/api/account', requireUser, async (req, res) => {
  try {
    if (!db) return res.status(500).json({ error: 'Database unavailable' });
    const doc = await db.collection('users').doc(req.uid).get();
    const d = doc.exists ? doc.data() : {};
    return res.json({
      email: d.email || req.userEmail,
      name: d.name || req.userName || null,
      createdAt: d.createdAt ? (d.createdAt.toDate ? d.createdAt.toDate().toISOString() : d.createdAt) : null,
      referredByName: d.referredByName || null
    });
  } catch (err) {
    console.error('/api/account error', err);
    return res.status(500).json({ error: 'Could not load your details.' });
  }
});

app.patch('/api/account', requireUser, async (req, res) => {
  try {
    if (!db) return res.status(500).json({ error: 'Database unavailable' });
    const { name } = req.body || {};
    if (!name || !String(name).trim()) return res.status(400).json({ error: 'Name is required' });
    if (String(name).trim().length > 120) return res.status(400).json({ error: 'Name too long' });
    await db.collection('users').doc(req.uid).set({ name: String(name).trim() }, { merge: true });
    return res.json({ ok: true });
  } catch (err) {
    console.error('PATCH /api/account error', err);
    return res.status(500).json({ error: 'Could not update your details.' });
  }
});

// Order history for the signed-in account — replaces email-based lookup.
app.get('/api/my-orders', requireUser, async (req, res) => {
  try {
    if (!db) return res.status(500).json({ error: 'Order lookup unavailable' });
    const snap = await db.collection('my_order').where('uid', '==', req.uid).orderBy('paidAt', 'desc').get();
    const publicBase = process.env.PUBLIC_URL ? process.env.PUBLIC_URL.replace(/\/$/, '') : derivePublicUrl(req);
    const rows = [];
    snap.forEach(doc => {
      const d = doc.data();
      const items = Array.isArray(d.items) ? d.items : [];
      rows.push({
        id: doc.id,
        reference: d.reference || doc.id,
        buyerName: d.buyerName || null,
        ngn_amount: d.ngn_amount || null,
        paidAt: d.paidAt ? (d.paidAt.toDate ? d.paidAt.toDate().toISOString() : d.paidAt) : null,
        items: items.map(it => {
          const product = it.productId && PRODUCTS[it.productId];
          return {
            productId: it.productId || null,
            title: (product && product.title) || it.title || null,
            coverUrl: (product && product.coverPath) ? `${publicBase}/${product.coverPath.replace(/^\/+/, '')}` : (it.coverUrl || null),
            pdfUrl: it.productId ? `/dl/${mintDownloadToken(it.productId)}` : (it.pdfUrl || null)
          };
        })
      });
    });
    return res.json({ count: rows.length, rows });
  } catch (err) {
    console.error('/api/my-orders error', err);
    return res.status(500).json({ error: 'Could not retrieve your orders. Please try again.' });
  }
});

// Wishlist — stored server-side per account (users/{uid}.wishlist: string[]).
// Signed-out visitors don't get a wishlist at all (see auth gate on the
// client); everything here requires a valid Firebase session.
app.get('/api/wishlist', requireUser, async (req, res) => {
  try {
    if (!db) return res.status(500).json({ error: 'Database unavailable' });
    const doc = await db.collection('users').doc(req.uid).get();
    const ids = (doc.exists && Array.isArray(doc.data().wishlist)) ? doc.data().wishlist : [];
    return res.json({ ids });
  } catch (err) {
    console.error('/api/wishlist error', err);
    return res.status(500).json({ error: 'Could not load your wishlist.' });
  }
});

// Adds/removes a single book and returns the resulting state — uses
// arrayUnion/arrayRemove so two tabs toggling at once can't clobber each
// other the way a full-array overwrite could.
app.post('/api/wishlist/toggle', requireUser, async (req, res) => {
  try {
    if (!db) return res.status(500).json({ error: 'Database unavailable' });
    const productId = req.body && req.body.productId;
    if (!productId || typeof productId !== 'string') return res.status(400).json({ error: 'productId required' });
    if (!PRODUCTS[productId]) return res.status(404).json({ error: 'Unknown product' });

    const userRef = db.collection('users').doc(req.uid);
    const snap = await userRef.get();
    const current = (snap.exists && Array.isArray(snap.data().wishlist)) ? snap.data().wishlist : [];
    const inList = current.includes(productId);

    await userRef.set({
      wishlist: inList
        ? admin.firestore.FieldValue.arrayRemove(productId)
        : admin.firestore.FieldValue.arrayUnion(productId)
    }, { merge: true });

    return res.json({ ok: true, inWishlist: !inList });
  } catch (err) {
    console.error('/api/wishlist/toggle error', err);
    return res.status(500).json({ error: 'Could not update your wishlist. Please try again.' });
  }
});

// /api/pay - initialize Paystack for one or more products (cart checkout)
// Requires a signed-in account (browsing/preview stays public — only paying does not).
app.post('/api/pay', requireUser, payLimiter, async (req, res) => {
  try {
    const { email, name, productId, productIds } = req.body;
    if (!email) return res.status(400).json({ error: 'Email required' });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Invalid email address' });
    if (!name || !String(name).trim()) return res.status(400).json({ error: 'Name required' });
    if (String(name).trim().length > 120) return res.status(400).json({ error: 'Name too long' });

    // Accept either a single productId (legacy) or an array productIds (cart)
    let ids = Array.isArray(productIds) ? productIds : (productId ? [productId] : []);
    ids = [...new Set(ids.filter(Boolean))]; // dedupe
    if (!ids.length) return res.status(400).json({ error: 'productId or productIds required' });

    const products = ids.map(id => PRODUCTS[id]).filter(Boolean);
    if (products.length !== ids.length) return res.status(400).json({ error: 'One or more productIds are invalid' });

    // Use fixed NGN price if set, otherwise convert from USD via FX rate
    const fxRate = await getExchangeRate();

    const items = products.map(p => {
      const ngn = p.priceNGN
        ? Math.round(Number(p.priceNGN))
        : Math.round(Number(p.priceUSD || 0) * Number(fxRate));
      return { id: p.id, usd: p.priceUSD || null, ngn };
    });
    const usdTotal = products.reduce((sum, p) => sum + Number(p.priceUSD || 0), 0);
    const ngnAmount = items.reduce((sum, it) => sum + it.ngn, 0);

    console.log(`[PAY] products=${ids.join(',')} usdTotal=${usdTotal} fxRate=${fxRate} => ngnAmount=${ngnAmount}`);

    // buyer_name travels inside Paystack's own metadata (set at initialize time)
    // rather than the inline-popup metadata, since that's the copy that's
    // actually still attached to the transaction when we verify it later.
    const metadata = { productIds: ids, items, usd_total: usdTotal, fx_rate: fxRate, ngn_charged: ngnAmount, buyer_name: String(name).trim(), uid: req.uid };

    if (!PAYSTACK_SECRET_KEY) {
      const fakeRef = `TEST_REF_${Date.now()}`;
      if (db) {
        await db.collection('transactions').doc(fakeRef).set({
          reference: fakeRef, email, amount: ngnAmount, status: 'initialized',
          metadata,
          createdAt: admin.firestore.Timestamp.now()
        }).catch(()=>null);
      }
      return res.json({ authorization_url: null, reference: fakeRef, amount: ngnAmount });
    }

    const initResp = await fetch(`${PAYSTACK_BASE}/transaction/initialize`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email,
        amount: toKobo(ngnAmount),
        currency: 'NGN',
        metadata
      })
    });
    const initJson = await initResp.json().catch(()=>null);
    if (!initJson || initJson.status === false) return res.status(400).json({ error: initJson ? initJson.message : 'Paystack init failed', details: initJson });

    if (db) {
      await db.collection('transactions').doc(initJson.data.reference).set({
        reference: initJson.data.reference, email, amount: ngnAmount, status: 'initialized', metadata: initJson.data.metadata||metadata, createdAt: admin.firestore.Timestamp.now()
      }).catch(()=>null);
    }
    return res.json({ authorization_url: initJson.data.authorization_url, reference: initJson.data.reference, amount: ngnAmount });
  } catch (err) {
    console.error('/api/pay error', err);
    return res.status(500).json({ error: 'Payment initialization failed. Please try again.' });
  }
});

// /api/verify - verify payment and record + email download link(s)
app.post('/api/verify', payLimiter, async (req, res) => {
  try {
    const { reference, purchaserEmail } = req.body;
    if (!reference) return res.status(400).json({ error: 'Reference required' });
    // Sanitize reference — only alphanumeric and underscores/dashes
    if (!/^[a-zA-Z0-9_\-]+$/.test(reference)) return res.status(400).json({ error: 'Invalid reference format' });

    let verifyJson = null;
    if (!PAYSTACK_SECRET_KEY) {
      // Dev/test mode — no live key, simulate verification
      if (db) {
        const doc = await db.collection('transactions').doc(reference).get().catch(()=>null);
        const saved = doc && doc.exists ? doc.data() : {};
        verifyJson = { status: true, data: { reference, status: 'success', amount: saved.amount ? toKobo(saved.amount) : 0, customer: { email: purchaserEmail || saved.email || null }, metadata: saved.metadata || {} } };
      } else {
        verifyJson = { status: true, data: { reference, status: 'success', amount: 0, customer: { email: purchaserEmail || null }, metadata: {} } };
      }
    } else {
      const vresp = await fetch(`${PAYSTACK_BASE}/transaction/verify/${encodeURIComponent(reference)}`, { method: 'GET', headers: { Authorization: `Bearer ${PAYSTACK_SECRET_KEY}` } });
      verifyJson = await vresp.json().catch(()=>null);
    }

    if (!verifyJson || verifyJson.status !== true) return res.json({ status: 'failed', data: verifyJson });
    const tx = verifyJson.data;
    if (!tx || tx.status !== 'success') return res.json({ status: 'failed', data: verifyJson });

    // SECURITY: always use Paystack's verified email — never trust a client-supplied one
    const userEmail = (tx.customer && tx.customer.email) || null;
    if (!userEmail) return res.status(400).json({ error: 'Could not determine buyer email from payment provider' });

    const metadata = tx.metadata || {};
    const buyerName = (metadata.custom_fields && metadata.custom_fields.find(f => f.variable_name === 'buyer_name')?.value) || purchaserEmail && purchaserEmail.split('@')[0] || null;

    // Support both the new cart metadata (productIds array) and the old
    // single-product metadata (productId) for transactions already in flight.
    const productIds = Array.isArray(metadata.productIds) && metadata.productIds.length
      ? metadata.productIds
      : (metadata.productId ? [metadata.productId] : []);

    const publicBase = process.env.PUBLIC_URL ? process.env.PUBLIC_URL.replace(/\/$/, '') : derivePublicUrl(req);
    const ngnAmountPaid = (tx.amount || 0) / 100;
    const usdTotal = metadata.usd_total || metadata.usd_price || 0;

    const items = productIds.map(id => {
      const product = PRODUCTS[id];
      if (!product) return null;
      const token = mintDownloadToken(product.id);
      return {
        productId: product.id,
        title: product.title,
        token,
        pdfUrl: `${publicBase}/dl/${token}`,
        coverUrl: product.coverPath ? `${publicBase}/${product.coverPath.replace(/^\/+/, '')}` : null,
        priceUSD: product.priceUSD
      };
    }).filter(Boolean);

    const record = {
      reference: tx.reference,
      email: userEmail,
      buyerName,
      uid: metadata.uid || null,
      status: 'success',
      usd_total: usdTotal,
      ngn_amount: ngnAmountPaid,
      fx_rate: metadata.fx_rate || null,
      items: items.map(it => ({ productId: it.productId, title: it.title, pdfUrl: it.pdfUrl, coverUrl: it.coverUrl })),
      paidAt: admin.firestore ? admin.firestore.Timestamp.now() : new Date()
    };

    // Affiliate commission — 15% of the actual NGN price paid, and only on
    // "ours" books (Amazon-linked "featured" books never reach this
    // endpoint at all, since that sale happens off-site). Uses
    // metadata.items, which carries the exact per-item ngn amount charged
    // at checkout — so a 50%-off book credits 15% of the discounted price,
    // never the original sticker price. Looked up from the buyer's own
    // account (set once, first-touch, back when they signed up) — not from
    // anything the buyer could tamper with at checkout time.
    let affiliateCode = null;
    let commissionAmount = 0;
    if (db && metadata.uid) {
      try {
        const buyerDoc = await db.collection('users').doc(metadata.uid).get();
        const code = buyerDoc.exists ? buyerDoc.data().referredByCode : null;
        if (code) {
          const metaItems = Array.isArray(metadata.items) ? metadata.items : [];
          const eligibleNgn = metaItems.reduce((sum, it) => {
            const product = PRODUCTS[it.id];
            return (product && product.category === 'ours') ? sum + Number(it.ngn || 0) : sum;
          }, 0);
          if (eligibleNgn > 0) {
            affiliateCode = code;
            commissionAmount = Math.round(eligibleNgn * AFFILIATE_COMMISSION_RATE);
          }
        }
      } catch (e) { /* commission lookup is best-effort — never block the order */ }
    }
    if (affiliateCode) {
      record.affiliateCode = affiliateCode;
      record.affiliateCommission = commissionAmount;
    }

    if (db) {
      await db.collection('my_order').add(record).catch(() => null);
      if (affiliateCode && commissionAmount > 0) {
        db.collection('affiliates').doc(affiliateCode).update({
          sales: admin.firestore.FieldValue.increment(1),
          earned: admin.firestore.FieldValue.increment(commissionAmount)
        }).catch(() => null);
      }
      await db.collection('transactions').doc(tx.reference).set({
        reference: tx.reference, email: userEmail, amount: ngnAmountPaid,
        status: 'success', paidAt: admin.firestore.Timestamp.now()
      }, { merge: true }).catch(() => null);
    }

    if (BREVO_API_KEY && userEmail && items.length) {
      try {
        const bookNames = items.map(it => it.title).filter(Boolean).join(', ');
        // If your Brevo template only has one {{ params.download_link }} merge
        // tag, this concatenates "Title: url" pairs on separate lines so nothing
        // gets lost for multi-book orders. {{ params.items_html }} is the one the
        // new email template actually uses — a styled row per book with its own
        // download button, so it looks right whether it's 1 book or several.
        const downloadLinks = items.length === 1
          ? items[0].pdfUrl
          : items.map(it => `${it.title}: ${it.pdfUrl}`).join('\n');

        // Paystack's verify-transaction response includes `channel` and `paid_at`
        // when a real key is configured; the dev-mode fallback above doesn't set
        // these, so we degrade gracefully instead of asserting a method we don't know.
        const channelLabels = {
          card: 'Card', bank: 'Bank Account', bank_transfer: 'Bank Transfer',
          ussd: 'USSD', qr: 'QR', mobile_money: 'Mobile Money', eft: 'EFT'
        };
        const paymentMethodDisplay = channelLabels[tx.channel] || 'Online payment';
        const paidAtDisplay = new Date(tx.paid_at || tx.paidAt || Date.now())
          .toLocaleString('en-NG', { day: '2-digit', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' });

        const itemsHtml = items.map((it, idx) => `
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0;">
            <tr>
              <td style="padding:14px 0;${idx > 0 ? 'border-top:1px solid #eef2f7;' : ''}">
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                  <tr>
                    ${it.coverUrl ? `
                    <td style="width:44px;padding-right:12px;vertical-align:middle;">
                      <img src="${it.coverUrl}" width="44" alt="${it.title}" style="display:block;width:44px;border-radius:6px;border:1px solid #eef2f7;">
                    </td>` : ''}
                    <td style="vertical-align:middle;">
                      <div style="font-family:'Inter',Arial,sans-serif;font-weight:700;font-size:14.5px;color:#0f172a;">${it.title}</div>
                      <div style="font-family:'Inter',Arial,sans-serif;font-size:12px;color:#94a3b8;padding-top:2px;">PDF &middot; eBook</div>
                    </td>
                    <td align="right" style="white-space:nowrap;vertical-align:middle;">
                      <a href="${it.pdfUrl}" style="background-color:#4f46e5;background-image:linear-gradient(90deg,#4f46e5,#06b6d4);color:#ffffff;text-decoration:none;font-family:'Inter',Arial,sans-serif;font-weight:700;font-size:12.5px;padding:9px 16px;border-radius:999px;display:inline-block;">Download</a>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
          </table>
        `).join('');

        const amountPaidDisplay = `₦${Number(ngnAmountPaid).toLocaleString()}`;

        const emailPayload = {
          sender: { name: BREVO_SENDER_NAME, email: BREVO_SENDER_EMAIL },
          to: [{ email: userEmail, name: buyerName || undefined }],
          templateId: BREVO_TEMPLATE_ID,
          params: {
            buyer_name: buyerName || 'there',
            book_name: bookNames || 'Mindshift Books purchase',
            download_link: downloadLinks,
            items_html: itemsHtml,
            amount_paid: amountPaidDisplay,
            payment_method: paymentMethodDisplay,
            paid_at: paidAtDisplay,
            reference: tx.reference
          }
        };

        const emailRes = await fetch('https://api.brevo.com/v3/smtp/email', {
          method: 'POST',
          headers: {
            accept: 'application/json',
            'api-key': BREVO_API_KEY,
            'content-type': 'application/json'
          },
          body: JSON.stringify(emailPayload)
        });
        const txt = await emailRes.text().catch(()=>null);
        if (!emailRes.ok) console.error('Brevo email error', emailRes.status, txt);
      } catch (e) { console.warn('Brevo email send failed', e.message || e); }
    }

    return res.json({ status: 'success', data: { reference: record.reference, buyerName: record.buyerName, items: record.items } });
  } catch (err) {
    console.error('/api/verify error', err);
    return res.status(500).json({ error: 'Payment verification failed. Please contact support.' });
  }
});

// Preview pages — explicit routes so SPA fallback doesn't catch them
app.get('/gcwa-preview', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'gcwa-preview.html'));
});

app.get('/escape-preview', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'escape-preview.html'));
});

app.get('/mmg-preview', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'mmg-preview.html'));
});

app.get('/tda-preview', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'tda-preview.html'));
});

// Other pages — explicit clean routes (no .html in the URL)
app.get('/review', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'review.html'));
});

// Wishlist page — book list is built client-side from localStorage + /api/products
app.get('/wishlist', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'wishlist.html'));
});

// /my-order is the old email-lookup page — permanently point it at the new
// account-based page so old links/bookmarks still land somewhere useful.
app.get('/my-order', (req, res) => {
  res.redirect(301, '/account');
});

app.get('/account', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'account.html'));
});

app.get('/login', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.get('/signup', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'signup.html'));
});

app.get('/welcome', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'welcome.html'));
});

app.get('/affiliate', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'affiliate.html'));
});

app.get('/affiliate/apply', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'affiliate-apply.html'));
});

app.get('/affiliate/dashboard', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'affiliate-dashboard.html'));
});

app.get('/affiliate/payout', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'payout.html'));
});

app.get('/free-ebooks', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'free-ebooks.html'));
});

app.get('/support', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'support.html'));
});

app.get('/legal', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'legal.html'));
});

// ---------- Admin dashboard (branded login page + signed session cookie) ----------
// Both admin/login.html and admin/dashboard.html live OUTSIDE `public/`, so
// they're never reachable via the static file server — only through these
// auth-gated routes.
const adminLoginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: 'Too many login attempts, please try again later.' },
  standardHeaders: true,
  legacyHeaders: false
});

app.get('/admin/login', (req, res) => {
  if (!ADMIN_PASSWORD) return res.status(503).type('text/plain').send('Admin dashboard not configured. Set ADMIN_PASSWORD on the server.');
  if (hasValidAdminSession(req)) return res.redirect('/admin');
  res.sendFile(path.join(__dirname, 'admin', 'login.html'));
});

app.post('/admin/login', adminLoginLimiter, (req, res) => {
  if (!ADMIN_PASSWORD) return res.status(503).json({ error: 'Admin dashboard not configured.' });
  const { username, password } = req.body || {};
  if (!checkAdminCredentials(username, password)) {
    return res.status(401).json({ error: 'Incorrect username or password.' });
  }
  const token = mintAdminSession();
  res.setHeader('Set-Cookie', `ms_admin=${token}; HttpOnly; Secure; SameSite=Lax; Max-Age=${ADMIN_SESSION_MAX_AGE}; Path=/`);
  return res.json({ ok: true });
});

app.get('/admin/logout', (req, res) => {
  res.setHeader('Set-Cookie', 'ms_admin=; HttpOnly; Secure; SameSite=Lax; Max-Age=0; Path=/');
  res.redirect('/admin/login');
});

app.get('/admin', requireAdminPage, (req, res) => {
  res.sendFile(path.join(__dirname, 'admin', 'dashboard.html'));
});

app.use('/api/admin', requireAdminApi);

// GET /api/admin/summary?days=30 — pageviews, downloads, and purchases,
// each broken down per book, for the last N days.
const AFFILIATE_ECOSYSTEM_PATHS = new Set(['/affiliate', '/affiliate/apply', '/affiliate/dashboard', '/affiliate/payout']);

app.get('/api/admin/summary', async (req, res) => {
  try {
    if (!db) return res.status(500).json({ error: 'Database unavailable' });
    const days = Math.min(Math.max(parseInt(req.query.days, 10) || 30, 1), 365);
    const since = admin.firestore.Timestamp.fromDate(new Date(Date.now() - days * 24 * 60 * 60 * 1000));

    const eventsSnap = await db.collection('events').where('createdAt', '>=', since).get();

    const pageviewsByPath = {};
    const reviewViewsByProduct = {};
    const previewViewsByProduct = {};
    const downloadsByProduct = {};
    let totalPageviews = 0;
    let totalDownloads = 0;
    let affiliateEcosystemViews = 0;

    eventsSnap.forEach(doc => {
      const d = doc.data();
      if (d.type === 'download') {
        totalDownloads++;
        if (d.productId) downloadsByProduct[d.productId] = (downloadsByProduct[d.productId] || 0) + 1;
        return;
      }
      totalPageviews++;
      const p = d.path || 'unknown';
      pageviewsByPath[p] = (pageviewsByPath[p] || 0) + 1;
      if (AFFILIATE_ECOSYSTEM_PATHS.has(p)) affiliateEcosystemViews++;
      if (d.type === 'review' && d.productId) {
        reviewViewsByProduct[d.productId] = (reviewViewsByProduct[d.productId] || 0) + 1;
      }
      if (d.type === 'preview' && d.productId) {
        previewViewsByProduct[d.productId] = (previewViewsByProduct[d.productId] || 0) + 1;
      }
    });

    const ordersSnap = await db.collection('my_order').where('paidAt', '>=', since).get();
    const purchasesByProduct = {};
    let totalOrders = 0;
    let totalRevenueNgn = 0;
    ordersSnap.forEach(doc => {
      const d = doc.data();
      totalOrders++;
      totalRevenueNgn += Number(d.ngn_amount || 0);
      (d.items || []).forEach(it => {
        if (!it.productId) return;
        purchasesByProduct[it.productId] = (purchasesByProduct[it.productId] || 0) + 1;
      });
    });

    // Affiliates who joined within this same date range, plus the running
    // lifetime total — the stat card shows lifetime (it's a "how many have
    // signed up ever" number), but rangeDays is included in case that's
    // ever useful on the frontend too.
    const affiliatesCountSnap = await db.collection('affiliates').count().get();
    const totalAffiliates = affiliatesCountSnap.data().count;
    const newAffiliatesSnap = await db.collection('affiliates').where('createdAt', '>=', since).count().get();
    const newAffiliates = newAffiliatesSnap.data().count;

    const withTitles = map => Object.entries(map)
      .map(([id, count]) => ({ productId: id, title: (PRODUCTS[id] && PRODUCTS[id].title) || id, count }))
      .sort((a, b) => b.count - a.count);

    res.json({
      rangeDays: days,
      totals: {
        pageviews: totalPageviews, downloads: totalDownloads, orders: totalOrders, revenueNgn: totalRevenueNgn,
        affiliateEcosystemViews, totalAffiliates, newAffiliates
      },
      topPages: Object.entries(pageviewsByPath).map(([path, count]) => ({ path, count })).sort((a, b) => b.count - a.count).slice(0, 20),
      reviewViews: withTitles(reviewViewsByProduct),
      previewViews: withTitles(previewViewsByProduct),
      downloads: withTitles(downloadsByProduct),
      purchases: withTitles(purchasesByProduct)
    });
  } catch (err) {
    console.error('/api/admin/summary error', err);
    res.status(500).json({ error: 'Could not load stats' });
  }
});

// GET /api/admin/affiliates — every affiliate, most-earned first, for the
// admin dashboard's Affiliates tab.
app.get('/api/admin/affiliates', async (req, res) => {
  try {
    if (!db) return res.status(500).json({ error: 'Database unavailable' });
    const snap = await db.collection('affiliates').get();
    const affiliates = snap.docs.map(d => {
      const a = d.data();
      const pendingPayout = a.pendingPayout || 0;
      return {
        code: d.id,
        name: a.name, email: a.email, phone: a.phone, platform: a.platform, handle: a.handle,
        status: a.status || 'active', broadcastOptOut: !!a.broadcastOptOut,
        bank: a.bank || null,
        clicks: a.clicks || 0, signups: a.signups || 0, sales: a.sales || 0,
        earned: a.earned || 0, paidOut: a.paidOut || 0, pendingPayout,
        outstanding: Math.max(0, (a.earned || 0) - (a.paidOut || 0)),
        availableBalance: Math.max(0, (a.earned || 0) - (a.paidOut || 0) - pendingPayout),
        createdAt: a.createdAt ? (a.createdAt.toDate ? a.createdAt.toDate().toISOString() : a.createdAt) : null
      };
    }).sort((a, b) => b.outstanding - a.outstanding);
    return res.json({ affiliates });
  } catch (err) {
    console.error('/api/admin/affiliates error', err);
    return res.status(500).json({ error: 'Could not load affiliates' });
  }
});

// ---------------- Admin: weekly payout queue ----------------

// GET /api/admin/payouts?status=pending — the Monday payout queue for the
// admin's dedicated Payouts page. Defaults to pending only; ?status=all
// returns everything (for a full history view).
app.get('/api/admin/payouts', async (req, res) => {
  try {
    if (!db) return res.status(500).json({ error: 'Database unavailable' });
    const status = String(req.query.status || 'pending');
    // Sorted in JS rather than orderBy()+where() on different fields, so
    // this never needs a manually-created Firestore composite index.
    const snap = await db.collection('payouts').orderBy('createdAt', 'desc').limit(300).get();
    const filteredDocs = status === 'all' ? snap.docs : snap.docs.filter(d => (d.data().status || 'pending') === status);
    const payouts = filteredDocs.map(d => {
      const p = d.data();
      return {
        id: d.id,
        affiliateCode: p.affiliateCode,
        affiliateName: p.affiliateName,
        amount: p.amount || 0,
        bank: p.bank || null,
        status: p.status || 'pending',
        createdAt: p.createdAt ? (p.createdAt.toDate ? p.createdAt.toDate().toISOString() : p.createdAt) : null,
        paidAt: p.paidAt ? (p.paidAt.toDate ? p.paidAt.toDate().toISOString() : p.paidAt) : null,
        processedBy: p.processedBy || null
      };
    });
    return res.json({ payouts });
  } catch (err) {
    console.error('/api/admin/payouts error', err);
    return res.status(500).json({ error: 'Could not load payouts' });
  }
});

// POST /api/admin/payouts/generate — manually trigger this week's batch
// (the Monday check also runs this automatically; this is a fallback for
// when the server was asleep/restarting right at the scheduled time).
app.post('/api/admin/payouts/generate', async (req, res) => {
  try {
    const result = await generateWeeklyPayouts();
    return res.json({ ok: true, ...result });
  } catch (err) {
    console.error('/api/admin/payouts/generate error', err);
    return res.status(500).json({ error: 'Could not generate payouts' });
  }
});

// POST /api/admin/payouts/:id/mark-paid — call this ONLY after the admin
// has actually sent the bank transfer. Moves the payout from pending to
// paid, stamps who processed it and when, and settles the affiliate's
// balance: paidOut goes up, pendingPayout comes back down by the same
// amount, so the money isn't counted as "owed" anymore anywhere.
app.post('/api/admin/payouts/:id/mark-paid', async (req, res) => {
  try {
    if (!db) return res.status(500).json({ error: 'Database unavailable' });
    const id = String(req.params.id || '');
    const ref = db.collection('payouts').doc(id);
    const doc = await ref.get();
    if (!doc.exists) return res.status(404).json({ error: 'Payout not found' });
    const p = doc.data();
    if (p.status === 'paid') return res.json({ ok: true, alreadyPaid: true });

    const paidAt = admin.firestore.Timestamp.now();
    await ref.update({ status: 'paid', paidAt, processedBy: ADMIN_USER });
    await db.collection('affiliates').doc(p.affiliateCode).update({
      paidOut: admin.firestore.FieldValue.increment(p.amount || 0),
      pendingPayout: admin.firestore.FieldValue.increment(-(p.amount || 0))
    });
    return res.json({ ok: true, paidAt: paidAt.toDate().toISOString(), processedBy: ADMIN_USER });
  } catch (err) {
    console.error('/api/admin/payouts/:id/mark-paid error', err);
    return res.status(500).json({ error: 'Could not update payout status' });
  }
});

// ---------------- Admin: affiliate broadcast ----------------

// POST /api/admin/affiliate-broadcast/upload-image — takes the banner image
// the dashboard just read locally as a base64 data URI, hosts it on
// Cloudinary, and hands back a real https:// URL. This is what makes the
// image actually render (and be downloadable/long-press-savable) in the
// sent email — a data: URI embedded straight in the HTML gets stripped by
// Gmail and most other mail clients.
app.post('/api/admin/affiliate-broadcast/upload-image', async (req, res) => {
  try {
    const dataUrl = String((req.body && req.body.imageDataUrl) || '');
    if (!/^data:image\/(jpeg|png|webp|gif);base64,/.test(dataUrl)) {
      return res.status(400).json({ error: 'Expected a JPG, PNG, WEBP, or GIF image.' });
    }
    const result = await uploadBannerImageToCloudinary(dataUrl);
    if (!result.ok) return res.status(502).json({ error: result.error || 'Upload failed.' });
    return res.json({ ok: true, url: result.url });
  } catch (err) {
    console.error('/api/admin/affiliate-broadcast/upload-image error', err);
    return res.status(500).json({ error: 'Could not upload image' });
  }
});

// POST /api/admin/affiliate-broadcast/test — sends the composed email to a
// single inbox (defaults to the store's own sender address) so it can be
// checked for real before it goes out to every affiliate.
app.post('/api/admin/affiliate-broadcast/test', async (req, res) => {
  try {
    const { content, error } = buildBroadcastContent(req.body);
    if (error) return res.status(400).json({ error });
    const testEmail = (String(req.body && req.body.testEmail || '').trim()) || BREVO_SENDER_EMAIL;
    const result = await sendAffiliateBroadcastEmail({ email: testEmail, name: 'Test', code: 'TESTCODE' }, content);
    if (!result.ok) return res.status(502).json({ error: result.error || 'Send failed.' });
    return res.json({ ok: true, sentTo: testEmail });
  } catch (err) {
    console.error('/api/admin/affiliate-broadcast/test error', err);
    return res.status(500).json({ error: 'Could not send test email' });
  }
});

// Shared by both the broadcast and promo-kit send endpoints: resolves who
// gets the email. recipientCode === 'all' (or omitted) sends to every
// active, non-opted-out affiliate; any other value is treated as one
// specific affiliate's code, so the admin can send a single test-in-context
// email — e.g. to re-send to one person whose first copy bounced — without
// blasting the whole list.
async function resolveBroadcastRecipients(recipientCode) {
  const snap = await db.collection('affiliates').get();
  const all = snap.docs.map(d => ({ code: d.id, ...d.data() }));
  if (recipientCode && recipientCode !== 'all') {
    const one = all.find(a => a.code === recipientCode);
    if (!one) return { error: `No affiliate found with code "${recipientCode}".` };
    if (!one.email) return { error: 'That affiliate has no email on file.' };
    return { recipients: [one] };
  }
  return { recipients: all.filter(a => a.email && a.status === 'active' && !a.broadcastOptOut) };
}

// POST /api/admin/affiliate-broadcast — sends to every active affiliate who
// hasn't opted out, or to a single affiliate when recipientCode is set.
// Sends in small batches with a short pause between them so a large list
// doesn't slam Brevo's rate limit all at once.
app.post('/api/admin/affiliate-broadcast', async (req, res) => {
  try {
    if (!db) return res.status(500).json({ error: 'Database unavailable' });
    const { content, error } = buildBroadcastContent(req.body);
    if (error) return res.status(400).json({ error });

    const { recipients, error: recipientError } = await resolveBroadcastRecipients(req.body && req.body.recipientCode);
    if (recipientError) return res.status(400).json({ error: recipientError });

    if (!recipients.length) return res.json({ ok: true, sent: 0, failed: 0, total: 0 });

    const BATCH_SIZE = 5;
    let sent = 0;
    const failures = [];
    for (let i = 0; i < recipients.length; i += BATCH_SIZE) {
      const batch = recipients.slice(i, i + BATCH_SIZE);
      const results = await Promise.all(batch.map(a => sendAffiliateBroadcastEmail(a, content)));
      results.forEach((r, idx) => {
        if (r.ok) sent++; else failures.push({ email: batch[idx].email, error: r.error });
      });
      if (i + BATCH_SIZE < recipients.length) await new Promise(r => setTimeout(r, 400));
    }

    console.log(`Affiliate broadcast by ${ADMIN_USER}: ${sent}/${recipients.length} sent — "${content.headline}"`);
    return res.json({ ok: true, sent, failed: failures.length, total: recipients.length, failures: failures.slice(0, 10) });
  } catch (err) {
    console.error('/api/admin/affiliate-broadcast error', err);
    return res.status(500).json({ error: 'Could not send broadcast' });
  }
});

// POST /api/admin/promo-kit/send — sends the fixed-content "Wave 1" promo
// kit email (Brevo template 6). Body: { recipientCode: 'all' | '<code>' },
// or { testEmail: '...' } to send a single test copy to any inbox first.
app.post('/api/admin/promo-kit/send', async (req, res) => {
  try {
    if (!db) return res.status(500).json({ error: 'Database unavailable' });

    const testEmail = String((req.body && req.body.testEmail) || '').trim();
    if (testEmail || (req.body && req.body.testEmail === '')) {
      const to = testEmail || BREVO_SENDER_EMAIL;
      const result = await sendAffiliatePromoKitEmail({ email: to, name: 'Test', code: 'TESTCODE' });
      if (!result.ok) return res.status(502).json({ error: result.error || 'Send failed.' });
      return res.json({ ok: true, sent: 1, failed: 0, total: 1, sentTo: to });
    }

    const { recipients, error: recipientError } = await resolveBroadcastRecipients(req.body && req.body.recipientCode);
    if (recipientError) return res.status(400).json({ error: recipientError });
    if (!recipients.length) return res.json({ ok: true, sent: 0, failed: 0, total: 0 });

    const BATCH_SIZE = 5;
    let sent = 0;
    const failures = [];
    for (let i = 0; i < recipients.length; i += BATCH_SIZE) {
      const batch = recipients.slice(i, i + BATCH_SIZE);
      const results = await Promise.all(batch.map(a => sendAffiliatePromoKitEmail(a)));
      results.forEach((r, idx) => {
        if (r.ok) sent++; else failures.push({ email: batch[idx].email, error: r.error });
      });
      if (i + BATCH_SIZE < recipients.length) await new Promise(r => setTimeout(r, 400));
    }

    console.log(`Promo kit send by ${ADMIN_USER}: ${sent}/${recipients.length} sent`);
    return res.json({ ok: true, sent, failed: failures.length, total: recipients.length, failures: failures.slice(0, 10) });
  } catch (err) {
    console.error('/api/admin/promo-kit/send error', err);
    return res.status(500).json({ error: 'Could not send promo kit email' });
  }
});

// Structured data endpoint — Google uses this for rich results / image search
app.get('/schema/:productId', (req, res) => {
  const product = PRODUCTS[req.params.productId];
  if (!product) return res.status(404).json({ error: 'Not found' });
  const publicBase = process.env.PUBLIC_URL || 'https://mindshiftbooks.shop';
  const schema = {
    '@context': 'https://schema.org',
    '@type': 'Book',
    name: product.title,
    author: { '@type': 'Person', name: product.author || 'MindShift Books' },
    publisher: { '@type': 'Organization', name: 'MindShift Books', url: publicBase },
    image: product.coverPath ? `${publicBase}/${product.coverPath}` : undefined,
    description: product.description || undefined,
    inLanguage: product.language || 'en',
    numberOfPages: product.pages || undefined,
    genre: product.genre || undefined,
    offers: {
      '@type': 'Offer',
      priceCurrency: 'NGN',
      price: product.priceNGN || 0,
      availability: 'https://schema.org/InStock',
      url: `${publicBase}/review?id=${product.id}`
    }
  };
  res.setHeader('Content-Type', 'application/ld+json');
  res.json(schema);
});

// 404 handler — must be last, after all other routes
app.use((req, res) => {
  res.status(404).sendFile(path.join(__dirname, 'public', '404.html'));
});

// SPA fallback for index.html
app.get('*', (req, res, next) => {
  if (req.method === 'GET' && req.headers.accept && req.headers.accept.indexOf('text/html') !== -1) {
    const p = req.path || '';
    if (p.startsWith('/api') || p.startsWith('/files') || p.startsWith('/images') || p.startsWith('/dl/')) return next();
    return res.sendFile(path.join(__dirname, 'public', 'index.html'));
  }
  return next();
});

app.listen(PORT, () => {
  console.log(`MindShift Books server running on port ${PORT}`);
  console.log(`Serving static: ${path.join(__dirname,'public')} and ${path.join(__dirname,'files')}`);

  // Pre-warm the free-eBooks cache right after boot, so the very first
  // visitor doesn't wait on a cold external call to Gutendex. This covers
  // both the homepage swiper and the /free-ebooks page's "All" tab, since
  // both hit the exact same underlying query (topic "fiction", page 1).
  fetchGutendexRange('fiction', false, 0, 20)
    .then(() => console.log('[free-ebooks] cache warmed on startup'))
    .catch(e => console.warn('[free-ebooks] startup warm-up failed (non-fatal):', e && e.message ? e.message : e));
});
