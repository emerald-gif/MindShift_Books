// public/main.js
// Loads products from server (/api/products)

// FIREBASE CONFIG (unchanged)
const firebaseConfig = {
  apiKey: "AIzaSyB5amYVfN2M6e1uUHvNh1cIlVD_Fa5g8eQ",
  authDomain: "iquote4all.firebaseapp.com",
  projectId: "iquote4all",
  storageBucket: "iquote4all.firebasestorage.app",
  messagingSenderId: "603028789594",
  appId: "1:603028789594:web:b5b9cc5fc9b35e4512bb63",
  measurementId: "G-TPW4DTTQEF"
};
firebase.initializeApp(firebaseConfig);
const db = firebase.firestore();

// runtime config
let PAYSTACK_PUBLIC_KEY = null;
let PUBLIC_PDF_URL = null;
let PAYSTACK_READY = false;
let PRODUCTS = []; // fetched from server

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
function openMyOrders(){ window.location.href = '/my-order.html'; }
function openContact(){ alert('Contact: mindshiftbooks.online@gmail.com'); }
function followYoutube(){ window.open('https://www.youtube.com/@MindShift_Books', '_blank'); }

// Fetch products from server
async function fetchProducts() {
  try {
    const res = await fetch('/api/products');
    const j = await res.json();
    PRODUCTS = (j && j.products) ? j.products : [];
    renderProducts();
  } catch (e) {
    console.error('Failed to fetch products', e);
    const el = document.getElementById('productGrid');
    if (el) el.innerHTML = '<div style="padding:20px;">Failed to load products.</div>';
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

// helper to format price
function formatPriceUSD(p) {
  if (!p) return '';
  const n = Number(p);
  if (Number.isNaN(n)) return '';
  return `$${n.toFixed(2)}`;
}

// Build the inner HTML for a single product card
function productCardInner(p) {
  return `
    <img src="${escapeHtml(p.cover || '')}" class="ebook-cover" alt="${escapeHtml(p.title || 'ebook')}"/>
    <div class="title">${escapeHtml(p.title || '')}</div>
    <div class="price">${formatPriceUSD(p.priceUSD)}</div>
    <div class="card-actions button-group" style="width:100%;">
      <button class="btn review-btn" data-product-id="${escapeHtml(p.id || '')}" data-action="review">Read Review</button>
      <button class="btn buy-btn" data-product-id="${escapeHtml(p.id || '')}" data-action="add-to-cart"><i class="fas fa-cart-plus"></i> Add to Cart</button>
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
  list.forEach(p => {
    const card = document.createElement('div');
    card.className = 'product-card';
    card.innerHTML = productCardInner(p);
    grid.appendChild(card);
  });
}

// Render product grids from PRODUCTS (from server), split into "Our Books" and "Featured" sections
function renderProducts() {
  const ourGrid = document.getElementById('ourBooksGrid');
  const featuredGrid = document.getElementById('featuredGrid');
  const ourSection = document.getElementById('ourBooksSection');
  const featuredSection = document.getElementById('featuredSection');
  const searchSection = document.getElementById('searchResultsSection');

  if (searchSection) searchSection.style.display = 'none';

  const ourBooks = PRODUCTS.filter(p => p.category === 'ours');
  const featuredBooks = PRODUCTS.filter(p => p.category !== 'ours');

  if (ourSection) ourSection.style.display = ourBooks.length ? '' : 'none';
  if (featuredSection) featuredSection.style.display = '';

  renderGrid(ourGrid, ourBooks, 'No books yet — check back soon.');
  renderGrid(featuredGrid, featuredBooks, 'No books available.');
}

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
});

// Review navigation
function openReview(productId){
  if (!productId) return;
  window.location.href = `/review.html?id=${encodeURIComponent(productId)}`;
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
    alert('This book is already in your cart.');
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

// Build the rows + total inside the cart overlay
function renderCartOverlay() {
  const list = document.getElementById('cartItemsList');
  const totalEl = document.getElementById('cartTotalPrice');
  if (!list || !totalEl) return;

  const cartIds = getCart();
  const items = cartIds.map(id => PRODUCTS.find(p => p.id === id)).filter(Boolean);

  // drop any stale ids that no longer match a real product — but only once
  // PRODUCTS has actually loaded, otherwise we'd wipe a valid cart on a slow load
  if (PRODUCTS.length && items.length !== cartIds.length) {
    saveCart(items.map(p => p.id));
  }

  if (!items.length) {
    if (cartIds.length && !PRODUCTS.length) {
      list.innerHTML = `<div class="muted" style="padding:24px;text-align:center;">Loading your cart…</div>`;
    } else {
      list.innerHTML = `<div class="muted" style="padding:24px;text-align:center;">Your cart is empty. Browse books and tap "Add to Cart".</div>`;
    }
    totalEl.textContent = formatPriceUSD(0);
    return;
  }

  list.innerHTML = items.map(p => `
    <div class="cart-item">
      <img src="${escapeHtml(p.cover || '')}" alt="${escapeHtml(p.title || '')}"/>
      <div class="cart-item-info">
        <div class="cart-item-title">${escapeHtml(p.title || '')}</div>
        <div class="cart-item-price">${formatPriceUSD(p.priceUSD)}</div>
      </div>
      <button class="cart-item-remove" data-action="remove-from-cart" data-product-id="${escapeHtml(p.id || '')}" aria-label="Remove from cart">
        <i class="fas fa-trash"></i>
      </button>
    </div>
  `).join('');

  const total = items.reduce((sum, p) => sum + Number(p.priceUSD || 0), 0);
  totalEl.textContent = formatPriceUSD(total);
}

function openCartOverlay() {
  renderCartOverlay();
  const overlay = document.getElementById('cartOverlay');
  if (!overlay) return;
  overlay.classList.add('show');
  overlay.setAttribute('aria-hidden', 'false');
  document.body.style.overflow = 'hidden';
}

function closeCartOverlay() {
  const overlay = document.getElementById('cartOverlay');
  if (!overlay) return;
  overlay.classList.remove('show');
  overlay.setAttribute('aria-hidden', 'true');
  document.body.style.overflow = '';
}

// ------------------ CART CHECKOUT (one payment for the whole cart) ------------------

async function proceedCartToPayment() {
  const email = (document.getElementById('cartBuyerEmail') || { value: '' }).value.trim();
  const name  = (document.getElementById('cartBuyerName') || { value: '' }).value.trim();
  const cartIds = getCart();

  if (!cartIds.length) {
    alert('Your cart is empty.');
    return;
  }
  if (!email || !/^\S+@\S+\.\S+$/.test(email)) {
    alert('Please enter a valid email');
    return;
  }

  const btn = document.getElementById('cartProceedBtn');
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Preparing...';
  }

  try {
    const resp = await fetch('/api/pay', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, productIds: cartIds })
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
        alert('Payment closed.');
      }
    });

    handler.openIframe();

  } catch (err) {
    console.error(err);
    alert(err.message || 'Payment failed');

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
      alert('Payment successful! Your books will be emailed shortly.');
      window.location.href = '/';
    } else {
      console.warn('verify failed', data);
      alert('Verification failed. Contact support.');
    }

  } catch (e) {
    console.error(e);
    alert('Verification request failed.');
  }
}

// ====== Cart UI wiring ======
function _wireCartButtons() {
  document.getElementById('cartIcon')?.addEventListener('click', openCartOverlay);
  document.getElementById('cartCloseBtn')?.addEventListener('click', closeCartOverlay);
  document.getElementById('cartProceedBtn')?.addEventListener('click', proceedCartToPayment);
  updateCartBadge();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', _wireCartButtons);
} else {
  _wireCartButtons();
}
      
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
             `<div class="meta">${formatPriceUSD(m.priceUSD)}</div>` +
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
  const featuredSection = document.getElementById('featuredSection');
  const searchSection = document.getElementById('searchResultsSection');
  const searchGrid = document.getElementById('searchGrid');

  if (!query) { renderProducts(); return; }

  const filtered = PRODUCTS.filter(p =>
    (p.title || '').toLowerCase().includes(query) || (p.id || '').toLowerCase().includes(query)
  );

  if (ourSection) ourSection.style.display = 'none';
  if (featuredSection) featuredSection.style.display = 'none';
  if (searchSection) searchSection.style.display = '';

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
