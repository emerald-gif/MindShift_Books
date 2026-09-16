// server/affiliate.js
// User-facing affiliate program routes: apply, dashboard data, bank-details
// OTP flow, and payout history. Moved out of server.js as-is — no logic
// changed, only relocated + wrapped in a Router. Admin-side affiliate
// routes (payout generation, the Affiliates tab, broadcast/promo-kit
// sends) stay in server.js for now — those move into server/admin.js next.
const express = require('express');
const fetch = require('node-fetch');
const crypto = require('crypto');
const {
  admin, db,
  BREVO_API_KEY, BREVO_SENDER_NAME, BREVO_SENDER_EMAIL,
  requireUser,
  nextMondayISO, AFFILIATE_MIN_PAYOUT,
  _adminReadCache
} = require('./shared');

const router = express.Router();

// Brevo template IDs used only by this file.
const BREVO_BANK_OTP_TEMPLATE_ID = Number(process.env.BREVO_BANK_OTP_TEMPLATE_ID || 3); // bank-details-change verification code
const BREVO_AFFILIATE_WELCOME_TEMPLATE_ID = Number(process.env.BREVO_AFFILIATE_WELCOME_TEMPLATE_ID || 4); // successful affiliate onboarding

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
// /api/affiliate/apply). Fire-and-forget — a failed send here shouldn't
// fail the application itself, since the affiliate record is already live.
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

// GET /api/affiliate/code-info/:code — public, no auth. Used only to show
// "Referred by [Name]" on the signup page — deliberately returns just the
// display name, nothing else about the affiliate.
router.get('/api/affiliate/code-info/:code', async (req, res) => {
  try {
    if (!db) return res.json({ name: null });
    const code = String(req.params.code || '').toUpperCase().slice(0, 40);
    const doc = await db.collection('affiliates').doc(code).get();
    return res.json({ name: doc.exists ? (doc.data().name || null) : null });
  } catch (err) {
    return res.json({ name: null });
  }
});

router.post('/api/affiliate/apply', requireUser, async (req, res) => {
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
    _adminReadCache.delete('affiliates:all'); // new affiliate — don't make admin wait out the cache to see it
    sendAffiliateWelcomeEmail(req.userEmail, record.name, code);
    return res.json({ code, ...record });
  } catch (err) {
    console.error('/api/affiliate/apply error', err);
    return res.status(500).json({ error: 'Could not set up your affiliate account. Please try again.' });
  }
});

router.get('/api/affiliate/me', requireUser, async (req, res) => {  try {
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

router.post('/api/affiliate/bank/otp', requireUser, async (req, res) => {
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
// window is currently open, so there's no request anyone can craft that
// skips the emailed code.
router.post('/api/affiliate/bank/otp/verify', requireUser, async (req, res) => {
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
// /api/affiliate/bank/otp/verify above — checked purely off the affiliate's
// own doc, never off anything the client sends.
router.put('/api/affiliate/bank', requireUser, async (req, res) => {
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
router.get('/api/affiliate/payouts', requireUser, async (req, res) => {
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

module.exports = router;
