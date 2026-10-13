/* MindShift Books — full-screen reels viewer (shared by the feed + profile pages).
   Tapping a video tile opens a swipe-up, video-only scroller starting on that
   video. Each page supplies a small config so this file stays page-agnostic:

   MSBReels.open(startId, {
     lookup(id)   -> { id, videoUrl, thumbnailUrl, text, author, avatar, authorUid, commentsOff } | null
     isLiked(id)  -> boolean
     like(id)     -> run the page's own like handler
     comment(id), link(id), openPost(id), author(item)
   })
   Like / comment counts are mirrored from the on-page cards, so every page's
   existing like logic (login gate, rollback, notifications) keeps working. */
(function(){
  if(window.MSBReels) return;

  var css = `
#msbReels{position:fixed;inset:0;z-index:99999;background:#000;display:none}
#msbReels.open{display:block}
#msbReels .rl-scroller{position:absolute;inset:0;overflow-y:scroll;scroll-snap-type:y mandatory;overscroll-behavior:contain;
  -webkit-overflow-scrolling:touch;scrollbar-width:none}
#msbReels .rl-scroller::-webkit-scrollbar{display:none}
#msbReels .rl-slide{position:relative;height:100vh;height:100dvh;width:100%;scroll-snap-align:start;scroll-snap-stop:always;
  background:#000;overflow:hidden}
#msbReels video{position:absolute;inset:0;width:100%;height:100%;object-fit:contain;background:#000}
#msbReels .rl-tap{position:absolute;inset:0;z-index:1}
#msbReels .rl-pause{position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);width:70px;height:70px;border-radius:50%;
  background:rgba(0,0,0,.45);display:none;align-items:center;justify-content:center;z-index:2;pointer-events:none}
#msbReels .rl-slide.paused .rl-pause{display:flex}
#msbReels .rl-pause svg{width:30px;height:30px;fill:#fff}
#msbReels .rl-back,#msbReels .rl-mute{position:fixed;top:max(14px,env(safe-area-inset-top));z-index:5;width:42px;height:42px;
  border-radius:50%;background:rgba(0,0,0,.45);border:none;color:#fff;display:flex;align-items:center;justify-content:center;
  cursor:pointer;-webkit-tap-highlight-color:transparent}
#msbReels .rl-back{left:12px}#msbReels .rl-mute{right:12px}
#msbReels .rl-back svg,#msbReels .rl-mute svg{width:22px;height:22px}
#msbReels .rl-info{position:absolute;left:0;right:66px;bottom:0;z-index:3;color:#fff;
  padding:70px 14px max(22px,env(safe-area-inset-bottom));background:linear-gradient(to top,rgba(0,0,0,.7),transparent)}
#msbReels .rl-info.expanded{background:linear-gradient(to top,rgba(0,0,0,.85) 70%,transparent)}
#msbReels .rl-author{display:inline-flex;align-items:center;gap:8px;font-weight:700;font-size:15px;cursor:pointer}
#msbReels .rl-author img{width:34px;height:34px;border-radius:50%;object-fit:cover;background:#4f46e5}
#msbReels .rl-cap{margin-top:8px;font-size:14px;line-height:1.4;white-space:pre-wrap;word-break:break-word;
  max-height:2.8em;overflow:hidden}
/* Short + faded: only when the text actually runs past 2 lines (class set from JS) */
#msbReels .rl-cap.has-more:not(.open){-webkit-mask-image:linear-gradient(to bottom,#000 40%,transparent 100%);
  mask-image:linear-gradient(to bottom,#000 40%,transparent 100%);cursor:pointer}
/* Expanded: a scrollable box so long captions can be read without leaving the reel */
#msbReels .rl-cap.open{max-height:38vh;overflow-y:auto;overscroll-behavior:contain;touch-action:pan-y;
  -webkit-overflow-scrolling:touch;padding-right:4px}
#msbReels .rl-more{display:none;margin-top:4px;background:none;border:none;color:#fff;font-weight:700;font-size:13px;
  padding:4px 0;cursor:pointer;opacity:.9;-webkit-tap-highlight-color:transparent}
#msbReels .rl-more.show{display:inline-block}
#msbReels .rl-rail{position:absolute;right:6px;bottom:max(90px,calc(env(safe-area-inset-bottom) + 80px));z-index:4;
  display:flex;flex-direction:column;gap:18px;align-items:center}
#msbReels .rl-act{background:none;border:none;color:#fff;display:flex;flex-direction:column;align-items:center;gap:3px;
  font-size:12px;font-weight:700;cursor:pointer;-webkit-tap-highlight-color:transparent;text-shadow:0 1px 3px rgba(0,0,0,.6);
  min-width:44px}
#msbReels .rl-act svg{width:28px;height:28px;fill:none;stroke:#fff;stroke-width:2;stroke-linecap:round;stroke-linejoin:round;
  filter:drop-shadow(0 1px 3px rgba(0,0,0,.5))}
#msbReels .rl-act.liked svg{fill:#ef4444;stroke:#ef4444;animation:rlpop .25s ease}
body.msb-reels-open .toast{z-index:100001!important}
body.msb-reels-open .auth-sheet{z-index:100003!important}
body.msb-reels-open .overlay{z-index:100002!important}
@keyframes rlpop{0%{transform:scale(.7)}60%{transform:scale(1.25)}100%{transform:scale(1)}}
#msbReels .rl-prog{position:absolute;left:0;right:0;bottom:0;height:3px;background:rgba(255,255,255,.25);z-index:5}
#msbReels .rl-prog i{display:block;height:100%;width:0;background:#fff}
`;
  var st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);

  var I = {
    back:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>',
    heart:'<svg viewBox="0 0 24 24"><path d="M20.84 4.61a5.5 5.5 0 00-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 00-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 000-7.78z"/></svg>',
    comment:'<svg viewBox="0 0 24 24"><path d="M21 11.5a8.38 8.38 0 01-.9 3.8 8.5 8.5 0 01-7.6 4.7 8.38 8.38 0 01-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 01-.9-3.8 8.5 8.5 0 014.7-7.6 8.38 8.38 0 013.8-.9h.5a8.48 8.48 0 018 8v.5z"/></svg>',
    link:'<svg viewBox="0 0 24 24"><path d="M10 13a5 5 0 007.54.54l3-3a5 5 0 00-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 00-7.54-.54l-3 3a5 5 0 007.07 7.07l1.71-1.71"/></svg>',
    open:'<svg viewBox="0 0 24 24"><path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>',
    play:'<svg viewBox="0 0 24 24"><polygon points="7 4 20 12 7 20 7 4"/></svg>'
  };
  function esc(s){ return String(s==null?'':s).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];}); }

  var muted = false, observer = null, pushed = false, syncTimer = null, cfg = null, activeId = null, items = [];

  function muteIcon(){
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
      (muted
        ? '<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/>'
        : '<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 010 7.07"/><path d="M19.07 4.93a10 10 0 010 14.14"/>') + '</svg>';
  }

  function slideHtml(p){
    return '<section class="rl-slide" data-id="'+esc(p.id)+'">'+
      '<video src="'+esc(p.videoUrl)+'" poster="'+esc(p.thumbnailUrl||'')+'" loop playsinline preload="metadata"></video>'+
      '<div class="rl-tap"></div><div class="rl-pause">'+I.play+'</div>'+
      '<div class="rl-rail">'+
        '<button class="rl-act" data-a="like" title="Like">'+I.heart+'<span data-c="like"></span></button>'+
        (p.commentsOff ? '' : '<button class="rl-act" data-a="comment" title="Comments">'+I.comment+'<span data-c="comment"></span></button>')+
        '<button class="rl-act" data-a="link" title="Copy link">'+I.link+'</button>'+
        '<button class="rl-act" data-a="open" title="Open post">'+I.open+'</button>'+
      '</div>'+
      '<div class="rl-info">'+
        '<div class="rl-author" data-a="author"><img src="'+esc(p.avatar||'logo.jpg')+'" alt="" onerror="this.style.background=\'linear-gradient(135deg,#4f46e5,#06b6d4)\'"><span>'+esc(p.author||'MindShift Books User')+'</span></div>'+
        (p.text ? '<div class="rl-cap">'+esc(p.text)+'</div><button class="rl-more" data-a="more">more</button>' : '')+
      '</div>'+
      '<div class="rl-prog"><i></i></div></section>';
  }

  function play(slide){
    var v = slide.querySelector('video');
    v.muted = muted; slide.classList.remove('paused');
    var pr = v.play();
    if(pr && pr.catch) pr.catch(function(){
      muted = true; v.muted = true; v.play().catch(function(){});
      var mb = document.getElementById('rlMuteBtn'); if(mb) mb.innerHTML = muteIcon();
    });
  }

  // Mirror like state + counts from the page's own cards (they own the real logic).
  function sync(slide){
    if(!slide || !cfg) return;
    var id = slide.getAttribute('data-id');
    var lb = slide.querySelector('[data-a="like"]');
    if(lb){
      var on = !!cfg.isLiked(id);
      lb.classList.toggle('liked', on);
      var src = document.getElementById('lc-'+id);
      lb.querySelector('[data-c="like"]').textContent = src ? src.textContent : '';
    }
    var cc = slide.querySelector('[data-c="comment"]');
    if(cc){ var s2 = document.getElementById('pcc-'+id); cc.textContent = s2 ? s2.textContent : ''; }
  }

  function measureCaption(slide){
    var cap = slide.querySelector('.rl-cap'), more = slide.querySelector('.rl-more');
    if(!cap || !more) return;
    var over = cap.scrollHeight > cap.clientHeight + 2;
    cap.classList.toggle('has-more', over);
    more.classList.toggle('show', over);
  }
  function toggleCaption(slide){
    var cap = slide.querySelector('.rl-cap'), more = slide.querySelector('.rl-more'), info = slide.querySelector('.rl-info');
    var open = !cap.classList.contains('open');
    cap.classList.toggle('open', open); info.classList.toggle('expanded', open);
    more.textContent = open ? 'less' : 'more';
    if(!open) cap.scrollTop = 0;
  }

  function open(startId, config){
    cfg = config;
    var seen = {}, ids = [];
    document.querySelectorAll('.pcard-video-el').forEach(function(el){
      var id = el.getAttribute('data-post-id');
      if(id && !seen[id]){ seen[id] = 1; ids.push(id); }
    });
    if(!seen[startId]) ids.unshift(startId);
    items = ids.map(function(id){ return cfg.lookup(id); }).filter(function(p){ return p && p.videoUrl; });
    if(!items.length){ cfg.openPost(startId); return; }

    document.querySelectorAll('.pcard-video-el').forEach(function(v){ v.pause(); });
    var ov = document.getElementById('msbReels');
    if(!ov){ ov = document.createElement('div'); ov.id = 'msbReels'; document.body.appendChild(ov); }
    ov.innerHTML = '<button class="rl-back" data-a="close" title="Back">'+I.back+'</button>'+
      '<button class="rl-mute" id="rlMuteBtn" data-a="mute" title="Sound">'+muteIcon()+'</button>'+
      '<div class="rl-scroller">'+items.map(slideHtml).join('')+'</div>';
    ov.classList.add('open');
    document.documentElement.style.overflow = 'hidden';
    document.body.style.overflow = 'hidden';
    document.body.classList.add('msb-reels-open');

    var scroller = ov.querySelector('.rl-scroller');
    var startIdx = Math.max(0, items.findIndex(function(p){ return p.id === startId; }));
    scroller.scrollTop = startIdx * scroller.clientHeight;

    if(observer) observer.disconnect();
    observer = new IntersectionObserver(function(entries){
      entries.forEach(function(en){
        var slide = en.target, v = slide.querySelector('video');
        if(en.isIntersecting){ activeId = slide.getAttribute('data-id'); play(slide); sync(slide); }
        else { v.pause(); v.currentTime = 0; }
      });
    }, { root: scroller, threshold: 0.7 });

    scroller.querySelectorAll('.rl-slide').forEach(function(slide){
      var v = slide.querySelector('video'), bar = slide.querySelector('.rl-prog i');
      v.addEventListener('timeupdate', function(){ if(v.duration) bar.style.width = (v.currentTime/v.duration*100)+'%'; });
      slide.querySelector('.rl-tap').addEventListener('click', function(){
        if(v.paused){ v.play().catch(function(){}); slide.classList.remove('paused'); }
        else { v.pause(); slide.classList.add('paused'); }
      });
      measureCaption(slide); sync(slide);
      observer.observe(slide);
    });

    ov.onclick = function(e){
      var t = e.target.closest('[data-a]'); 
      var cap = e.target.closest('.rl-cap.has-more:not(.open)');
      var slide = e.target.closest('.rl-slide');
      if(cap && slide){ toggleCaption(slide); return; }
      if(!t) return;
      var a = t.getAttribute('data-a'), id = slide ? slide.getAttribute('data-id') : null;
      var item = id ? items.find(function(p){ return p.id === id; }) : null;
      e.stopPropagation();
      if(a === 'close') close();
      else if(a === 'mute') toggleMute();
      else if(a === 'more') toggleCaption(slide);
      else if(a === 'like'){ cfg.like(id); setTimeout(function(){ sync(slide); }, 0); setTimeout(function(){ sync(slide); }, 250); }
      else if(a === 'comment') cfg.comment(id);
      else if(a === 'link') cfg.link(id);
      else if(a === 'open') cfg.openPost(id);
      else if(a === 'author') cfg.author(item);
    };

    // Keep like/comment counts fresh (page handlers update their own cards async).
    clearInterval(syncTimer);
    syncTimer = setInterval(function(){
      var s = activeId && ov.querySelector('.rl-slide[data-id="'+activeId+'"]'); if(s) sync(s);
    }, 400);

    history.pushState({ msbReels: 1 }, ''); pushed = true;
  }

  function toggleMute(){
    muted = !muted;
    document.querySelectorAll('#msbReels video').forEach(function(v){ v.muted = muted; });
    var mb = document.getElementById('rlMuteBtn'); if(mb) mb.innerHTML = muteIcon();
  }

  function teardown(){
    var ov = document.getElementById('msbReels');
    if(!ov || !ov.classList.contains('open')) return;
    if(observer){ observer.disconnect(); observer = null; }
    clearInterval(syncTimer); syncTimer = null; activeId = null;
    ov.querySelectorAll('video').forEach(function(v){ v.pause(); v.removeAttribute('src'); v.load(); });
    ov.classList.remove('open'); ov.innerHTML = ''; ov.onclick = null;
    document.documentElement.style.overflow = ''; document.body.style.overflow = '';
    document.body.classList.remove('msb-reels-open');
    // Resume whichever feed videos are actually on screen (muted, like before).
    document.querySelectorAll('.pcard-video-el').forEach(function(v){
      var b = v.getBoundingClientRect();
      if(!b.height) return;
      var vis = Math.max(0, Math.min(b.bottom, innerHeight) - Math.max(b.top, 0)) / b.height;
      if(vis >= 0.6) v.play().catch(function(){});
    });
  }
  function close(){
    if(pushed){ pushed = false; history.back(); }   // popstate performs the teardown
    else teardown();
  }
  window.addEventListener('popstate', function(){ pushed = false; teardown(); });

  window.MSBReels = { open: open, close: close };
})();
