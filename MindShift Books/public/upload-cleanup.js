// public/upload-cleanup.js
//
// Keeps Cloudinary tidy when photos are edited or removed.
//
// /api/upload-image hands back a deleteToken with every new upload. This helper remembers
// those tokens for the CURRENT page session only (memory, never saved), so it can only ever
// delete an image that this page just uploaded and that nothing references any more:
//   - a photo/cover that was replaced by an edited version
//   - a photo/cover the writer removed before publishing
//   - the untouched original once the edited version is what got published
// Images loaded from a saved post/article/draft have no token here and are never touched.
//
//   MindshiftUploads.remember(url, token)          // called when an upload succeeds
//   MindshiftUploads.discard(url, getIdToken)      // fire-and-forget delete (no-op without a token)
window.MindshiftUploads = (function () {
  var tokens = {};
  return {
    remember: function (url, token) { if (url && token) tokens[url] = token; },
    has: function (url) { return !!(url && tokens[url]); },
    discard: function (url, getIdToken) {
      var t = url && tokens[url];
      if (!t) return;
      delete tokens[url];                       // never try twice
      Promise.resolve(getIdToken()).then(function (id) {
        return fetch('/api/delete-image', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + id },
          body: JSON.stringify({ url: url, token: t }),
          keepalive: true                       // lets it finish even if the page is closing after publish
        });
      }).catch(function () { /* best-effort: a leftover file is harmless */ });
    }
  };
})();
