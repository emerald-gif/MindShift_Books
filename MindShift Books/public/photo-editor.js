// public/photo-editor.js
//
// Shared full-screen photo editor — crop (Free / Original / 1:1 / 4:5 / 16:9),
// rotate + flip, filters, brightness / contrast / saturation, and text overlays
// (Instagram-style: type on the photo, pick a font + colour + background, drag /
// pinch to place it, drag it to the bin to delete).
//
//   <script src="/photo-editor.js"></script>
//
//   const res = await MindshiftPhotoEditor.open({
//     src,            // data: URL, blob: URL or https URL of the ORIGINAL photo
//     state,          // optional: the `state` returned last time, to reopen with edits intact
//     title,          // optional header text (default "Edit photo")
//     aspects,        // optional: e.g. ['16:9'] to offer only some crop shapes
//     aspect,         // optional: start with this crop shape, e.g. '16:9' (new edits only)
//     text            // optional: pass false to hide the Text tab
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

  // Text styles. Canvas can't use CSS classes, so each style is a full font string ({s} = px).
  var FONTS = [
    { id: 'classic', name: 'Classic', css: '800 {s}px Inter,system-ui,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif' },
    { id: 'script',  name: 'Script',  css: 'italic 400 {s}px "Snell Roundhand","Brush Script MT","Segoe Script","Lucida Handwriting",cursive', sc: 1.18 },
    { id: 'serif',   name: 'Serif',   css: '700 {s}px Georgia,"Times New Roman",Times,serif' },
    { id: 'type',    name: 'Typewriter', css: '700 {s}px "Courier New",Courier,"Roboto Mono",monospace', sc: 0.92 },
    { id: 'poster',  name: 'Poster',  css: '700 {s}px Impact,Haettenschweiler,"Arial Narrow Bold","Roboto Condensed",sans-serif-condensed,"Arial Black",sans-serif', up: true, sc: 1.1 }
  ];
  var TEXT_COLORS = ['#ffffff', '#111111', '#4f46e5', '#06b6d4', '#f59e0b', '#ef4444', '#22c55e', '#ec4899'];
  var TEXT_SIZE_DEFAULT = 0.075;      // fraction of the photo's shorter side
  var COMPOSER_UNIT = 400;            // px reference while typing (size 0.075 -> 30px)
  var MAX_TEXTS = 12;

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

  /* ───────────────────────── text helpers ───────────────────────── */

  var _scratch = null;
  function scratchCtx() {
    if (!_scratch) _scratch = document.createElement('canvas').getContext('2d');
    return _scratch;
  }

  function fontOf(t) { return FONTS[t.font] || FONTS[0]; }

  // Layout of one text item at `unit` px (= the photo's shorter side). Same numbers drive
  // the preview, the hit-test, the typing box and the export.
  function measureText(t, unit) {
    var f = fontOf(t), px = Math.max(4, t.size * unit * (f.sc || 1));
    var c = scratchCtx();
    c.font = f.css.replace('{s}', px);
    var raw = t.text || '';
    var lines = (f.up ? raw.toUpperCase() : raw).split('\n');
    var ws = [], tw = 0, lh = px * 1.25;
    for (var i = 0; i < lines.length; i++) {
      var w = c.measureText(lines[i] || ' ').width;
      ws.push(w); if (w > tw) tw = w;
    }
    var padX = t.bg ? px * 0.4 : 0, padY = t.bg ? px * 0.12 : 0;
    return { px: px, font: c.font, lines: lines, ws: ws, lh: lh, tw: tw, padX: padX, padY: padY,
             w: tw + padX * 2, h: lines.length * lh + padY * 2 };
  }

  function contrastOn(hex) {
    var m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
    if (!m) return '#111111';
    var n = parseInt(m[1], 16), r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
    return (0.299 * r + 0.587 * g + 0.114 * b) > 150 ? '#111111' : '#ffffff';
  }

  function rrect(ctx, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  // Draws one text item centred on the current origin (caller sets translate / rotate).
  function drawTextItem(ctx, t, unit) {
    if (!t.text || !t.text.trim()) return;
    var m = measureText(t, unit);
    var bgCol = null, txtCol = t.color;
    if (t.bg === 1) { bgCol = t.color; txtCol = contrastOn(t.color); }
    else if (t.bg === 2) { bgCol = 'rgba(0,0,0,0.55)'; }
    var top = -m.h / 2 + m.padY;
    function lineX(i) { return t.align === 'left' ? -m.tw / 2 : t.align === 'right' ? m.tw / 2 - m.ws[i] : -m.ws[i] / 2; }
    ctx.save();
    if (bgCol) {
      ctx.fillStyle = bgCol;
      for (var i = 0; i < m.lines.length; i++) {
        if (!m.lines[i].trim()) continue;
        rrect(ctx, lineX(i) - m.padX, top + i * m.lh, m.ws[i] + m.padX * 2, m.lh, m.px * 0.32);
        ctx.fill();
      }
    } else {
      ctx.shadowColor = 'rgba(0,0,0,0.38)';
      ctx.shadowBlur = m.px * 0.14;
      ctx.shadowOffsetY = m.px * 0.03;
    }
    ctx.font = m.font; ctx.textBaseline = 'middle'; ctx.textAlign = 'left'; ctx.fillStyle = txtCol;
    for (var j = 0; j < m.lines.length; j++) ctx.fillText(m.lines[j], lineX(j), top + j * m.lh + m.lh / 2);
    ctx.restore();
  }

  function cloneText(t) {
    return { text: t.text, font: t.font, color: t.color, bg: t.bg, align: t.align, size: t.size, x: t.x, y: t.y, rot: t.rot };
  }

  function cleanText(t) {   // trusts nothing from an old saved state
    t = t || {};
    var size = Number(t.size); if (!(size > 0)) size = TEXT_SIZE_DEFAULT;
    return {
      text: String(t.text == null ? '' : t.text).slice(0, 400),
      font: Math.min(Math.max(t.font | 0, 0), FONTS.length - 1),
      color: /^#[0-9a-f]{6}$/i.test(t.color || '') ? t.color : '#ffffff',
      bg: Math.min(Math.max(t.bg | 0, 0), 2),
      align: t.align === 'left' || t.align === 'right' ? t.align : 'center',
      size: Math.min(Math.max(size, 0.02), 0.4),
      x: isFinite(t.x) ? Number(t.x) : 0.5, y: isFinite(t.y) ? Number(t.y) : 0.5,
      rot: isFinite(t.rot) ? Number(t.rot) : 0
    };
  }

  // Is image-space point (px,py) on text `t`? (`slop` widens it so small text is still easy to grab)
  function hitTest(t, unit, tw, th, px, py, slop) {
    var m = measureText(t, unit);
    var dx = px - t.x * tw, dy = py - t.y * th, a = -t.rot * Math.PI / 180;
    var lx = dx * Math.cos(a) - dy * Math.sin(a), ly = dx * Math.sin(a) + dy * Math.cos(a);
    return Math.abs(lx) <= m.w / 2 + slop && Math.abs(ly) <= m.h / 2 + slop;
  }

  // Keep the text glued to the picture when the picture is turned / mirrored.
  function turnTexts(texts) {          // 90° clockwise
    texts.forEach(function (t) { var x = t.x; t.x = 1 - t.y; t.y = x; t.rot = normRot(t.rot + 90); });
  }
  function mirrorTexts(texts) {        // horizontal flip — the words themselves stay readable
    texts.forEach(function (t) { t.x = 1 - t.x; t.rot = normRot(-t.rot); });
  }
  function normRot(d) { d = d % 360; if (d > 180) d -= 360; if (d <= -180) d += 360; return d; }

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
    '#kv-pe.tab-crop .pe-tab[data-tab=crop],#kv-pe.tab-filters .pe-tab[data-tab=filters],#kv-pe.tab-adjust .pe-tab[data-tab=adjust],#kv-pe.tab-text .pe-tab[data-tab=text]{color:#fff}' +
    /* text tab */
    '#kv-pe.tab-text #pe-t-text{display:block}' +
    '#kv-pe .pe-txt{position:absolute;inset:0;touch-action:none;display:none}' +
    '#kv-pe.tab-text .pe-txt{display:block}' +
    '#kv-pe .pe-hint{font-size:12.5px;color:#7c8497;line-height:1.5;margin-top:12px}' +
    '#kv-pe .pe-add{background:linear-gradient(135deg,#4f46e5,#06b6d4);color:#fff;font-weight:700}' +
    '#kv-pe .pe-add b{font-size:17px;font-weight:800;letter-spacing:-.5px}' +
    '#kv-pe .pe-trash{position:absolute;left:50%;bottom:14px;width:54px;height:54px;margin-left:-27px;border-radius:50%;background:rgba(20,20,31,.92);border:1.5px solid rgba(255,255,255,.35);color:#fff;display:flex;align-items:center;justify-content:center;opacity:0;transform:scale(.7);transition:opacity .15s,transform .15s,background .15s;pointer-events:none;z-index:3}' +
    '#kv-pe .pe-trash svg{width:24px;height:24px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}' +
    '#kv-pe .pe-trash.show{opacity:1;transform:scale(1)}' +
    '#kv-pe .pe-trash.hot{background:#ef4444;border-color:#ef4444;transform:scale(1.22)}' +
    /* composer (typing screen) */
    '#pe-te{position:fixed;left:0;right:0;top:0;bottom:0;z-index:10001;display:none;flex-direction:column;background:rgba(8,8,14,.74);color:#fff;font-family:Inter,system-ui,-apple-system,sans-serif;-webkit-user-select:none;user-select:none}' +
    '#pe-te.on{display:flex}' +
    '#kv-pe.composing .pe-hdr,#kv-pe.composing .pe-panel,#kv-pe.composing .pe-trash{visibility:hidden}' +
    '#pe-te .te-top{display:flex;align-items:center;gap:10px;padding:calc(env(safe-area-inset-top,0px) + 10px) 12px 8px;flex-shrink:0}' +
    '#pe-te .te-sp{flex:1}' +
    '#pe-te .te-btn{width:40px;height:40px;border-radius:50%;border:none;background:rgba(255,255,255,.14);color:#fff;display:flex;align-items:center;justify-content:center;cursor:pointer;font-family:inherit;padding:0;-webkit-tap-highlight-color:transparent}' +
    '#pe-te .te-btn svg{width:20px;height:20px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round}' +
    '#pe-te .te-bg span{display:flex;align-items:center;justify-content:center;width:22px;height:22px;border-radius:6px;font-weight:800;font-size:14px;line-height:1;border:2px solid #fff;color:#fff;box-sizing:border-box}' +
    '#pe-te .te-bg.b1 span{background:#fff;color:#111}' +
    '#pe-te .te-bg.b2 span{background:rgba(255,255,255,.35);border-color:rgba(255,255,255,.35)}' +
    '#pe-te .te-done{border:none;background:linear-gradient(135deg,#4f46e5,#06b6d4);color:#fff;font-weight:700;font-size:15px;font-family:inherit;padding:9px 20px;border-radius:99px;cursor:pointer}' +
    '#pe-te .te-mid{flex:1;min-height:0;display:flex;align-items:center;justify-content:center;overflow:hidden;padding:0 16px}' +
    '#pe-te .te-box{position:relative;flex:0 0 auto;max-width:100%}' +
    '#pe-te .te-box canvas{position:absolute;left:0;top:0;pointer-events:none}' +
    '#pe-te textarea{position:absolute;left:0;top:0;width:100%;height:100%;box-sizing:border-box;margin:0;border:0;outline:0;resize:none;overflow:hidden;white-space:pre;background:transparent;color:transparent;caret-color:#fff;-webkit-user-select:text;user-select:text;font-family:inherit;-webkit-text-fill-color:transparent}' +
    '#pe-te textarea::placeholder{color:rgba(255,255,255,.55);-webkit-text-fill-color:rgba(255,255,255,.55)}' +
    '#pe-te .te-bot{flex-shrink:0;padding:6px 0 calc(env(safe-area-inset-bottom,0px) + 8px)}' +
    '#pe-te .te-row{display:flex;gap:12px;overflow-x:auto;scrollbar-width:none;padding:6px 14px;align-items:center}' +
    '#pe-te .te-row::-webkit-scrollbar{display:none}' +
    '#pe-te .te-f{flex:0 0 auto;width:44px;height:44px;border-radius:50%;border:none;background:rgba(255,255,255,.16);color:#fff;font-size:18px;cursor:pointer;padding:0;display:flex;align-items:center;justify-content:center}' +
    '#pe-te .te-f.sel{background:#fff;color:#111}' +
    '#pe-te .te-c{flex:0 0 auto;width:30px;height:30px;border-radius:50%;border:2.5px solid rgba(255,255,255,.55);cursor:pointer;padding:0;position:relative;box-sizing:border-box}' +
    '#pe-te .te-c.sel{border-color:#fff;box-shadow:0 0 0 2px rgba(0,0,0,.45),0 0 0 4px #fff}' +
    '#pe-te .te-c.custom{background:conic-gradient(#ef4444,#f59e0b,#22c55e,#06b6d4,#4f46e5,#ec4899,#ef4444);overflow:hidden}' +
    '#pe-te .te-c.custom input{position:absolute;inset:-6px;width:44px;height:44px;opacity:0;cursor:pointer;border:0;padding:0}' +
    '#pe-te .te-sz{display:flex;align-items:center;gap:12px;padding:6px 20px 2px}' +
    '#pe-te .te-sz input{flex:1;accent-color:#818cf8;height:28px}' +
    '#pe-te .te-sz i{font-style:normal;font-weight:700;color:#cbd5e1;line-height:1}';

  var ICON = {
    rot:  '<svg viewBox="0 0 24 24"><path d="M21 12a9 9 0 1 1-3-6.7"/><polyline points="21 3 21 9 15 9"/></svg>',
    flip: '<svg viewBox="0 0 24 24"><path d="M12 3v18"/><path d="M8 7L3 17h5z"/><path d="M16 7l5 10h-5z"/></svg>',
    undo: '<svg viewBox="0 0 24 24"><polyline points="7 6 3 10 7 14"/><path d="M3 10h10a5 5 0 0 1 5 5v1a5 5 0 0 1-5 5H9"/></svg>',
    redo: '<svg viewBox="0 0 24 24"><polyline points="17 6 21 10 17 14"/><path d="M21 10H11a5 5 0 0 0-5 5v1a5 5 0 0 0 5 5h4"/></svg>',
    crop: '<svg viewBox="0 0 24 24"><path d="M6 2v14a2 2 0 0 0 2 2h14"/><path d="M18 22V8a2 2 0 0 0-2-2H2"/></svg>',
    fx:   '<svg viewBox="0 0 24 24"><circle cx="9" cy="12" r="6"/><circle cx="15" cy="12" r="6"/></svg>',
    adj:  '<svg viewBox="0 0 24 24"><line x1="4" y1="7" x2="20" y2="7"/><line x1="4" y1="17" x2="20" y2="17"/><circle cx="9" cy="7" r="2.4" fill="#14141f"/><circle cx="15" cy="17" r="2.4" fill="#14141f"/></svg>',
    txt:  '<svg viewBox="0 0 24 24"><polyline points="4 7 4 4 20 4 20 7"/><line x1="9" y1="20" x2="15" y2="20"/><line x1="12" y1="4" x2="12" y2="20"/></svg>',
    bin:  '<svg viewBox="0 0 24 24"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>',
    al: {
      left:   '<svg viewBox="0 0 24 24"><line x1="4" y1="6" x2="20" y2="6"/><line x1="4" y1="12" x2="14" y2="12"/><line x1="4" y1="18" x2="18" y2="18"/></svg>',
      center: '<svg viewBox="0 0 24 24"><line x1="4" y1="6" x2="20" y2="6"/><line x1="7" y1="12" x2="17" y2="12"/><line x1="5" y1="18" x2="19" y2="18"/></svg>',
      right:  '<svg viewBox="0 0 24 24"><line x1="4" y1="6" x2="20" y2="6"/><line x1="10" y1="12" x2="20" y2="12"/><line x1="6" y1="18" x2="20" y2="18"/></svg>'
    }
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
          '<div class="pe-txt" id="pe-txt"></div>' +
        '</div>' +
        '<div class="pe-trash" id="pe-trash">' + ICON.bin + '</div>' +
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
        '<div class="pe-tool" id="pe-t-text">' +
          '<div class="pe-row"><button type="button" class="pe-tbtn pe-add" id="pe-addtext"><b>Aa</b>Add text</button></div>' +
          '<div class="pe-hint">Tap text to edit \u00b7 drag to move \u00b7 pinch to resize and rotate \u00b7 drag to the bin to delete</div>' +
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
          '<button type="button" class="pe-tab" data-tab="text" id="pe-tab-text">' + ICON.txt + 'Text</button>' +
        '</div>' +
      '</div>' +
      /* the typing screen: dimmed photo behind, text in the middle, styles above the keyboard */
      '<div id="pe-te" role="dialog" aria-label="Add text">' +
        '<div class="te-top">' +
          '<button type="button" class="te-btn te-bg" id="te-bg" aria-label="Text background"><span>A</span></button>' +
          '<button type="button" class="te-btn" id="te-al" aria-label="Alignment"></button>' +
          '<div class="te-sp"></div>' +
          '<button type="button" class="te-done" id="te-done">Done</button>' +
        '</div>' +
        '<div class="te-mid"><div class="te-box" id="te-box"><canvas id="te-cv"></canvas>' +
          '<textarea id="te-ta" rows="1" placeholder="Type something\u2026" maxlength="400" spellcheck="false" autocapitalize="sentences" aria-label="Text"></textarea></div></div>' +
        '<div class="te-bot">' +
          '<div class="te-row" id="te-fonts"></div>' +
          '<div class="te-row" id="te-colors"></div>' +
          '<div class="te-sz"><i style="font-size:12px">A</i><input type="range" id="te-size" min="3" max="18" step="0.5" aria-label="Text size"><i style="font-size:22px">A</i></div>' +
        '</div>' +
      '</div>';
    document.body.appendChild(el);
    buildComposerUI();

    $('pe-cancel').onclick = function () { cancel(); };
    $('pe-done').onclick = function () { done(); };
    $('pe-rot').onclick = function () { if (S) { S.rot = (S.rot + 1) % 4; turnTexts(S.texts); transformChanged(true); pushHistory(); } };
    $('pe-flip').onclick = function () { if (S) { S.flip = !S.flip; mirrorTexts(S.texts); transformChanged(true); pushHistory(); } };
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
      b.onclick = function () {
        var tab = b.getAttribute('data-tab');
        setTab(tab);
        // first visit to Text with nothing on the photo yet: go straight to typing, like Instagram
        if (tab === 'text' && S && S.texts.length === 0 && !S.ed) openComposer(-1);
      };
    });
    $('pe-addtext').onclick = function () { if (S && !S.ed) openComposer(-1); };
    bindTextStage();
    Array.prototype.forEach.call(el.querySelectorAll('.pe-sl input[type=range]'), function (inp) {
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
      if (S.ed) {                                   // typing screen: Esc / Ctrl+Enter finish, undo belongs to the textarea
        if (e.key === 'Escape' || ((e.ctrlKey || e.metaKey) && e.key === 'Enter')) { e.preventDefault(); closeComposer(true); }
        return;
      }
      if (e.key === 'Escape') { cancel(); return; }
      if ((e.key === 'Delete' || e.key === 'Backspace') && S.tab === 'text' && S.sel >= 0) {
        e.preventDefault(); S.texts.splice(S.sel, 1); S.sel = -1; drawStage(); pushHistory(); return;
      }
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
    return S.rot === 0 && !S.flip && S.filter === 'none' && !S.adj.b && !S.adj.c && !S.adj.s && full && !S.texts.length;
  }

  function serialize() {
    return {
      rot: S.rot, flip: S.flip, aspect: S.aspect, filter: S.filter,
      adj: { b: S.adj.b, c: S.adj.c, s: S.adj.s },
      crop: { x: S.crop.x / S.tw, y: S.crop.y / S.th, w: S.crop.w / S.tw, h: S.crop.h / S.th },
      texts: S.texts.map(cloneText)     // positions are fractions of the turned photo, so crop changes never move them
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
    if (S.texts.length) {
      var f = cv.width / r.w;                       // canvas px per photo px
      ctx.save();
      ctx.setTransform(f, 0, 0, f, -r.x * f, -r.y * f);
      drawTexts(ctx, { k: f, sel: S.tab === 'text' ? S.sel : -1, skip: S.ed ? S.ed.idx : -2 });
      ctx.restore();
    }
  }

  // Draws every text in photo-pixel space (caller has set the transform).
  function drawTexts(ctx, o) {
    var unit = Math.min(S.tw, S.th);
    S.texts.forEach(function (t, i) {
      if (o.skip === i) return;
      ctx.save();
      ctx.translate(t.x * S.tw, t.y * S.th);
      ctx.rotate(t.rot * Math.PI / 180);
      drawTextItem(ctx, t, unit);
      if (o.sel === i && t.text.trim()) {
        var m = measureText(t, unit), pd = 8 / o.k;
        ctx.lineWidth = 3 / o.k; ctx.strokeStyle = 'rgba(0,0,0,.35)'; ctx.setLineDash([]);
        ctx.strokeRect(-m.w / 2 - pd, -m.h / 2 - pd, m.w + pd * 2, m.h + pd * 2);
        ctx.lineWidth = 1.5 / o.k; ctx.strokeStyle = '#fff'; ctx.setLineDash([6 / o.k, 4 / o.k]);
        ctx.strokeRect(-m.w / 2 - pd, -m.h / 2 - pd, m.w + pd * 2, m.h + pd * 2);
      }
      ctx.restore();
    });
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
    Array.prototype.forEach.call(el.querySelectorAll('.pe-sl input[type=range]'), function (inp) {
      var v = S.adj[inp.getAttribute('data-k')] || 0;
      inp.value = v; inp.nextElementSibling.textContent = v;
    });
  }

  function setTab(tab) {
    if (!S) return;
    S.tab = tab;
    if (tab !== 'text') S.sel = -1;
    el.className = 'on tab-' + tab;
    if (tab === 'filters') buildThumbs();
    layoutStage();
  }

  /* ───────────────────────── text: typing screen ─────────────────────────
     Opens over the editor (dimmed photo behind), like Instagram: type in the middle, pick a
     font / colour / background / alignment / size just above the keyboard, tap Done.
     While typing, the words are drawn by the SAME drawTextItem the photo uses, and a
     transparent <textarea> sits exactly on top of them to take the typing and show the caret. */
  var TE = {};

  function clampN(v, a, b) { return Math.min(Math.max(v, a), b); }

  function buildComposerUI() {
    TE.root = $('pe-te'); TE.ta = $('te-ta'); TE.cv = $('te-cv'); TE.box = $('te-box');

    var fh = $('te-fonts');
    FONTS.forEach(function (f, i) {
      var b = document.createElement('button');
      b.type = 'button'; b.className = 'te-f'; b.setAttribute('data-i', i);
      b.setAttribute('aria-label', f.name + ' font');
      b.textContent = f.up ? 'AA' : 'Aa';
      b.style.font = f.css.replace('{s}', '18');
      b.onclick = function () { if (S && S.ed) { S.ed.t.font = i; composerChanged(); } };
      fh.appendChild(b);
    });

    var ch = $('te-colors');
    TEXT_COLORS.forEach(function (c) {
      var b = document.createElement('button');
      b.type = 'button'; b.className = 'te-c'; b.setAttribute('data-c', c);
      b.setAttribute('aria-label', 'Colour ' + c);
      b.style.background = c;
      b.onclick = function () { if (S && S.ed) { S.ed.t.color = c; composerChanged(); } };
      ch.appendChild(b);
    });
    var cu = document.createElement('label');
    cu.className = 'te-c custom'; cu.setAttribute('aria-label', 'Custom colour');
    cu.innerHTML = '<input type="color" value="#ffffff">';
    cu.firstChild.addEventListener('input', function () { if (S && S.ed) { S.ed.t.color = this.value; composerChanged(true); } });
    ch.appendChild(cu);

    $('te-bg').onclick = function () { if (S && S.ed) { S.ed.t.bg = (S.ed.t.bg + 1) % 3; composerChanged(); } };
    $('te-al').onclick = function () {
      if (!S || !S.ed) return;
      var o = ['center', 'left', 'right'];
      S.ed.t.align = o[(o.indexOf(S.ed.t.align) + 1) % 3];
      composerChanged();
    };
    $('te-size').addEventListener('input', function () { if (S && S.ed) { S.ed.t.size = clampN(Number(this.value) / 100, 0.03, 0.18); layoutComposer(); drawStage(); } });
    $('te-done').onclick = function () { closeComposer(true); };
    TE.ta.addEventListener('input', function () {
      if (!S || !S.ed) return;
      S.ed.t.text = TE.ta.value;
      layoutComposer();
      TE.ta.scrollTop = 0; TE.ta.scrollLeft = 0;
    });
    // desktop: clicking a style button must not pull focus (and the caret) out of the text box
    TE.root.addEventListener('mousedown', function (e) {
      var tg = e.target;
      if (tg === TE.ta || (tg.tagName && tg.tagName.toUpperCase() === 'INPUT')) return;
      e.preventDefault();
    });
    // a tap on the empty dimmed area = Done, like Instagram
    $('te-box').parentNode.addEventListener('click', function (e) { if (e.target === this) closeComposer(true); });

    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', positionComposer);
      window.visualViewport.addEventListener('scroll', positionComposer);
    }
  }

  // Keeps the screen exactly as tall as what's visible above the phone keyboard.
  function positionComposer() {
    var vv = window.visualViewport, r = TE.root;
    if (!vv || !r) return;
    r.style.top = vv.offsetTop + 'px'; r.style.left = vv.offsetLeft + 'px';
    r.style.width = vv.width + 'px'; r.style.height = vv.height + 'px';
    r.style.right = 'auto'; r.style.bottom = 'auto';
  }

  function refocus() {
    if (TE.ta && document.activeElement !== TE.ta) { try { TE.ta.focus({ preventScroll: true }); } catch (_) { TE.ta.focus(); } }
  }

  function composerChanged(keepFocus) {
    syncComposerUI();
    layoutComposer();
    drawStage();
    if (!keepFocus) refocus();
  }

  function syncComposerUI() {
    var t = S.ed.t;
    Array.prototype.forEach.call($('te-fonts').children, function (b) { b.classList.toggle('sel', Number(b.getAttribute('data-i')) === t.font); });
    var known = false;
    Array.prototype.forEach.call($('te-colors').children, function (b) {
      var c = b.getAttribute('data-c');
      var on = !!c && c.toLowerCase() === t.color.toLowerCase();
      if (on) known = true;
      b.classList.toggle('sel', on);
    });
    $('te-colors').lastChild.classList.toggle('sel', !known);
    $('te-bg').className = 'te-btn te-bg b' + t.bg;
    $('te-al').innerHTML = ICON.al[t.align] || ICON.al.center;
    $('te-size').value = String(Math.round(t.size * 200) / 2);
  }

  function layoutComposer() {
    var t = S.ed.t, unit = COMPOSER_UNIT, m = measureText(t, unit);
    var maxW = Math.max(120, (TE.root.clientWidth || window.innerWidth) - 32);
    if (m.w + 6 > maxW) { unit = COMPOSER_UNIT * (maxW - 6) / m.w; m = measureText(t, unit); }   // very long line: shrink to fit while typing
    var w = Math.min(Math.max(Math.ceil(m.w) + 6, 90), maxW), h = Math.max(m.h, m.lh);
    TE.box.style.width = w + 'px'; TE.box.style.height = h + 'px';
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    TE.cv.width = Math.round(w * dpr); TE.cv.height = Math.round(Math.ceil(h) * dpr);
    TE.cv.style.width = w + 'px'; TE.cv.style.height = Math.ceil(h) + 'px';
    var c = TE.cv.getContext('2d');
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.clearRect(0, 0, TE.cv.width, TE.cv.height);
    c.setTransform(dpr, 0, 0, dpr, w * dpr / 2, h * dpr / 2);
    drawTextItem(c, t, unit);
    var ta = TE.ta;
    ta.style.font = m.font;
    ta.style.lineHeight = m.lh + 'px';
    ta.style.padding = m.padY + 'px ' + (m.padX + 3) + 'px';
    ta.style.textAlign = t.align;
  }

  function newText() {
    var last = S.texts.length ? S.texts[S.texts.length - 1] : null;
    return cleanText({
      text: '', font: last ? last.font : 0, color: last ? last.color : '#ffffff', bg: last ? last.bg : 0, align: 'center',
      size: TEXT_SIZE_DEFAULT, x: (S.crop.x + S.crop.w / 2) / S.tw, y: (S.crop.y + S.crop.h / 2) / S.th, rot: 0
    });
  }

  function openComposer(idx) {
    if (!S || S.ed) return;
    var t;
    if (idx >= 0 && S.texts[idx]) t = cloneText(S.texts[idx]);
    else {
      if (S.texts.length >= MAX_TEXTS) { window.alert('That\u2019s the most text you can put on one photo.'); return; }
      idx = -1; t = newText();
    }
    S.ed = { idx: idx, t: t };
    S.sel = -1;
    TE.ta.value = t.text;
    TE.root.classList.add('on');
    el.classList.add('composing');
    positionComposer();
    syncComposerUI();
    layoutComposer();
    drawStage();
    try { TE.ta.focus({ preventScroll: true }); } catch (_) { TE.ta.focus(); }
  }

  function closeComposer(commit) {
    if (!S || !S.ed) return;
    var ed = S.ed;
    S.ed = null;
    TE.root.classList.remove('on');
    el.classList.remove('composing');
    TE.ta.blur();
    if (commit) {
      var has = ed.t.text.trim().length > 0;
      if (ed.idx >= 0) {
        if (has) { S.texts[ed.idx] = ed.t; S.sel = ed.idx; }
        else { S.texts.splice(ed.idx, 1); S.sel = -1; }
      } else if (has) { S.texts.push(ed.t); S.sel = S.texts.length - 1; }
      pushHistory();
    }
    drawStage();
  }

  /* ───────────────────────── text: moving / pinching on the photo ─────────────────────────
     Tap = edit · one finger = move · two fingers = resize + rotate · drop on the bin = delete. */
  function bindTextStage() {
    var surf = $('pe-txt'), trash = $('pe-trash');
    var ptrs = {}, g = null, wheelT = 0;
    function count() { return Object.keys(ptrs).length; }
    function toImg(x, y) {
      var rc = $('pe-wrap').getBoundingClientRect();
      return { x: S.view.region.x + (x - rc.left) / S.view.scale, y: S.view.region.y + (y - rc.top) / S.view.scale };
    }
    function overTrash(x, y) {
      var r = trash.getBoundingClientRect(), pad = 18;
      return x >= r.left - pad && x <= r.right + pad && y >= r.top - pad && y <= r.bottom + pad;
    }
    function hideTrash() { trash.classList.remove('show'); trash.classList.remove('hot'); }

    surf.addEventListener('pointerdown', function (e) {
      if (!S || S.tab !== 'text' || S.ed || !S.view) return;
      try { surf.setPointerCapture(e.pointerId); } catch (_) {}
      ptrs[e.pointerId] = { x: e.clientX, y: e.clientY };
      e.preventDefault();
      var n = count();
      if (n === 1) {
        var p = toImg(e.clientX, e.clientY), unit = Math.min(S.tw, S.th), slop = 14 / S.view.scale, hit = -1;
        for (var i = S.texts.length - 1; i >= 0; i--) {
          if (hitTest(S.texts[i], unit, S.tw, S.th, p.x, p.y, slop)) { hit = i; break; }
        }
        S.sel = hit;
        g = { mode: 'drag', idx: hit, sx: e.clientX, sy: e.clientY, moved: false, t0: hit >= 0 ? { x: S.texts[hit].x, y: S.texts[hit].y } : null };
        drawStage();
      } else if (n === 2) {
        var ids = Object.keys(ptrs), a = ptrs[ids[0]], b = ptrs[ids[1]], t = S.sel >= 0 ? S.texts[S.sel] : null;
        if (!t) { g = { mode: 'none' }; hideTrash(); return; }
        g = { mode: 'pinch', ids: ids, d0: Math.hypot(b.x - a.x, b.y - a.y) || 1, a0: Math.atan2(b.y - a.y, b.x - a.x),
              size0: t.size, rot0: t.rot, edited: !!(g && g.moved) };
        hideTrash();
      }
    });

    surf.addEventListener('pointermove', function (e) {
      if (!g || !ptrs[e.pointerId] || !S) return;
      ptrs[e.pointerId] = { x: e.clientX, y: e.clientY };
      if (g.mode === 'pinch') {
        var a = ptrs[g.ids[0]], b = ptrs[g.ids[1]], t = S.texts[S.sel];
        if (!a || !b || !t) return;
        t.size = clampN(g.size0 * Math.hypot(b.x - a.x, b.y - a.y) / g.d0, 0.02, 0.4);
        t.rot = normRot(g.rot0 + (Math.atan2(b.y - a.y, b.x - a.x) - g.a0) * 180 / Math.PI);
        g.edited = true;
        drawStage();
      } else if (g.mode === 'drag' && g.idx >= 0 && count() === 1) {
        var dx = e.clientX - g.sx, dy = e.clientY - g.sy;
        if (!g.moved && Math.hypot(dx, dy) < 6) return;
        g.moved = true;
        var tx = S.texts[g.idx], k = S.view.scale, c = S.crop;
        tx.x = clampN(g.t0.x + dx / k / S.tw, c.x / S.tw, (c.x + c.w) / S.tw);
        tx.y = clampN(g.t0.y + dy / k / S.th, c.y / S.th, (c.y + c.h) / S.th);
        trash.classList.add('show');
        trash.classList.toggle('hot', overTrash(e.clientX, e.clientY));
        drawStage();
      }
    });

    function end(e) {
      if (!ptrs[e.pointerId]) return;
      delete ptrs[e.pointerId];
      if (!g || !S) { if (!count()) g = null; return; }
      if (g.mode === 'pinch') {
        if (count() === 0) { var ed = g.edited; g = null; hideTrash(); if (ed) pushHistory(); }
        return;
      }
      if (count() > 0) return;
      var gg = g, cancelled = e.type === 'pointercancel';
      g = null; hideTrash();
      if (gg.mode !== 'drag' || gg.idx < 0) return;
      if (gg.moved) {
        if (!cancelled && overTrash(e.clientX, e.clientY)) { S.texts.splice(gg.idx, 1); S.sel = -1; drawStage(); }
        pushHistory();
      } else if (!cancelled) {
        openComposer(gg.idx);                       // a plain tap edits the text
      }
    }
    surf.addEventListener('pointerup', end);
    surf.addEventListener('pointercancel', end);

    // desktop: scroll wheel resizes the selected text, Shift + wheel rotates it
    surf.addEventListener('wheel', function (e) {
      if (!S || S.tab !== 'text' || S.ed || S.sel < 0 || !S.texts[S.sel]) return;
      e.preventDefault();
      var t = S.texts[S.sel], up = e.deltaY < 0;
      if (e.shiftKey) t.rot = normRot(t.rot + (up ? -5 : 5));
      else t.size = clampN(t.size * (up ? 1.06 : 0.94), 0.02, 0.4);
      drawStage();
      clearTimeout(wheelT);
      wheelT = setTimeout(function () { pushHistory(); }, 400);
    }, { passive: false });
  }

  /* ───────────────────────── undo / redo ─────────────────────────
     One step per deliberate action: a rotate, a flip, a crop-shape chip, a finished crop
     drag, a filter tap, a finished slider drag, "Reset adjustments". Each step is the
     whole edit state (serialize()), so undoing always lands on an exact earlier look. */
  var HIST_MAX = 60;

  function histKey(st) {
    var c = st.crop;
    return JSON.stringify([st.rot, st.flip, st.aspect, st.filter, st.adj.b, st.adj.c, st.adj.s,
      Math.round(c.x * 1e4), Math.round(c.y * 1e4), Math.round(c.w * 1e4), Math.round(c.h * 1e4),
      (st.texts || []).map(function (t) { return [t.text, t.font, t.color, t.bg, t.align, +t.size.toFixed(4), +t.x.toFixed(4), +t.y.toFixed(4), +t.rot.toFixed(1)]; })]);
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
    S.texts = (snap.texts || []).map(cloneText); S.sel = -1;
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
    $('pe-te').classList.remove('on');
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
    if (S.texts.length) {                            // text goes on AFTER the look, so filters never tint it
      ctx.save();
      ctx.translate(-c.x * (w / c.w), -c.y * (h / c.h));
      ctx.scale(w / c.w, h / c.h);
      drawTexts(ctx, { k: 1, sel: -1, skip: -2 });
      ctx.restore();
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
      S = { resolve: resolve, tab: 'crop', rot: 0, flip: false, aspect: 'free', filter: 'none', adj: { b: 0, c: 0, s: 0 }, aspects: opts.aspects || null, texts: [], sel: -1, ed: null };
      $('pe-tab-text').style.display = opts.text === false ? 'none' : '';
      $('pe-te').classList.remove('on');
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
          S.texts = (Array.isArray(st.texts) ? st.texts : []).slice(0, MAX_TEXTS).map(cleanText);
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
    _test: { applyLook: applyLook, dragCrop: dragCrop, fitAspect: fitAspect, clampCrop: clampCrop, lookParams: lookParams, isNeutral: isNeutral,
             turnTexts: turnTexts, mirrorTexts: mirrorTexts, hitTest: hitTest, cleanText: cleanText, contrastOn: contrastOn }
  };
})();
