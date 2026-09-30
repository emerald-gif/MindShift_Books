/* Link preview card — one look everywhere (composer, feed, profile, post page).
     msbLinkCard(preview, { removeJs })  -> HTML string
   `preview` = { url, title, description, image, siteName, domain } as saved on the post. It comes from
   Firestore, so it is treated as untrusted: only http(s) links, only https images, everything escaped.
   `removeJs` (composer only) adds an ✕ button that runs that JS string, e.g. "removeLinkPreview()". */
(function () {
  if (!document.getElementById('msb-linkcard-css')) {
    var st = document.createElement('style'); st.id = 'msb-linkcard-css';
    st.textContent =
      '.lcard{position:relative;display:block;margin:12px 0 4px;border:1px solid var(--border,#e5e7eb);border-radius:14px;overflow:hidden;background:var(--card,#fff);color:var(--txt,#0f172a);text-decoration:none;-webkit-tap-highlight-color:transparent;transition:background .15s,border-color .15s}' +
      'a.lcard:hover{border-color:#c7d2fe}a.lcard:active{background:rgba(79,70,229,.05)}' +
      '.lcard-img{display:block;width:100%;aspect-ratio:1.91/1;object-fit:cover;background:linear-gradient(135deg,#eef2ff,#ecfeff);border-bottom:1px solid var(--border,#e5e7eb)}' +
      '.lcard-body{padding:10px 13px 11px;min-width:0}' +
      '.lcard-site{display:flex;align-items:center;gap:6px;font-size:11.5px;font-weight:700;letter-spacing:.02em;color:var(--sub,#6b7280);text-transform:uppercase;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}' +
      '.lcard-site svg{width:12px;height:12px;flex:0 0 auto;fill:none;stroke:currentColor;stroke-width:2.2;stroke-linecap:round;stroke-linejoin:round}' +
      '.lcard-title{margin-top:3px;font-size:14.5px;font-weight:700;line-height:1.35;color:var(--txt,#0f172a);display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;word-break:break-word}' +
      '.lcard-desc{margin-top:3px;font-size:13px;line-height:1.4;color:var(--sub,#6b7280);display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;word-break:break-word}' +
      '.lcard-x{position:absolute;top:8px;right:8px;width:30px;height:30px;border-radius:50%;border:none;background:rgba(15,23,42,.72);color:#fff;display:flex;align-items:center;justify-content:center;cursor:pointer;padding:0;z-index:2}' +
      '.lcard-x svg{width:15px;height:15px;fill:none;stroke:currentColor;stroke-width:2.4;stroke-linecap:round}' +
      '.lcard.noimg .lcard-x{top:6px;right:6px;background:rgba(100,116,139,.16);color:var(--sub,#6b7280)}' +
      '.lcard.noimg .lcard-body{padding-right:44px}' +
      '.lcard.skel .sk{border-radius:6px;background:linear-gradient(90deg,#eef0f4 25%,#f6f7fa 50%,#eef0f4 75%);background-size:200% 100%;animation:lcsk 1.2s infinite}' +
      '@keyframes lcsk{to{background-position:-200% 0}}' +
      '@media (prefers-color-scheme:dark){html[data-theme=dark] .lcard{background:var(--card,#14141f)}}';
    document.head.appendChild(st);
  }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function safeHref(u) { try { var x = new URL(String(u)); return (x.protocol === 'http:' || x.protocol === 'https:') ? x.href : ''; } catch (e) { return ''; } }
  function safeImg(u) { try { var x = new URL(String(u)); return x.protocol === 'https:' ? x.href : ''; } catch (e) { return ''; } }
  var LINK = '<svg viewBox="0 0 24 24"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>';
  var X = '<svg viewBox="0 0 24 24"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';

  window.msbLinkCard = function (p, o) {
    o = o || {};
    if (!p || typeof p !== 'object') return '';
    var href = safeHref(p.url); if (!href || !p.title) return '';
    var img = safeImg(p.image), host = '';
    try { host = new URL(href).hostname.replace(/^www\./i, ''); } catch (e) {}
    var site = p.siteName || p.domain || host;
    var rm = o.removeJs ? '<button type="button" class="lcard-x" aria-label="Remove link preview" onclick="event.preventDefault();event.stopPropagation();' + esc(o.removeJs) + '">' + X + '</button>' : '';
    return '<a class="lcard' + (img ? '' : ' noimg') + '" href="' + esc(href) + '" target="_blank" rel="noopener noreferrer nofollow ugc" onclick="event.stopPropagation()">' +
      (img ? '<img class="lcard-img" src="' + esc(img) + '" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()">' : '') +
      rm +
      '<div class="lcard-body"><div class="lcard-site">' + LINK + '<span>' + esc(site) + '</span></div>' +
      '<div class="lcard-title">' + esc(p.title) + '</div>' +
      (p.description ? '<div class="lcard-desc">' + esc(p.description) + '</div>' : '') + '</div></a>';
  };
  // shown in the composer while the server fetches the page
  window.msbLinkCardSkeleton = function () {
    return '<div class="lcard skel noimg" aria-busy="true"><div class="lcard-body"><div class="sk" style="height:11px;width:34%"></div><div class="sk" style="height:15px;width:88%;margin-top:9px"></div><div class="sk" style="height:12px;width:64%;margin-top:7px"></div></div></div>';
  };
})();
