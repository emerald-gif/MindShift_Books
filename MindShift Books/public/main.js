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
let selectedProduct = null;
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

// Render product grid from PRODUCTS (from server)
function renderProducts() {
  const grid = document.getElementById('productGrid');
  if (!grid) return;
  grid.innerHTML = '';

  if (!PRODUCTS.length) {
    grid.innerHTML = '<div class="center" style="grid-column:1/-1;padding:24px;"><div class="muted">No books available.</div></div>';
    return;
  }

  PRODUCTS.forEach(p => {
    const card = document.createElement('div');
    card.className = 'product-card';
    card.innerHTML = `
      <img src="${escapeHtml(p.cover || '')}" class="ebook-cover" alt="${escapeHtml(p.title || 'ebook')}"/>
      <div class="title">${escapeHtml(p.title || '')}</div>
      <div class="price">${formatPriceUSD(p.priceUSD)}</div>
      <div class="card-actions button-group" style="width:100%;">
        <button class="btn review-btn" data-product-id="${escapeHtml(p.id || '')}" data-action="review">Read Review</button>
        <button class="btn buy-btn" data-product-id="${escapeHtml(p.id || '')}" data-action="buy">Buy eBook</button>
      </div>
    `;
    grid.appendChild(card);
  });
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
  if (action === 'buy') openCheckoutModal(productId);
});

// Review navigation
function openReview(productId){
  if (!productId) return;
  window.location.href = `/review.html?id=${encodeURIComponent(productId)}`;
}

// Modal and payment logic (FINAL FIXED VERSION)
function modalBackdrop() {
  return document.getElementById('modalBackdrop');
}

// Open modal as REAL overlay
function openCheckoutModal(productId) {
  selectedProduct = PRODUCTS.find(x => x.id === productId);
  if (!selectedProduct) { 
    alert('Product not found'); 
    return; 
  }

  // Fill modal values
  const mbTitle = document.getElementById('modalBookTitle');
  const mbPrice = document.getElementById('modalPrice');

  if (mbTitle) mbTitle.textContent = selectedProduct.title;
  if (mbPrice) mbPrice.textContent = `Price: ${formatPriceUSD(selectedProduct.priceUSD)}`;

  // Clear input
  const buyerEmailEl = document.getElementById('buyerEmail');
  const buyerNameEl = document.getElementById('buyerName');
  if (buyerEmailEl) buyerEmailEl.value = '';
  if (buyerNameEl) buyerNameEl.value = '';

  // Show modal properly (no more inline display)
  const modal = modalBackdrop();
  if (!modal) return;

  modal.classList.add('show');
  modal.setAttribute('aria-hidden', 'false');

  // Disable page scroll
  document.body.style.overflow = 'hidden';
}

// Close modal
function closeCheckoutModal() {
  const modal = modalBackdrop();
  if (!modal) return;

  modal.classList.remove('show');
  modal.setAttribute('aria-hidden', 'true');

  // Restore page scroll
  document.body.style.overflow = '';
}

// Close modal by clicking outside
document.addEventListener('click', function (e) {
  const modal = modalBackdrop();
  if (!modal) return;
  if (modal.getAttribute('aria-hidden') === 'true') return;

  // If clicked directly on the dark backdrop
  if (e.target === modal) closeCheckoutModal();
});

// Close modal with ESC key
document.addEventListener('keydown', function (e) {
  if (e.key === 'Escape') closeCheckoutModal();
});


// ------------------ PAYMENT LOGIC ------------------ //

async function proceedToPayment() {
  const email = (document.getElementById('buyerEmail') || { value: '' }).value.trim();
  const name  = (document.getElementById('buyerName') || { value: '' }).value.trim();

  if (!email || !/^\S+@\S+\.\S+$/.test(email)) {
    alert('Please enter a valid email');
    return;
  }
  if (!selectedProduct) {
    alert('No product selected');
    return;
  }

  const btn = document.getElementById('modalProceedBtn');
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Preparing...';
  }

  try {
    const resp = await fetch('/api/pay', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, productId: selectedProduct.id })
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
        productId: selectedProduct.id
      },
      callback: function(response) {
        verifyPayment(response.reference, email);
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


async function verifyPayment(reference, purchaserEmail) {
  try {
    const res = await fetch('/api/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reference, purchaserEmail })
    });

    const data = await res.json();

    if (res.ok && data.status === 'success') {
      alert('Payment successful! The file will be emailed shortly.');
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

// performSearch: filters the grid in-place (no navigation)
function performSearch() {
  const query = (document.getElementById('searchInput').value || '').trim().toLowerCase();
  const grid = document.getElementById('productGrid');

  if (!query) { renderProducts(); return; }

  const filtered = PRODUCTS.filter(p =>
    (p.title || '').toLowerCase().includes(query) || (p.id || '').toLowerCase().includes(query)
  );

  grid.innerHTML = '';
  if (!filtered.length) {
    grid.innerHTML = `<div style="padding:20px;grid-column:1/-1">No books found for "<strong>${escapeHtml(query)}</strong>"</div>`;
    return;
  }

  filtered.forEach(p => {
    const card = document.createElement('div');
    card.className = 'product-card';
    card.innerHTML = `
      <img src="${escapeHtml(p.cover || '')}" class="ebook-cover" alt="${escapeHtml(p.title)}" />
      <div class="title">${escapeHtml(p.title)}</div>
      <div class="price">${formatPriceUSD(p.priceUSD)}</div>
      <div class="card-actions button-group" style="width:100%;">
        <button class="btn review-btn" data-product-id="${escapeHtml(p.id || '')}" data-action="review">Read Review</button>
        <button class="btn buy-btn" data-product-id="${escapeHtml(p.id || '')}" data-action="buy">Buy eBook</button>
      </div>
    `;
    grid.appendChild(card);
  });

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

// close sidebar on ESC
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    const sidebar = document.getElementById('sidebar');
    if (sidebar && sidebar.getAttribute('data-open') === 'true') {
      sidebar.setAttribute('data-open', 'false');
      sidebar.style.left = '-300px';
      sidebar.setAttribute('aria-hidden', 'true');
    }
    const modal = modalBackdrop();
    if (modal && modal.style.display === 'flex') modal.style.display = 'none';
  }
});

// expose to window
window.toggleSidebar = toggleSidebar;
window.openMyOrders = openMyOrders;
window.openContact = openContact;
window.followYoutube = followYoutube;
window.openCheckoutModal = openCheckoutModal;
window.closeCheckoutModal = closeCheckoutModal;
window.proceedToPayment = proceedToPayment;
window.openReview = openReview;
window.showSuggestions = showSuggestions;
window.performSearch = performSearch;
