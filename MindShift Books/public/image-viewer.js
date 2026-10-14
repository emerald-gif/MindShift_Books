/* MindShift Books — full-screen image viewer for feed/profile post images.
   Swipe sideways between photos, "1/3" counter, tap the dark area or ✕ to close (also back button / Esc).
   If the page defines window.msbImgEngage, a bottom bar appears with like / comment / repost / save / share
   and the post's author + caption — same actions as the post page, mirrored from the on-page card.

   MSBImageViewer.fromEl(imgEl)       -> opens that photo (+ siblings in the same carousel); reads data-post-id from the <img>
   MSBImageViewer.open(urls, i, id)   -> explicit list; `id` (optional) enables the engagement bar

   window.msbImgEngage = { like(id), comment(id), repost?(id), save?(id), share(id), info?(id)->{author,avatar,text},
                           isLiked?(id), isSaved?(id) }                                                          */
(function(){
  if(window.MSBImageViewer) return;
  var css = `
#msbImgV{position:fixed;inset:0;background:rgba(10,8,20,.95);z-index:99990;opacity:0;pointer-events:none;transition:opacity .2s;touch-action:pan-x;color:#fff;font-family:inherit}
#msbImgV.show{opacity:1;pointer-events:all}
#msbImgV *{-webkit-tap-highlight-color:transparent}
#msbImgV .iv-close{position:absolute;top:max(16px,env(safe-area-inset-top));right:16px;width:42px;height:42px;border-radius:50%;background:rgba(0,0,0,.55);
  border:none;color:#fff;display:flex;align-items:center;justify-content:center;cursor:pointer;z-index:3}
#msbImgV .iv-close svg{width:18px;height:18px;fill:none;stroke:currentColor;stroke-width:2.5;stroke-linecap:round;stroke-linejoin:round}
#msbImgV .iv-count{position:absolute;top:max(22px,calc(env(safe-area-inset-top) + 6px));left:50%;transform:translateX(-50%);background:rgba(0,0,0,.55);color:#fff;
  font-size:12.5px;font-weight:700;padding:5px 13px;border-radius:99px;z-index:3;letter-spacing:.2px}
#msbImgV .iv-track{display:flex;width:100vw;height:100vh;height:100dvh;overflow-x:auto;scroll-snap-type:x mandatory;-webkit-overflow-scrolling:touch;scrollbar-width:none}
#msbImgV .iv-track::-webkit-scrollbar{display:none}
#msbImgV .iv-slide{flex:0 0 100vw;scroll-snap-align:center;scroll-snap-stop:always;display:flex;align-items:center;justify-content:center}
#msbImgV .iv-slide img{max-width:94vw;max-height:86vh;max-height:86dvh;object-fit:contain;border-radius:8px;-webkit-user-select:none;user-select:none}
#msbImgV.has-bar .iv-slide{padding-bottom:96px}
#msbImgV.has-bar.has-info .iv-slide{padding-bottom:150px}
#msbImgV.has-bar .iv-slide img{max-height:calc(100dvh - 190px)}
#msbImgV.has-bar.has-info .iv-slide img{max-height:calc(100dvh - 250px)}
#msbImgV .iv-foot{position:absolute;left:0;right:0;bottom:0;z-index:3;display:none;padding:34px 0 0;background:linear-gradient(to top,rgba(10,8,20,.92) 55%,transparent)}
#msbImgV.has-bar .iv-foot{display:block}
#msbImgV .iv-info{display:none;padding:0 16px 10px;max-width:520px;margin:0 auto}
#msbImgV.has-info .iv-info{display:block}
#msbImgV .iv-auth{display:flex;align-items:center;gap:9px;font-weight:800;font-size:14px}
#msbImgV .iv-auth img{width:28px;height:28px;border-radius:50%;object-fit:cover;background:#4f46e5;flex:none}
#msbImgV .iv-auth span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#msbImgV .iv-cap{margin-top:6px;font-size:13.5px;line-height:1.4;color:rgba(255,255,255,.85);display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;word-break:break-word}
#msbImgV .iv-bar{display:flex;align-items:center;justify-content:space-between;max-width:520px;margin:0 auto;padding:6px 14px calc(max(10px,env(safe-area-inset-bottom)) + 4px);
  border-top:1px solid rgba(255,255,255,.1)}
#msbImgV .iv-act{background:none;border:none;color:#fff;display:flex;align-items:center;gap:6px;padding:10px 8px;font-size:13px;font-weight:700;font-family:inherit;cursor:pointer;
  min-width:44px;justify-content:center;border-radius:12px;transition:transform .12s}
#msbImgV .iv-act:active{transform:scale(.9)}
#msbImgV .iv-act svg{width:23px;height:23px;fill:none;stroke:#fff;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
#msbImgV .iv-act span{min-width:0}
#msbImgV .iv-act.liked svg{fill:#ef4444;stroke:#ef4444;animation:ivpop .3s ease}
#msbImgV .iv-act.reposted svg{stroke:#34d399}
#msbImgV .iv-act.reposted{color:#6ee7b7}
#msbImgV .iv-act.saved svg{fill:#fbbf24;stroke:#fbbf24}
@keyframes ivpop{0%{transform:scale(.7)}60%{transform:scale(1.3)}100%{transform:scale(1)}}
#msbImgV .iv-burst{position:fixed;width:96px;height:96px;margin:-48px 0 0 -48px;z-index:4;pointer-events:none;animation:ivburst .8s ease-out forwards}
#msbImgV .iv-burst svg{width:100%;height:100%;fill:#ef4444;filter:drop-shadow(0 4px 14px rgba(0,0,0,.45))}
@keyframes ivburst{0%{transform:scale(.3);opacity:0}25%{transform:scale(1.15);opacity:1}55%{transform:scale(1);opacity:1}100%{transform:scale(1.1) translateY(-30px);opacity:0}}
.pcard-single img,.pcard-slide img{cursor:pointer}
/* sheets opened FROM the viewer (repost, login, save confirmation, toasts) must sit above it */
body.msb-imgv-open .toast{z-index:100001!important}
body.msb-imgv-open .overlay{z-index:100002!important}
body.msb-imgv-open .auth-sheet{z-index:100003!important}
body.msb-imgv-open .rp-overlay{z-index:100004!important}
body.msb-imgv-open .rp-sheet{z-index:100005!important}
body.msb-imgv-open .save-drawer-backdrop{z-index:100006!important}
`;
  var st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);

  var I = {
    heart:'<svg viewBox="0 0 24 24"><path d="M20.84 4.61a5.5 5.5 0 00-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 00-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 000-7.78z"/></svg>',
    comment:'<svg viewBox="0 0 24 24"><path d="M21 11.5a8.38 8.38 0 01-.9 3.8 8.5 8.5 0 01-7.6 4.7 8.38 8.38 0 01-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 01-.9-3.8 8.5 8.5 0 014.7-7.6 8.38 8.38 0 013.8-.9h.5a8.48 8.48 0 018 8v.5z"/></svg>',
    repost:'<svg viewBox="0 0 24 24"><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 014-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 01-4 4H3"/></svg>',
    save:'<svg viewBox="0 0 24 24"><path d="M19 21l-7-5-7 5V5a2 2 0 012-2h10a2 2 0 012 2z"/></svg>',
    share:'<svg viewBox="0 0 24 24"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg>'
  };
  function esc(s){ return String(s==null?'':s).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];}); }

  var el = null, track = null, countEl = null, n = 0, pushed = false, prevOv = '', curId = null, syncTimer = null, lastTap = 0;
  function E(){ return window.msbImgEngage || null; }

  function build(){
    el = document.createElement('div'); el.id = 'msbImgV';
    el.innerHTML = '<button class="iv-close" aria-label="Close"><svg viewBox="0 0 24 24"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>'+
      '<div class="iv-count"></div><div class="iv-track"></div>'+
      '<div class="iv-foot"><div class="iv-info"></div><div class="iv-bar"></div></div>';
    document.body.appendChild(el);
    track = el.querySelector('.iv-track'); countEl = el.querySelector('.iv-count');
    el.addEventListener('click', function(){ close(); });
    track.addEventListener('scroll', updateCount, { passive:true });
    var foot = el.querySelector('.iv-foot');
    foot.addEventListener('click', function(e){
      e.stopPropagation();
      var b = e.target.closest('[data-e]'); if(!b || !curId) return;
      var a = b.getAttribute('data-e'), X = E(); if(!X) return;
      if(a === 'like') X.like(curId);
      else if(a === 'comment') X.comment(curId);
      else if(a === 'repost') X.repost && X.repost(curId);
      else if(a === 'save') X.save && X.save(curId);
      else if(a === 'share') X.share(curId);
      setTimeout(sync, 0); setTimeout(sync, 300); setTimeout(sync, 1500);
    });
  }
  function updateCount(){
    if(!n || !track.clientWidth) return;
    countEl.textContent = (Math.round(track.scrollLeft / track.clientWidth) + 1) + '/' + n;
  }
  function txt(prefix){ var e = document.getElementById(prefix + curId); return e ? e.textContent : ''; }
  function has(prefix, cls, fallback){
    var e = document.getElementById(prefix + curId);
    return e ? e.classList.contains(cls) : !!(fallback && fallback(curId));
  }
  // Mirror like / comment / repost / save state from the post's card on the page (the page owns the real logic).
  function sync(){
    var X = E(); if(!el || !X || !curId) return;
    var q = function(a){ return el.querySelector('[data-e="'+a+'"]'); };
    var b;
    if((b = q('like')))   { b.classList.toggle('liked', has('lb-','liked', X.isLiked)); b.querySelector('span').textContent = txt('lc-'); }
    if((b = q('comment'))){ b.querySelector('span').textContent = txt('pcc-'); }
    if((b = q('repost'))) { b.classList.toggle('reposted', has('rb-','reposted')); b.querySelector('span').textContent = txt('rc-'); }
    if((b = q('save')))   { b.classList.toggle('saved', has('sv-','saved', X.isSaved)); }
  }
  function renderFoot(id){
    var X = E(), foot = el.querySelector('.iv-foot');
    var on = !!(X && id);
    el.classList.toggle('has-bar', on);
    if(!on){ el.classList.remove('has-info'); return; }
    var info = X.info ? X.info(id) : null;
    var infoEl = el.querySelector('.iv-info');
    if(info && (info.author || info.text)){
      infoEl.innerHTML = '<div class="iv-auth">'+(info.avatar ? '<img src="'+esc(info.avatar)+'" alt="" onerror="this.style.visibility=\'hidden\'">' : '')+
        '<span>'+esc(info.author||'')+'</span></div>'+(info.text ? '<div class="iv-cap">'+esc(info.text)+'</div>' : '');
      el.classList.add('has-info');
    } else { infoEl.innerHTML = ''; el.classList.remove('has-info'); }
    var btn = function(a, icon, count){ return '<button class="iv-act" data-e="'+a+'" aria-label="'+a+'">'+icon+(count ? '<span></span>' : '')+'</button>'; };
    el.querySelector('.iv-bar').innerHTML =
      btn('like', I.heart, true) + (X.comment ? btn('comment', I.comment, true) : '') +
      (X.repost ? btn('repost', I.repost, true) : '') + (X.save ? btn('save', I.save, false) : '') + btn('share', I.share, false);
    sync();
  }

  function burst(x, y){
    var b = document.createElement('div'); b.className = 'iv-burst'; b.innerHTML = I.heart;
    b.style.left = x + 'px'; b.style.top = y + 'px'; el.appendChild(b); setTimeout(function(){ b.remove(); }, 850);
  }

  function open(list, start, postId){
    if(!list || !list.length) return;
    if(!el) build();
    n = list.length; curId = postId || null;
    track.innerHTML = list.map(function(src){ return '<div class="iv-slide"><img src="'+esc(src)+'" alt="" draggable="false"></div>'; }).join('');
    track.querySelectorAll('img').forEach(function(im){
      im.addEventListener('click', function(e){
        e.stopPropagation();
        var now = Date.now();
        if(now - lastTap < 300 && curId && E()){                 // double-tap = like
          lastTap = 0; burst(e.clientX, e.clientY);
          if(!has('lb-','liked', E().isLiked)){ E().like(curId); setTimeout(sync, 0); setTimeout(sync, 300); }
        } else lastTap = now;
      });
    });
    countEl.style.display = n > 1 ? '' : 'none';
    renderFoot(curId);
    prevOv = document.body.style.overflow; document.body.style.overflow = 'hidden';
    document.body.classList.add('msb-imgv-open');
    el.classList.add('show');
    track.scrollLeft = (start || 0) * track.clientWidth;
    updateCount();
    clearInterval(syncTimer); syncTimer = setInterval(sync, 400);
    if(!pushed){ history.pushState({ msbImgV:1 }, ''); pushed = true; }
  }
  function hide(){
    if(!el || !el.classList.contains('show')) return;
    el.classList.remove('show'); document.body.style.overflow = prevOv;
    document.body.classList.remove('msb-imgv-open');
    clearInterval(syncTimer); syncTimer = null; curId = null;
  }
  function close(){
    if(pushed){ pushed = false; history.back(); }   // popstate hides it
    else hide();
  }
  function fromEl(img){
    var wrap = img.closest('.pcard-carousel');
    var imgs = wrap ? Array.prototype.slice.call(wrap.querySelectorAll('.pcard-slide img')) : [img];
    open(imgs.map(function(i){ return i.currentSrc || i.src; }), Math.max(0, imgs.indexOf(img)), img.getAttribute('data-post-id'));
  }
  window.addEventListener('popstate', function(){
    if(window.MSBShare && MSBShare.justClosed()) return;      // that back press only closed the share drawer
    pushed = false; hide();
  });
  document.addEventListener('keydown', function(e){
    if(!el || !el.classList.contains('show') || (window.MSBShare && MSBShare.isOpen())) return;
    if(e.key === 'Escape') close();
    else if(e.key === 'ArrowRight') track.scrollBy({ left: track.clientWidth, behavior:'smooth' });
    else if(e.key === 'ArrowLeft') track.scrollBy({ left: -track.clientWidth, behavior:'smooth' });
  });
  window.MSBImageViewer = { open: open, close: close, fromEl: fromEl };
})();
