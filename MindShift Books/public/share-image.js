/* ══════════════════════════════════════════════════════════════════════
   SHARE-AS-IMAGE
   ──────────────────────────────────────────────────────────────────────
   Turns a post or article into a shareable image card — a "Grid" (square,
   1080x1080) or "Stories" (portrait, 1080x1920) format, matching the
   toggle Substack uses for their Notes. The card is drawn directly on a
   <canvas> (no html2canvas / no DOM capture), images are preloaded when
   the sheet opens, and the final file is encoded in the background, so
   Download/Share are near-instant. Images are drawn with an explicit
   cover-crop, so they are never squashed.

   Include on any page with:
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
    '.shareimg-bg-label{font-size:11.5px;font-weight:800;letter-spacing:.04em;text-transform:uppercase;color:#9ca3af;text-align:center;margin:2px 0 10px}' +
    '.shareimg-bg-row{display:flex;gap:8px;justify-content:center;flex-wrap:nowrap;margin:0 auto 18px}' +
    '.shareimg-bg-swatch{width:32px;height:32px;border-radius:9px;border:none;cursor:pointer;display:flex;align-items:center;justify-content:center;flex-shrink:0;padding:0;box-shadow:inset 0 0 0 1.5px rgba(15,23,42,.1);-webkit-tap-highlight-color:transparent;transition:transform .12s}' +
    '.shareimg-bg-swatch:active{transform:scale(.92)}' +
    '.shareimg-bg-swatch.active{box-shadow:0 0 0 2px #fff,0 0 0 4px #0f172a}' +
    '.shareimg-bg-swatch svg{width:15px;height:15px;color:#fff;filter:drop-shadow(0 1px 2px rgba(0,0,0,.4));display:none}' +
    '.shareimg-bg-swatch.active svg{display:block}' +
    '.shareimg-preview-wrap{display:flex;justify-content:center;margin-bottom:18px}' +
    '.shareimg-frame{border-radius:18px;overflow:hidden;box-shadow:0 10px 30px rgba(15,23,42,.18);background:#e2e8f0}' +
    '.shareimg-frame canvas{display:block;width:100%;height:100%}' +
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
        '<div class="shareimg-frame" id="shareimgFrame"></div>' +
      '</div>' +
      '<div class="shareimg-bg-label">Background</div>' +
      '<div class="shareimg-bg-row" id="shareimgBgRow"></div>' +
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
  // Background choices — one array, used for BOTH the swatch buttons (CSS
  // string built from the spec) and the canvas painter. Brand gradient
  // stays first/default.
  var BG_OPTIONS = [
    { id: 'brand',    angle: 160, stops: [[0, '#4338ca'], [0.45, '#4f46e5'], [1, '#06b6d4']] },
    { id: 'midnight', solid: '#0f172a' },
    { id: 'sunrise',  angle: 160, stops: [[0, '#fb923c'], [1, '#ec4899']] },
    { id: 'emerald',  angle: 160, stops: [[0, '#059669'], [1, '#34d399']] },
    { id: 'lavender', angle: 160, stops: [[0, '#a78bfa'], [1, '#f0abfc']] },
    { id: 'sand',     solid: '#d8b48c' }
  ];
  var currentShape = 'grid';
  var currentBg = BG_OPTIONS[0].id;
  var currentItem = null;
  var PREVIEW_TARGET_W = 280;  // on-screen preview width in CSS px
  var PREVIEW_SCALE = 0.55;    // preview canvas px per design px (~2x retina of 280)
  var EXPORT_TYPE = 'image/jpeg'; // JPEG encodes ~5x faster and is ~8x smaller than PNG for this card (it has no transparency). Set to 'image/png' to go back.
  var EXPORT_QUALITY = 0.94;
  var EXPORT_EXT = EXPORT_TYPE === 'image/png' ? 'png' : 'jpg';
  var MARK_URL = '/share-mark.png'; // 96px logo (the old card downloaded the 723KB MINDSHIFT.jpg every time)
  var FONT_STACK = "'Inter', system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";

  // Card design constants (design px, the card is laid out at 1080 wide).
  var BG_PAD_X = 56, BG_PAD_Y = 40, CARD_PAD = 44, CARD_RADIUS = 26;
  var MIN_IMG_H = 240;

  function bgOptionById(id) {
    for (var i = 0; i < BG_OPTIONS.length; i++) if (BG_OPTIONS[i].id === id) return BG_OPTIONS[i];
    return BG_OPTIONS[0];
  }
  function bgCss(o) {
    if (o.solid) return o.solid;
    return 'linear-gradient(' + o.angle + 'deg,' + o.stops.map(function (s) { return s[1] + ' ' + Math.round(s[0] * 100) + '%'; }).join(',') + ')';
  }

  function renderBgSwatches() {
    var row = document.getElementById('shareimgBgRow');
    if (!row) return;
    row.innerHTML = BG_OPTIONS.map(function (o) {
      var active = o.id === currentBg;
      return '<button type="button" class="shareimg-bg-swatch' + (active ? ' active' : '') + '" ' +
        'style="background:' + bgCss(o) + '" onclick="setShareImageBg(\'' + o.id + '\')" aria-label="' + o.id + ' background">' +
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>' +
        '</button>';
    }).join('');
  }

  window.setShareImageBg = function (id) {
    currentBg = id;
    renderBgSwatches();
    renderPreview();
  };

  function truncate(str, max) {
    if (!str) return '';
    str = String(str).trim();
    return str.length > max ? str.slice(0, max).trim() + '\u2026' : str;
  }

  function fmtDate(ts) {
    var ms = (ts && ts.seconds) ? ts.seconds * 1000 : (ts || Date.now());
    return new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  }

  // Cloudinary originals are often several MB. Ask Cloudinary for a
  // downsized, compressed copy (f_auto,q_auto,w_###,c_limit). Non-Cloudinary
  // URLs, or ones that already carry a transform, pass through untouched.
  function cldResize(url, width) {
    if (!url || typeof url !== 'string') return url;
    if (url.indexOf('res.cloudinary.com') === -1) return url;
    var marker = '/upload/';
    var i = url.indexOf(marker);
    if (i === -1) return url;
    var after = url.slice(i + marker.length, i + marker.length + 12);
    if (/^[a-z]_/.test(after)) return url;
    return url.slice(0, i + marker.length) + 'f_auto,q_auto,w_' + width + ',c_limit/' + url.slice(i + marker.length);
  }

  function coverUrl(item) { return item && item.image ? cldResize(item.image, 900) : ''; }
  function avatarUrl(item) { return item && item.avatar ? cldResize(item.avatar, 120) : MARK_URL; }

  // ── Image loading ─────────────────────────────────────────────────────
  // Every image is loaded ONCE into a cache and drawn straight onto a
  // canvas. Loads start the moment the sheet opens, so by the time the
  // person taps Download the bytes are already here. crossOrigin keeps the
  // canvas untainted so it can be exported; if an image can't be loaded
  // that way we skip it instead of failing the whole export.
  var imgCache = {};
  function loadImg(url) {
    if (!url) return null;
    if (imgCache[url]) return imgCache[url];
    var e = imgCache[url] = { status: 'loading', img: null, promise: null };
    e.promise = new Promise(function (resolve) {
      function done(ok, img) {
        if (e.status !== 'loading') return;
        e.status = ok ? 'ok' : 'err';
        e.img = ok ? img : null;
        resolve(e);
      }
      var timer = setTimeout(function () { done(false); }, 8000);
      var im = new Image();
      im.crossOrigin = 'anonymous';
      im.onload = function () { clearTimeout(timer); done(true, im); };
      im.onerror = function () {
        // Retry through fetch, bypassing a cached copy that was stored without CORS headers.
        fetch(url, { mode: 'cors', cache: 'reload' })
          .then(function (r) { if (!r.ok) throw new Error('http ' + r.status); return r.blob(); })
          .then(function (b) {
            var i2 = new Image();
            i2.onload = function () { clearTimeout(timer); done(true, i2); };
            i2.onerror = function () { clearTimeout(timer); done(false); };
            i2.src = URL.createObjectURL(b);
          })
          .catch(function () { clearTimeout(timer); done(false); });
      };
      im.src = url;
    });
    return e;
  }

  function itemUrls(item) {
    return [coverUrl(item), avatarUrl(item), MARK_URL].filter(Boolean);
  }
  function startLoads(item) { itemUrls(item).forEach(loadImg); }
  function settleImages(item) {
    return Promise.all(itemUrls(item).map(function (u) { return loadImg(u).promise; }));
  }

  var fontsPromise = null;
  function ensureFonts(item) {
    var sample = item ? [item.author, item.title, item.brief, item.text].join(' ').slice(0, 400) : 'Aa';
    var specs = ['500 24px ' + FONT_STACK, '600 32px ' + FONT_STACK, '800 34px ' + FONT_STACK];
    var p = (document.fonts && document.fonts.load)
      ? Promise.all(specs.map(function (s) { return document.fonts.load(s, sample); })).catch(function () {})
      : Promise.resolve();
    // Never let a slow font hold up the card — fall back to the system stack.
    return Promise.race([p, new Promise(function (r) { setTimeout(r, 1500); })]);
  }

  // ── Canvas drawing ────────────────────────────────────────────────────
  // The card is drawn straight onto a <canvas> (no html2canvas). The same
  // function draws the on-screen preview (small scale) and the export
  // (scale 1), so they can never drift apart. Images are drawn with an
  // explicit "cover" crop from their natural size, which is what keeps
  // them from being squashed into the slot.
  function roundRectPath(ctx, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  // Draws img into (x,y,w,h) like CSS object-fit:cover — uniform scale,
  // centered crop (fx/fy = 0..1 focus), never stretched.
  function drawCover(ctx, img, x, y, w, h, fx, fy) {
    var iw = img.naturalWidth || img.width, ih = img.naturalHeight || img.height;
    if (!iw || !ih) return;
    var s = Math.max(w / iw, h / ih);
    var sw = w / s, sh = h / s;
    ctx.drawImage(img, (iw - sw) * fx, (ih - sh) * fy, sw, sh, x, y, w, h);
  }

  function paintBg(ctx, w, h, opt) {
    if (opt.solid) { ctx.fillStyle = opt.solid; ctx.fillRect(0, 0, w, h); return; }
    var a = opt.angle * Math.PI / 180;
    var dx = Math.sin(a), dy = -Math.cos(a);
    var len = Math.abs(w * dx) + Math.abs(h * dy);
    var cx = w / 2, cy = h / 2;
    var g = ctx.createLinearGradient(cx - dx * len / 2, cy - dy * len / 2, cx + dx * len / 2, cy + dy * len / 2);
    opt.stops.forEach(function (s) { g.addColorStop(s[0], s[1]); });
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
  }

  // Word-wraps to maxW, honouring newlines and breaking over-long words.
  function wrapText(ctx, text, maxW) {
    var out = [];
    String(text || '').split('\n').forEach(function (para) {
      if (para === '') { out.push(''); return; }
      var line = '';
      para.split(' ').forEach(function (word) {
        var test = line ? line + ' ' + word : word;
        if (ctx.measureText(test).width <= maxW) { line = test; return; }
        if (line) { out.push(line); line = ''; }
        if (ctx.measureText(word).width <= maxW) { line = word; return; }
        var chunk = '';
        Array.from(word).forEach(function (ch) {
          if (chunk && ctx.measureText(chunk + ch).width > maxW) { out.push(chunk); chunk = ch; }
          else chunk += ch;
        });
        line = chunk;
      });
      out.push(line);
    });
    return out;
  }

  function fitText(ctx, text, maxW) {
    if (ctx.measureText(text).width <= maxW) return text;
    var t = text;
    while (t.length > 1 && ctx.measureText(t + '\u2026').width > maxW) t = t.slice(0, -1);
    return t.trim() + '\u2026';
  }

  function drawCard(item, shape, bgId, scale) {
    var dims = SHAPES[shape];
    var canvas = document.createElement('canvas');
    canvas.width = Math.round(dims.w * scale);
    canvas.height = Math.round(dims.h * scale);
    var ctx = canvas.getContext('2d');
    ctx.scale(scale, scale);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.textBaseline = 'middle';

    paintBg(ctx, dims.w, dims.h, bgOptionById(bgId));

    var isArticle = item.type === 'article';
    var cardW = dims.w - BG_PAD_X * 2;
    var contentW = cardW - CARD_PAD * 2;

    // ── Measure text ──
    var titleLines = [], briefLines = [], textLines = [];
    var TITLE = { px: 34, lh: 34 * 1.28 }, BRIEF = { px: 24, lh: 24 * 1.45 }, POST = { px: 32, lh: 32 * 1.38 };
    var textH = 0;
    if (isArticle) {
      ctx.font = '800 ' + TITLE.px + 'px ' + FONT_STACK;
      var t = truncate(item.title, 90);
      titleLines = t ? wrapText(ctx, t, contentW) : [];
      ctx.font = '500 ' + BRIEF.px + 'px ' + FONT_STACK;
      var b = truncate(item.brief, 160);
      briefLines = b ? wrapText(ctx, b, contentW) : [];
      textH = titleLines.length * TITLE.lh + 14 + briefLines.length * BRIEF.lh;
    } else {
      ctx.font = '600 ' + POST.px + 'px ' + FONT_STACK;
      var p = truncate(item.text, 220);
      textLines = p ? wrapText(ctx, p, contentW) : [];
      textH = textLines.length * POST.lh;
    }

    // ── Image slot: follows the picture's own shape, limited by the space left ──
    var cUrl = coverUrl(item);
    var cEntry = cUrl ? loadImg(cUrl) : null;
    var hasImg = !!cEntry && cEntry.status !== 'err';
    var imgH = 0;
    var AUTHOR_H = 58, AUTHOR_GAP = 28, DIV_H = 58, FOOT_H = 24;
    var fixed = CARD_PAD * 2 + AUTHOR_H + AUTHOR_GAP + textH + DIV_H + FOOT_H + (hasImg ? 24 : 0);
    if (hasImg) {
      var room = (dims.h - BG_PAD_Y * 2) - fixed;
      var natural = cEntry.status === 'ok' && cEntry.img.naturalWidth
        ? contentW * cEntry.img.naturalHeight / cEntry.img.naturalWidth
        : Math.round(dims.w * 0.42);
      imgH = Math.round(Math.max(MIN_IMG_H, Math.min(natural, contentW, room)));
    }
    var cardH = fixed + imgH;
    var cardX = BG_PAD_X;
    var cardY = Math.max(BG_PAD_Y, Math.round((dims.h - cardH) / 2));

    // ── Card ──
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,.18)';
    ctx.shadowBlur = 28 * scale;   // canvas shadows ignore ctx.scale
    ctx.shadowOffsetY = 14 * scale;
    ctx.fillStyle = '#fff';
    roundRectPath(ctx, cardX, cardY, cardW, cardH, CARD_RADIUS);
    ctx.fill();
    ctx.restore();

    var x0 = cardX + CARD_PAD;
    var y = cardY + CARD_PAD;

    // Author row
    var avEntry = loadImg(avatarUrl(item));
    ctx.save();
    ctx.beginPath();
    ctx.arc(x0 + 29, y + 29, 29, 0, Math.PI * 2);
    ctx.closePath();
    ctx.clip();
    if (avEntry && avEntry.status === 'ok') {
      drawCover(ctx, avEntry.img, x0, y, 58, 58, 0.5, 0.5);
    } else {
      var ag = ctx.createLinearGradient(x0, y, x0 + 58, y + 58);
      ag.addColorStop(0, '#4f46e5'); ag.addColorStop(1, '#06b6d4');
      ctx.fillStyle = ag;
      ctx.fillRect(x0, y, 58, 58);
      if (avEntry && avEntry.status === 'err') {
        ctx.fillStyle = '#fff';
        ctx.font = '800 26px ' + FONT_STACK;
        ctx.textAlign = 'center';
        ctx.fillText(String(item.author || 'M').trim().charAt(0).toUpperCase() || 'M', x0 + 29, y + 30);
        ctx.textAlign = 'left';
      }
    }
    ctx.restore();

    ctx.fillStyle = '#0f172a';
    ctx.font = '800 26px ' + FONT_STACK;
    ctx.textAlign = 'left';
    var nameX = x0 + 58 + 16;
    ctx.fillText(fitText(ctx, item.author || 'MindShift Books', contentW - 58 - 16 - 30 - 16), nameX, y + 30);

    var mark = loadImg(MARK_URL);
    if (mark && mark.status === 'ok') {
      ctx.save();
      roundRectPath(ctx, x0 + contentW - 30, y + 14, 30, 30, 8);
      ctx.clip();
      drawCover(ctx, mark.img, x0 + contentW - 30, y + 14, 30, 30, 0.5, 0.5);
      ctx.restore();
    }
    y += AUTHOR_H + AUTHOR_GAP;

    // Cover / post image
    if (hasImg) {
      ctx.save();
      roundRectPath(ctx, x0, y, contentW, imgH, 18);
      ctx.clip();
      if (cEntry.status === 'ok') {
        drawCover(ctx, cEntry.img, x0, y, contentW, imgH, 0.5, 0.5);
      } else {
        ctx.fillStyle = '#e2e8f0';
        ctx.fillRect(x0, y, contentW, imgH);
      }
      ctx.restore();
      y += imgH + 24;
    }

    // Text
    if (isArticle) {
      ctx.fillStyle = '#0f172a';
      ctx.font = '800 ' + TITLE.px + 'px ' + FONT_STACK;
      titleLines.forEach(function (ln, i) { ctx.fillText(ln, x0, y + TITLE.lh * i + TITLE.lh / 2); });
      y += titleLines.length * TITLE.lh + 14;
      ctx.fillStyle = '#475569';
      ctx.font = '500 ' + BRIEF.px + 'px ' + FONT_STACK;
      briefLines.forEach(function (ln, i) { ctx.fillText(ln, x0, y + BRIEF.lh * i + BRIEF.lh / 2); });
      y += briefLines.length * BRIEF.lh;
    } else {
      ctx.fillStyle = '#0f172a';
      ctx.font = '600 ' + POST.px + 'px ' + FONT_STACK;
      textLines.forEach(function (ln, i) { ctx.fillText(ln, x0, y + POST.lh * i + POST.lh / 2); });
      y += textLines.length * POST.lh;
    }

    // Divider + footer
    y += 32;
    ctx.fillStyle = '#e2e8f0';
    ctx.fillRect(x0, y, contentW, 2);
    y += 2 + 24;
    ctx.fillStyle = '#94a3b8';
    ctx.font = '600 20px ' + FONT_STACK;
    ctx.textAlign = 'left';
    ctx.fillText(fmtDate(item.publishedAt), x0, y + FOOT_H / 2);
    ctx.textAlign = 'right';
    ctx.fillText('mindshiftbooks.shop', x0 + contentW, y + FOOT_H / 2);
    ctx.textAlign = 'left';

    return canvas;
  }

  // ── Preview ───────────────────────────────────────────────────────────
  var renderToken = 0;
  function renderPreview() {
    var token = ++renderToken;
    var dims = SHAPES[currentShape];
    var frame = document.getElementById('shareimgFrame');
    frame.style.width = PREVIEW_TARGET_W + 'px';
    frame.style.height = Math.round(PREVIEW_TARGET_W * dims.h / dims.w) + 'px';
    document.getElementById('shareimgGridBtn').classList.toggle('active', currentShape === 'grid');
    document.getElementById('shareimgStoriesBtn').classList.toggle('active', currentShape === 'stories');

    function paint() {
      var cv = drawCard(currentItem, currentShape, currentBg, PREVIEW_SCALE);
      frame.innerHTML = '';
      frame.appendChild(cv);
    }
    paint(); // instant first paint with whatever is already loaded
    ensureFonts(currentItem).then(function () { if (token === renderToken) paint(); });
    settleImages(currentItem).then(function () {
      if (token !== renderToken) return;
      paint();
      schedulePrepare();
    });
  }

  window.setShareImageShape = function (shape) {
    currentShape = shape;
    renderPreview();
  };

  window.openShareImageCard = function (item) {
    currentItem = item;
    currentShape = 'grid';
    currentBg = BG_OPTIONS[0].id;
    prepared = null;
    startLoads(item); // start downloading images right now, in parallel with opening the sheet
    document.getElementById('shareimgOverlay').classList.add('on');
    document.getElementById('shareimgSheet').classList.add('on');
    document.body.style.overflow = 'hidden';
    renderBgSwatches();
    renderPreview();
  };

  window.closeShareImageCard = function () {
    document.getElementById('shareimgOverlay').classList.remove('on');
    document.getElementById('shareimgSheet').classList.remove('on');
    document.body.style.overflow = '';
  };

  // ── Export ────────────────────────────────────────────────────────────
  // The final image is encoded in the background as soon as the preview
  // settles, so Download/Share usually just pick up a finished Blob.
  var prepared = null, prepTimer = null;

  function canvasToBlob(canvas) {
    return new Promise(function (resolve, reject) {
      canvas.toBlob(function (b) { b ? resolve(b) : reject(new Error('toBlob returned null')); }, EXPORT_TYPE, EXPORT_QUALITY);
    });
  }

  function buildBlob() {
    var item = currentItem, shape = currentShape, bg = currentBg;
    return ensureFonts(item)
      .then(function () { return settleImages(item); })
      .then(function () { return canvasToBlob(drawCard(item, shape, bg, 1)); });
  }

  function getBlob() {
    var key = currentShape + '|' + currentBg;
    if (prepared && prepared.key === key) return prepared.promise;
    var p = buildBlob();
    prepared = { key: key, promise: p };
    p.catch(function () { if (prepared && prepared.promise === p) prepared = null; });
    return p;
  }

  function schedulePrepare() {
    clearTimeout(prepTimer);
    prepTimer = setTimeout(function () { getBlob().catch(function () {}); }, 200);
  }

  function saveBlob(blob, name) {
    var url = URL.createObjectURL(blob);
    var link = document.createElement('a');
    link.download = name;
    link.href = url;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 10000);
  }

  window.downloadShareImageCard = async function () {
    var btn = document.getElementById('shareimgDownloadBtn');
    var original = btn.innerHTML;
    btn.disabled = true;
    btn.textContent = 'Preparing\u2026';
    try {
      var blob = await getBlob();
      saveBlob(blob, 'mindshift-' + (currentItem.type || 'post') + '-' + currentShape + '.' + EXPORT_EXT);
    } catch (e) {
      console.error('downloadShareImageCard failed:', e);
      alert('Could not generate the image \u2014 try again.');
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
      var blob = await getBlob();
      var file = new File([blob], 'mindshift-share.' + EXPORT_EXT, { type: blob.type });
      var caption = (currentItem.type === 'article' ? currentItem.title : currentItem.text) || 'Check this out on MindShift Books';
      var url = currentItem.id
        ? (location.origin + '/' + (currentItem.type === 'post' ? 'post-read' : 'article-read') + '?id=' + currentItem.id)
        : location.href;

      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        await navigator.share({ text: caption, url: url, files: [file] });
      } else if (navigator.share) {
        await navigator.share({ text: caption, url: url });
      } else {
        saveBlob(blob, 'mindshift-share.' + EXPORT_EXT);
      }
    } catch (e) {
      if (e && e.name !== 'AbortError') console.error('shareShareImageCard failed:', e);
    } finally {
      btn.disabled = false;
      btn.innerHTML = original;
    }
  };
})();
