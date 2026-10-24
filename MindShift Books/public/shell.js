/* ═══════════════════════════════════════════════════════════════════════
   MindShift Books — shell.js  (desktop behaviour; layout itself is /shell.css)
   Loaded deferred on every page that has  <html data-layout="…">.  Does nothing on phones.

   • makes sure the sidebar exists (some pages never loaded it) so the left rail can show
   • adds Search + Messages to the rail and highlights the page you are on
   • builds the right rail (search, what's new, create, discover links) on feed / reading / profile pages
   • keyboard shortcuts:   /  search     c  create     g h  home     g m  messages     ?  help
   Edit RIGHT_RAIL below to change what appears in the right rail.
   ═══════════════════════════════════════════════════════════════════════ */
(function () {
  var html = document.documentElement;
  var layout = html.getAttribute('data-layout');
  if (!layout) return;

  var RIGHT_RAIL_LAYOUTS = { feed: 1, read: 1, profile: 1 };
  var WHATS_NEW = { title: "What's new", text: 'Link previews, full-screen images, sharing straight to a chat, and a new dark mode.' };
  var mqRail = window.matchMedia('(min-width:1024px)');
  var mqRight = window.matchMedia('(min-width:1280px)');
  var path = (location.pathname.replace(/\/+$/, '') || '/').replace(/\.html$/, '');

  var I = {
    search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><line x1="20" y1="20" x2="16.2" y2="16.2"/></svg>',
    chat: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.4 8.4 0 01-.9 3.8 8.5 8.5 0 01-7.6 4.7 8.4 8.4 0 01-3.8-.9L3 21l1.9-5.7a8.4 8.4 0 01-.9-3.8 8.5 8.5 0 014.7-7.6 8.4 8.4 0 013.8-.9h.5a8.5 8.5 0 018 8z"/></svg>',
    spark: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z"/></svg>',
    book: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M2 4h6a4 4 0 014 4v13a3 3 0 00-3-3H2z"/><path d="M22 4h-6a4 4 0 00-4 4v13a3 3 0 013-3h7z"/></svg>',
    gift: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="8" width="18" height="4"/><path d="M12 8v13M19 12v9H5v-9M7.5 8a2.5 2.5 0 010-5C11 3 12 8 12 8s1-5 4.5-5a2.5 2.5 0 010 5"/></svg>',
    share: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.6" y1="13.5" x2="15.4" y2="17.5"/><line x1="15.4" y1="6.5" x2="8.6" y2="10.5"/></svg>'
  };

  function openSearch() {
    if (typeof window.openSearchScreen === 'function') window.openSearchScreen();
    else location.href = '/?search=1';
  }
  function openCreate() {
    if (typeof window.msOpenCreate === 'function') window.msOpenCreate();
    else if (typeof window.openCreatePicker === 'function') window.openCreatePicker();
    else location.href = '/create-post';
  }

  /* ── 1. the sidebar must exist for the rail ── */
  var railTried = false;
  function ensureSidebar() {
    if (railTried || !mqRail.matches) return;
    if (document.getElementById('sidebar') || document.getElementById('sidebar-slot')) { railTried = true; return; }
    railTried = true;
    var slot = document.createElement('div'); slot.id = 'sidebar-slot';
    document.body.insertBefore(slot, document.body.firstChild);
    var s = document.createElement('script'); s.src = '/sidebar-nav.js'; document.body.appendChild(s);
  }

  /* ── 2. decorate the rail: extra items + current page ── */
  function li(label, icon, onclick) {
    var e = document.createElement('li');
    e.setAttribute('data-shell', '1');
    e.innerHTML = '<span class="sb-ico">' + icon + '</span><span class="sb-label">' + label + '</span>';
    e.addEventListener('click', onclick);
    return e;
  }
  function decorateRail() {
    var sb = document.getElementById('sidebar'); if (!sb) return false;
    var group = sb.querySelector('.sb-group'); if (!group) return false;
    if (!group.querySelector('[data-shell]')) {
      var home = group.firstElementChild;
      var search = li('Search', I.search, openSearch);
      var msgs = li('Messages', I.chat, function () { location.href = '/messages'; });
      if (home && home.nextSibling) { group.insertBefore(search, home.nextSibling); group.insertBefore(msgs, search.nextSibling); }
      else { group.appendChild(search); group.appendChild(msgs); }
    }
    var items = sb.querySelectorAll('.sb-group li');
    for (var i = 0; i < items.length; i++) {
      var oc = items[i].getAttribute('onclick') || '', m = /href\s*=\s*'([^']+)'/.exec(oc), target = m ? m[1].split('#')[0] : '';
      var on = false;
      if (target === '/') on = (path === '/' || path === '/articles');
      else if (target) on = (path === target || path.indexOf(target + '/') === 0);
      if (items[i].getAttribute('data-shell') && items[i].textContent.trim() === 'Messages') on = (path === '/messages');
      items[i].classList.toggle('is-active', on);
    }
    return true;
  }
  function watchRail() {
    if (!mqRail.matches) return;
    ensureSidebar();
    var tries = 0, t = setInterval(function () { tries++; if (decorateRail() || tries > 40) clearInterval(t); }, 150);
    try {   // the sidebar re-renders some rows after login state arrives: keep the highlight right
      var sb = document.getElementById('sidebar');
      if (sb) new MutationObserver(function () { decorateRail(); }).observe(sb, { childList: true, subtree: true, attributes: true, attributeFilter: ['style'] });
    } catch (e) {}
  }

  /* ── 3. right rail ── */
  var built = false;
  function row(href, icon, title, sub) {
    return '<a class="sr-row" href="' + href + '"><span class="sr-ic">' + icon + '</span><span>' + title + (sub ? '<small>' + sub + '</small>' : '') + '</span></a>';
  }
  function buildRight() {
    if (built || !RIGHT_RAIL_LAYOUTS[layout] || !mqRight.matches) return;
    built = true;
    var el = document.createElement('aside'); el.id = 'shell-right'; el.setAttribute('aria-label', 'More');
    el.innerHTML =
      '<button type="button" class="sr-search" id="srSearch">' + I.search + '<span>Search MindShift Books</span><kbd>/</kbd></button>' +
      '<section class="sr-card" id="srWho"><h3>Who to follow</h3><div class="sr-skel"></div><div class="sr-skel"></div><div class="sr-skel"></div></section>' +
      '<section class="sr-card"><h3>' + WHATS_NEW.title + '</h3><p>' + WHATS_NEW.text + '</p><a class="sr-btn" href="/whats-new">See what\'s new</a></section>' +
      '<section class="sr-card"><h3>Create</h3>' +
        '<a class="sr-btn" href="/create-post">Write a post</a><a class="sr-btn alt" href="/write">Write an article</a></section>' +
      '<section class="sr-card"><h3>Discover</h3>' +
        row('/free-ebooks', I.gift, 'Free eBooks', 'Classic reads, free to read') +
        row('/books', I.book, 'Bookstore', 'Guides and ebooks') +
        row('/suggestions', I.spark, 'People to follow', 'Find creators you\'ll like') +
        row('/affiliate', I.share, 'Become an affiliate', 'Earn on every book') + '</section>' +
      '<div class="sr-foot"><a href="/legal">Terms &amp; Privacy</a><a href="/support">Support</a><a href="/whats-new">What\'s new</a><br>&copy; ' + new Date().getFullYear() + ' MindShift Books</div>';
    document.body.appendChild(el);
    document.getElementById('srSearch').addEventListener('click', openSearch);
    loadWho();
  }
  function esc(t) { return String(t == null ? '' : t).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function fmtN(n) { return n >= 1e6 ? (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'K' : String(n); }
  function loadWho() {
    var box = document.getElementById('srWho'); if (!box) return;
    fetch('/api/who-to-follow').then(function (r) { return r.json(); }).then(function (d) {
      var list = (d && d.people) || [];
      if (!list.length) { box.style.display = 'none'; return; }
      // a different handful each visit, so the same people aren't always on top
      var pick = list.slice().sort(function () { return Math.random() - 0.5; }).slice(0, 4);
      box.innerHTML = '<h3>Who to follow</h3>' + pick.map(function (u) {
        return '<a class="sr-person" href="/profile/@' + encodeURIComponent(u.username) + '"><img class="av" data-author-photo alt="' + esc(u.name) + '" src="' + esc(u.photo || '/logo.jpg') + '">' +
          '<span class="t"><b>' + esc(u.name) + '</b><small>@' + esc(u.username) + ' · ' + fmtN(u.followers) + ' followers</small></span></a>';
      }).join('') + '<a class="sr-more" href="/suggestions">Show more</a>';
    }).catch(function () { box.style.display = 'none'; });
  }

  /* ── 4. keyboard shortcuts (desktop only; never while typing) ── */
  var gWait = 0;
  document.addEventListener('keydown', function (e) {
    if (!mqRail.matches || e.metaKey || e.ctrlKey || e.altKey) return;
    var t = e.target, tag = (t && t.tagName) || '';
    if (/INPUT|TEXTAREA|SELECT/.test(tag) || (t && t.isContentEditable)) return;
    var k = e.key;
    if (k === '/') { e.preventDefault(); openSearch(); }
    else if (k === 'c') { e.preventDefault(); openCreate(); }
    else if (k === 'g') { gWait = Date.now(); }
    else if ((k === 'h' || k === 'm') && Date.now() - gWait < 1200) { gWait = 0; location.href = (k === 'h') ? '/' : '/messages'; }
    else if (k === '?') { toast('/ search   ·   c create   ·   g then h home   ·   g then m messages'); }
  });
  function toast(msg) {
    var d = document.createElement('div');
    d.style.cssText = 'position:fixed;left:50%;bottom:28px;transform:translateX(-50%);background:var(--c-ink-bg,#0f172a);color:#fff;padding:12px 18px;border-radius:14px;font:600 14px system-ui,sans-serif;z-index:100000;box-shadow:0 12px 30px rgba(0,0,0,.35)';
    d.textContent = msg; document.body.appendChild(d); setTimeout(function () { d.remove(); }, 3600);
  }

  /* ── Messages: the "pick a conversation" pane shown beside the list on desktop ── */
  function buildEmptyPane() {
    if (layout !== 'messages' || !mqRail.matches || document.getElementById('msgEmpty')) return;
    var d = document.createElement('div'); d.id = 'msgEmpty';
    d.innerHTML = '<div class="me-ic">' + I.chat + '</div><h2>Your messages</h2><p>Pick a conversation from the list, or start a new one to chat with a creator or reader.</p>';
    document.body.appendChild(d);
  }

  /* ── go ── */
  function init() { watchRail(); buildRight(); buildEmptyPane(); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
  var onChange = function () { init(); };
  if (mqRail.addEventListener) { mqRail.addEventListener('change', onChange); mqRight.addEventListener('change', onChange); }
  else { mqRail.addListener(onChange); mqRight.addListener(onChange); }
})();
