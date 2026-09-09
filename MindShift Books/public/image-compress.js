// public/image-compress.js
//
// Shared image-compression helper used by every upload entry point in the
// app (write.html, profile.html, create-post.html, admin/dashboard.html).
//
// Why this exists: raw phone photos and images saved out of tools like
// ChatGPT routinely arrive as 5-15MB files, and some of them carry an
// odd/generic MIME type that our server's `data:image/...;base64,` check
// doesn't recognize even though the bytes are a perfectly valid image.
// Rather than hard-rejecting those uploads with an alert, we decode the
// source file onto a <canvas> and re-export it as a clean, correctly
// labeled, much smaller image/jpeg data URL. Canvas re-encoding sidesteps
// whatever the browser thought the source type was, so this also fixes the
// "valid image gets rejected as wrong format" bug as a side effect.
//
// Tradeoff: everything gets flattened onto a white background and encoded
// as JPEG, so transparency (alpha) in PNGs is lost. That's fine for the
// photos/covers these pickers handle; it would matter for logos or graphics
// that rely on a transparent background.
window.MindshiftImage = (function () {
  var MAX_DIM = 2000;                    // longest edge, px
  var TARGET_BYTES = 1.5 * 1024 * 1024;  // aim to land under this
  var HARD_CAP_BYTES = 8 * 1024 * 1024;  // give up above this even after max compression

  function readFileAsDataUrl(file) {
    return new Promise(function (resolve, reject) {
      var r = new FileReader();
      r.onload = function (ev) { resolve(ev.target.result); };
      r.onerror = function () { reject(new Error('Could not read that file.')); };
      r.readAsDataURL(file);
    });
  }

  function loadImage(dataUrl) {
    return new Promise(function (resolve, reject) {
      var img = new Image();
      img.onload = function () { resolve(img); };
      img.onerror = function () { reject(new Error('That file doesn\'t look like a valid image.')); };
      img.src = dataUrl;
    });
  }

  function drawToCanvas(img, width, height) {
    var canvas = document.createElement('canvas');
    canvas.width = width; canvas.height = height;
    var ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(img, 0, 0, width, height);
    return canvas;
  }

  function approxBytes(dataUrl) { return dataUrl.length * 0.75; }

  // Resizes to fit within maxDim and re-encodes as JPEG, stepping quality
  // (and if needed, dimensions) down until under targetBytes. Resolves with
  // a data:image/jpeg;base64,... string. Rejects only if the file can't be
  // read/decoded as an image, or truly can't be brought under HARD_CAP_BYTES.
  async function compress(file, opts) {
    opts = opts || {};
    var maxDim = opts.maxDim || MAX_DIM;
    var targetBytes = opts.targetBytes || TARGET_BYTES;

    var rawDataUrl = await readFileAsDataUrl(file);
    var img = await loadImage(rawDataUrl);

    var width = img.naturalWidth || img.width;
    var height = img.naturalHeight || img.height;
    if (width > maxDim || height > maxDim) {
      var scale = maxDim / Math.max(width, height);
      width = Math.round(width * scale);
      height = Math.round(height * scale);
    }

    var canvas = drawToCanvas(img, width, height);
    var quality = 0.92;
    var out = canvas.toDataURL('image/jpeg', quality);

    while (approxBytes(out) > targetBytes && quality > 0.4) {
      quality -= 0.1;
      out = canvas.toDataURL('image/jpeg', quality);
    }

    var shrinkTries = 0;
    while (approxBytes(out) > targetBytes && shrinkTries < 3) {
      width = Math.round(width * 0.8);
      height = Math.round(height * 0.8);
      canvas = drawToCanvas(img, width, height);
      out = canvas.toDataURL('image/jpeg', 0.75);
      shrinkTries++;
    }

    if (approxBytes(out) > HARD_CAP_BYTES) {
      throw new Error('This image is too complex to compress enough — try a different one.');
    }
    return out;
  }

  return { compress: compress };
})();
