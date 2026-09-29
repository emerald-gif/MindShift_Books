// server/bookstore.js
// The eBook store's catalog + free library: product catalog, gated PDF
// downloads, the free-ebooks (Gutendex/Project Gutenberg) system and its
// on-domain reader, book preview pages, /config, and the schema.org SEO
// endpoint. Moved out of server.js as-is — no logic changed, only
// relocated + wrapped in a Router.
//
// NOT included yet (deliberately, next pass): /api/pay, /api/verify,
// /api/orders, /api/my-orders, /api/wishlist*, /api/challenge*,
// /api/rewards* — these touch real money and account data and are being
// pulled out on their own, more carefully, once this piece is proven safe
// in production.
//
// PRODUCTS is exported because server.js (still) and the eventual
// admin.js both need it — admin's dashboard summary looks up product
// titles by id. mintDownloadToken is exported for the same reason:
// /api/orders and /api/my-orders (still in server.js) mint fresh download
// links using it.
const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const fetch = require('node-fetch');
const { admin, db, PROJECT_ROOT, PAYSTACK_PUBLIC_KEY, PUBLIC_PDF_URL } = require('./shared');

const router = express.Router();

// ----------------- BOOK PREVIEW HELPERS -----------------
// One general page (server/preview-template.html) serves every book's free preview,
// the same way review.html serves every book's details page. Per-book copy
// (badge, intro, locked-section text, bullets, PDF, page limit) lives in the
// `preview` block on each product below — no per-book HTML files.
function publicPreview(p) {
  const v = p && p.preview;
  if (!v || !v.pdf) return null;
  return {
    pdf: v.pdf,
    maxPages: v.maxPages || null,
    badge: v.badge || null,
    intro: v.intro || null,
    locked: v.locked || null,
    bullets: Array.isArray(v.bullets) ? v.bullets : []
  };
}
function previewUrlFor(p) {
  return publicPreview(p) ? '/preview?id=' + encodeURIComponent(p.id) : null;
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
    // Free preview — rendered by the ONE general page (server/preview-template.html).
    // To add a preview for another book, just add a block like this.
    preview: {
      slug: "tda", // keeps the old /tda-preview URL working
      pdf: "/tda-preview.pdf",
      intro: "Read the opening chapter and see the exact system for building follow-through before you buy.",
      locked: "The rest of the book — the full system for building discipline that runs on autopilot — is waiting for you inside the full version.",
      bullets: [
        "The full system for making discipline automatic (remaining chapters)",
        "How to design your environment so the right action becomes easier",
        "How to recover after falling off without losing a month",
      ],
    },
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
    // Free preview — rendered by the ONE general page (server/preview-template.html).
    preview: {
      slug: "gcwa", // keeps the old /gcwa-preview URL working
      pdf: "/gcwa-preview.pdf",
      maxPages: 15, // only show the first N pages
      ogImage: "og-gcwa.jpg",
      intro: "Read the opening chapter. See exactly why this approach works before you buy.",
      locked: "The rest of the book — the exact strategies, scripts, and step-by-step system — is waiting for you inside the full version.",
      bullets: [
        "The full positioning system (Chapter 2–4)",
        "Word-for-word outreach scripts that actually get replies",
        "How to close without feeling salesy",
      ],
    },
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
    // Free preview — rendered by the ONE general page (server/preview-template.html).
    preview: {
      slug: "escape", // keeps the old /escape-preview URL working
      pdf: "/escape-preview.pdf",
      ogImage: "og-escape.jpg",
      intro: "Read the opening chapter. See exactly why your environment matters more than your willpower — before you buy.",
      locked: "The rest of the book — the full framework for auditing and rebuilding the environment around you — is waiting for you inside the full version.",
      bullets: [
        "The full framework for auditing your environment (remaining chapters)",
        "Step-by-step exercises to identify who and what is shaping you",
        "How to deliberately engineer surroundings that pull you forward",
      ],
    },
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
    // Free preview — rendered by the ONE general page (server/preview-template.html).
    preview: {
      slug: "mmg", // keeps the old /mmg-preview URL working
      pdf: "/mmg-preview.pdf",
      intro: "Read the opening chapter and see the money mindset framework for yourself before you buy.",
      locked: "The rest of the book — the full framework for closing your own money mindset gap — is waiting for you inside the full version.",
      bullets: [
        "The full framework for closing your money mindset gap (remaining chapters)",
        "Step-by-step exercises to identify your own money blocks",
        "How to rebuild the beliefs that shape your financial decisions",
      ],
    },
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

  'broke-confused-and-trying': {
    id: 'broke-confused-and-trying',
    title: 'Broke, Confused & Trying',
    priceUSD: null,
    priceNGN: 1000,
    originalPriceNGN: 2000,
    coverPath: 'bct.jpg',
    pdfPath: 'public/files/Broke_Confused_Trying.pdf',
    // Free preview — rendered by the ONE general page (server/preview-template.html).
    preview: {
      slug: "bct", // keeps the old /bct-preview URL working
      pdf: "/bct-preview.pdf",
      intro: "Read the opening chapter and see the goal + deadline + plan + action formula for yourself before you buy.",
      locked: "The remaining 9 situations — and the full goal + deadline + plan + action formula applied to each one — are waiting for you inside the full version.",
      bullets: [
        "9 more real situations — JAMB Brain vs Life Brain, Japa or Stay, Broke But Building, and more",
        "The full goal + deadline + plan + action formula applied to each one",
        "How to take the smallest useful first step on your own goals",
      ],
    },
    reviewImages: [],
    category: 'ours',
    author: 'MindShift Books',
    genre: 'Personal Development',
    language: 'English',
    pages: 60,
    description: `BROKE, CONFUSED & TRYING

10 Real Situations Where You Have No Idea What To Do Next — And a Simple Formula to Get Moving Anyway

You're not lazy. You're not lost. You're just standing in one of those moments where the next step isn't obvious, and everyone around you seems to have theirs figured out.

JAMB Brain vs Life Brain. Japa or Stay. Broke But Building. The exam that decides nothing and everything. The relationship you can't tell if you should leave. The job offer that pays less than your worth but teaches you more than your pride can admit.

Broke, Confused & Trying takes ten of the most common situations young Nigerians actually get stuck in, and applies one simple formula to each: Goal. Deadline. Plan. Action.

No vague motivation. No "just believe in yourself." Just a repeatable way to turn "I have no idea what to do" into a next step you can actually take today.

Inside, you'll work through:

The goal + deadline + plan + action formula, explained once and then applied ten times so it actually sticks
JAMB Brain vs Life Brain — why the thinking that got you through school breaks down the moment school ends
Japa or Stay — how to make the decision without pretending it's simple
Broke But Building — what to actually do with ambition when the money isn't there yet
Seven more real situations pulled straight from what young people are genuinely stuck on right now

This isn't a book about becoming a different person. It's about getting unstuck in the specific situation you're in right now — with a plan you can start on before you finish reading.

BROKE. CONFUSED. STILL TRYING. THAT'S ENOUGH TO START.`
  },

  'when-god-feels-silent': {
    id: 'when-god-feels-silent',
    title: 'When God Feels Silent',
    priceUSD: null,
    priceNGN: 1500,
    originalPriceNGN: 2000,
    coverPath: 'wgfs.jpg',
    pdfPath: 'public/files/When_God_Feels_Silent.pdf',
    // Free preview — rendered by the ONE general page (server/preview-template.html).
    preview: {
      slug: "wgfs", // keeps the old /wgfs-preview URL working
      pdf: "/wgfs-preview.pdf",
      badge: "📖 Free Preview — Preface & Chapters 1–2",
      intro: "Read the Preface, Chapter 1, and the start of Chapter 2 — a companion for the seasons when prayer feels like it's hitting a ceiling.",
      locked: "Chapters 3–8, Final Words, and the full Appendix of verses for hard days are waiting for you inside the complete book.",
      bullets: [
        "6 more chapters — doubt, waiting, comparison, and what silence is not",
        "Final Words, plus four small practices for staying in a season with no end date",
        "A one-page appendix of verses for hard days",
      ],
    },
    reviewImages: [], // no reviews yet, add later
    category: 'ours',
    author: 'MindShift Books',
    genre: 'Faith & Spirituality',
    language: 'English',
    pages: 24,
    description: `WHEN GOD FEELS SILENT

A Companion For The Seasons When Prayer Hits The Ceiling And Heaven Feels Far

There is a specific kind of pain that doesn't come from what God has said, but from what He hasn't. You prayed. You waited. And then — nothing. No verse that leapt off the page. No word from a friend that felt like it was meant for you. Just the quiet.

When God Feels Silent will not try to explain your particular silence away. It isn't a formula, and this ache doesn't resolve in five steps. What it offers instead is company — Scripture's own record of people who waited, grieved, doubted, and stayed anyway — and a handful of small, honest practices for staying close to God in a season that doesn't come with a finish line.

Each chapter follows the same shape: a real ache named plainly, a table clearing away common misunderstandings, a story from Scripture worth sitting with, a short reflection, and a small close — one verse, one prayer — for today specifically, not for the whole season at once.

Inside, you'll sit with:

When Heaven Feels Quiet — the difference between God's absence and God's silence
The Grief That Doesn't Explain Itself — why not every loss resolves into a tidy lesson
The Prayer That Never Got An Answer — what to do with a prayer that's been open for years
When Doubt Feels Like Betrayal — the difference between doubt and unbelief
The Company Of The Waiting — David, Hannah, and Joseph's long, undocumented seasons of waiting
Comparing Your Silence To Someone Else's Noise — what a public testimony usually leaves out
What Silence Is Not — clearing away punishment, abandonment, and disqualification
Learning To Stay — four small, repeatable practices for a season with no end date

Plus a one-page appendix of verses for hard days, so you always have somewhere to turn without hunting through chapters.

This Book Is For You If...

You're in a season where prayer feels like it's hitting a ceiling.
Grief hasn't resolved into anything tidy.
Doubt has started to feel like betrayal.
God — who used to feel close — has started to feel quiet.

This isn't a book about making the silence make sense today. You are not asked to resolve it. You are only asked to stay while it lasts.

YOU ARE NOT ALONE IN THE QUIET.`
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
router.get('/dl/:token', (req, res) => {
  const productId = validateDownloadToken(req.params.token);
  if (!productId) {
    return res.status(403).type('text/plain').send('Invalid download link. Go to My Orders to get a fresh one.');
  }
  const product = PRODUCTS[productId];
  if (!product || !product.pdfPath) {
    return res.status(404).type('text/plain').send('File not found.');
  }
  const filePath = path.join(PROJECT_ROOT, product.pdfPath);
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
router.get('/api/products', (req, res) => {
  try {
    const out = Object.values(PRODUCTS).map(p => ({
      id: p.id,
      title: p.title,
      priceUSD: p.priceUSD || null,
      priceNGN: p.priceNGN || null,
      originalPriceNGN: p.originalPriceNGN || null,
      cover: p.coverPath,
      reviewImages: p.reviewImages || [],
      previewUrl: previewUrlFor(p),
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
router.get('/api/product/:id', (req, res) => {
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
      previewUrl: previewUrlFor(p),
      hasPdf: !!p.pdfPath,
      category: p.category || 'featured',
      author: p.author || null,
      genre: p.genre || null,
      language: p.language || 'English',
      pages: p.pages || null,
      description: p.description || null,
      preview: publicPreview(p),
      externalUrl: p.externalUrl || null
    };
    return res.json({ product: out });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Server error' });
  }
});

// ---------------- FREE EBOOKS (curated Project Gutenberg catalog) ----------------
// Real, actually-free public-domain books shown in our own UI, curated to
// MindShift's niche (mindset, money, productivity, purpose...) instead of a
// general-purpose library. We never host the files — /read/:id fetches the
// book from gutenberg.org server-side and caches it on our own disk.
//
// The catalog itself is a static JSON file (data/free-ebooks-catalog.json)
// generated OFF Render by scripts/sync-free-ebooks.js. Render's outbound IPs
// get a Cloudflare 403 from gutendex.com, so the server never calls
// Gutendex at all — it just reads the JSON at boot and filters it in memory.
const FREE_EBOOK_CATEGORIES = [
  { slug: 'all',           label: 'All',           code: null },
  { slug: 'mindset',       label: 'Mindset',       code: 'MINDSET' },
  { slug: 'money',         label: 'Money',         code: 'MONEY' },
  { slug: 'productivity',  label: 'Productivity',  code: 'PRODUCTIVITY' },
  { slug: 'relationships', label: 'Relationships', code: 'RELATIONSHIPS' },
  { slug: 'health',        label: 'Health',        code: 'HEALTH' },
  { slug: 'career',        label: 'Career',        code: 'CAREER' },
  { slug: 'education',     label: 'Education',     code: 'EDUCATION' },
  { slug: 'purpose',       label: 'Purpose',       code: 'PURPOSE' },
  { slug: 'reflective',    label: 'Reflective',    code: 'REFLECTIVE' },
  { slug: 'fiction',       label: 'Fiction',       code: 'FICTION' }
];
const CAT_LABEL_BY_CODE = FREE_EBOOK_CATEGORIES.reduce((m, c) => { if (c.code) m[c.code] = c.label; return m; }, {});

const FREE_CATALOG_PATH = path.join(PROJECT_ROOT, 'data', 'free-ebooks-catalog.json');
const FREE_PAGE_SIZE = 20;

// Only used if the catalog JSON hasn't been generated/deployed yet, so the
// page still shows something real instead of an empty state.
const FALLBACK_BOOKS = [
  { id: 4507,  title: 'As a Man Thinketh',                      author: 'James Allen',          cats: ['MINDSET', 'PURPOSE'],            downloads: 8 },
  { id: 59844, title: 'The Science of Getting Rich',            author: 'Wallace D. Wattles',   cats: ['MONEY', 'MINDSET'],              downloads: 7 },
  { id: 34258, title: 'Acres of Diamonds',                      author: 'Russell H. Conwell',   cats: ['MONEY', 'CAREER'],               downloads: 6 },
  { id: 132,   title: 'The Art of War',                         author: 'Sun Tzu',              cats: ['CAREER', 'PRODUCTIVITY'],        downloads: 5 },
  { id: 1232,  title: 'The Prince',                             author: 'Niccolò Machiavelli',  cats: ['CAREER'],                        downloads: 4 },
  { id: 2680,  title: 'Meditations',                            author: 'Marcus Aurelius',      cats: ['PURPOSE', 'REFLECTIVE'],         downloads: 3 },
  { id: 205,   title: 'Walden',                                 author: 'Henry David Thoreau',  cats: ['REFLECTIVE', 'PURPOSE'],         downloads: 2 },
  { id: 148,   title: 'The Autobiography of Benjamin Franklin', author: 'Benjamin Franklin',    cats: ['MONEY', 'PRODUCTIVITY'],         downloads: 1 }
];

function gutenbergCoverUrl(id) {
  return `https://www.gutenberg.org/cache/epub/${id}/pg${id}.cover.medium.jpg`;
}

function normalizeCatalogBook(e) {
  const cats = Array.isArray(e.cats) ? e.cats : [];
  const subjects = Array.isArray(e.subjects) ? e.subjects : [];
  return {
    id: e.id,
    title: e.title || 'Untitled',
    authors: [e.author || 'Unknown Author'],
    author: e.author || 'Unknown Author',
    description: subjects.length ? `Subjects: ${subjects.slice(0, 6).join(', ')}` : '',
    cover: gutenbergCoverUrl(e.id),
    categories: subjects.slice(0, 3),
    cats,
    tag: cats.length ? (CAT_LABEL_BY_CODE[cats[0]] || '') : '',
    language: 'en',
    pageCount: null,
    publishedDate: null,
    downloadCount: e.downloads || 0,
    readLink: `/read/${e.id}`,
    _search: `${e.title || ''} ${e.author || ''} ${subjects.join(' ')}`.toLowerCase()
  };
}

let freeCatalog = [];
function loadFreeCatalog() {
  try {
    const raw = JSON.parse(fs.readFileSync(FREE_CATALOG_PATH, 'utf8'));
    const list = Array.isArray(raw) ? raw : raw.books;
    if (!Array.isArray(list) || !list.length) throw new Error('catalog is empty');
    freeCatalog = list.filter(b => b && b.id && b.title).map(normalizeCatalogBook);
    console.log(`[free-ebooks] loaded ${freeCatalog.length} books from catalog`);
  } catch (e) {
    freeCatalog = FALLBACK_BOOKS.map(normalizeCatalogBook);
    console.warn(`[free-ebooks] catalog not available (${e && e.message ? e.message : e}) — using built-in fallback list. Run scripts/sync-free-ebooks.js and commit data/free-ebooks-catalog.json.`);
  }
  freeCatalog.sort((a, b) => b.downloadCount - a.downloadCount);
}
loadFreeCatalog();

function publicBook(b) {
  const { _search, ...rest } = b;
  return rest;
}

// Fetches a book's file straight from gutenberg.org's own predictable URLs.
async function fetchGutenbergTextDirect(id) {
  const candidates = [
    `https://www.gutenberg.org/cache/epub/${id}/pg${id}-images.html`,
    `https://www.gutenberg.org/cache/epub/${id}/pg${id}.txt`,
    `https://www.gutenberg.org/files/${id}/${id}-h/${id}-h.htm`
  ];
  for (const url of candidates) {
    try {
      const resp = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; MindShiftBooks/1.0; +https://mindshiftbooks.shop)' } });
      if (resp.ok) return { url, text: await resp.text(), isHtml: url.endsWith('.html') || url.endsWith('.htm') };
    } catch (e) { /* try next candidate */ }
  }
  return null;
}

router.get('/api/free-ebook-categories', (req, res) => {
  // Only list categories that actually have books, so no chip leads to an empty page.
  const counts = {};
  freeCatalog.forEach(b => b.cats.forEach(c => { counts[c] = (counts[c] || 0) + 1; }));
  const cats = FREE_EBOOK_CATEGORIES
    .filter(c => !c.code || counts[c.code])
    .map(c => ({ slug: c.slug, label: c.label, code: c.code, count: c.code ? counts[c.code] : freeCatalog.length }));
  res.json({ categories: cats });
});

// List/browse — one category (or a free-text search) at a time, paginated
// via startIndex. Everything is served from the in-memory catalog.
router.get('/api/free-ebooks', (req, res) => {
  const slug = (req.query.category || 'all').toString();
  const q = (req.query.q || '').toString().trim().toLowerCase();
  const startIndex = Math.max(0, parseInt(req.query.startIndex, 10) || 0);

  let pool = freeCatalog;
  if (q) {
    const tokens = q.split(/\s+/).filter(Boolean);
    pool = pool.filter(b => tokens.every(t => b._search.includes(t)));
  } else if (slug !== 'all') {
    const cat = FREE_EBOOK_CATEGORIES.find(c => c.slug === slug);
    if (cat && cat.code) pool = pool.filter(b => b.cats.includes(cat.code));
  }

  const total = pool.length;
  // The homepage / bookstore "Free eBooks" swipers rotate through
  // startIndex by hour — wrap so a small catalog never returns an empty shelf.
  let from = startIndex;
  if (!q && slug === 'all' && total && from >= total) from = (Math.floor(from / FREE_PAGE_SIZE) * FREE_PAGE_SIZE) % total;
  const items = pool.slice(from, from + FREE_PAGE_SIZE).map(publicBook);
  res.json({ items, totalItems: total });
});

// Whole catalog in one small response — the page groups it into banner /
// shelves / filters client-side, so category taps are instant (no per-tap fetch).
router.get('/api/free-ebooks-all', (req, res) => {
  res.set('Cache-Control', 'public, max-age=300');
  res.json({ books: freeCatalog.map(publicBook), totalItems: freeCatalog.length });
});

// Single-book detail — used by the book detail drawer.
router.get('/api/free-ebooks/:id', (req, res) => {
  const id = Number(req.params.id);
  const book = freeCatalog.find(b => b.id === id);
  if (!book) return res.status(404).json({ error: 'Book not found' });
  res.json({ book: publicBook(book) });
});

// ---------------- FREE EBOOKS — on-domain reader (/read/:id) ----------------
// Opens the actual book at mindshiftbooks.shop/read/:id, never
// gutenberg.org, by fetching Gutenberg's file server-side and caching it to
// local disk on first request. Every request after that is served straight
// off our own disk — fast, and doesn't hammer Gutenberg's free servers.
// Download is intentionally not exposed yet — this is read-only.
const GUTENBERG_CACHE_DIR = path.join(PROJECT_ROOT, 'cache', 'gutenberg-reads');

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


router.get('/read/:id', async (req, res) => {
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

    // No Gutendex here (Render is Cloudflare-blocked from it) — go straight
    // to gutenberg.org's own file URLs.
    const direct = await fetchGutenbergTextDirect(id);
    if (!direct) return res.status(502).send('Could not load this book right now. Please try again.');
    const known = freeCatalog.find(b => b.id === Number(id));
    let title = known ? known.title : null;
    if (!title) {
      // Book came from the live Gutendex list, so it isn't in our saved catalog —
      // read the title out of the Gutenberg file itself.
      const tm = direct.text.match(/<title>([\s\S]*?)<\/title>/i) || direct.text.match(/^Title:\s*(.+)$/im);
      title = tm ? tm[1].replace(/^The Project Gutenberg eBook of\s*/i, '').replace(/\s+/g, ' ').trim() : `Book #${id}`;
    }
    const html = direct.isHtml
      ? wrapGutenbergHtml(direct.text, direct.url, title, id)
      : wrapPlainTextAsHtml(direct.text, title, id);

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
router.get('/config', (req, res) => {
  return res.json({ paystackPublicKey: PAYSTACK_PUBLIC_KEY || null, publicPdfUrl: PUBLIC_PDF_URL || null });
});

// ---------------- BOOK PREVIEW PAGE ----------------
// /preview?id=<productId> — and the old pretty URLs (/gcwa-preview, /tda-preview,
// …) still work, because a product's preview.slug maps them to the same page.
// The server drops the book's title/OG tags + data into the template so link
// previews (WhatsApp, X, Google) stay per-book even though it's one HTML file.
const PREVIEW_SLUGS = {};
Object.values(PRODUCTS).forEach(p => {
  if (p.preview && p.preview.slug) PREVIEW_SLUGS[p.preview.slug] = p.id;
});

function escAttr(v) {
  return String(v == null ? '' : v)
    .replace(/&/g, '&amp;').replace(/"/g, '&quot;')
    .replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function servePreviewPage(req, res, id) {
  const p = PRODUCTS[id];
  const pub = publicPreview(p);
  if (!pub) {
    return res.status(404).sendFile(path.join(PROJECT_ROOT, 'public', '404.html'));
  }
  fs.readFile(path.join(PROJECT_ROOT, 'server', 'preview-template.html'), 'utf8', (err, tpl) => {
    if (err) {
      console.error('[preview] template read failed:', err.message);
      return res.status(500).type('text/plain').send('Could not load this preview right now.');
    }
    const base = (process.env.PUBLIC_URL || 'https://mindshiftbooks.shop').replace(/\/$/, '');
    const title = `Preview — ${p.title} | MindShift Books`;
    const ogTitle = `Free Preview — ${p.title} | MindShift Books`;
    const desc = pub.intro || `Read a free preview of ${p.title} before you buy.`;
    const image = p.preview.ogImage || p.coverPath;
    const imageUrl = image ? `${base}/${encodeURI(image)}` : `${base}/og-image.jpg`;
    const canonical = p.preview.slug ? `${base}/${p.preview.slug}-preview` : `${base}/preview?id=${encodeURIComponent(p.id)}`;
    const boot = {
      id: p.id, title: p.title,
      priceNGN: p.priceNGN || null, originalPriceNGN: p.originalPriceNGN || null,
      preview: pub
    };
    const head = [
      `<title>${escAttr(title)}</title>`,
      `<meta name="description" content="${escAttr(desc)}"/>`,
      `<meta property="og:type" content="website" />`,
      `<meta property="og:site_name" content="MindShift Books" />`,
      `<meta property="og:title" content="${escAttr(ogTitle)}" />`,
      `<meta property="og:description" content="${escAttr(desc)}" />`,
      `<meta property="og:url" content="${escAttr(canonical)}" />`,
      `<meta property="og:image" content="${escAttr(imageUrl)}" />`,
      p.preview.ogImage ? `<meta property="og:image:width" content="1200" />\n  <meta property="og:image:height" content="630" />` : '',
      `<meta name="twitter:card" content="summary_large_image" />`,
      `<meta name="twitter:title" content="${escAttr(ogTitle)}" />`,
      `<meta name="twitter:description" content="${escAttr(desc)}" />`,
      `<meta name="twitter:image" content="${escAttr(imageUrl)}" />`,
      `<link rel="canonical" href="${escAttr(canonical)}" />`,
      `<script>window.__PREVIEW__ = ${JSON.stringify(boot).replace(/</g, '\\u003c')};</script>`
    ].filter(Boolean).join('\n  ');
    res.set('Content-Type', 'text/html; charset=utf-8');
    res.send(tpl.replace('<!--PREVIEW_HEAD-->', head));
  });
}

router.get('/preview', (req, res) => servePreviewPage(req, res, String(req.query.id || '')));

// Legacy pretty URLs — /gcwa-preview, /escape-preview, /mmg-preview, /tda-preview,
// /wgfs-preview, /bct-preview. Unknown slugs fall through to the rest of the app.
router.get('/:slug-preview', (req, res, next) => {
  const id = PREVIEW_SLUGS[req.params.slug];
  if (!id) return next();
  servePreviewPage(req, res, id);
});

// Structured data endpoint — Google uses this for rich results / image search
router.get('/schema/:productId', (req, res) => {
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

module.exports = router;
module.exports.PRODUCTS = PRODUCTS;
module.exports.mintDownloadToken = mintDownloadToken;
module.exports.validateDownloadToken = validateDownloadToken;

// Kept so server.js's existing call still works. Nothing to warm any more —
// the catalog is loaded from disk at boot and served from memory.
module.exports.warmupFreeEbooksCache = async function warmupFreeEbooksCache() {
  console.log(`[free-ebooks] ready: ${freeCatalog.length} books in memory`);
};
