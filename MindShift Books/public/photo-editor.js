// public/photo-editor.js
//
// Shared full-screen photo editor — crop (Free / Original / 1:1 / 4:5 / 16:9),
// rotate + flip, filters, and brightness / contrast / saturation.
//
//   <script src="/photo-editor.js"></script>
//
//   const res = await MindshiftPhotoEditor.open({
//     src,            // data: URL, blob: URL or https URL of the ORIGINAL photo
//     state,          // optional: the `state` returned last time, to reopen with edits intact
//     title,          // optional header text (default "Edit photo")
//     aspects,        // optional: e.g. ['16:9'] to offer only some crop shapes
//     aspect          // optional: start with this crop shape, e.g. '16:9' (new edits only)
//   });
//   // res === null                      -> cancelled
//   // res.changed === false             -> back to the untouched original (res.dataUrl is null)
//   // res.changed === true              -> res.dataUrl is the edited JPEG
//   // res.state                         -> hand back into open({ state }) to keep editing
//
// How it works (why it's fast and consistent):
//  - Everything is drawn on <canvas>; edits are baked into the exported JPEG,
//    so nothing changes about how photos are hosted or displayed.
//  - Filters/adjustments run through ONE per-pixel function (applyLook) used for
//    the live preview, the filter thumbnails and the final export, so what you
//    see is exactly what you get. (ctx.filter isn't supported in Safari, which is
//    why this doesn't use it.)
//  - Cropping never touches pixels until Done; the box is just a rectangle.
window.MindshiftPhotoEditor = (function () {
  var MAX_DIM = 2000;                      // same longest-edge cap as image-compress.js
  var PV_MAX = 1100;                       // longest edge of the live preview bitmap
  var TARGET_BYTES = 1.5 * 1024 * 1024;    // same target as image-compress.js
  var THUMB = 76;

  var PRESETS = [
    { id: 'none',   name: 'Original' },
    { id: 'vivid',  name: 'Vivid',  sa: 1.35, co: 1.08 },
    { id: 'warm',   name: 'Warm',   tint: [1.07, 1.0, 0.88], sa: 1.08 },
    { id: 'cool',   name: 'Cool',   tint: [0.90, 1.0, 1.10] },
    { id: 'bright', name: 'Bright', br: 1.12, co: 1.05 },
    { id: 'drama',  name: 'Drama',  co: 1.3, sa: 1.1, br: 0.95 },
    { id: 'fade',   name: 'Fade',   fade: 0.3, co: 0.92, sa: 0.9 },
    { id: 'sepia',  name: 'Sepia',  sep: 0.85 },
    { id: 'mono',   name: 'Mono',   sa: 0, co: 1.1 }
  ];

  var ASPECTS = [
    { id: 'free', label: 'Free',     ar: null },
    { id: 'orig', label: 'Original', ar: 'orig' },
    { id: '1:1',  label: '1:1',      ar: 1 },
    { id: '4:5',  label: '4:5',      ar: 4 / 5 },
    { id: '16:9', label: '16:9',     ar: 16 / 9 }
  ];

  /* ───────────────────────── pure helpers (unit-testable) ───────────────────────── */

  function presetById(id) {
    for (var i = 0; i < PRESETS.length; i++) if (PRESETS[i].id === id) return PRESETS[i];
    return PRESETS[0];
  }

  function lookParams(filterId, adj) {
    var p = presetById(filterId);
    adj = adj || { b: 0, c: 0, s: 0 };
    return {
      br: (p.br || 1) * (1 + adj.b / 100 * 0.6),
      co: (p.co || 1) * (1 + adj.c / 100 * 0.7),
      sa: Math.max(0, (p.sa === undefined ? 1 : p.sa) * (1 + adj.s / 100)),
      sep: p.sep || 0,
      tint: p.tint || null,
      fade: p.fade || 0
    };
  }

  function isNeutral(lp) {
    return lp.br === 1 && lp.co === 1 && lp.sa === 1 && !lp.sep && !lp.tint && !lp.fade;
  }

  // Mutates and returns imageData. (Uint8ClampedArray clamps + rounds on assignment.)
  function applyLook(imageData, filterId, adj) {
    var lp = lookParams(filterId, adj);
    if (isNeutral(lp)) return imageData;
    var d = imageData.data, n = d.length;
    var tr = lp.tint ? lp.tint[0] : 1, tg = lp.tint ? lp.tint[1] : 1, tb = lp.tint ? lp.tint[2] : 1;
    var br = lp.br, co = lp.co, sa = lp.sa, sep = lp.sep, fade = lp.fade;
    for (var i = 0; i < n; i += 4) {
      var r = d[i] * tr, g = d[i + 1] * tg, b = d[i + 2] * tb;
      if (sep) {
        var nr = 0.393 * r + 0.769 * g + 0.189 * b;
        var ng = 0.349 * r + 0.686 * g + 0.168 * b;
        var nb = 0.272 * r + 0.534 * g + 0.131 * b;
        r += (nr - r) * sep; g += (ng - g) * sep; b += (nb - b) * sep;
      }
      if (sa !== 1) {
        var l = 0.299 * r + 0.587 * g + 0.114 * b;
        r = l + (r - l) * sa; g = l + (g - l) * sa; b = l + (b - l) * sa;
      }
      if (br !== 1) { r *= br; g *= br; b *= br; }
      if (co !== 1) { r = (r - 128) * co + 128; g = (g - 128) * co + 128; b = (b - 128) * co + 128; }
      if (fade) { r += (255 - r) * fade * 0.25; g += (255 - g) * fade * 0.25; b += (255 - b) * fade * 0.25; }
      d[i] = r; d[i + 1] = g; d[i + 2] = b;
    }
    return imageData;
  }

  function minCrop(tw, th) { return Math.max(24, 0.08 * Math.min(tw, th)); }

  function clampCrop(c, tw, th) {
    var m = minCrop(tw, th);
    var w = Math.min(Math.max(c.w, m), tw), h = Math.min(Math.max(c.h, m), th);
    var x = Math.min(Math.max(c.x, 0), tw - w), y = Math.min(Math.max(c.y, 0), th - h);
    return { x: x, y: y, w: w, h: h };
  }

  // Largest rect of ratio `ar` inside `crop`, centered on it.
  function fitAspect(crop, ar) {
    if (!ar) return crop;
    var cx = crop.x + crop.w / 2, cy = crop.y + crop.h / 2;
    var w = crop.w, h = w / ar;
    if (h > crop.h) { h = crop.h; w = h * ar; }
    return { x: cx - w / 2, y: cy - h / 2, w: w, h: h };
  }

  // Applies a drag of (dx,dy) IMAGE pixels on handle (hx,hy) — each -1/0/1;
  // (0,0) means "move the whole box". `ar` locks the ratio (corners only).
  function dragCrop(start, hx, hy, dx, dy, ar, tw, th) {
    var m = minCrop(tw, th), x = start.x, y = start.y, w = start.w, h = start.h;
    if (hx === 0 && hy === 0) {
      return { x: Math.min(Math.max(start.x + dx, 0), tw - w), y: Math.min(Math.max(start.y + dy, 0), th - h), w: w, h: h };
    }
    if (!ar) {
      if (hx === -1) { x = Math.min(Math.max(start.x + dx, 0), start.x + start.w - m); w = start.x + start.w - x; }
      if (hx === 1)  { w = Math.min(Math.max(start.w + dx, m), tw - start.x); }
      if (hy === -1) { y = Math.min(Math.max(start.y + dy, 0), start.y + start.h - m); h = start.y + start.h - y; }
      if (hy === 1)  { h = Math.min(Math.max(start.h + dy, m), th - start.y); }
      return { x: x, y: y, w: w, h: h };
    }
    // Locked ratio: anchor the opposite corner, resize from the dragged one.
    var ax = hx === 1 ? start.x : start.x + start.w;
    var ay = hy === 1 ? start.y : start.y + start.h;
    var px = (hx === 1 ? start.x + start.w : start.x) + dx;
    var py = (hy === 1 ? start.y + start.h : start.y) + dy;
    var nw = Math.abs(px - ax), nh = Math.abs(py - ay);
    var nw2 = (nw + nh * ar) / 2;
    var maxW = hx === 1 ? tw - ax : ax;
    var maxH = hy === 1 ? th - ay : ay;
    nw2 = Math.min(nw2, maxW, maxH * ar);
    nw2 = Math.max(nw2, Math.max(m, m * ar));
    nw2 = Math.min(nw2, maxW, maxH * ar);
    var nh2 = nw2 / ar;
    return { x: hx === 1 ? ax : ax - nw2, y: hy === 1 ? ay : ay - nh2, w: nw2, h: nh2 };
  }

  /* ───────────────────────── image loading ───────────────────────── */

  function loadImage(src) {
    return new Promise(function (resolve, reject) {
      function tryLoad(url, cors, onFail) {
        var im = new Image();
        if (cors) im.crossOrigin = 'anonymous';
        im.onload = function () { resolve(im); };
        im.onerror = onFail;
        im.src = url;
      }
      var isHttp = /^https?:/i.test(src);
      tryLoad(src, isHttp, function () {
        if (!isHttp) return reject(new Error('Could not open this photo.'));
        // A cached copy stored without CORS headers can block the first try — go around it.
        fetch(src, { mode: 'cors', cache: 'reload' })
          .then(function (r) { if (!r.ok) throw new Error('http'); return r.blob(); })
          .then(function (b) { tryLoad(URL.createObjectURL(b), false, function () { reject(new Error('Could not open this photo.')); }); })
          .catch(function () { reject(new Error('Could not open this photo.')); });
      });
    });
  }

  /* ───────────────────────── UI (built once, reused) ───────────────────────── */

  var CSS = '' +
    '#kv-pe{position:fixed;inset:0;z-index:10000;background:#0b0b12;color:#fff;display:none;flex-direction:column;font-family:Inter,system-ui,-apple-system,sans-serif;-webkit-user-select:none;user-select:none;touch-action:manipulation}' +
    '#kv-pe.on{display:flex}' +
    '#kv-pe .pe-hdr{display:flex;align-items:center;justify-content:space-between;padding:calc(env(safe-area-inset-top,0px) + 10px) 12px 10px;flex-shrink:0}' +
    '#kv-pe .pe-sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}' +
    '#kv-pe .pe-hist{display:flex;gap:8px}' +
    '#kv-pe .pe-ibtn{width:40px;height:40px;border-radius:50%;border:none;background:#1c1c2e;color:#e2e8f0;display:flex;align-items:center;justify-content:center;cursor:pointer;-webkit-tap-highlight-color:transparent}' +
    '#kv-pe .pe-ibtn:active{background:#2b2b45}' +
    '#kv-pe .pe-ibtn:disabled{opacity:.3;cursor:default}' +
    '#kv-pe .pe-ibtn svg{width:20px;height:20px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}' +
    '#kv-pe .pe-hbtn{background:none;border:none;color:#cbd5e1;font-weight:600;font-size:15px;font-family:inherit;padding:8px 10px;cursor:pointer;border-radius:10px}' +
    '#kv-pe .pe-done{background:linear-gradient(135deg,#4f46e5,#06b6d4);color:#fff;padding:8px 18px;border-radius:99px;font-weight:700}' +
    '#kv-pe .pe-done:disabled{opacity:.45}' +
    '#kv-pe .pe-stage{position:relative;flex:1;min-height:0;overflow:hidden}' +
    '#kv-pe .pe-wrap{position:absolute}' +
    '#kv-pe canvas.pe-cv{display:block;width:100%;height:100%;border-radius:2px}' +
    '#kv-pe .pe-crop{position:absolute;inset:0;overflow:hidden;touch-action:none;display:none}' +
    '#kv-pe.tab-crop .pe-crop{display:block}' +
    '#kv-pe .pe-box{position:absolute;box-shadow:0 0 0 9999px rgba(0,0,0,.58);border:1.5px solid #fff;cursor:move;touch-action:none;' +
      'background-image:linear-gradient(rgba(255,255,255,.35),rgba(255,255,255,.35)),linear-gradient(rgba(255,255,255,.35),rgba(255,255,255,.35)),linear-gradient(90deg,rgba(255,255,255,.35),rgba(255,255,255,.35)),linear-gradient(90deg,rgba(255,255,255,.35),rgba(255,255,255,.35));' +
      'background-size:100% 1px,100% 1px,1px 100%,1px 100%;background-position:0 33.33%,0 66.66%,33.33% 0,66.66% 0;background-repeat:no-repeat}' +
    '#kv-pe .pe-h{position:absolute;width:44px;height:44px;touch-action:none}' +
    '#kv-pe .pe-h::after{content:"";position:absolute;left:50%;top:50%;width:14px;height:14px;margin:-7px 0 0 -7px;background:#fff;border-radius:3px;box-shadow:0 1px 4px rgba(0,0,0,.5)}' +
    '#kv-pe .pe-h.e-n::after,#kv-pe .pe-h.e-s::after{width:26px;height:6px;margin:-3px 0 0 -13px;border-radius:3px}' +
    '#kv-pe .pe-h.e-e::after,#kv-pe .pe-h.e-w::after{width:6px;height:26px;margin:-13px 0 0 -3px;border-radius:3px}' +
    '#kv-pe .pe-h.nw{left:-22px;top:-22px}#kv-pe .pe-h.ne{right:-22px;top:-22px}#kv-pe .pe-h.sw{left:-22px;bottom:-22px}#kv-pe .pe-h.se{right:-22px;bottom:-22px}' +
    '#kv-pe .pe-h.e-n{left:50%;top:-22px;margin-left:-22px}#kv-pe .pe-h.e-s{left:50%;bottom:-22px;margin-left:-22px}' +
    '#kv-pe .pe-h.e-w{left:-22px;top:50%;margin-top:-22px}#kv-pe .pe-h.e-e{right:-22px;top:50%;margin-top:-22px}' +
    '#kv-pe .pe-box.locked .pe-h.e-n,#kv-pe .pe-box.locked .pe-h.e-s,#kv-pe .pe-box.locked .pe-h.e-w,#kv-pe .pe-box.locked .pe-h.e-e{display:none}' +
    '#kv-pe .pe-loading{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-size:14px;color:#94a3b8}' +
    '#kv-pe .pe-panel{flex-shrink:0;background:#14141f;border-top:1px solid rgba(255,255,255,.07);padding-bottom:env(safe-area-inset-bottom,0px)}' +
    '#kv-pe .pe-tool{display:none;min-height:104px;padding:14px 12px 8px;box-sizing:border-box}' +
    '#kv-pe.tab-crop #pe-t-crop,#kv-pe.tab-filters #pe-t-filters,#kv-pe.tab-adjust #pe-t-adjust{display:block}' +
    '#kv-pe .pe-chips{display:flex;gap:8px;overflow-x:auto;scrollbar-width:none;padding-bottom:10px}' +
    '#kv-pe .pe-chips::-webkit-scrollbar,#kv-pe .pe-filters::-webkit-scrollbar{display:none}' +
    '#kv-pe .pe-chip{flex:0 0 auto;background:#23233a;border:none;color:#cbd5e1;font-weight:600;font-size:13px;font-family:inherit;padding:8px 14px;border-radius:99px;cursor:pointer}' +
    '#kv-pe .pe-chip.sel{background:#fff;color:#0f172a}' +
    '#kv-pe .pe-row{display:flex;gap:10px}' +
    '#kv-pe .pe-tbtn{display:flex;align-items:center;gap:7px;background:#23233a;border:none;color:#e2e8f0;font-weight:600;font-size:13px;font-family:inherit;padding:9px 14px;border-radius:12px;cursor:pointer}' +
    '#kv-pe .pe-tbtn svg,#kv-pe .pe-tab svg{width:18px;height:18px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}' +
    '#kv-pe .pe-filters{display:flex;gap:10px;overflow-x:auto;scrollbar-width:none}' +
    '#kv-pe .pe-f{flex:0 0 auto;background:none;border:none;color:#94a3b8;font-weight:600;font-size:11.5px;font-family:inherit;cursor:pointer;display:flex;flex-direction:column;align-items:center;gap:6px;padding:0}' +
    '#kv-pe .pe-f canvas{width:' + THUMB + 'px;height:' + THUMB + 'px;border-radius:12px;border:2px solid transparent;display:block}' +
    '#kv-pe .pe-f.sel{color:#fff}#kv-pe .pe-f.sel canvas{border-color:#fff}' +
    '#kv-pe .pe-sl{display:grid;grid-template-columns:86px 1fr 34px;align-items:center;gap:10px;margin-bottom:10px;font-size:13px;font-weight:600;color:#cbd5e1}' +
    '#kv-pe .pe-sl output{text-align:right;color:#94a3b8;font-variant-numeric:tabular-nums}' +
    '#kv-pe input[type=range]{width:100%;accent-color:#818cf8;height:28px}' +
    '#kv-pe .pe-reset{background:none;border:none;color:#818cf8;font-weight:700;font-size:13px;font-family:inherit;padding:2px 0;cursor:pointer}' +
    '#kv-pe .pe-tabs{display:flex;border-top:1px solid rgba(255,255,255,.07)}' +
    '#kv-pe .pe-tab{flex:1;background:none;border:none;color:#7c8497;font-weight:700;font-size:11.5px;font-family:inherit;padding:10px 0 12px;display:flex;flex-direction:column;align-items:center;gap:4px;cursor:pointer}' +
    '#kv-pe.tab-crop .pe-tab[data-tab=crop],#kv-pe.tab-filters .pe-tab[data-tab=filters],#kv-pe.tab-adjust .pe-tab[data-tab=adjust]{color:#fff}';

  var ICON = {
    rot:  '<svg viewBox="0 0 24 24"><path d="M21 12a9 9 0 1 1-3-6.7"/><polyline points="21 3 21 9 15 9"/></svg>',
    flip: '<svg viewBox="0 0 24 24"><path d="M12 3v18"/><path d="M8 7L3 17h5z"/><path d="M16 7l5 10h-5z"/></svg>',
    undo: '<svg viewBox="0 0 24 24"><polyline points="7 6 3 10 7 14"/><path d="M3 10h10a5 5 0 0 1 5 5v1a5 5 0 0 1-5 5H9"/></svg>',
    redo: '<svg viewBox="0 0 24 24"><polyline points="17 6 21 10 17 14"/><path d="M21 10H11a5 5 0 0 0-5 5v1a5 5 0 0 0 5 5h4"/></svg>',
    crop: '<svg viewBox="0 0 24 24"><path d="M6 2v14a2 2 0 0 0 2 2h14"/><path d="M18 22V8a2 2 0 0 0-2-2H2"/></svg>',
    fx:   '<svg viewBox="0 0 24 24"><circle cx="9" cy="12" r="6"/><circle cx="15" cy="12" r="6"/></svg>',
    adj:  '<svg viewBox="0 0 24 24"><line x1="4" y1="7" x2="20" y2="7"/><line x1="4" y1="17" x2="20" y2="17"/><circle cx="9" cy="7" r="2.4" fill="#14141f"/><circle cx="15" cy="17" r="2.4" fill="#14141f"/></svg>'
  };

  var el = null;           // root element (built lazily)
  var S = null;            // active session, or null

  function $(id) { return document.getElementById(id); }

  function build() {
    if (el) return;
    var st = document.createElement('style');
    st.setAttribute('data-photo-editor', '');
    st.textContent = CSS;
    document.head.appendChild(st);

    el = document.createElement('div');
    el.id = 'kv-pe';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-modal', 'true');
    el.innerHTML =
      '<div class="pe-hdr">' +
        '<button type="button" class="pe-hbtn" id="pe-cancel">Cancel</button>' +
        '<div class="pe-title pe-sr" id="pe-title">Edit photo</div>' +
        '<div class="pe-hist" role="group" aria-label="History">' +
          '<button type="button" class="pe-ibtn" id="pe-undo" aria-label="Undo" title="Undo" disabled>' + ICON.undo + '</button>' +
          '<button type="button" class="pe-ibtn" id="pe-redo" aria-label="Redo" title="Redo" disabled>' + ICON.redo + '</button>' +
        '</div>' +
        '<button type="button" class="pe-hbtn pe-done" id="pe-done" disabled>Done</button>' +
      '</div>' +
      '<div class="pe-stage" id="pe-stage">' +
        '<div class="pe-wrap" id="pe-wrap">' +
          '<canvas class="pe-cv" id="pe-cv"></canvas>' +
          '<div class="pe-crop" id="pe-crop">' +
            '<div class="pe-box" id="pe-box">' +
              '<div class="pe-h nw" data-hx="-1" data-hy="-1"></div><div class="pe-h ne" data-hx="1" data-hy="-1"></div>' +
              '<div class="pe-h sw" data-hx="-1" data-hy="1"></div><div class="pe-h se" data-hx="1" data-hy="1"></div>' +
              '<div class="pe-h e-n" data-hx="0" data-hy="-1"></div><div class="pe-h e-s" data-hx="0" data-hy="1"></div>' +
              '<div class="pe-h e-w" data-hx="-1" data-hy="0"></div><div class="pe-h e-e" data-hx="1" data-hy="0"></div>' +
            '</div>' +
          '</div>' +
        '</div>' +
        '<div class="pe-loading" id="pe-loading">Loading photo\u2026</div>' +
      '</div>' +
      '<div class="pe-panel">' +
        '<div class="pe-tool" id="pe-t-crop">' +
          '<div class="pe-chips" id="pe-chips"></div>' +
          '<div class="pe-row">' +
            '<button type="button" class="pe-tbtn" id="pe-rot">' + ICON.rot + 'Rotate</button>' +
            '<button type="button" class="pe-tbtn" id="pe-flip">' + ICON.flip + 'Flip</button>' +
          '</div>' +
        '</div>' +
        '<div class="pe-tool" id="pe-t-filters"><div class="pe-filters" id="pe-filters"></div></div>' +
        '<div class="pe-tool" id="pe-t-adjust">' +
          '<div class="pe-sl"><span>Brightness</span><input type="range" min="-100" max="100" value="0" data-k="b"><output>0</output></div>' +
          '<div class="pe-sl"><span>Contrast</span><input type="range" min="-100" max="100" value="0" data-k="c"><output>0</output></div>' +
          '<div class="pe-sl"><span>Saturation</span><input type="range" min="-100" max="100" value="0" data-k="s"><output>0</output></div>' +
          '<button type="button" class="pe-reset" id="pe-reset">Reset adjustments</button>' +
        '</div>' +
        '<div class="pe-tabs">' +
          '<button type="button" class="pe-tab" data-tab="crop">' + ICON.crop + 'Crop</button>' +
          '<button type="button" class="pe-tab" data-tab="filters">' + ICON.fx + 'Filters</button>' +
          '<button type="button" class="pe-tab" data-tab="adjust">' + ICON.adj + 'Adjust</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(el);

    $('pe-cancel').onclick = function () { cancel(); };
    $('pe-done').onclick = function () { done(); };
    $('pe-rot').onclick = function () { if (S) { S.rot = (S.rot + 1) % 4; transformChanged(true); pushHistory(); } };
    $('pe-flip').onclick = function () { if (S) { S.flip = !S.flip; transformChanged(true); pushHistory(); } };
    $('pe-reset').onclick = function () {
      if (!S) return;
      S.adj = { b: 0, c: 0, s: 0 };
      syncSliders();
      lookChanged();
      pushHistory();
    };
    $('pe-undo').onclick = function () { undo(); };
    $('pe-redo').onclick = function () { redo(); };
    Array.prototype.forEach.call(el.querySelectorAll('.pe-tab'), function (b) {
      b.onclick = function () { setTab(b.getAttribute('data-tab')); };
    });
    Array.prototype.forEach.call(el.querySelectorAll('input[type=range]'), function (inp) {
      inp.addEventListener('input', function () {
        if (!S) return;
        S.adj[inp.getAttribute('data-k')] = Number(inp.value);
        inp.nextElementSibling.textContent = inp.value;
        lookChanged();
      });
      // 'change' fires when the finger lifts — one undo step per slider drag, not per pixel
      inp.addEventListener('change', function () { pushHistory(); });
    });

    // crop dragging (one pointer at a time)
    var cropEl = $('pe-crop'), drag = null;
    cropEl.addEventListener('pointerdown', function (e) {
      if (!S || S.tab !== 'crop') return;
      var t = e.target, hx = 0, hy = 0;
      if (t.classList.contains('pe-h')) { hx = Number(t.getAttribute('data-hx')); hy = Number(t.getAttribute('data-hy')); }
      else if (t.id !== 'pe-box') return;
      drag = { id: e.pointerId, x: e.clientX, y: e.clientY, hx: hx, hy: hy, start: { x: S.crop.x, y: S.crop.y, w: S.crop.w, h: S.crop.h } };
      try { cropEl.setPointerCapture(e.pointerId); } catch (_) {}
      e.preventDefault();
    });
    cropEl.addEventListener('pointermove', function (e) {
      if (!drag || e.pointerId !== drag.id || !S) return;
      var k = S.view.scale || 1;
      var ar = currentAR();
      S.crop = dragCrop(drag.start, drag.hx, drag.hy, (e.clientX - drag.x) / k, (e.clientY - drag.y) / k, ar, S.tw, S.th);
      positionBox();
    });
    function endDrag(e) { if (drag && e.pointerId === drag.id) { drag = null; pushHistory(); } }
    cropEl.addEventListener('pointerup', endDrag);
    cropEl.addEventListener('pointercancel', endDrag);

    window.addEventListener('resize', function () { if (S) layoutStage(); });
    document.addEventListener('keydown', function (e) {
      if (!S) return;
      if (e.key === 'Escape') { cancel(); return; }
      var mod = e.ctrlKey || e.metaKey, k = (e.key || '').toLowerCase();
      if (mod && k === 'z') { e.preventDefault(); if (e.shiftKey) redo(); else undo(); }
      else if (mod && k === 'y') { e.preventDefault(); redo(); }
    });
  }

  /* ───────────────────────── session logic ───────────────────────── */

  function currentAR() {
    if (!S) return null;
    var a = null;
    for (var i = 0; i < ASPECTS.length; i++) if (ASPECTS[i].id === S.aspect) a = ASPECTS[i].ar;
    if (a === 'orig') return S.tw / S.th;
    return a;
  }

  function fullCrop() { return { x: 0, y: 0, w: S.tw, h: S.th }; }

  function isDefaultState() {
    if (!S) return true;
    var full = Math.abs(S.crop.x) < 1 && Math.abs(S.crop.y) < 1 && Math.abs(S.crop.w - S.tw) < 1 && Math.abs(S.crop.h - S.th) < 1;
    return S.rot === 0 && !S.flip && S.filter === 'none' && !S.adj.b && !S.adj.c && !S.adj.s && full;
  }

  function serialize() {
    return {
      rot: S.rot, flip: S.flip, aspect: S.aspect, filter: S.filter,
      adj: { b: S.adj.b, c: S.adj.c, s: S.adj.s },
      crop: { x: S.crop.x / S.tw, y: S.crop.y / S.th, w: S.crop.w / S.tw, h: S.crop.h / S.th }
    };
  }

  // Rebuilds the rotated/flipped full-res canvas + the small preview bitmap.
  function rebuildTransform() {
    var bw = S.base.width, bh = S.base.height, odd = S.rot % 2 === 1;
    var tc = document.createElement('canvas');
    tc.width = odd ? bh : bw; tc.height = odd ? bw : bh;
    var ctx = tc.getContext('2d');
    ctx.translate(tc.width / 2, tc.height / 2);
    ctx.rotate(S.rot * Math.PI / 2);
    if (S.flip) ctx.scale(-1, 1);
    ctx.drawImage(S.base, -bw / 2, -bh / 2);
    S.tc = tc; S.tw = tc.width; S.th = tc.height;

    var k = Math.min(1, PV_MAX / Math.max(S.tw, S.th));
    var pv = document.createElement('canvas');
    pv.width = Math.max(1, Math.round(S.tw * k)); pv.height = Math.max(1, Math.round(S.th * k));
    pv.getContext('2d').drawImage(tc, 0, 0, pv.width, pv.height);
    S.pv = pv;
    S.pvf = document.createElement('canvas');
    S.pvf.width = pv.width; S.pvf.height = pv.height;
    S.lookDirty = true;
    S.thumbsDirty = true;
  }

  function rebuildLook() {
    var ctx = S.pvf.getContext('2d');
    ctx.clearRect(0, 0, S.pvf.width, S.pvf.height);
    ctx.drawImage(S.pv, 0, 0);
    if (!isNeutral(lookParams(S.filter, S.adj))) {
      var id = ctx.getImageData(0, 0, S.pvf.width, S.pvf.height);
      applyLook(id, S.filter, S.adj);
      ctx.putImageData(id, 0, 0);
    }
    S.lookDirty = false;
  }

  function transformChanged(resetCrop) {
    rebuildTransform();
    if (resetCrop) { S.crop = fitAspect(fullCrop(), currentAR()); }
    else S.crop = clampCrop(S.crop, S.tw, S.th);
    renderAspectChips();
    layoutStage();
    if (S.tab === 'filters') buildThumbs();
  }

  function lookChanged() {
    S.lookDirty = true;
    if (S.raf) return;
    S.raf = requestAnimationFrame(function () {
      S.raf = 0;
      if (!S) return;
      drawStage();
      // thumbnails don't depend on the adjustments, only on the picture
    });
  }

  function layoutStage() {
    if (!S || !S.tc) return;
    var stage = $('pe-stage'), pad = 14;
    var sw = stage.clientWidth, sh = stage.clientHeight;
    if (!sw || !sh) return;
    var region = S.tab === 'crop' ? fullCrop() : S.crop;
    var s = Math.min((sw - pad * 2) / region.w, (sh - pad * 2) / region.h);
    var dw = Math.max(1, region.w * s), dh = Math.max(1, region.h * s);
    var wrap = $('pe-wrap');
    wrap.style.width = dw + 'px'; wrap.style.height = dh + 'px';
    wrap.style.left = (sw - dw) / 2 + 'px'; wrap.style.top = (sh - dh) / 2 + 'px';
    S.view = { scale: s, region: region, dw: dw, dh: dh };
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    var cv = $('pe-cv');
    cv.width = Math.round(dw * dpr); cv.height = Math.round(dh * dpr);
    drawStage();
    positionBox();
  }

  function drawStage() {
    if (!S || !S.view) return;
    if (S.lookDirty) rebuildLook();
    var cv = $('pe-cv'), ctx = cv.getContext('2d');
    var r = S.view.region, k = S.pvf.width / S.tw;
    ctx.imageSmoothingQuality = 'high';
    ctx.clearRect(0, 0, cv.width, cv.height);
    ctx.drawImage(S.pvf, r.x * k, r.y * k, r.w * k, r.h * k, 0, 0, cv.width, cv.height);
  }

  function positionBox() {
    if (!S || !S.view) return;
    var box = $('pe-box'), k = S.view.scale;
    box.style.left = S.crop.x * k + 'px'; box.style.top = S.crop.y * k + 'px';
    box.style.width = S.crop.w * k + 'px'; box.style.height = S.crop.h * k + 'px';
    box.classList.toggle('locked', !!currentAR());
  }

  function renderAspectChips() {
    var host = $('pe-chips');
    host.innerHTML = '';
    ASPECTS.forEach(function (a) {
      if (S.aspects && a.id !== 'free' && a.id !== 'orig' && S.aspects.indexOf(a.id) === -1) return;
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'pe-chip' + (S.aspect === a.id ? ' sel' : '');
      b.textContent = a.label;
      b.onclick = function () {
        S.aspect = a.id;
        var ar = currentAR();
        if (ar) S.crop = clampCrop(fitAspect(S.crop, ar), S.tw, S.th);
        renderAspectChips();
        positionBox();
        pushHistory();
      };
      host.appendChild(b);
    });
  }

  function buildThumbs() {
    if (!S) return;
    if (!S.thumbsDirty && $('pe-filters').childNodes.length) { markFilter(); return; }
    var host = $('pe-filters');
    host.innerHTML = '';
    // centre-square of the current picture, small
    var side = Math.min(S.pv.width, S.pv.height);
    var tb = document.createElement('canvas');
    tb.width = THUMB; tb.height = THUMB;
    tb.getContext('2d').drawImage(S.pv, (S.pv.width - side) / 2, (S.pv.height - side) / 2, side, side, 0, 0, THUMB, THUMB);
    PRESETS.forEach(function (p) {
      var c = document.createElement('canvas');
      c.width = THUMB; c.height = THUMB;
      var cx = c.getContext('2d');
      cx.drawImage(tb, 0, 0);
      if (p.id !== 'none') { var id = cx.getImageData(0, 0, THUMB, THUMB); applyLook(id, p.id, { b: 0, c: 0, s: 0 }); cx.putImageData(id, 0, 0); }
      var b = document.createElement('button');
      b.type = 'button'; b.className = 'pe-f'; b.setAttribute('data-f', p.id);
      b.appendChild(c);
      var lbl = document.createElement('span'); lbl.textContent = p.name; b.appendChild(lbl);
      b.onclick = function () { S.filter = p.id; markFilter(); lookChanged(); pushHistory(); };
      host.appendChild(b);
    });
    S.thumbsDirty = false;
    markFilter();
  }

  function markFilter() {
    Array.prototype.forEach.call($('pe-filters').children, function (b) {
      b.classList.toggle('sel', b.getAttribute('data-f') === S.filter);
    });
  }

  function syncSliders() {
    Array.prototype.forEach.call(el.querySelectorAll('input[type=range]'), function (inp) {
      var v = S.adj[inp.getAttribute('data-k')] || 0;
      inp.value = v; inp.nextElementSibling.textContent = v;
    });
  }

  function setTab(tab) {
    if (!S) return;
    S.tab = tab;
    el.className = 'on tab-' + tab;
    if (tab === 'filters') buildThumbs();
    layoutStage();
  }

  /* ───────────────────────── undo / redo ─────────────────────────
     One step per deliberate action: a rotate, a flip, a crop-shape chip, a finished crop
     drag, a filter tap, a finished slider drag, "Reset adjustments". Each step is the
     whole edit state (serialize()), so undoing always lands on an exact earlier look. */
  var HIST_MAX = 60;

  function histKey(st) {
    var c = st.crop;
    return JSON.stringify([st.rot, st.flip, st.aspect, st.filter, st.adj.b, st.adj.c, st.adj.s,
      Math.round(c.x * 1e4), Math.round(c.y * 1e4), Math.round(c.w * 1e4), Math.round(c.h * 1e4)]);
  }

  function updateHistButtons() {
    var u = $('pe-undo'), r = $('pe-redo');
    if (!u || !r) return;
    u.disabled = !S || !S.hist || S.hi <= 0;
    r.disabled = !S || !S.hist || S.hi >= S.hist.length - 1;
  }

  function pushHistory() {
    if (!S || !S.hist) return;
    var st = serialize();
    if (S.hist[S.hi] && histKey(S.hist[S.hi]) === histKey(st)) return;   // nothing actually changed
    S.hist = S.hist.slice(0, S.hi + 1);
    S.hist.push(st);
    if (S.hist.length > HIST_MAX) S.hist.shift();
    S.hi = S.hist.length - 1;
    updateHistButtons();
  }

  function applySnap(snap) {
    var needT = snap.rot !== S.rot || snap.flip !== S.flip;
    S.rot = snap.rot; S.flip = snap.flip; S.aspect = snap.aspect; S.filter = snap.filter;
    S.adj = { b: snap.adj.b, c: snap.adj.c, s: snap.adj.s };
    if (needT) rebuildTransform();
    S.crop = clampCrop({ x: snap.crop.x * S.tw, y: snap.crop.y * S.th, w: snap.crop.w * S.tw, h: snap.crop.h * S.th }, S.tw, S.th);
    S.lookDirty = true;
    syncSliders();
    renderAspectChips();
    if (S.tab === 'filters') { if (needT) buildThumbs(); else markFilter(); }
    else if (needT) S.thumbsDirty = true;
    layoutStage();
    updateHistButtons();
  }

  function undo() { if (S && S.hist && S.hi > 0) { S.hi--; applySnap(S.hist[S.hi]); } }
  function redo() { if (S && S.hist && S.hi < S.hist.length - 1) { S.hi++; applySnap(S.hist[S.hi]); } }

  /* ───────────────────────── finishing ───────────────────────── */

  function close(result) {
    var resolve = S.resolve;
    if (S.raf) cancelAnimationFrame(S.raf);
    S = null;
    el.className = '';
    document.body.style.overflow = S_prevOverflow;
    resolve(result);
  }
  var S_prevOverflow = '';

  function cancel() {
    if (!S) return;
    if (JSON.stringify(serialize()) !== S.initial && !window.confirm('Discard your changes?')) return;
    close(null);
  }

  function exportDataUrl() {
    var c = S.crop, w = Math.max(1, Math.round(c.w)), h = Math.max(1, Math.round(c.h));
    var out = document.createElement('canvas');
    out.width = w; out.height = h;
    var ctx = out.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(S.tc, c.x, c.y, c.w, c.h, 0, 0, w, h);
    if (!isNeutral(lookParams(S.filter, S.adj))) {
      var id = ctx.getImageData(0, 0, w, h);
      applyLook(id, S.filter, S.adj);
      ctx.putImageData(id, 0, 0);
    }
    var q = 0.9, url = out.toDataURL('image/jpeg', q);
    while (url.length * 0.75 > TARGET_BYTES && q > 0.55) { q -= 0.1; url = out.toDataURL('image/jpeg', q); }
    return url;
  }

  function done() {
    if (!S) return;
    var state = serialize();
    if (isDefaultState()) return close({ changed: false, dataUrl: null, state: state });
    var btn = $('pe-done');
    btn.disabled = true; btn.textContent = 'Saving\u2026';
    // let the button repaint before the (synchronous) pixel work
    setTimeout(function () {
      var url;
      try { url = exportDataUrl(); }
      catch (err) {
        btn.disabled = false; btn.textContent = 'Done';
        window.alert('Could not save this edit \u2014 try again.');
        return;
      }
      btn.textContent = 'Done';
      close({ changed: true, dataUrl: url, state: state });
    }, 30);
  }

  function open(opts) {
    opts = opts || {};
    build();
    if (S) return Promise.resolve(null);
    return new Promise(function (resolve, reject) {
      S_prevOverflow = document.body.style.overflow;
      document.body.style.overflow = 'hidden';
      S = { resolve: resolve, tab: 'crop', rot: 0, flip: false, aspect: 'free', filter: 'none', adj: { b: 0, c: 0, s: 0 }, aspects: opts.aspects || null };
      $('pe-title').textContent = opts.title || 'Edit photo';
      $('pe-loading').style.display = 'flex';
      $('pe-done').disabled = true;
      $('pe-undo').disabled = true; $('pe-redo').disabled = true;
      $('pe-filters').innerHTML = '';
      el.className = 'on tab-crop';

      loadImage(opts.src).then(function (img) {
        if (!S) return; // cancelled while loading
        var w = img.naturalWidth || img.width, h = img.naturalHeight || img.height;
        var k = Math.min(1, MAX_DIM / Math.max(w, h));
        var base = document.createElement('canvas');
        base.width = Math.max(1, Math.round(w * k)); base.height = Math.max(1, Math.round(h * k));
        var bctx = base.getContext('2d');
        bctx.fillStyle = '#fff'; bctx.fillRect(0, 0, base.width, base.height);
        bctx.drawImage(img, 0, 0, base.width, base.height);
        S.base = base;

        var st = opts.state;
        if (st) {
          S.rot = st.rot | 0; S.flip = !!st.flip; S.aspect = st.aspect || 'free';
          S.filter = st.filter || 'none';
          S.adj = { b: (st.adj && st.adj.b) || 0, c: (st.adj && st.adj.c) || 0, s: (st.adj && st.adj.s) || 0 };
        }
        // opts.aspect (e.g. '16:9') = a suggested starting crop shape for a brand-new edit
        if (!st && opts.aspect) {
          for (var ai = 0; ai < ASPECTS.length; ai++) if (ASPECTS[ai].id === opts.aspect) S.aspect = opts.aspect;
        }
        rebuildTransform();
        S.crop = st && st.crop
          ? clampCrop({ x: st.crop.x * S.tw, y: st.crop.y * S.th, w: st.crop.w * S.tw, h: st.crop.h * S.th }, S.tw, S.th)
          : fitAspect(fullCrop(), currentAR());
        syncSliders();
        renderAspectChips();
        $('pe-loading').style.display = 'none';
        $('pe-done').disabled = false;
        requestAnimationFrame(function () { if (S) layoutStage(); });
        S.initial = JSON.stringify(serialize()); // baseline for the "Discard your changes?" prompt
        S.hist = [serialize()]; S.hi = 0;        // baseline for undo/redo
        updateHistButtons();
      }).catch(function (err) {
        S = null; el.className = ''; document.body.style.overflow = S_prevOverflow;
        reject(err);
      });
    });
  }

  return {
    open: open,
    // exposed for tests only
    _test: { applyLook: applyLook, dragCrop: dragCrop, fitAspect: fitAspect, clampCrop: clampCrop, lookParams: lookParams, isNeutral: isNeutral }
  };
})();
