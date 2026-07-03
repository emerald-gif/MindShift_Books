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

const app = express();
const PORT = process.env.PORT || 3000;

// ── Security headers (helmet) ──────────────────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: false, // CSP managed separately if needed
  crossOriginEmbedderPolicy: false
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

app.use(bodyParser.json({ limit: '100kb' })); // tightened from 1mb — no endpoint needs that much
app.use(bodyParser.urlencoded({ extended: true, limit: '100kb' }));

// Clean URLs: redirect any request that still ends in .html to the extension-less version
app.get(/\.html$/, (req, res, next) => {
  const clean = req.path.replace(/\.html$/, '') || '/';
  const qs = req.url.slice(req.path.length); // preserves ?query
  return res.redirect(301, clean + qs);
});

// Serve static assets (public folder only — /files is NOT served statically)
app.use(express.static(path.join(__dirname, 'public')));

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
const BREVO_TEMPLATE_ID = Number(process.env.BREVO_TEMPLATE_ID || 1); // single template, id 1
const BREVO_SENDER_NAME = process.env.BREVO_SENDER_NAME || 'Mindshift Books';
const BREVO_SENDER_EMAIL = process.env.BREVO_SENDER_EMAIL || 'contact@mindshiftbooks.shop';

function toKobo(ngn) { return Math.round(Number(ngn) * 100); }

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
  'getting-clients-without-ads': {
    id: 'getting-clients-without-ads',
    title: 'Getting Client Without Ads',
    priceUSD: null,
    priceNGN: 7500,
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
    priceNGN: 7500,
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
    description: 'Your environment is not your background. It is the structure shaping every decision you make, every ambition you carry, and every ceiling you are willing to accept — most of the time without you ever noticing. Escape Your Environment Or Become It makes the invisible architecture visible and gives you the complete framework for changing it — whether your environment is actively working against you, or simply failing to push you forward. Change your environment. Change your life.'
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

// /config endpoint for client (Paystack public key + optional publicPdf fallback)
app.get('/config', (req, res) => {
  return res.json({ paystackPublicKey: PAYSTACK_PUBLIC_KEY || null, publicPdfUrl: PUBLIC_PDF_URL || null });
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

// /api/pay - initialize Paystack for one or more products (cart checkout)
app.post('/api/pay', payLimiter, async (req, res) => {
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
    const metadata = { productIds: ids, items, usd_total: usdTotal, fx_rate: fxRate, ngn_charged: ngnAmount, buyer_name: String(name).trim() };

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
      status: 'success',
      usd_total: usdTotal,
      ngn_amount: ngnAmountPaid,
      fx_rate: metadata.fx_rate || null,
      items: items.map(it => ({ productId: it.productId, title: it.title, pdfUrl: it.pdfUrl, coverUrl: it.coverUrl })),
      paidAt: admin.firestore ? admin.firestore.Timestamp.now() : new Date()
    };

    if (db) {
      await db.collection('my_order').add(record).catch(() => null);
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

// Other pages — explicit clean routes (no .html in the URL)
app.get('/review', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'review.html'));
});

app.get('/my-order', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'my-order.html'));
});

app.get('/support', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'support.html'));
});

app.get('/legal', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'legal.html'));
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
});
