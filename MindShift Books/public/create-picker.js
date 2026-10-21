/* ═══════════════════════════════════════════════════════════════════════
   CREATE PICKER — shared across articles.html, article-read.html,
   profile.html, books.html, insights.html, settings.html.
   Replaces the old direct "/write" link: tapping "Create" now opens a
   small bottom sheet letting the user choose Post or Article, instead of
   jumping straight into the article editor.
   Also injects a floating "+" button (bottom-right, like Substack's) that
   opens the exact same sheet — just a faster-to-reach shortcut to the
   sidebar's existing "Create" item, not a second/different flow.
   Plain script (not a module) so it works on every page unchanged. Builds
   its own markup + styles on load so no per-page HTML edits are needed
   beyond swapping the sidebar item / buttons to call openCreatePicker().
   ═══════════════════════════════════════════════════════════════════════ */
(function(){
  function inject(){
    if(document.getElementById('cpk-overlay')) return; // already injected

    var style = document.createElement('style');
    style.textContent = `
#cpk-fab{position:fixed;right:16px;bottom:max(env(safe-area-inset-bottom,0px),16px);width:52px;height:52px;border-radius:16px;
  background:linear-gradient(135deg,#4f46e5,#06b6d4);border:none;cursor:pointer;z-index:900;
  display:flex;align-items:center;justify-content:center;box-shadow:0 10px 24px -8px rgba(79,70,229,.65);
  transition:transform .22s cubic-bezier(.34,1.4,.64,1)}
#cpk-fab:active{transform:scale(.92)}
#cpk-fab svg{width:22px;height:22px;stroke:#fff;fill:none;stroke-width:2.4;stroke-linecap:round;stroke-linejoin:round}
#cpk-overlay{position:fixed;inset:0;background:rgba(11,18,32,.45);z-index:9998;opacity:0;pointer-events:none;transition:opacity .28s ease;
  -webkit-backdrop-filter:blur(6px);backdrop-filter:blur(6px)}
#cpk-overlay.on{opacity:1;pointer-events:all}
#cpk-sheet{position:fixed;left:0;right:0;bottom:0;z-index:9999;background:var(--c-bg,#fff);border-radius:28px 28px 0 0;
  max-width:480px;margin:0 auto;transform:translateY(100%);transition:transform .42s cubic-bezier(.2,.9,.25,1);
  padding:0 0 max(env(safe-area-inset-bottom,0px),14px);box-shadow:0 0 0 .5px var(--ds-hairline,rgba(15,23,42,.08)),0 -18px 60px -12px rgba(15,23,42,.35)}
#cpk-sheet.on{transform:translateY(0)}
.cpk-drag{width:36px;height:5px;border-radius:3px;background:var(--c-handle,rgba(15,23,42,.16));margin:10px auto 0}
.cpk-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;padding:16px 20px 6px}
.cpk-title{font-size:23px;font-weight:800;letter-spacing:-.03em;color:var(--c-ink,#0b1220);line-height:1.15}
.cpk-subtitle{font-size:14px;color:var(--c-sub,#566074);margin-top:3px;letter-spacing:-.005em}
.cpk-x{width:34px;height:34px;border-radius:50%;border:none;background:var(--ds-fill,rgba(15,23,42,.055));color:var(--c-sub,#566074);display:flex;align-items:center;justify-content:center;
  cursor:pointer;flex-shrink:0;transition:transform .2s cubic-bezier(.34,1.4,.64,1),background .15s}
.cpk-x:active{transform:scale(.9);background:var(--ds-fill-2,rgba(15,23,42,.09))}
.cpk-opts{display:flex;flex-direction:column;gap:12px;padding:14px 16px 0}
.cpk-opt{position:relative;display:flex;align-items:center;gap:15px;width:100%;text-align:left;border:none;border-radius:20px;background:var(--c-bg,#fff);
  padding:15px 14px 15px 15px;cursor:pointer;font-family:inherit;-webkit-tap-highlight-color:transparent;
  box-shadow:0 0 0 1px var(--ds-hairline,rgba(15,23,42,.08)),0 2px 6px rgba(15,23,42,.05);
  transition:transform .22s cubic-bezier(.34,1.4,.64,1),box-shadow .2s,background .15s}
.cpk-opt:active{transform:scale(.975);background:var(--c-surface,#f8f9fd)}
.cpk-opt-ico{width:54px;height:54px;border-radius:17px;display:flex;align-items:center;justify-content:center;flex-shrink:0}
.cpk-opt-ico.post{background:linear-gradient(135deg,#4f46e5,#06b6d4);box-shadow:0 10px 20px -8px rgba(79,70,229,.7)}
.cpk-opt-ico.article{background:linear-gradient(135deg,#7c3aed,#ec4899);box-shadow:0 10px 20px -8px rgba(124,58,237,.65)}
.cpk-opt-ico svg{width:26px;height:26px;stroke:#fff;fill:none;stroke-width:1.9;stroke-linecap:round;stroke-linejoin:round}
.cpk-opt-txt{flex:1;min-width:0}
.cpk-opt-lbl{font-size:17px;font-weight:800;letter-spacing:-.02em;color:var(--c-ink,#0b1220)}
.cpk-opt-sub{font-size:13px;color:var(--c-sub,#566074);margin-top:3px;line-height:1.4}
.cpk-opt-arrow{width:30px;height:30px;border-radius:50%;background:var(--ds-fill,rgba(15,23,42,.055));color:var(--c-sub,#566074);display:flex;align-items:center;justify-content:center;flex-shrink:0}
.cpk-cancel{display:block;margin:10px auto 0;padding:12px 28px;border:none;border-radius:999px;background:none;color:var(--c-sub,#566074);
  font-size:14.5px;font-weight:700;cursor:pointer;font-family:inherit}
.cpk-cancel:active{background:var(--ds-fill,rgba(15,23,42,.055))}
@media (prefers-reduced-motion:reduce){#cpk-sheet,#cpk-overlay,.cpk-opt{transition-duration:.01ms}}
`;
    document.head.appendChild(style);

    var overlay = document.createElement('div');
    overlay.id = 'cpk-overlay';
    overlay.onclick = window.closeCreatePicker;
    document.body.appendChild(overlay);

    var sheet = document.createElement('div');
    sheet.id = 'cpk-sheet';
    sheet.innerHTML =
      '<div class="cpk-drag"></div>' +
      '<div class="cpk-head">' +
        '<div><div class="cpk-title">Create</div><div class="cpk-subtitle">What do you want to share?</div></div>' +
        '<button class="cpk-x" aria-label="Close" onclick="window.closeCreatePicker()"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>' +
      '</div>' +
      '<div class="cpk-opts">' +
        '<button class="cpk-opt" onclick="window.location.href=\'/create-post\'">' +
          '<div class="cpk-opt-ico post"><svg viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="4"/><circle cx="8.5" cy="8.5" r="1.6"/><polyline points="21 15 16 10 5 21"/></svg></div>' +
          '<div class="cpk-opt-txt"><div class="cpk-opt-lbl">Post</div><div class="cpk-opt-sub">A quick update with up to 5 photos</div></div>' +
          '<div class="cpk-opt-arrow"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg></div>' +
        '</button>' +
        '<button class="cpk-opt" onclick="window.location.href=\'/write\'">' +
          '<div class="cpk-opt-ico article"><svg viewBox="0 0 24 24"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 013 3L7 19l-4 1 1-4L16.5 3.5z"/></svg></div>' +
          '<div class="cpk-opt-txt"><div class="cpk-opt-lbl">Article</div><div class="cpk-opt-sub">A full write-up with a cover image</div></div>' +
          '<div class="cpk-opt-arrow"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg></div>' +
        '</button>' +
      '</div>' +
      '<button class="cpk-cancel" onclick="window.closeCreatePicker()">Cancel</button>';
    document.body.appendChild(sheet);

    // The floating "+" is only for the main feed (For You / Following /
    // Explore all live on this one page, articles.html, served at "/").
    // Everywhere else that loads this script (article-read, post-read,
    // profile, books, settings, insights, suggestions) still gets the
    // sheet + overlay wired up — just no floating button cluttering a
    // reading screen — and "Create" in the sidebar still works there too.
    if (isFeedPage()) {
      var fab = document.createElement('button');
      fab.id = 'cpk-fab';
      fab.type = 'button';
      fab.setAttribute('aria-label', 'Create');
      fab.innerHTML = '<svg viewBox="0 0 24 24"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>';
      fab.onclick = window.openCreatePicker;
      document.body.appendChild(fab);
    }
  }

  function isFeedPage(){
    var path = location.pathname.replace(/\/+$/, '') || '/';
    return path === '/' || path === '/articles' || path === '/articles.html' || path === '/index' || path === '/index.html';
  }

  window.openCreatePicker = function(){
    inject();
    document.getElementById('cpk-overlay').classList.add('on');
    requestAnimationFrame(function(){
      document.getElementById('cpk-sheet').classList.add('on');
    });
    document.body.style.overflow = 'hidden';
  };

  window.closeCreatePicker = function(){
    var overlay = document.getElementById('cpk-overlay');
    var sheet = document.getElementById('cpk-sheet');
    if(sheet) sheet.classList.remove('on');
    if(overlay) overlay.classList.remove('on');
    document.body.style.overflow = '';
  };

  // Inject immediately (not just on first openCreatePicker() call) so the
  // floating "+" button is visible on page load, not only after someone
  // taps "Create" in the sidebar once.
  if (document.body) inject();
  else document.addEventListener('DOMContentLoaded', inject);
})();
