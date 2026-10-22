// public/uploader.js
//
// Shared "MindShift upload modal" widget — previously copy-pasted
// (markup, CSS, and logic all identical) into write.html and profile.html.
// Now lives in one place and injects its own CSS + HTML into the page the
// first time it's used, so any page just needs:
//
//   <script src="/image-compress.js"></script>
//   <script src="/uploader.js"></script>
//
// and can then call MindshiftUploader.open({ title, getToken, onSuccess }).
//
// Compression: onFile() used to hard-reject anything over 5MB with an
// alert and upload the raw file's data URL as-is. It now runs every picked
// file through MindshiftImage.compress() first — this resizes/re-encodes
// the image client-side so it's both smaller and normalized to a clean
// image/jpeg, which also fixes uploads from sources (e.g. images saved out
// of ChatGPT) that report an odd/unrecognized MIME type even though the
// image itself is fine. The server-side size check remains as a backstop.
(function () {
  var STYLE = "\n#kv-up-bd{position:fixed;inset:0;background:rgba(15,10,30,.55);z-index:9999;display:flex;align-items:flex-end;justify-content:center;opacity:0;transition:opacity .25s;pointer-events:none;backdrop-filter:blur(3px)}\n#kv-up-bd.kv-show{opacity:1;pointer-events:all}\n#kv-up-sheet{width:100%;max-width:480px;background:var(--c-bg,#fff);border-radius:24px 24px 0 0;transform:translateY(100%);transition:transform .4s cubic-bezier(.22,1,.36,1);padding-bottom:max(env(safe-area-inset-bottom,0px),16px);box-shadow:0 -8px 40px rgba(37,99,235,.18)}\n#kv-up-bd.kv-show #kv-up-sheet{transform:translateY(0)}\n.kv-up-bar{height:3px;background:linear-gradient(90deg,#4f46e5,#06b6d4 55%,#ec4899);border-radius:24px 24px 0 0}\n.kv-up-drag{width:36px;height:4px;border-radius:2px;background:var(--c-surface,#e5e7eb);margin:12px auto 0}\n.kv-up-hdr{display:flex;align-items:center;justify-content:space-between;padding:14px 20px 12px}\n.kv-up-brand{display:flex;align-items:center;gap:9px}\n.kv-up-klogo{width:30px;height:30px;border-radius:9px;background:linear-gradient(135deg,#4f46e5,#06b6d4);display:flex;align-items:center;justify-content:center;box-shadow:0 2px 8px rgba(37,99,235,.3)}\n.kv-up-klogo-k{font-size:17px;font-weight:900;color:#fff;line-height:1;letter-spacing:-.02em;font-family:system-ui,sans-serif}\n.kv-up-ttl{font-size:15px;font-weight:800;color:var(--c-ink,#0f0a1e);letter-spacing:-.01em}\n.kv-up-close{width:32px;height:32px;border-radius:50%;border:1.5px solid var(--c-line,#e5e7eb);background:var(--c-bg,#fff);display:flex;align-items:center;justify-content:center;cursor:pointer;color:var(--c-sub2,#6b7280);transition:all .15s;flex-shrink:0}\n.kv-up-close:hover{border-color:#4f46e5;color:var(--c-ind,#4f46e5);background:var(--c-tonal,#eef2ff)}\n.kv-up-line{height:1px;background:var(--c-surface,#f3f4f6)}\n.kv-up-tiles{display:grid;grid-template-columns:1fr 1fr;gap:12px;padding:20px}\n.kv-up-tile{border:1.5px solid var(--c-line-ind,#e0e7ff);border-radius:18px;background:var(--c-tonal,#eef2ff);padding:22px 10px 18px;display:flex;flex-direction:column;align-items:center;gap:10px;cursor:pointer;transition:all .18s;font-family:inherit;width:100%;text-align:center}\n.kv-up-tile:hover{border-color:#4f46e5;background:var(--c-tonal,#eef2ff);box-shadow:0 4px 18px rgba(37,99,235,.13);transform:translateY(-1px)}\n.kv-up-tile:active{transform:scale(.97)}\n.kv-up-tile-ico{width:58px;height:58px;border-radius:16px;background:linear-gradient(135deg,var(--c-tonal,#e0e7ff),var(--c-surface,#eef2ff));display:flex;align-items:center;justify-content:center;box-shadow:0 2px 10px rgba(37,99,235,.14)}\n.kv-up-tile-ico svg{width:26px;height:26px;stroke:#4f46e5;fill:none;stroke-width:1.6;stroke-linecap:round;stroke-linejoin:round}\n.kv-up-tile-lbl{font-size:14px;font-weight:800;color:var(--c-ink,#0f0a1e)}\n.kv-up-tile-sub{font-size:11.5px;color:var(--c-mute,#9ca3af);line-height:1.45}\n.kv-up-prev-img-wrap{position:relative;width:calc(100% - 40px);margin:16px 20px 0;border-radius:16px;overflow:hidden;background:var(--c-surface,#f3f4f6);height:220px}\n.kv-up-prev-img-wrap img{width:100%;height:100%;object-fit:cover;display:block}\n.kv-up-uploading{position:absolute;inset:0;background:rgba(var(--glass-rgb,255,255,255),.88);display:none;flex-direction:column;align-items:center;justify-content:center;gap:10px}\n.kv-up-uploading.kv-on{display:flex}\n.kv-up-spin{width:38px;height:38px;border:3px solid var(--c-line-ind,#e0e7ff);border-top-color:#4f46e5;border-radius:50%;animation:kvSpin .72s linear infinite}\n.kv-up-spin-lbl{font-size:13px;font-weight:700;color:var(--c-ind,#4f46e5)}\n@keyframes kvSpin{to{transform:rotate(360deg)}}\n.kv-up-change{display:block;text-align:center;font-size:13px;color:var(--c-mute,#9ca3af);cursor:pointer;padding:12px 20px 2px;background:none;border:none;font-family:inherit;width:100%;transition:color .15s}\n.kv-up-change:hover{color:var(--c-ind,#4f46e5)}\n.kv-up-err-box{margin:0 20px 10px;background:var(--c-red-bg,#fef2f2);border:1px solid var(--c-line-red,#fecaca);border-radius:12px;padding:10px 14px;font-size:13px;color:var(--c-red-txt,#dc2626);display:none;line-height:1.45}\n.kv-up-cta{box-sizing:border-box;width:calc(100% - 40px);margin:6px 20px 0;padding:15px;border-radius:14px;border:none;background:linear-gradient(135deg,#4f46e5,#06b6d4);color:#fff;font-size:15px;font-weight:800;cursor:pointer;letter-spacing:.01em;transition:opacity .15s;font-family:inherit;display:block}\n.kv-up-cta:hover{opacity:.9}\n.kv-up-cta:disabled{opacity:.45;cursor:not-allowed}\n.kv-up-gap{height:10px}\n";

  var MARKUP = '' +
    '<div id="kv-up-bd">' +
    '  <div id="kv-up-sheet">' +
    '    <div class="kv-up-drag"></div>' +
    '    <div class="kv-up-hdr">' +
    '      <div class="kv-up-brand">' +
    '        <div><div class="kv-up-ttl" id="kv-up-ttl">Upload Image</div><div class="kv-up-sub" id="kv-up-sub">Choose where the photo comes from</div></div>' +
    '      </div>' +
    '      <button class="kv-up-close" id="kv-up-close" aria-label="Close">' +
    '        <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>' +
    '      </button>' +
    '    </div>' +
    '    <div class="kv-up-line"></div>' +
    '    <div id="kv-up-pick">' +
    '      <div class="kv-up-tiles">' +
    '        <button class="kv-up-tile" id="kv-up-lib-btn">' +
    '          <div class="kv-up-tile-ico"><svg viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg></div>' +
    '          <span class="kv-up-tile-lbl">Library</span>' +
    '          <span class="kv-up-tile-sub">Choose from photos<br>or files on device</span>' +
    '        </button>' +
    '        <button class="kv-up-tile" id="kv-up-cam-btn">' +
    '          <div class="kv-up-tile-ico"><svg viewBox="0 0 24 24"><path d="M23 19a2 2 0 01-2 2H3a2 2 0 01-2-2V8a2 2 0 012-2h4l2-3h6l2 3h4a2 2 0 012 2z"/><circle cx="12" cy="13" r="4"/></svg></div>' +
    '          <span class="kv-up-tile-lbl">Camera</span>' +
    '          <span class="kv-up-tile-sub">Snap a new photo<br>right now</span>' +
    '        </button>' +
    '      </div>' +
    '      <input type="file" id="kv-up-lib-in" accept="image/*" style="display:none">' +
    '      <input type="file" id="kv-up-cam-in" accept="image/*" capture="environment" style="display:none">' +
    '    </div>' +
    '    <div id="kv-up-prev" style="display:none">' +
    '      <div class="kv-up-prev-img-wrap">' +
    '        <img id="kv-up-prev-img" src="" alt="Preview">' +
    '        <div class="kv-up-uploading" id="kv-up-upl">' +
    '          <div class="kv-up-spin"></div>' +
    '          <span class="kv-up-spin-lbl" id="kv-up-spin-lbl">Uploading…</span>' +
    '        </div>' +
    '      </div>' +
    '      <button class="kv-up-edit" id="kv-up-edit" style="display:none"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>Crop &amp; edit photo</button>' +
    '      <button class="kv-up-change" id="kv-up-change">&#8592; Choose a different image</button>' +
    '      <div class="kv-up-err-box" id="kv-up-err"></div>' +
    '      <button class="kv-up-cta" id="kv-up-cta">Upload Image</button>' +
    '      <div class="kv-up-gap"></div>' +
    '    </div>' +
    '  </div>' +
    '</div>';

  // Extra rule for the optional "Crop & edit photo" button.
  STYLE += "\n.kv-up-edit{display:flex;align-items:center;justify-content:center;gap:8px;width:calc(100% - 40px);margin:12px 20px 0;padding:12px;border:1.5px solid var(--c-line-ind,#e0e7ff);background:var(--c-tonal,#eef2ff);color:var(--c-ind,#4f46e5);font-weight:700;font-size:14px;border-radius:12px;cursor:pointer;font-family:inherit}\n.kv-up-edit:active{background:var(--c-tonal2,#e0e7ff)}\n";

// ── v2 look (matches design.css): bigger sheet radius, quiet handle, tonal close, card tiles with gradient icons ──
STYLE += "\n#kv-up-bd{background:rgba(11,18,32,.45);-webkit-backdrop-filter:blur(6px);backdrop-filter:blur(6px)}\n#kv-up-sheet{border-radius:28px 28px 0 0;transition:transform .42s cubic-bezier(.2,.9,.25,1);box-shadow:0 0 0 .5px var(--ds-hairline,rgba(15,23,42,.08)),0 -18px 60px -12px rgba(15,23,42,.35)}\n.kv-up-bar{display:none}\n.kv-up-drag{width:36px;height:5px;border-radius:3px;background:var(--c-handle,rgba(15,23,42,.16));margin:10px auto 0}\n.kv-up-hdr{align-items:flex-start;padding:16px 20px 4px}\n.kv-up-ttl{font-size:23px;font-weight:800;letter-spacing:-.03em;color:var(--c-ink,#0b1220);line-height:1.15}\n.kv-up-sub{font-size:14px;color:var(--c-sub,#566074);margin-top:3px}\n.kv-up-close{width:34px;height:34px;border:none;background:var(--ds-fill,rgba(15,23,42,.055));color:var(--c-sub,#566074)}\n.kv-up-close:hover{background:var(--ds-fill-2,rgba(15,23,42,.09));color:var(--c-sub,#566074)}\n.kv-up-close:active{transform:scale(.9)}\n.kv-up-line{display:none}\n.kv-up-tiles{gap:12px;padding:16px 16px 6px}\n.kv-up-tile{border:none;border-radius:22px;background:var(--c-bg,#fff);padding:22px 10px 20px;gap:11px;box-shadow:0 0 0 1px var(--ds-hairline,rgba(15,23,42,.08)),0 2px 6px rgba(15,23,42,.05);transition:transform .22s cubic-bezier(.34,1.4,.64,1),box-shadow .2s;-webkit-tap-highlight-color:transparent}\n.kv-up-tile:hover{border:none;background:var(--c-bg,#fff);transform:none;box-shadow:0 0 0 1px var(--ds-hairline,rgba(15,23,42,.08)),0 2px 6px rgba(15,23,42,.05)}\n.kv-up-tile:active{transform:scale(.96);background:var(--c-surface,#f8f9fd)}\n.kv-up-tile-ico{width:62px;height:62px;border-radius:20px;background:linear-gradient(135deg,#4f46e5,#06b6d4);box-shadow:0 12px 22px -10px rgba(79,70,229,.7)}\n#kv-up-cam-btn .kv-up-tile-ico{background:linear-gradient(135deg,#7c3aed,#ec4899);box-shadow:0 12px 22px -10px rgba(124,58,237,.65)}\n.kv-up-tile-ico svg{width:28px;height:28px;stroke:#fff;stroke-width:1.8}\n.kv-up-tile-lbl{font-size:16px;font-weight:800;letter-spacing:-.02em;color:var(--c-ink,#0b1220)}\n.kv-up-tile-sub{font-size:12.5px;color:var(--c-sub,#566074);line-height:1.45}\n.kv-up-prev-img-wrap{border-radius:22px;box-shadow:0 0 0 1px var(--ds-hairline,rgba(15,23,42,.08)),0 14px 30px -14px rgba(15,23,42,.45)}\n.kv-up-cta{border-radius:999px;font-weight:800;letter-spacing:-.005em;box-shadow:0 12px 24px -10px rgba(79,70,229,.7)}\n.kv-up-change{font-weight:600;color:var(--c-sub,#566074)}\n.kv-up-edit{border-radius:999px}\n";
  var styleEl = document.createElement('style');
  styleEl.textContent = STYLE;
  document.head.appendChild(styleEl);
  var wrap = document.createElement('div');
  wrap.innerHTML = MARKUP;
  document.body.appendChild(wrap);

  window.MindshiftUploader = (function () {
    var _opts = {}, _dataUrl = null;
    var _orig = null, _editState = null, _edited = false; // for the optional "Crop & edit photo" step
    var $ = function (id) { return document.getElementById(id); };

    function open(opts) {
      _opts = opts || {}; _dataUrl = null; _orig = null; _editState = null; _edited = false;
      $('kv-up-edit').style.display = 'none';
      $('kv-up-ttl').textContent = _opts.title || 'Upload Image';
      $('kv-up-err').style.display = 'none';
      $('kv-up-lib-in').value = '';
      $('kv-up-cam-in').value = '';
      setState('pick');
      requestAnimationFrame(function () { $('kv-up-bd').classList.add('kv-show'); });
      document.body.style.overflow = 'hidden';
    }

    function close() {
      $('kv-up-bd').classList.remove('kv-show');
      setTimeout(function () { document.body.style.overflow = ''; }, 400);
    }

    function setState(s) {
      $('kv-up-pick').style.display = s === 'pick' ? 'block' : 'none';
      $('kv-up-prev').style.display = s === 'preview' ? 'block' : 'none';
      $('kv-up-upl').classList.remove('kv-on');
      $('kv-up-cta').disabled = false;
    }

    async function onFile(e) {
      var file = e.target.files[0];
      if (!file) return;
      // Compress/normalize before ever previewing — this replaces the old
      // hard "over 5MB, rejected" alert with an automatic resize + re-encode,
      // and fixes uploads whose source MIME type Cloudinary's check wouldn't
      // otherwise recognize (see file header comment).
      setState('preview');
      $('kv-up-prev-img').src = '';
      $('kv-up-upl').classList.add('kv-on');
      $('kv-up-spin-lbl').textContent = 'Compressing…';
      $('kv-up-cta').disabled = true;
      try {
        _dataUrl = await window.MindshiftImage.compress(file);
        _orig = _dataUrl; _editState = null; _edited = false;   // a new file starts a fresh edit
        $('kv-up-edit').style.display = (_opts.editable && window.MindshiftPhotoEditor) ? 'flex' : 'none';
        $('kv-up-prev-img').src = _dataUrl;
        $('kv-up-err').style.display = 'none';
      } catch (err) {
        setState('pick');
        var el = $('kv-up-err');
        el.textContent = err.message || 'Could not process that image. Try a different one.';
        el.style.display = 'block';
        return;
      }
      $('kv-up-upl').classList.remove('kv-on');
      $('kv-up-spin-lbl').textContent = 'Uploading…';
      $('kv-up-cta').disabled = false;
    }

    // Optional step: crop / rotate / filters before uploading. Always edits from the
    // untouched original and remembers the last settings, like the create-post pen.
    async function doEdit() {
      if (!_orig || !window.MindshiftPhotoEditor) return;
      var res;
      try {
        res = await window.MindshiftPhotoEditor.open({ src: _orig, state: _editState, aspect: _opts.aspect, title: _opts.editTitle || 'Edit photo' });
      } catch (err) {
        var el = $('kv-up-err');
        el.textContent = "Couldn't open this photo for editing.";
        el.style.display = 'block';
        return;
      }
      if (!res) return;                     // cancelled
      _editState = res.state;
      _edited = !!res.changed;
      _dataUrl = res.changed ? res.dataUrl : _orig;
      $('kv-up-prev-img').src = _dataUrl;
      $('kv-up-err').style.display = 'none';
    }

    async function doUpload() {
      if (!_dataUrl) return;
      $('kv-up-cta').disabled = true;
      $('kv-up-upl').classList.add('kv-on');
      $('kv-up-err').style.display = 'none';
      try {
        var token = await _opts.getToken();
        var res = await fetch('/api/upload-image', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token }, body: JSON.stringify({ dataUrl: _dataUrl }) });
        var json = await res.json();
        if (!res.ok) throw new Error(json.error || 'Upload failed');
        close();
        if (window.MindshiftUploads) window.MindshiftUploads.remember(json.url, json.deleteToken);
        if (_opts.onSuccess) _opts.onSuccess(json.url, { orig: _orig, state: _editState, edited: _edited });
      } catch (err) {
        $('kv-up-upl').classList.remove('kv-on');
        $('kv-up-cta').disabled = false;
        var el = $('kv-up-err');
        el.textContent = 'Upload failed — ' + err.message + '. Tap to try again.';
        el.style.display = 'block';
      }
    }

    $('kv-up-bd').addEventListener('click', function (e) { if (e.target === $('kv-up-bd')) close(); });
    $('kv-up-close').addEventListener('click', close);
    $('kv-up-lib-btn').addEventListener('click', function () { $('kv-up-lib-in').click(); });
    $('kv-up-cam-btn').addEventListener('click', function () { $('kv-up-cam-in').click(); });
    $('kv-up-lib-in').addEventListener('change', onFile);
    $('kv-up-cam-in').addEventListener('change', onFile);
    $('kv-up-change').addEventListener('click', function () { setState('pick'); });
    $('kv-up-edit').addEventListener('click', doEdit);
    $('kv-up-cta').addEventListener('click', doUpload);

    return { open: open, close: close };
  })();
})();
