// public/main.js
// Loads products from server (/api/products)

// ── bfcache guard ────────────────────────────────────────────────────
// Mobile browsers often restore a page from the back/forward cache on
// back/forward nav instead of reloading it — you get back the exact frozen
// DOM/JS state from the moment you left (mid-fetch, stuck skeletons, stale
// auth state). None of our data fetches or Firebase listeners re-fire on
// that kind of restore, so the page just sits there looking "static".
// Forcing a real reload when a persisted (bfcache) restore is detected
// makes every page re-run its scripts fresh, same as a normal page load.
window.addEventListener('pageshow', function (event) {
  if (event.persisted) {
    window.location.reload();
  }
});

// ── First-party page-view tracking (no third-party pixels/cookies) ─────────
// Fires once per page load to /api/track. No IP, no cookies, no cross-site
// identifiers — just type + path + which book (if any). Powers the admin
// dashboard's view counts.
(function trackPageView() {
  try {
    const path = location.pathname;
    const params = new URLSearchParams(location.search);
    let type = 'page';
    if (path === '/' || path === '/index') type = 'home';
    else if (path === '/review') type = 'review';

    const payload = JSON.stringify({
      type,
      path,
      productId: params.get('id') || null,
      ref: document.referrer || null
    });

    if (navigator.sendBeacon) {
      navigator.sendBeacon('/api/track', new Blob([payload], { type: 'application/json' }));
    } else {
      fetch('/api/track', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: payload, keepalive: true }).catch(() => {});
    }
  } catch (e) { /* analytics must never break the page */ }
})();

// FIREBASE CONFIG
const firebaseConfig = {
  apiKey: "AIzaSyDTn70s1_uIiSOR6lPLY_nKh8Ff1FViFCs",
  authDomain: "mindshiftbooks-c4451.firebaseapp.com",
  projectId: "mindshiftbooks-c4451",
  storageBucket: "mindshiftbooks-c4451.firebasestorage.app",
  messagingSenderId: "388697987853",
  appId: "1:388697987853:web:f023df9412c22285012e44",
  measurementId: "G-CHPJDQ4W08"
};
firebase.initializeApp(firebaseConfig);
const db = firebase.firestore();

// Runtime config
let PAYSTACK_PUBLIC_KEY = null;
let PUBLIC_PDF_URL = null;
let PAYSTACK_READY = false;
let PRODUCTS = []; // fetched from server

// Wishlist state — declared here (ahead of fetchProducts()/renderProducts())
// on purpose. fetchProducts() below can call renderProducts() synchronously
// (see its cached-data branch) whenever there's a warm localStorage product
// cache, i.e. on basically any return visit — and renderProducts() reaches
// isInWishlist()/wishlistIds through productCardInner(). Since these are
// `let` bindings, declaring them further down the file used to leave them
// in the temporal dead zone during that synchronous call, throwing
// "Cannot access 'wishlistIds' before initialization" on exactly the
// return-visit case. The functions that use them are function declarations
// (fully hoisted), so only the variables themselves needed to move.
let wishlistIds = [];
let wishlistFetched = false; // true once fetchWishlist() has resolved at least once for the current session

async function initConfigAndPaystack() {
  try {
    const res = await fetch('/config');
    const cfg = await res.json();
    PAYSTACK_PUBLIC_KEY = cfg.paystackPublicKey || null;
    PUBLIC_PDF_URL = cfg.publicPdfUrl || null;

    if (!window.PaystackPop) {
      await new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = 'https://js.paystack.co/v1/inline.js';
        s.async = true;
        s.onload = () => resolve();
        s.onerror = () => reject(new Error('Failed to load Paystack inline script'));
        document.head.appendChild(s);
      });
    }
    PAYSTACK_READY = true;
  } catch (e) {
    console.warn('config init failed', e);
  }
}
initConfigAndPaystack();

function toggleSidebar() {
  const sidebar = document.getElementById('sidebar');
  const open = sidebar.getAttribute('data-open') === 'true';
  sidebar.setAttribute('data-open', open ? 'false' : 'true');
  sidebar.style.left = open ? '-300px' : '0px';
  sidebar.setAttribute('aria-hidden', open ? 'true' : 'false');
}
function openMyOrders(){ window.location.href = '/my-order'; }
function openContact(){ showToast('Contact us: contact@mindshiftbooks.shop', 'info', 6000); }
function followYoutube(){ window.open('https://www.youtube.com/@MindShift_Books', '_blank'); }

// Fetch products from server
// ── Product list cache (stale-while-revalidate) ──────────────────────
const PRODUCTS_CACHE_KEY = 'ms_products_cache';
const PRODUCTS_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

function getCachedProducts() {
  try {
    const raw = localStorage.getItem(PRODUCTS_CACHE_KEY);
    if (!raw) return null;
    const { ts, data } = JSON.parse(raw);
    if (Date.now() - ts > PRODUCTS_CACHE_TTL) return null; // expired
    return data;
  } catch(e) { return null; }
}

function setCachedProducts(data) {
  try {
    localStorage.setItem(PRODUCTS_CACHE_KEY, JSON.stringify({ ts: Date.now(), data }));
  } catch(e) {}
}

async function fetchProducts() {
  // 1. Show cached data immediately if available — no spinner
  const cached = getCachedProducts();
  if (cached && cached.length) {
    PRODUCTS = cached;
    renderProducts();
  }

  // 2. Always fetch fresh in background
  try {
    const res = await fetch('/api/products');
    const j = await res.json();
    const fresh = (j && j.products) ? j.products : [];
    // Only re-render if data actually changed
    if (JSON.stringify(fresh) !== JSON.stringify(PRODUCTS)) {
      PRODUCTS = fresh;
      renderProducts();
    }
    setCachedProducts(fresh);
  } catch (e) {
    // If fetch fails but we already rendered from cache, stay silent
    if (!PRODUCTS.length) {
      console.error('Failed to fetch products', e);
      const el = document.getElementById('productGrid');
      if (el) el.innerHTML = '<div style="padding:20px;">Failed to load products.</div>';
    }
  }
}

// safe escape for HTML content
function escapeHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// helper to format price — prefers NGN fixed price, falls back to USD
function formatPrice(p) {
  if (p.priceNGN) return `₦${Number(p.priceNGN).toLocaleString()}`;
  if (p.priceUSD) return `$${Number(p.priceUSD).toFixed(2)}`;
  return '';
}

// ── Toast notification system ────────────────────────────────────────
function showToast(msg, type = 'info', duration = 4000) {
  let container = document.getElementById('toastContainer');
  if (!container) {
    container = document.createElement('div');
    container.id = 'toastContainer';
    document.body.appendChild(container);
  }
  const icons = { success: '✅', error: '❌', warning: '⚠️', info: 'ℹ️' };
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.innerHTML = `
    <span class="toast-icon">${icons[type] || 'ℹ️'}</span>
    <span class="toast-msg">${msg}</span>
    <button class="toast-close" onclick="this.closest('.toast').remove()">✕</button>`;
  container.appendChild(toast);
  setTimeout(() => {
    toast.classList.add('hiding');
    setTimeout(() => toast.remove(), 260);
  }, duration);
}

// Heart icon markup used for every wishlist toggle button (card + review page)
function wishlistHeartSvg(filled) {
  return `<svg viewBox="0 0 24 24" fill="${filled ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" width="16" height="16"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"></path></svg>`;
}

function wishlistToggleButton(productId, opts) {
  opts = opts || {};
  const inList = isInWishlist(productId);
  const cls = opts.cardOverlay ? 'wishlist-heart-btn' : 'btn wishlist-inline-btn';
  return `
    <button type="button" class="${cls}${inList ? ' active' : ''}" data-action="toggle-wishlist" data-product-id="${escapeHtml(productId || '')}" aria-pressed="${inList}" aria-label="${inList ? 'Remove from wishlist' : 'Add to wishlist'}">
      ${wishlistHeartSvg(inList)}
      ${opts.cardOverlay ? '' : `<span class="wishlist-inline-label">${inList ? 'In Wishlist' : 'Add to Wishlist'}</span>`}
    </button>
  `;
}

// Build the inner HTML for a single product card
function productCardInner(p) {
  const isFeatured = p.category !== 'ours';

  if (isFeatured) {
    // Recommended read — compact grid card with container
    return `
      <div class="card-cover-wrap">
        <img src="${escapeHtml(p.cover || '')}" class="ebook-cover" alt="${escapeHtml(p.title || 'ebook')}"/>
        ${wishlistToggleButton(p.id, { cardOverlay: true })}
      </div>
      <div class="title">${escapeHtml(p.title || '')}</div>
      <div class="card-author">${escapeHtml(p.author || '')}</div>
      <div class="card-actions button-group" style="width:100%;margin-top:auto;">
        <button class="btn review-btn" data-product-id="${escapeHtml(p.id || '')}" data-action="review">Details</button>
        <a class="btn buy-btn find-on-amazon-btn" href="${escapeHtml(p.externalUrl || '#')}" target="_blank" rel="noopener noreferrer">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="14" height="14" style="vertical-align:-2px;margin-right:4px;"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path><polyline points="15 3 21 3 21 9"></polyline><line x1="10" y1="14" x2="21" y2="3"></line></svg>
          <span class="amz-label">Find on Amazon</span>
        </a>
      </div>
    `;
  }

  // Our book — no container, just cover + content below
  const price = formatPrice(p);
  const orig = p.originalPriceNGN ? `₦${Number(p.originalPriceNGN).toLocaleString()}` : null;
  const pct  = (p.originalPriceNGN && p.priceNGN) ? Math.round((1 - p.priceNGN / p.originalPriceNGN) * 100) : null;

  return `
    <div class="our-spotlight-head">
      <span class="section-accent"></span>
      <h3>What Readers Are Loving</h3>
      <span class="section-pill section-pill--trending">Trending</span>
    </div>
    <div class="card-cover-wrap">
      <img src="${escapeHtml(p.cover || '')}" class="our-cover" alt="${escapeHtml(p.title || 'ebook')}"/>
      ${wishlistToggleButton(p.id, { cardOverlay: true })}
    </div>
    <div class="our-title">${escapeHtml(p.title || '')}</div>
    <div class="our-author">${escapeHtml(p.author || '')}</div>
    <div class="card-price-block">
      <div class="card-price">${price}</div>
      ${(orig || pct) ? `
      <div class="card-price-subrow">
        ${orig ? `<span class="card-price-old">${orig}</span>` : ''}
        ${pct  ? `<span class="card-discount-badge">${pct}% OFF</span>` : ''}
      </div>` : ''}
    </div>
    <div class="our-actions">
      <button class="btn buy-btn" data-product-id="${escapeHtml(p.id || '')}" data-action="add-to-cart">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="14" height="14" style="vertical-align:-2px;margin-right:4px;"><circle cx="9" cy="21" r="1"></circle><circle cx="20" cy="21" r="1"></circle><path d="M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6"></path></svg>
        Add to Cart
      </button>
      <button class="btn review-btn" data-product-id="${escapeHtml(p.id || '')}" data-action="review">Details</button>
    </div>
  `;
}

// Render a list of products into a given grid element
function renderGrid(grid, list, emptyMessage) {
  if (!grid) return;
  grid.innerHTML = '';
  if (!list.length) {
    grid.innerHTML = `<div class="center" style="grid-column:1/-1;padding:24px;"><div class="muted">${emptyMessage || 'No books available.'}</div></div>`;
    return;
  }
  const isOurBooks = grid.id === 'ourBooksGrid';
  const isSwiper = grid.classList.contains('swiper-track');
  list.forEach(p => {
    const card = document.createElement('div');
    card.className = isOurBooks ? 'our-book-item' : (isSwiper ? 'swiper-card' : 'product-card');
    card.innerHTML = productCardInner(p);
    grid.appendChild(card);
  });
  if (isSwiper) updateSwiperArrows(grid);
}

// ── "Recommended Reads" swiper controls (works across every swiper-wrap on the page) ──
function updateSwiperArrows(track) {
  const wrap = track.closest('.swiper-wrap');
  if (!wrap) return;
  const prevBtn = wrap.querySelector('[data-swiper-prev]');
  const nextBtn = wrap.querySelector('[data-swiper-next]');
  if (!prevBtn || !nextBtn) return;
  const maxScroll = track.scrollWidth - track.clientWidth - 2;
  prevBtn.classList.toggle('is-hidden', track.scrollLeft <= 4);
  nextBtn.classList.toggle('is-hidden', track.scrollLeft >= maxScroll);
}

(function wireFeaturedSwipers() {
  document.addEventListener('DOMContentLoaded', () => {
    const wraps = document.querySelectorAll('.swiper-wrap');
    wraps.forEach(wrap => {
      const track = wrap.querySelector('.swiper-track');
      const prevBtn = wrap.querySelector('[data-swiper-prev]');
      const nextBtn = wrap.querySelector('[data-swiper-next]');
      if (!track || !prevBtn || !nextBtn) return;

      const stepSize = () => {
        const card = track.querySelector('.swiper-card');
        if (!card) return track.clientWidth;
        const style = getComputedStyle(track);
        const gap = parseFloat(style.columnGap || style.gap || '12');
        return card.getBoundingClientRect().width + gap;
      };

      nextBtn.addEventListener('click', () => {
        track.scrollBy({ left: stepSize() * 2, behavior: 'smooth' });
      });
      prevBtn.addEventListener('click', () => {
        track.scrollBy({ left: -stepSize() * 2, behavior: 'smooth' });
      });
      track.addEventListener('scroll', () => updateSwiperArrows(track), { passive: true });
      window.addEventListener('resize', () => updateSwiperArrows(track));
    });
  });
})();

// ── "Free eBooks" swiper on the homepage — pulls the current top/trending
// titles (Gutendex's default ordering is by download_count, so "all,
// startIndex 0" already surfaces the most-read public-domain books first).
// Cards link straight to /read/:id (our own on-domain reader) since there's
// no detail drawer on this page — that lives on /free-ebooks.
function freeEbookCardInner(b) {
  const cover = b.cover || `data:image/svg+xml,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="140" height="200"><rect width="140" height="200" rx="8" fill="#e2e8f0"/><text x="70" y="104" font-family="sans-serif" font-size="12" fill="#94a3b8" text-anchor="middle">No Cover</text></svg>`
  )}`;
  return `
    <div class="card-cover-wrap">
      <img src="${escapeHtml(cover)}" class="ebook-cover" alt="${escapeHtml(b.title)}" loading="lazy"/>
    </div>
    <div class="title">${escapeHtml(b.title)}</div>
    <div class="card-author">${escapeHtml(b.author || '')}</div>
    <div class="card-actions button-group" style="width:100%;margin-top:auto;">
      <button class="btn free-ebook-read-btn" data-fe-detail="${escapeHtml(b.id)}" style="width:100%;">Read Free</button>
    </div>
  `;
}

async function loadFreeEbooksSwiper() {
  const track = document.getElementById('freeEbooksGrid');
  const section = document.getElementById('freeEbooksSection');
  if (!track) return;
  // The inline loader at the top of index.html already fetches this as
  // early as possible (before this script even runs) — skip if it succeeded.
  if (window.__feHomeSwiper && window.__feHomeSwiper.done) return;
  try {
    const res = await fetch('/api/free-ebooks?category=all&startIndex=0');
    if (!res.ok) throw new Error('fetch failed');
    const data = await res.json();
    const items = (data.items || []).slice(0, 12);
    if (!items.length) {
      if (section) section.style.display = 'none';
      return;
    }
    track.innerHTML = '';
    items.forEach(b => {
      const card = document.createElement('div');
      card.className = 'swiper-card fe-card';
      card.innerHTML = freeEbookCardInner(b);
      track.appendChild(card);
    });
    if (typeof updateSwiperArrows === 'function') updateSwiperArrows(track);
  } catch (e) {
    console.error('Failed to load free eBooks swiper', e);
    if (section) section.style.display = 'none';
  }
}
document.addEventListener('DOMContentLoaded', loadFreeEbooksSwiper);

// ── Free eBook detail drawer — shared by the homepage swiper and, in its
// own copy, by /free-ebooks.html. Opens on any [data-fe-detail] click. ──
(function wireFreeEbookDrawer() {
  const modal = document.getElementById('feModal');
  if (!modal) return; // not on this page
  const modalClose = document.getElementById('feModalClose');
  const modalCover = document.getElementById('feModalCover');
  const modalTitle = document.getElementById('feModalTitle');
  const modalAuthor = document.getElementById('feModalAuthor');
  const modalMeta = document.getElementById('feModalMeta');
  const modalDesc = document.getElementById('feModalDesc');
  const modalReadBtn = document.getElementById('feModalReadBtn');

  function placeholderCover(title) {
    return `data:image/svg+xml,${encodeURIComponent(
      `<svg xmlns="http://www.w3.org/2000/svg" width="140" height="200"><rect width="140" height="200" rx="8" fill="#e2e8f0"/><text x="70" y="104" font-family="sans-serif" font-size="12" fill="#94a3b8" text-anchor="middle">No Cover</text></svg>`
    )}`;
  }
  function stripHtml(str) {
    if (!str) return '';
    return String(str).replace(/<[^>]*>/g, '');
  }

  async function openDetail(id) {
    modal.classList.add('open');
    document.body.style.overflow = 'hidden';
    modalTitle.textContent = 'Loading…';
    modalAuthor.textContent = '';
    modalMeta.innerHTML = '';
    modalDesc.textContent = 'Loading description…';
    modalDesc.classList.add('loading');
    modalCover.src = placeholderCover('');
    modalReadBtn.href = '#';

    try {
      const res = await fetch('/api/free-ebooks/' + encodeURIComponent(id));
      const j = await res.json();
      const b = j.book;
      if (!b) throw new Error('not found');
      modalCover.src = b.cover || placeholderCover(b.title);
      modalTitle.textContent = b.title;
      modalAuthor.textContent = (b.authors && b.authors.length) ? b.authors.join(', ') : 'Unknown Author';
      const metaBits = [];
      if (b.categories && b.categories.length) metaBits.push(b.categories[0]);
      if (b.pageCount) metaBits.push(b.pageCount + ' pages');
      if (b.publishedDate) metaBits.push(b.publishedDate.slice(0, 4));
      modalMeta.innerHTML = metaBits.map(m => `<span>${escapeHtml(m)}</span>`).join('');
      modalDesc.textContent = stripHtml(b.description) || 'No description available for this title.';
      modalDesc.classList.remove('loading');
      modalReadBtn.href = b.readLink || '#';
    } catch (e) {
      modalDesc.textContent = 'Could not load this book right now. Please try again.';
      modalDesc.classList.remove('loading');
    }
  }

  function closeDetail() {
    modal.classList.remove('open');
    document.body.style.overflow = '';
  }

  document.addEventListener('click', (ev) => {
    const btn = ev.target.closest('[data-fe-detail]');
    if (btn) { openDetail(btn.getAttribute('data-fe-detail')); return; }
    if (ev.target.closest('#feModalClose')) { closeDetail(); return; }
    if (ev.target === modal) { closeDetail(); return; }
  });
  if (modalClose) modalClose.addEventListener('click', closeDetail);
})();

// Render product grids from PRODUCTS (from server), split into "Our Books" and "Featured" sections
function renderProducts() {
  const ourGrid = document.getElementById('ourBooksGrid');
  const featuredGrids = [
    document.getElementById('featuredGrid1'),
    document.getElementById('featuredGrid2'),
    document.getElementById('featuredGrid3')
  ];
  const ourSection = document.getElementById('ourBooksSection');
  const featuredSections = [
    document.getElementById('featuredSection'),
    document.getElementById('featuredSection2'),
    document.getElementById('featuredSection3')
  ];
  const searchSection = document.getElementById('searchResultsSection');

  if (searchSection) searchSection.style.display = 'none';

  const ourBooks = PRODUCTS.filter(p => p.category === 'ours');
  const featuredBooks = PRODUCTS.filter(p => p.category !== 'ours');

  // split the featured books into 3 even groups (3 books each, when there are 9)
  const groupCount = featuredSections.length;
  const groupSize = Math.ceil(featuredBooks.length / groupCount) || 1;
  const groups = [];
  for (let i = 0; i < groupCount; i++) {
    groups.push(featuredBooks.slice(i * groupSize, (i + 1) * groupSize));
  }

  if (ourSection) ourSection.style.display = ourBooks.length ? '' : 'none';
  renderGrid(ourGrid, ourBooks, 'No books yet — check back soon.');

  featuredSections.forEach((section, i) => {
    if (!section) return;
    section.style.display = groups[i].length ? '' : 'none';
    renderGrid(featuredGrids[i], groups[i], 'No books available.');
  });

  updateAuthCtaVisibility();
}

// ── Signed-out CTA banner (before FAQ) ────────────────────────────────
// Shown only once Firebase auth has resolved AND confirms nobody is signed
// in. Hidden again while search results are on screen so it doesn't
// interrupt the search flow.
let msbIsSignedIn = null; // null = auth not resolved yet
let msbSearchActive = false;

function updateAuthCtaVisibility() {
  const shouldShow = (msbIsSignedIn === false && !msbSearchActive);
  const section = document.getElementById('authCtaSection');
  if (section) section.style.display = shouldShow ? '' : 'none';
  const sidebarCta = document.getElementById('sidebarAuthCta');
  if (sidebarCta) sidebarCta.style.display = (msbIsSignedIn === false) ? '' : 'none';
}

(function wireAuthCta() {
  // main.js loads before auth.js, so window.MSBAuth isn't ready yet at this
  // exact point — but 'msb-auth-changed' is a plain event, so attaching the
  // listener now is safe; it'll catch the event whenever auth.js resolves
  // sign-in state later. This listener stays live for the whole session so
  // later sign-in/sign-out (without a page reload) still updates the banner.
  window.addEventListener('msb-auth-changed', (ev) => {
    msbIsSignedIn = !!(ev.detail && ev.detail.user);
    updateAuthCtaVisibility();
  });

  // Defensive check in case window.MSBAuth is already available (e.g. if
  // script load order ever changes) — gives an earlier first read.
  if (window.MSBAuth && typeof window.MSBAuth.onAuthReady === 'function') {
    window.MSBAuth.onAuthReady(user => {
      if (msbIsSignedIn === null) { msbIsSignedIn = !!user; updateAuthCtaVisibility(); }
    });
  }

  // Fallback: if auth.js/Firebase never loads (blocked script, network
  // issue, ad blocker) the event above may never fire and the banner would
  // stay hidden forever. Treat "still unknown after a few seconds" as
  // signed-out so guests still see the nice sign-up prompt instead of
  // nothing at all. A genuine 'msb-auth-changed' event, if it does still
  // arrive later, will correct this via the listener above.
  setTimeout(() => {
    if (msbIsSignedIn === null) { msbIsSignedIn = false; updateAuthCtaVisibility(); }
  }, 4000);
})();

// initial load
fetchProducts();

// Delegated click handler for product buttons (avoids inline onclick and quoting issues)
document.addEventListener('click', function (ev) {
  const btn = ev.target.closest('button[data-action]');
  if (!btn) return;
  const action = btn.getAttribute('data-action');
  const productId = btn.getAttribute('data-product-id');
  if (action === 'review') openReview(productId);
  if (action === 'add-to-cart') addToCart(productId);
  if (action === 'remove-from-cart') removeFromCart(productId);
  if (action === 'toggle-wishlist') toggleWishlist(productId);
});

// Review navigation
function openReview(productId){
  if (!productId) return;
  window.location.href = `/review?id=${encodeURIComponent(productId)}`;
}

// ====================================================================
// CART (localStorage-backed) — replaces the old single-book buy modal
// ====================================================================

const CART_KEY = 'msb_cart';

function getCart() {
  try {
    const raw = JSON.parse(localStorage.getItem(CART_KEY));
    return Array.isArray(raw) ? raw : [];
  } catch (e) {
    return [];
  }
}

function saveCart(cartIds) {
  localStorage.setItem(CART_KEY, JSON.stringify(cartIds));
  updateCartBadge();
}

function updateCartBadge() {
  const badge = document.getElementById('cartBadge');
  if (!badge) return;
  const count = getCart().length;
  if (count > 0) {
    badge.textContent = String(count);
    badge.style.display = 'flex';
  } else {
    badge.style.display = 'none';
  }
}

function addToCart(productId) {
  if (!productId) return;
  const cart = getCart();
  if (cart.includes(productId)) {
    showToast('This book is already in your cart.', 'warning');
    return;
  }
  cart.push(productId);
  saveCart(cart);
}

function removeFromCart(productId) {
  const cart = getCart().filter(id => id !== productId);
  saveCart(cart);
  renderCartOverlay();
}

// ====================================================================
// WISHLIST (server-side, per account) — signed-out visitors get the sign-in
// drawer instead (below); nothing is stored for them. Kept in memory as
// wishlistIds, populated by fetchWishlist() on sign-in and cleared on
// sign-out (see the msb-auth-changed listener near the bottom of this file).
// wishlistIds/wishlistFetched themselves are declared near the top of this
// file — see the comment there for why.
// ====================================================================

function getWishlist() {
  return wishlistIds;
}

function isInWishlist(productId) {
  return wishlistIds.includes(productId);
}

function updateWishlistBadge() {
  const badge = document.getElementById('wishlistBadge');
  if (!badge) return;
  const count = wishlistIds.length;
  if (count > 0) {
    badge.textContent = String(count);
    badge.style.display = 'flex';
  } else {
    badge.style.display = 'none';
  }
}

function setWishlistIds(ids) {
  wishlistIds = Array.isArray(ids) ? ids : [];
  updateWishlistBadge();
  window.dispatchEvent(new CustomEvent('msb-wishlist-changed', { detail: { ids: wishlistIds } }));
}

// Pulls the signed-in account's saved books from the server. Called after
// every sign-in (and on load if already signed in); clears the list on
// sign-out since there's nothing local to fall back on anymore.
async function fetchWishlist() {
  const user = window.MSBAuth && window.MSBAuth.getUser();
  if (!user) { wishlistFetched = true; setWishlistIds([]); return; }
  try {
    const token = await window.MSBAuth.getIdToken();
    const res = await fetch('/api/wishlist', { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error('wishlist fetch failed');
    const data = await res.json();
    setWishlistIds(data.ids);
  } catch (e) {
    setWishlistIds([]); // fail quiet — hearts just show unsaved until next load
  } finally {
    wishlistFetched = true;
  }
}

// Adds/removes a book on the server and returns the new state (true = now in
// wishlist). Updates the local cache optimistically so the heart flips
// instantly, and rolls back if the request fails.
async function toggleWishlist(productId) {
  if (!productId) return false;
  const user = window.MSBAuth && window.MSBAuth.getUser();
  if (!user) { openWishlistAuthDrawer(); return false; }

  const wasIn = isInWishlist(productId);
  setWishlistIds(wasIn ? wishlistIds.filter(id => id !== productId) : [...wishlistIds, productId]);

  try {
    const token = await window.MSBAuth.getIdToken();
    const res = await fetch('/api/wishlist/toggle', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ productId })
    });
    if (!res.ok) throw new Error('wishlist toggle failed');
    const data = await res.json();
    showToast(data.inWishlist ? 'Added to your wishlist.' : 'Removed from your wishlist.', data.inWishlist ? 'success' : 'info', 2500);
    return data.inWishlist;
  } catch (e) {
    setWishlistIds(wasIn ? [...wishlistIds, productId] : wishlistIds.filter(id => id !== productId)); // roll back
    showToast("Couldn't update your wishlist — please try again.", 'error', 3000);
    return wasIn;
  }
}

function openWishlist() { window.location.href = '/wishlist'; }

// ---------------- Wishlist sign-in drawer ----------------
// Lightweight bottom-sheet nudge shown when a signed-out visitor taps a
// wishlist heart. Saving books requires an account (the wishlist lives on
// the server, tied to the shopper) — this is the light-touch prompt that
// asks them to sign in or create one, injected once and reused on every
// page that loads main.js.
function ensureWishlistAuthDrawer() {
  if (document.getElementById('wishlistAuthBackdrop')) return;
  const wrap = document.createElement('div');
  wrap.innerHTML = `
    <div class="wishlist-drawer-backdrop" id="wishlistAuthBackdrop" aria-hidden="true">
      <div class="wishlist-drawer" role="dialog" aria-modal="true" aria-labelledby="wishlistDrawerTitle">
        <button type="button" class="wishlist-drawer-close" id="wishlistDrawerCloseBtn" aria-label="Close">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="18" height="18"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
        </button>
        <div class="cart-auth-gate">
          <div class="cart-auth-gate-icon">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" width="22" height="22"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"></path></svg>
          </div>
          <h3 id="wishlistDrawerTitle">Sign in to save books</h3>
          <p>Create a free account or sign in to start your wishlist.</p>
          <div class="cart-auth-gate-actions">
            <button type="button" class="btn buy-btn" id="wishlistDrawerSignUpBtn">Create Account</button>
            <button type="button" class="cart-auth-secondary" id="wishlistDrawerSignInBtn">Sign In</button>
          </div>
        </div>
      </div>
    </div>`;
  document.body.appendChild(wrap.firstElementChild);

  const backdrop = document.getElementById('wishlistAuthBackdrop');
  document.getElementById('wishlistDrawerCloseBtn')?.addEventListener('click', closeWishlistAuthDrawer);
  backdrop?.addEventListener('click', (e) => { if (e.target === backdrop) closeWishlistAuthDrawer(); });
  document.getElementById('wishlistDrawerSignInBtn')?.addEventListener('click', () => goToWishlistAuth('/login'));
  document.getElementById('wishlistDrawerSignUpBtn')?.addEventListener('click', () => goToWishlistAuth('/signup'));
}

function goToWishlistAuth(path) {
  window.location.href = path + '?returnTo=' + encodeURIComponent(window.location.pathname + window.location.search);
}

function openWishlistAuthDrawer() {
  ensureWishlistAuthDrawer();
  const backdrop = document.getElementById('wishlistAuthBackdrop');
  if (!backdrop) return;
  backdrop.classList.add('show');
  backdrop.setAttribute('aria-hidden', 'false');
  document.body.style.overflow = 'hidden';
}

function closeWishlistAuthDrawer() {
  const backdrop = document.getElementById('wishlistAuthBackdrop');
  if (!backdrop) return;
  backdrop.classList.remove('show');
  backdrop.setAttribute('aria-hidden', 'true');
  document.body.style.overflow = '';
}

// Fetch (or clear) the wishlist every time sign-in state changes.
window.addEventListener('msb-auth-changed', fetchWishlist);

// Keep every heart button for a given book (card overlay + review-page
// button, possibly several on one page) in sync after a toggle.
window.addEventListener('msb-wishlist-changed', () => {
  document.querySelectorAll('[data-action="toggle-wishlist"]').forEach(btn => {
    const id = btn.getAttribute('data-product-id');
    const inList = isInWishlist(id);
    btn.classList.toggle('active', inList);
    btn.setAttribute('aria-pressed', String(inList));
    btn.setAttribute('aria-label', inList ? 'Remove from wishlist' : 'Add to wishlist');
    const svg = btn.querySelector('svg');
    if (svg) svg.setAttribute('fill', inList ? 'currentColor' : 'none');
    const label = btn.querySelector('.wishlist-inline-label');
    if (label) label.textContent = inList ? 'In Wishlist' : 'Add to Wishlist';
  });
});

// Build the rows + total inside the cart overlay
function renderCartOverlay() {
  const list = document.getElementById('cartItemsList');
  const totalEl = document.getElementById('cartTotalPrice');
  const summary = document.getElementById('cartSummary');
  const countEl = document.getElementById('cartItemCount');
  if (!list || !totalEl) return;

  const cartIds = getCart();
  const items = cartIds.map(id => PRODUCTS.find(p => p.id === id)).filter(Boolean);

  // drop any stale ids that no longer match a real product — but only once
  // PRODUCTS has actually loaded, otherwise we'd wipe a valid cart on a slow load
  if (PRODUCTS.length && items.length !== cartIds.length) {
    saveCart(items.map(p => p.id));
  }

  if (!items.length) {
    if (summary) summary.style.display = 'none';
    if (countEl) countEl.textContent = '';

    if (cartIds.length && !PRODUCTS.length) {
      list.innerHTML = `<div class="muted" style="padding:40px 10px;text-align:center;">Loading your cart…</div>`;
    } else {
      list.innerHTML = `
        <div class="cart-empty">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" width="48" height="48"><circle cx="9" cy="21" r="1"></circle><circle cx="20" cy="21" r="1"></circle><path d="M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6"></path></svg>
          <h3>Your cart is empty</h3>
          <p>Browse the catalog and tap "Add to Cart" on any book you like.</p>
          <button type="button" class="btn buy-btn" id="cartEmptyBrowseBtn">Browse Books</button>
        </div>
      `;
      document.getElementById('cartEmptyBrowseBtn')?.addEventListener('click', closeCartOverlay);
    }
    totalEl.textContent = '₦0';
    return;
  }

  if (summary) summary.style.display = '';
  if (countEl) countEl.textContent = `${items.length} ${items.length === 1 ? 'item' : 'items'}`;

  list.innerHTML = items.map(p => `
    <div class="cart-item">
      <img src="${escapeHtml(p.cover || '')}" alt="${escapeHtml(p.title || '')}"/>
      <div class="cart-item-info">
        <div class="cart-item-title">${escapeHtml(p.title || '')}</div>
        <div class="cart-item-price">${formatPrice(p)}</div>
      </div>
      <button class="cart-item-remove" data-action="remove-from-cart" data-product-id="${escapeHtml(p.id || '')}" aria-label="Remove from cart">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" width="16" height="16"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"></path><path d="M10 11v6"></path><path d="M14 11v6"></path><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"></path></svg>
      </button>
    </div>
  `).join('');

  const total = items.reduce((sum, p) => sum + Number(p.priceNGN || p.priceUSD || 0), 0);
  const hasNGN = items.some(p => p.priceNGN);
  totalEl.textContent = hasNGN ? `₦${total.toLocaleString()}` : `$${total.toFixed(2)}`;
}

// Shows the recipient chip + Proceed to Payment for signed-in users, or the
// sign-in/sign-up gate for signed-out users. Books are always sent to the
// signed-in account's own email — nothing to type, nothing to get wrong.
function updateCartCheckoutGate() {
  const signedInBlock = document.getElementById('cartCheckoutSignedIn');
  const signedOutBlock = document.getElementById('cartCheckoutSignedOut');
  if (!signedInBlock || !signedOutBlock) return;

  const user = window.MSBAuth && window.MSBAuth.getUser();
  if (user) {
    signedOutBlock.style.display = 'none';
    signedInBlock.style.display = '';
    const email = user.email || '';
    const name = user.displayName || (email ? email.split('@')[0] : 'Your account');
    const nameEl = document.getElementById('cartRecipientName');
    const emailEl = document.getElementById('cartRecipientEmail');
    const avatarEl = document.getElementById('cartRecipientAvatar');
    if (nameEl) nameEl.textContent = name;
    if (emailEl) emailEl.textContent = email;
    if (avatarEl) avatarEl.textContent = (name.trim()[0] || '?').toUpperCase();
  } else {
    signedInBlock.style.display = 'none';
    signedOutBlock.style.display = '';
  }
}

function openCartOverlay() {
  renderCartOverlay();
  const overlay = document.getElementById('cartOverlay');
  if (!overlay) return;
  overlay.classList.add('show');
  overlay.setAttribute('aria-hidden', 'false');
  document.body.style.overflow = 'hidden';
  updateCartCheckoutGate();
}

// Keep the cart's checkout section in sync if auth state changes while the
// cart happens to be open (e.g. signs out in another tab, or resumes after
// coming back from /login).
window.addEventListener('msb-auth-changed', () => {
  const overlay = document.getElementById('cartOverlay');
  if (overlay && overlay.classList.contains('show')) updateCartCheckoutGate();
});

function closeCartOverlay() {
  const overlay = document.getElementById('cartOverlay');
  if (!overlay) return;
  overlay.classList.remove('show');
  overlay.setAttribute('aria-hidden', 'true');
  document.body.style.overflow = '';
}

// Called by auth.js once, right after sign-in, if the person had tapped
// "Proceed to Payment" while signed out. Picks the cart flow back up exactly
// where they left off.
window.msbResumeCheckout = function () {
  if (getCart().length > 0) {
    openCartOverlay();
    proceedCartToPayment();
  }
};

// ------------------ CART CHECKOUT (one payment for the whole cart) ------------------

async function proceedCartToPayment() {
  // Browsing and cart-building stay open to everyone — only this step (an
  // actual purchase) requires a signed-in account. requireSignIn() redirects
  // to /login and remembers to resume checkout automatically after sign-in
  // (see msbResumeCheckout below). In normal use this button isn't even
  // visible when signed out (see updateCartCheckoutGate), but this stays as
  // a safety net for the msbResumeCheckout() auto-resume path.
  if (!window.MSBAuth || !window.MSBAuth.requireSignIn()) {
    return;
  }

  const user = window.MSBAuth.getUser();
  const email = (user && user.email || '').trim();
  const name  = (user && user.displayName || (email ? email.split('@')[0] : '')).trim();
  const cartIds = getCart();

  if (!cartIds.length) {
    showToast('Your cart is empty.', 'warning');
    return;
  }
  if (!email || !/^\S+@\S+\.\S+$/.test(email)) {
    showToast('We could not read your account email. Please sign in again.', 'error');
    return;
  }

  const btn = document.getElementById('cartProceedBtn');
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Preparing...';
  }

  try {
    const idToken = await window.MSBAuth.getIdToken();
    const resp = await fetch('/api/pay', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${idToken}` },
      body: JSON.stringify({ email, name, productIds: cartIds })
    });

    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || 'Payment initialization failed');

    const { reference, amount } = data;

    const timeoutAt = Date.now() + 5000;
    while (!PAYSTACK_READY && Date.now() < timeoutAt)
      await new Promise(r => setTimeout(r, 100));

    if (!window.PaystackPop) throw new Error('Paystack not available');
    if (!PAYSTACK_PUBLIC_KEY) throw new Error('Missing Paystack public key');

    const handler = PaystackPop.setup({
      key: PAYSTACK_PUBLIC_KEY,
      email: email,
      amount: Math.round(Number(amount) * 100),
      currency: 'NGN',
      ref: reference,
      callback_url: window.location.origin + '/',
      metadata: {
        custom_fields: [
          {
            display_name: 'Buyer name',
            variable_name: 'buyer_name',
            value: name || ''
          }
        ],
        productIds: cartIds
      },
      callback: function(response) {
        verifyCartPayment(response.reference, email);
      },
      onClose: function() {
        if (btn) {
          btn.disabled = false;
          btn.textContent = 'Proceed to Payment';
        }
        showToast('Payment was closed. Try again when ready.', 'info');
      }
    });

    handler.openIframe();

  } catch (err) {
    console.error(err);
    showToast(err.message || 'Payment failed. Please try again.', 'error');

  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = 'Proceed to Payment';
    }
  }
}

async function verifyCartPayment(reference, purchaserEmail) {
  try {
    const res = await fetch('/api/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reference, purchaserEmail })
    });

    const data = await res.json();

    if (res.ok && data.status === 'success') {
      saveCart([]); // clear cart now that the order went through
      closeCartOverlay();
      showToast('Payment successful! 🎉 Your book will be emailed to you shortly.', 'success', 6000);
      window.location.href = '/';
    } else {
      console.warn('verify failed', data);
      showToast('Verification failed. Please contact support.', 'error');
    }

  } catch (e) {
    console.error(e);
    showToast('Verification request failed. Please try again.', 'error');
  }
}

// ====== Cart UI wiring ======
function goToCartAuth(path) {
  // Same handoff mechanism as requireSignIn() — remembers a checkout was in
  // progress so msbResumeCheckout() reopens the cart and picks up right
  // where they left off once they're signed in.
  try { sessionStorage.setItem('msb_resume_action', 'checkout'); } catch (e) {}
  window.location.href = path + '?returnTo=' + encodeURIComponent('/');
}

function _wireCartButtons() {
  document.getElementById('cartIcon')?.addEventListener('click', openCartOverlay);
  document.getElementById('cartCloseBtn')?.addEventListener('click', closeCartOverlay);
  document.getElementById('cartProceedBtn')?.addEventListener('click', proceedCartToPayment);
  document.getElementById('cartSignInBtn')?.addEventListener('click', () => goToCartAuth('/login'));
  document.getElementById('cartSignUpBtn')?.addEventListener('click', () => goToCartAuth('/signup'));
  document.getElementById('cartSwitchAccountBtn')?.addEventListener('click', () => {
    window.MSBAuth && window.MSBAuth.signOut();
  });
  updateCartBadge();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', _wireCartButtons);
} else {
  _wireCartButtons();
}

// ── Paystack redirect mode handler ──────────────────────────────────────────
// On mobile, Paystack sometimes redirects to this page instead of calling the
// inline popup callback. We detect that here and trigger verify automatically.
(async function handlePaystackRedirect() {
  const params = new URLSearchParams(window.location.search);
  const reference = params.get('reference') || params.get('trxref');
  if (!reference) return;

  // Clean the URL immediately so a page refresh doesn't re-trigger this
  const cleanUrl = window.location.pathname;
  window.history.replaceState({}, document.title, cleanUrl);

  showToast('Confirming your payment…', 'info', 8000);

  try {
    const res = await fetch('/api/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reference })
    });

    const data = await res.json();

    if (res.ok && data.status === 'success') {
      saveCart([]);
      showToast('Payment confirmed! 🎉 Your book will be emailed to you shortly.', 'success', 8000);
    } else {
      showToast('Payment received but confirmation had an issue. Please check your email or visit My Orders.', 'error', 10000);
    }
  } catch (e) {
    console.error('Redirect verify error:', e);
    showToast('Could not confirm payment automatically. Please check My Orders or contact support.', 'error', 10000);
  }
})();
      
/* ===========================
SEARCH + SUGGESTIONS
=========================== */

function showSuggestions() {
  const q = (document.getElementById('searchInput').value || '').trim().toLowerCase();
  const box = document.getElementById('suggestionsBox');

  if (!box) return;
  if (!q) { box.style.display = 'none'; box.innerHTML = ''; return; }

  const matches = PRODUCTS.filter(p =>
    (p.title || '').toLowerCase().includes(q) || (p.id || '').toLowerCase().includes(q)
  ).slice(0, 8);

  if (!matches.length) { box.style.display = 'none'; box.innerHTML = ''; return; }

  box.innerHTML = matches.map(m => {
    return `<div class="item" role="option" data-product-id="${escapeHtml(m.id || '')}">` +
             `<div class="label">${escapeHtml(m.title)}</div>` +
             `<div class="meta">${formatPrice(m)}</div>` +
           `</div>`;
  }).join('');

  box.style.display = 'block';
  box.setAttribute('aria-hidden', 'false');
}

// suggestion click -> set input & filter
document.getElementById('suggestionsBox')?.addEventListener('click', function(ev){
  const item = ev.target.closest('.item');
  if (!item) return;
  const id = item.getAttribute('data-product-id');
  if (!id) return;
  const product = PRODUCTS.find(p => p.id === id);
  if (!product) return;
  document.getElementById('searchInput').value = product.title;
  // hide suggestions
  const box = document.getElementById('suggestionsBox');
  if (box) { box.style.display = 'none'; box.innerHTML = ''; box.setAttribute('aria-hidden','true'); }
  performSearch();
});

// performSearch: filters across all products and shows results in the search section
function performSearch() {
  const query = (document.getElementById('searchInput').value || '').trim().toLowerCase();
  const ourSection = document.getElementById('ourBooksSection');
  const featuredSections = [
    document.getElementById('featuredSection'),
    document.getElementById('featuredSection2'),
    document.getElementById('featuredSection3')
  ];
  const searchSection = document.getElementById('searchResultsSection');
  const searchGrid = document.getElementById('searchGrid');

  if (!query) { msbSearchActive = false; renderProducts(); return; }

  const filtered = PRODUCTS.filter(p =>
    (p.title || '').toLowerCase().includes(query) || (p.id || '').toLowerCase().includes(query)
  );

  msbSearchActive = true;
  if (ourSection) ourSection.style.display = 'none';
  featuredSections.forEach(s => { if (s) s.style.display = 'none'; });
  if (searchSection) searchSection.style.display = '';
  updateAuthCtaVisibility();

  if (!searchGrid) return;
  if (!filtered.length) {
    searchGrid.innerHTML = `<div style="padding:20px;grid-column:1/-1">No books found for "<strong>${escapeHtml(query)}</strong>"</div>`;
    return;
  }

  renderGrid(searchGrid, filtered);

  const box = document.getElementById('suggestionsBox');
  if (box) { box.style.display = 'none'; box.innerHTML = ''; box.setAttribute('aria-hidden', 'true'); }
}

// close suggestions / close sidebar on outside click
document.addEventListener('click', function (ev) {
  const box = document.getElementById('suggestionsBox');
  const wrapper = document.querySelector('.search-wrapper');
  if (box && wrapper) {
    if (!wrapper.contains(ev.target)) {
      box.style.display = 'none';
      box.innerHTML = '';
    }
  }

  // sidebar close on outside click
  const sidebar = document.getElementById('sidebar');
  const hamburger = document.querySelector('.hamburger');
  if (sidebar && sidebar.getAttribute('data-open') === 'true') {
    if (!sidebar.contains(ev.target) && hamburger && !hamburger.contains(ev.target)) {
      sidebar.setAttribute('data-open', 'false');
      sidebar.style.left = '-300px';
      sidebar.setAttribute('aria-hidden', 'true');
    }
  }
});

// close sidebar / cart overlay on ESC
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    const sidebar = document.getElementById('sidebar');
    if (sidebar && sidebar.getAttribute('data-open') === 'true') {
      sidebar.setAttribute('data-open', 'false');
      sidebar.style.left = '-300px';
      sidebar.setAttribute('aria-hidden', 'true');
    }
    const cartOverlay = document.getElementById('cartOverlay');
    if (cartOverlay && cartOverlay.classList.contains('show')) closeCartOverlay();
    const wishlistDrawer = document.getElementById('wishlistAuthBackdrop');
    if (wishlistDrawer && wishlistDrawer.classList.contains('show')) closeWishlistAuthDrawer();
  }
});

// expose to window
window.toggleSidebar = toggleSidebar;
window.openMyOrders = openMyOrders;
window.openContact = openContact;
window.followYoutube = followYoutube;
window.openCartOverlay = openCartOverlay;
window.closeCartOverlay = closeCartOverlay;
window.proceedCartToPayment = proceedCartToPayment;
window.openReview = openReview;
window.showSuggestions = showSuggestions;
window.performSearch = performSearch;
window.openWishlist = openWishlist;
window.toggleWishlist = toggleWishlist;
window.isInWishlist = isInWishlist;
window.getWishlist = getWishlist;
window.wishlistToggleButton = wishlistToggleButton;
window.openWishlistAuthDrawer = openWishlistAuthDrawer;
window.closeWishlistAuthDrawer = closeWishlistAuthDrawer;
window.fetchWishlist = fetchWishlist;
window.isWishlistFetched = () => wishlistFetched;
