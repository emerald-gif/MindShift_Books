/* ═══════════════════════════════════════════════════════════════════════
   CREATE PICKER — shared across articles.html, article-read.html,
   profile.html, books.html, insights.html, settings.html.
   Replaces the old direct "/write" link: tapping "Create" now opens a
   small bottom sheet letting the user choose Post or Article, instead of
   jumping straight into the article editor.
   Plain script (not a module) so it works on every page unchanged. Builds
   its own markup + styles on load so no per-page HTML edits are needed
   beyond swapping the sidebar item / buttons to call openCreatePicker().
   ═══════════════════════════════════════════════════════════════════════ */
(function(){
  function inject(){
    if(document.getElementById('cpk-overlay')) return; // already injected

    var style = document.createElement('style');
    style.textContent = `
#cpk-overlay{position:fixed;inset:0;background:rgba(15,10,30,.55);z-index:9998;opacity:0;pointer-events:none;transition:opacity .25s;backdrop-filter:blur(3px)}
#cpk-overlay.on{opacity:1;pointer-events:all}
#cpk-sheet{position:fixed;left:0;right:0;bottom:0;z-index:9999;background:#fff;border-radius:22px 22px 0 0;
  max-width:480px;margin:0 auto;transform:translateY(100%);transition:transform .35s cubic-bezier(.22,1,.36,1);
  padding:0 0 max(env(safe-area-inset-bottom,0px),18px);box-shadow:0 -8px 40px rgba(37,99,235,.16)}
#cpk-sheet.on{transform:translateY(0)}
.cpk-bar{height:3px;background:linear-gradient(90deg,#4f46e5,#06b6d4 55%,#ec4899);border-radius:22px 22px 0 0}
.cpk-drag{width:36px;height:4px;border-radius:2px;background:#e5e7eb;margin:12px auto 4px}
.cpk-title{font-size:15px;font-weight:800;color:#0f172a;text-align:center;padding:8px 20px 14px}
.cpk-opts{display:flex;flex-direction:column;gap:10px;padding:0 18px}
.cpk-opt{display:flex;align-items:center;gap:14px;width:100%;text-align:left;border:1.5px solid #e5e7eb;
  border-radius:16px;background:#fff;padding:14px 16px;cursor:pointer;font-family:inherit;transition:all .15s}
.cpk-opt:hover{border-color:#4f46e5;background:#eef2ff}
.cpk-opt:active{transform:scale(.98)}
.cpk-opt-ico{width:44px;height:44px;border-radius:13px;background:linear-gradient(135deg,#e0e7ff,#eef2ff);
  display:flex;align-items:center;justify-content:center;flex-shrink:0}
.cpk-opt-ico svg{width:22px;height:22px;stroke:#4f46e5;fill:none;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}
.cpk-opt-txt{flex:1}
.cpk-opt-lbl{font-size:14.5px;font-weight:800;color:#0f172a}
.cpk-opt-sub{font-size:12px;color:#9ca3af;margin-top:2px;line-height:1.4}
.cpk-opt-arrow{color:#c7d2fe;flex-shrink:0}
.cpk-cancel{display:block;width:calc(100% - 36px);margin:14px 18px 0;padding:13px;border:none;border-radius:14px;
  background:#f1f5f9;color:#6b7280;font-size:14px;font-weight:700;cursor:pointer;font-family:inherit}
`;
    document.head.appendChild(style);

    var overlay = document.createElement('div');
    overlay.id = 'cpk-overlay';
    overlay.onclick = window.closeCreatePicker;
    document.body.appendChild(overlay);

    var sheet = document.createElement('div');
    sheet.id = 'cpk-sheet';
    sheet.innerHTML =
      '<div class="cpk-bar"></div>' +
      '<div class="cpk-drag"></div>' +
      '<div class="cpk-title">What do you want to create?</div>' +
      '<div class="cpk-opts">' +
        '<button class="cpk-opt" onclick="window.location.href=\'/create-post\'">' +
          '<div class="cpk-opt-ico"><svg viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg></div>' +
          '<div class="cpk-opt-txt"><div class="cpk-opt-lbl">Post</div><div class="cpk-opt-sub">Quick text update — attach up to 5 photos</div></div>' +
          '<svg class="cpk-opt-arrow" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>' +
        '</button>' +
        '<button class="cpk-opt" onclick="window.location.href=\'/write\'">' +
          '<div class="cpk-opt-ico"><svg viewBox="0 0 24 24"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg></div>' +
          '<div class="cpk-opt-txt"><div class="cpk-opt-lbl">Article</div><div class="cpk-opt-sub">Full write-up with a cover image and category</div></div>' +
          '<svg class="cpk-opt-arrow" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>' +
        '</button>' +
      '</div>' +
      '<button class="cpk-cancel" onclick="window.closeCreatePicker()">Cancel</button>';
    document.body.appendChild(sheet);
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
})();
