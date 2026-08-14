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
    priceNGN: 6000,
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

// /config endpoint for client (Paystack public key + optional publicPdf fallback)
app.get('/config', (req, res) => {
  return res.json({ paystackPublicKey: PAYSTACK_PUBLIC_KEY || null, publicPdfUrl: PUBLIC_PDF_URL || null });
});

// ---------- /api/track - first-party page-view beacon (no third-party pixels) ----------
// Fires from a tiny snippet on each page. No cookies, no IP storage, no
// cross-site identifiers — just a type + path + optional productId, so the
// admin dashboard can show views/downloads/purchases per book.
const TRACK_TYPES = new Set(['home', 'review', 'preview', 'page']);
app.post('/api/track', (req, res) => {
  // Always respond fast; analytics must never slow down or break the page.
  res.status(204).end();
  if (!db) return;
  try {
    const { type, path: p, productId, ref } = req.body || {};
    if (!TRACK_TYPES.has(type)) return;
    db.collection('events').add({
      type,
      path: typeof p === 'string' ? p.slice(0, 200) : null,
      productId: (productId && PRODUCTS[productId]) ? productId : null,
      ref: typeof ref === 'string' ? ref.slice(0, 300) : null,
      createdAt: admin.firestore.Timestamp.now()
    }).catch(() => null);
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

app.get('/mmg-preview', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'mmg-preview.html'));
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

    const withTitles = map => Object.entries(map)
      .map(([id, count]) => ({ productId: id, title: (PRODUCTS[id] && PRODUCTS[id].title) || id, count }))
      .sort((a, b) => b.count - a.count);

    res.json({
      rangeDays: days,
      totals: { pageviews: totalPageviews, downloads: totalDownloads, orders: totalOrders, revenueNgn: totalRevenueNgn },
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
});
