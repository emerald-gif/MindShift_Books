// server.js
// MindShift Books - Single source of truth for products + Paystack endpoints
// Install: npm i express node-fetch firebase-admin cors body-parser
const express = require('express');
const path = require('path');
const fetch = require('node-fetch');
const cors = require('cors');
const bodyParser = require('body-parser');
const admin = require('firebase-admin');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(bodyParser.json({ limit: '1mb' }));
app.use(bodyParser.urlencoded({ extended: true }));

// Serve static assets
app.use(express.static(path.join(__dirname, 'public')));
app.use('/files', express.static(path.join(__dirname, 'files')));

// Firebase admin init (SERVICE_ACCOUNT_JSON or ADC)
try {
  if (process.env.SERVICE_ACCOUNT_JSON) {
    const serviceAccount = JSON.parse(process.env.SERVICE_ACCOUNT_JSON);
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
    console.log('firebase-admin initialized from SERVICE_ACCOUNT_JSON');
  } else {
    admin.initializeApp();
    console.log('firebase-admin initialized from ADC/default credentials');
  }
} catch (e) {
  console.warn('firebase-admin init warning:', e.message || e);
}
const db = admin.firestore ? admin.firestore() : null;

// Paystack / email config
const PAYSTACK_BASE = 'https://api.paystack.co';
const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY || null;
const PAYSTACK_PUBLIC_KEY = process.env.PAYSTACK_PUBLIC_KEY || null;
const PUBLIC_PDF_URL = process.env.PUBLIC_PDF_URL || null;

// Brevo (formerly Sendinblue) transactional email config
const BREVO_API_KEY = process.env.BREVO_API_KEY || null; // set this in your environment
const BREVO_TEMPLATE_ID = Number(process.env.BREVO_TEMPLATE_ID || 1); // single template, id 1
const BREVO_SENDER_NAME = process.env.BREVO_SENDER_NAME || 'Mindshift Books';
const BREVO_SENDER_EMAIL = process.env.BREVO_SENDER_EMAIL || 'contact@mindshiftbooks.online';

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
    priceUSD: 9.99, // placeholder price — change to whatever you want to charge
    coverPath: 'gcwa.jpg',
    pdfPath: 'files/Getting_Clients_Without_Ads.pdf',
    reviewImages: [], // no reviews yet, add later
    category: 'ours',
    author: 'MindShift Books',
    genre: 'Business & Marketing',
    language: 'English',
    // Placeholder — swap in your real description/sales copy whenever you're ready.
    description: 'A practical, step-by-step guide to landing paying clients through organic outreach, positioning, and relationship-building — without spending a dime on paid ads.'
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
      cover: p.coverPath,
      reviewImages: p.reviewImages || [],
      hasPdf: !!p.pdfPath,
      category: p.category || 'featured',
      author: p.author || null,
      genre: p.genre || null,
      language: p.language || 'English',
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
      cover: p.coverPath,
      reviewImages: p.reviewImages || [],
      hasPdf: !!p.pdfPath,
      category: p.category || 'featured',
      author: p.author || null,
      genre: p.genre || null,
      language: p.language || 'English',
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
app.get('/api/orders', async (req, res) => {
  try {
    const email = (req.query.email || '').trim().toLowerCase();
    if (!email) return res.status(400).json({ error: 'Email is required' });
    if (!db) return res.status(500).json({ error: 'Firestore not configured' });

    // Query Firestore for orders matching email
    const snap = await db.collection('my_order').where('email', '==', email).orderBy('paidAt', 'desc').get();
    const rows = [];
    snap.forEach(doc => {
      const d = doc.data();

      // Every order is normalized to an `items` array, whether it was a
      // single-book purchase (legacy schema) or a multi-book cart checkout.
      let items;
      if (Array.isArray(d.items) && d.items.length) {
        items = d.items.map(it => ({
          productId: it.productId || null,
          title: (it.productId && PRODUCTS[it.productId] && PRODUCTS[it.productId].title) || it.title || null,
          pdfUrl: it.pdfUrl || null,
          priceUSD: it.priceUSD || null
        }));
      } else if (d.productId) {
        // legacy single-item order saved before the cart system existed
        items = [{
          productId: d.productId,
          title: (PRODUCTS[d.productId] && PRODUCTS[d.productId].title) || d.productTitle || null,
          pdfUrl: d.pdfUrl || null,
          priceUSD: d.usd_price || null
        }];
      } else {
        items = [];
      }

      rows.push({
        id: doc.id,
        ...d,
        items
      });
    });

    return res.json({ count: rows.length, rows });
  } catch (err) {
    console.error('/api/orders error', err);
    return res.status(500).json({ error: err.message || 'Server error' });
  }
});

// /api/pay - initialize Paystack for one or more products (cart checkout)
app.post('/api/pay', async (req, res) => {
  try {
    const { email, name, productId, productIds } = req.body;
    if (!email) return res.status(400).json({ error: 'Email required' });
    if (!name || !String(name).trim()) return res.status(400).json({ error: 'Name required' });

    // Accept either a single productId (legacy) or an array productIds (cart)
    let ids = Array.isArray(productIds) ? productIds : (productId ? [productId] : []);
    ids = [...new Set(ids.filter(Boolean))]; // dedupe
    if (!ids.length) return res.status(400).json({ error: 'productId or productIds required' });

    const products = ids.map(id => PRODUCTS[id]).filter(Boolean);
    if (products.length !== ids.length) return res.status(400).json({ error: 'One or more productIds are invalid' });

    // NEW: Get fxRate via helper with env override, live lookup, fallback 1500
    const fxRate = await getExchangeRate();

    const items = products.map(p => ({
      id: p.id,
      usd: p.priceUSD,
      ngn: Math.round(Number(p.priceUSD) * Number(fxRate))
    }));
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
    return res.status(500).json({ error: err.message || 'Server error' });
  }
});

// /api/verify - verify payment and record + email download link(s)
app.post('/api/verify', async (req, res) => {
  try {
    const { reference, purchaserEmail } = req.body;
    if (!reference) return res.status(400).json({ error: 'Reference required' });

    let verifyJson = null;
    if (!PAYSTACK_SECRET_KEY) {
      // simulate
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

    const userEmail = purchaserEmail || (tx.customer && tx.customer.email) || null;
    const metadata = tx.metadata || {};
    const buyerName = metadata.buyer_name || null;

    // Support both the new cart metadata (productIds array) and the old
    // single-product metadata (productId) for transactions already in flight.
    const productIds = Array.isArray(metadata.productIds) && metadata.productIds.length
      ? metadata.productIds
      : (metadata.productId ? [metadata.productId] : []);

    const publicBase = process.env.PUBLIC_URL ? process.env.PUBLIC_URL.replace(/\/$/, '') : derivePublicUrl(req);

    const items = productIds.map(id => {
      const product = PRODUCTS[id];
      if (!product) return null;
      return {
        productId: product.id,
        title: product.title,
        pdfUrl: `${publicBase}/${product.pdfPath.replace(/^\/+/, '')}`,
        priceUSD: product.priceUSD
      };
    }).filter(Boolean);

    const ngnAmountPaid = (tx.amount || 0) / 100;
    const usdTotal = metadata.usd_total || metadata.usd_price || items.reduce((sum, it) => sum + Number(it.priceUSD || 0), 0);

    const record = {
      reference: tx.reference,
      email: userEmail,
      buyerName,
      status: 'success',
      usd_total: usdTotal,
      ngn_amount: ngnAmountPaid,
      fx_rate: metadata.fx_rate || null,
      paystack: tx,
      items,
      paidAt: admin.firestore ? admin.firestore.Timestamp.now() : new Date()
    };

    if (db) {
      await db.collection('my_order').add(record).catch(()=>null);
      await db.collection('transactions').doc(tx.reference).set({ reference: tx.reference, email: userEmail, amount: ngnAmountPaid, status: 'success', paidAt: admin.firestore.Timestamp.now() }, { merge: true }).catch(()=>null);
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

        const itemsHtml = items.map(it => `
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 12px 0;">
            <tr>
              <td style="background-color:#f8fafc;border-radius:10px;padding:14px 16px;">
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                  <tr>
                    <td style="font-family:'Inter',Arial,sans-serif;font-weight:700;font-size:15px;color:#0f172a;">${it.title}</td>
                    <td align="right" style="white-space:nowrap;">
                      <a href="${it.pdfUrl}" style="background-color:#4f46e5;background-image:linear-gradient(90deg,#4f46e5,#06b6d4);color:#ffffff;text-decoration:none;font-family:'Inter',Arial,sans-serif;font-weight:700;font-size:13px;padding:10px 18px;border-radius:8px;display:inline-block;">Download</a>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
          </table>
        `).join('');

        const emailPayload = {
          sender: { name: BREVO_SENDER_NAME, email: BREVO_SENDER_EMAIL },
          to: [{ email: userEmail, name: buyerName || undefined }],
          templateId: BREVO_TEMPLATE_ID,
          params: {
            buyer_name: buyerName || 'there',
            book_name: bookNames || 'Mindshift Books purchase',
            download_link: downloadLinks,
            items_html: itemsHtml,
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

    return res.json({ status: 'success', data: record });
  } catch (err) {
    console.error('/api/verify error', err);
    return res.status(500).json({ error: err.message || 'Server error' });
  }
});

// debug listing (optional)
app.get('/debug/orders', async (req, res) => {
  if (!db) return res.status(400).json({ error: 'No Firestore configured' });
  try {
    const snap = await db.collection('my_order').orderBy('paidAt','desc').limit(100).get();
    const out = [];
    snap.forEach(d => out.push({ id: d.id, ...d.data() }));
    res.json({ count: out.length, orders: out });
  } catch (e) { res.status(500).json({ error: e.message || 'Server error' }); }
});

// SPA fallback for index.html
app.get('*', (req, res, next) => {
  if (req.method === 'GET' && req.headers.accept && req.headers.accept.indexOf('text/html') !== -1) {
    const p = req.path || '';
    if (p.startsWith('/api') || p.startsWith('/files') || p.startsWith('/images')) return next();
    return res.sendFile(path.join(__dirname, 'public', 'index.html'));
  }
  return next();
});

app.listen(PORT, () => {
  console.log(`MindShift Books server running on port ${PORT}`);
  console.log(`Serving static: ${path.join(__dirname,'public')} and ${path.join(__dirname,'files')}`);
});
