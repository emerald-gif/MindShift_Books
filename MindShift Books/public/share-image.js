/* ══════════════════════════════════════════════════════════════════════
   SHARE-AS-IMAGE
   ──────────────────────────────────────────────────────────────────────
   Turns a post or article into a shareable image card — a "Grid" (square,
   1080x1080) or "Stories" (portrait, 1080x1920) format, matching the
   toggle Substack uses for their Notes. Reuses the exact html2canvas
   pattern already proven in whoami.html: build the real card off-screen
   at true pixel resolution, capture it, hand the PNG to the Web Share API
   (with a caption/link fallback chain) or a plain download.

   Include on any page with:
       <script src="https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js"></script>
       <script src="/share-image.js"></script>
   then call:
       window.openShareImageCard({
         type: 'post' | 'article',
         id, author, avatar, publishedAt,
         text,              // posts: the post body
         title, brief,      // articles: heading + summary
         image              // optional — post's first image, or article cover
       });

   Every page that has post/article data already loaded (articles.html's
   card menus, post-read.html/article-read.html's share sheets) calls this
   with whatever fields it already has in memory — this file doesn't fetch
   anything itself.
   ══════════════════════════════════════════════════════════════════════ */
(function () {
  if (window.openShareImageCard) return; // already loaded on this page

  var CSS =
    '.shareimg-overlay{position:fixed;inset:0;background:rgba(15,23,42,.55);z-index:2400;opacity:0;pointer-events:none;transition:opacity .25s}' +
    '.shareimg-overlay.on{opacity:1;pointer-events:all}' +
    '.shareimg-sheet{position:fixed;left:0;right:0;bottom:0;z-index:2401;background:#fff;border-radius:22px 22px 0 0;padding:14px 18px max(env(safe-area-inset-bottom,0px),18px);transform:translateY(100%);transition:transform .32s cubic-bezier(.32,0,.15,1);max-height:92vh;overflow-y:auto;box-sizing:border-box}' +
    '.shareimg-sheet.on{transform:none}' +
    '.shareimg-bar{width:36px;height:4px;background:#e5e7eb;border-radius:99px;margin:0 auto 14px}' +
    '.shareimg-hdr{display:flex;align-items:center;justify-content:space-between;margin-bottom:14px}' +
    '.shareimg-hdr h4{margin:0;font-size:16px;font-weight:800;color:#0f172a}' +
    '.shareimg-close{background:#f1f5f9;border:none;border-radius:50%;width:30px;height:30px;display:flex;align-items:center;justify-content:center;cursor:pointer;color:#64748b}' +
    '.shareimg-close svg{width:15px;height:15px}' +
    '.shareimg-toggle{display:flex;gap:6px;background:#f1f5f9;border-radius:12px;padding:4px;margin:0 auto 16px;width:fit-content}' +
    '.shareimg-toggle button{border:none;background:none;padding:8px 18px;border-radius:9px;font-weight:700;font-size:13.5px;color:#64748b;cursor:pointer;display:flex;align-items:center;gap:6px;-webkit-tap-highlight-color:transparent}' +
    '.shareimg-toggle button.active{background:#0f172a;color:#fff}' +
    '.shareimg-toggle svg{width:15px;height:15px}' +
    '.shareimg-preview-wrap{display:flex;justify-content:center;margin-bottom:18px}' +
    '.shareimg-frame{border-radius:18px;overflow:hidden;box-shadow:0 10px 30px rgba(15,23,42,.18);background:#e2e8f0}' +
    '.shareimg-card{transform-origin:top left;font-family:inherit}' +
    '.shareimg-bg{width:100%;height:100%;box-sizing:border-box;background:linear-gradient(160deg,#4338ca 0%,#4f46e5 45%,#06b6d4 100%);display:flex;flex-direction:column;position:relative}' +
    '.shareimg-brand{display:flex;align-items:center;gap:12px;padding:56px 56px 0}' +
    '.shareimg-brand img{width:44px;height:44px;border-radius:11px;object-fit:cover}' +
    '.shareimg-brand span{color:#fff;font-weight:800;font-size:30px}' +
    '.shareimg-cardbody-wrap{flex:1;display:flex;align-items:center;justify-content:center;padding:40px 56px}' +
    '.shareimg-cardbody{background:#fff;border-radius:26px;padding:44px;width:100%;box-shadow:0 30px 60px rgba(0,0,0,.25)}' +
    '.shareimg-author-row{display:flex;align-items:center;gap:16px;margin-bottom:28px}' +
    '.shareimg-author-row img{width:58px;height:58px;border-radius:50%;object-fit:cover;flex-shrink:0;background:linear-gradient(135deg,#4f46e5,#06b6d4)}' +
    '.shareimg-author-name{font-weight:800;font-size:26px;color:#0f172a;flex:1;min-width:0}' +
    '.shareimg-flag{width:30px;height:30px;flex-shrink:0;color:#4f46e5}' +
    '.shareimg-img{width:100%;border-radius:18px;object-fit:cover;margin-bottom:24px;display:block}' +
    '.shareimg-title{font-weight:800;font-size:34px;color:#0f172a;line-height:1.28;margin:0 0 14px}' +
    '.shareimg-text{font-weight:600;font-size:32px;color:#0f172a;line-height:1.38;margin:0;white-space:pre-wrap;word-break:break-word}' +
    '.shareimg-brief{font-weight:500;font-size:24px;color:#475569;line-height:1.45;margin:0}' +
    '.shareimg-divider{height:2px;background:#e2e8f0;margin:32px 0 24px}' +
    '.shareimg-foot{display:flex;align-items:center;justify-content:space-between;font-size:20px;font-weight:600;color:#94a3b8}' +
    '.shareimg-actions{display:flex;gap:10px}' +
    '.shareimg-actions button{flex:1;display:flex;align-items:center;justify-content:center;gap:8px;padding:13px 10px;border-radius:14px;border:none;font-weight:700;font-size:14px;cursor:pointer;-webkit-tap-highlight-color:transparent}' +
    '.shareimg-actions button svg{width:17px;height:17px}' +
    '.shareimg-act-share{background:linear-gradient(90deg,#4f46e5,#06b6d4);color:#fff}' +
    '.shareimg-act-download{background:#f1f5f9;color:#0f172a}' +
    '.shareimg-actions button:disabled{opacity:.6;cursor:default}';

  var styleTag = document.createElement('style');
  styleTag.setAttribute('data-share-image', '');
  styleTag.textContent = CSS;
  document.head.appendChild(styleTag);

  var HTML =
    '<div class="shareimg-overlay" id="shareimgOverlay" onclick="closeShareImageCard()"></div>' +
    '<div class="shareimg-sheet" id="shareimgSheet">' +
      '<div class="shareimg-bar"></div>' +
      '<div class="shareimg-hdr">' +
        '<h4>Share as Image</h4>' +
        '<button class="shareimg-close" onclick="closeShareImageCard()" aria-label="Close">' +
          '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>' +
        '</button>' +
      '</div>' +
      '<div class="shareimg-toggle">' +
        '<button id="shareimgGridBtn" onclick="setShareImageShape(\'grid\')">' +
          '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/></svg> Grid' +
        '</button>' +
        '<button id="shareimgStoriesBtn" onclick="setShareImageShape(\'stories\')">' +
          '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="6" y="2" width="12" height="20" rx="2.5"/></svg> Stories' +
        '</button>' +
      '</div>' +
      '<div class="shareimg-preview-wrap">' +
        '<div class="shareimg-frame" id="shareimgFrame">' +
          '<div class="shareimg-card" id="shareimgCard"></div>' +
        '</div>' +
      '</div>' +
      '<div class="shareimg-actions">' +
        '<button class="shareimg-act-download" id="shareimgDownloadBtn" onclick="downloadShareImageCard()">' +
          '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>' +
          'Download' +
        '</button>' +
        '<button class="shareimg-act-share" id="shareimgShareBtn" onclick="shareShareImageCard()">' +
          '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg>' +
          'Share' +
        '</button>' +
      '</div>' +
    '</div>';

  var mount = document.createElement('div');
  mount.innerHTML = HTML;
  while (mount.firstChild) document.body.appendChild(mount.firstChild);

  // ── State ──
  var SHAPES = {
    grid:    { w: 1080, h: 1080 },
    stories: { w: 1080, h: 1920 }
  };
  var currentShape = 'stories';
  var currentItem = null;
  var PREVIEW_TARGET_W = 280; // on-screen preview width in CSS px, height follows shape ratio

  function truncate(str, max) {
    if (!str) return '';
    str = String(str).trim();
    return str.length > max ? str.slice(0, max).trim() + '\u2026' : str;
  }

  function fmtDate(ts) {
    var ms = (ts && ts.seconds) ? ts.seconds * 1000 : (ts || Date.now());
    return new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  }

  function esc(s) {
    return (s || '').replace(/[&<>"']/g, function (m) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m];
    });
  }

  // Builds the inner HTML for the card at its TRUE pixel resolution
  // (1080-wide). The same markup is used for the live on-screen preview
  // (shrunk via a CSS transform: scale() on the wrapper) and for the real
  // export (transform temporarily removed, see exportCanvas() below) — one
  // template, so preview and output can never drift apart.
  function buildCardInnerHtml(item, shape) {
    var dims = SHAPES[shape];
    var isArticle = item.type === 'article';
    var img = item.image || '';
    var bodyHtml = isArticle
      ? '<div class="shareimg-title">' + esc(truncate(item.title, 90)) + '</div>' +
        (item.brief ? '<div class="shareimg-brief">' + esc(truncate(item.brief, 160)) + '</div>' : '')
      : '<div class="shareimg-text">' + esc(truncate(item.text, 220)) + '</div>';

    return (
      '<div class="shareimg-bg" style="width:' + dims.w + 'px;height:' + dims.h + 'px">' +
        '<div class="shareimg-brand"><img src="/MINDSHIFT.jpg" alt=""><span>MindShift Books</span></div>' +
        '<div class="shareimg-cardbody-wrap">' +
          '<div class="shareimg-cardbody">' +
            '<div class="shareimg-author-row">' +
              '<img src="' + (item.avatar || '/logo.jpg') + '" alt="">' +
              '<div class="shareimg-author-name">' + esc(item.author || 'MindShift Books') + '</div>' +
              '<svg class="shareimg-flag" viewBox="0 0 24 24" fill="currentColor"><path d="M5 3v18l7-5 7 5V3a1 1 0 00-1-1H6a1 1 0 00-1 1z"/></svg>' +
            '</div>' +
            (img ? '<img class="shareimg-img" src="' + img + '" alt="" style="height:' + Math.round(dims.w * 0.42) + 'px">' : '') +
            bodyHtml +
            '<div class="shareimg-divider"></div>' +
            '<div class="shareimg-foot"><span>' + fmtDate(item.publishedAt) + '</span><span>mindshiftbooks.shop</span></div>' +
          '</div>' +
        '</div>' +
      '</div>'
    );
  }

  function renderPreview() {
    var dims = SHAPES[currentShape];
    var scale = PREVIEW_TARGET_W / dims.w;
    var frame = document.getElementById('shareimgFrame');
    var card = document.getElementById('shareimgCard');
    frame.style.width = Math.round(dims.w * scale) + 'px';
    frame.style.height = Math.round(dims.h * scale) + 'px';
    card.style.width = dims.w + 'px';
    card.style.height = dims.h + 'px';
    card.style.transform = 'scale(' + scale + ')';
    card.innerHTML = buildCardInnerHtml(currentItem, currentShape);
    document.getElementById('shareimgGridBtn').classList.toggle('active', currentShape === 'grid');
    document.getElementById('shareimgStoriesBtn').classList.toggle('active', currentShape === 'stories');
  }

  window.setShareImageShape = function (shape) {
    currentShape = shape;
    renderPreview();
  };

  window.openShareImageCard = function (item) {
    currentItem = item;
    currentShape = 'stories';
    document.getElementById('shareimgOverlay').classList.add('on');
    document.getElementById('shareimgSheet').classList.add('on');
    document.body.style.overflow = 'hidden';
    renderPreview();
  };

  window.closeShareImageCard = function () {
    document.getElementById('shareimgOverlay').classList.remove('on');
    document.getElementById('shareimgSheet').classList.remove('on');
    document.body.style.overflow = '';
  };

  // Temporarily removes the preview's scale-down transform (so html2canvas
  // captures the card at its true 1080-wide resolution, not shrunk), runs
  // the capture, then restores the preview transform. Same node throughout
  // — no separate off-screen duplicate to keep in sync.
  async function exportCanvas() {
    var dims = SHAPES[currentShape];
    var scale = PREVIEW_TARGET_W / dims.w;
    var card = document.getElementById('shareimgCard');
    card.style.transform = 'none';
    // Let layout settle at full resolution before html2canvas measures it.
    await new Promise(function (r) { requestAnimationFrame(function () { requestAnimationFrame(r); }); });
    try {
      return await html2canvas(card, { scale: 2, backgroundColor: null, useCORS: true, allowTaint: true, width: dims.w, height: dims.h });
    } finally {
      card.style.transform = 'scale(' + scale + ')';
    }
  }

  function canvasToBlob(canvas) {
    return new Promise(function (resolve) { canvas.toBlob(resolve, 'image/png'); });
  }

  window.downloadShareImageCard = async function () {
    var btn = document.getElementById('shareimgDownloadBtn');
    var original = btn.innerHTML;
    btn.disabled = true;
    btn.textContent = 'Preparing\u2026';
    try {
      var canvas = await exportCanvas();
      var link = document.createElement('a');
      link.download = 'mindshift-' + (currentItem.type || 'post') + '-' + currentShape + '.png';
      link.href = canvas.toDataURL('image/png');
      document.body.appendChild(link);
      link.click();
      link.remove();
    } catch (e) {
      console.error('downloadShareImageCard failed:', e);
      alert('Could not generate the image — try again.');
    } finally {
      btn.disabled = false;
      btn.innerHTML = original;
    }
  };

  window.shareShareImageCard = async function () {
    var btn = document.getElementById('shareimgShareBtn');
    var original = btn.innerHTML;
    btn.disabled = true;
    btn.textContent = 'Preparing\u2026';
    try {
      var canvas = await exportCanvas();
      var blob = await canvasToBlob(canvas);
      var file = new File([blob], 'mindshift-share.png', { type: 'image/png' });
      var caption = (currentItem.type === 'article' ? currentItem.title : currentItem.text) || 'Check this out on MindShift Books';
      var url = currentItem.id
        ? (location.origin + '/' + (currentItem.type === 'post' ? 'post-read' : 'article-read') + '?id=' + currentItem.id)
        : location.href;

      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        await navigator.share({ text: caption, url: url, files: [file] });
      } else if (navigator.share) {
        await navigator.share({ text: caption, url: url });
      } else {
        var link = document.createElement('a');
        link.download = 'mindshift-share.png';
        link.href = canvas.toDataURL('image/png');
        document.body.appendChild(link);
        link.click();
        link.remove();
      }
    } catch (e) {
      if (e && e.name !== 'AbortError') console.error('shareShareImageCard failed:', e);
    } finally {
      btn.disabled = false;
      btn.innerHTML = original;
    }
  };
})();
