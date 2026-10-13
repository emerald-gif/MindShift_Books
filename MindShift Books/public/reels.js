/* MindShift Books — full-screen reels viewer (feed, profile pages, post page).
   MSBReels.open(startId, cfg)
     cfg.lookup(id)  -> item {id, videoUrl, thumbnailUrl, text, author, avatar, authorUid, isMindshift, commentsOff}
     cfg.items       -> optional ready-made item list (skips scanning the page for .pcard-video-el)
     cfg.isLiked(id) -> boolean            (used when cfg.getState is absent; counts are mirrored from #lc-/#pcc- on the page)
     cfg.getState(id)-> {liked, likes, comments}   optional, for pages without feed cards
     cfg.onActive(id)-> optional, called when a reel becomes the visible one
     cfg.like / comment / link / openPost (id)    cfg.author(item)                                              */
(function(){
  if(window.MSBReels) return;

  var css = `
#msbReels{position:fixed;inset:0;z-index:99999;background:#000;display:none;color:#fff;
  font-family:inherit;-webkit-user-select:none;user-select:none}
#msbReels.open{display:block}
#msbReels *{-webkit-tap-highlight-color:transparent}
#msbReels .rl-scroller{position:absolute;inset:0;overflow-y:scroll;scroll-snap-type:y mandatory;overscroll-behavior:contain;
  -webkit-overflow-scrolling:touch;scrollbar-width:none}
#msbReels .rl-scroller::-webkit-scrollbar{display:none}
#msbReels .rl-slide{position:relative;height:100vh;height:100dvh;width:100%;scroll-snap-align:start;scroll-snap-stop:always;background:#000;overflow:hidden}
#msbReels .rl-frame{position:relative;height:100%;max-width:520px;margin:0 auto;overflow:hidden}
#msbReels video{position:absolute;inset:0;width:100%;height:100%;object-fit:contain;background:#000}
#msbReels video.fill{object-fit:cover}
#msbReels .rl-tap{position:absolute;inset:0;z-index:1}
#msbReels .rl-pause{position:absolute;top:50%;left:50%;transform:translate(-50%,-50%) scale(.8);width:76px;height:76px;border-radius:50%;
  background:rgba(0,0,0,.5);backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);display:flex;align-items:center;justify-content:center;
  z-index:2;pointer-events:none;opacity:0;transition:opacity .18s,transform .18s}
#msbReels .rl-slide.paused .rl-pause{opacity:1;transform:translate(-50%,-50%) scale(1)}
#msbReels .rl-pause svg{width:32px;height:32px;fill:#fff;margin-left:4px}
#msbReels .rl-spin{position:absolute;top:50%;left:50%;width:44px;height:44px;margin:-22px 0 0 -22px;border-radius:50%;
  border:3px solid rgba(255,255,255,.25);border-top-color:#fff;animation:rlspin .8s linear infinite;z-index:2;pointer-events:none;display:none}
#msbReels .rl-slide.buffering .rl-spin{display:block}
@keyframes rlspin{to{transform:rotate(360deg)}}
#msbReels .rl-err{position:absolute;top:50%;left:0;right:0;transform:translateY(-50%);text-align:center;font-size:14px;font-weight:600;
  color:rgba(255,255,255,.85);z-index:2;display:none;padding:0 30px;pointer-events:none}
#msbReels .rl-slide.failed .rl-err{display:block}
#msbReels .rl-burst{position:absolute;width:96px;height:96px;margin:-48px 0 0 -48px;z-index:3;pointer-events:none;
  animation:rlburst .8s ease-out forwards}
#msbReels .rl-burst svg{width:100%;height:100%;fill:#ef4444;stroke:#ef4444;stroke-width:1;filter:drop-shadow(0 4px 14px rgba(0,0,0,.45))}
@keyframes rlburst{0%{transform:scale(.3);opacity:0}25%{transform:scale(1.15);opacity:1}55%{transform:scale(1);opacity:1}100%{transform:scale(1.1) translateY(-30px);opacity:0}}

/* top bar */
#msbReels .rl-top{position:fixed;top:0;left:0;right:0;z-index:6;pointer-events:none;
  background:linear-gradient(to bottom,rgba(0,0,0,.55),transparent);height:96px}
#msbReels .rl-top-in{max-width:520px;margin:0 auto;padding:max(12px,env(safe-area-inset-top)) 12px 0;display:flex;align-items:center;gap:10px}
#msbReels .rl-chip{pointer-events:auto;min-width:42px;height:42px;border-radius:21px;padding:0 12px;border:none;color:#fff;cursor:pointer;
  background:rgba(20,20,26,.5);backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);display:flex;align-items:center;justify-content:center;
  font-weight:800;font-size:14px;font-family:inherit}
#msbReels .rl-chip:active{transform:scale(.94)}
#msbReels .rl-chip svg{width:22px;height:22px}
#msbReels .rl-sp{flex:1}

/* right rail */
#msbReels .rl-rail{position:absolute;right:10px;bottom:calc(max(18px,env(safe-area-inset-bottom)) + 74px);z-index:4;
  display:flex;flex-direction:column;gap:14px;align-items:center}
#msbReels .rl-act{background:none;border:none;color:#fff;display:flex;flex-direction:column;align-items:center;gap:4px;
  font-size:12px;font-weight:700;cursor:pointer;font-family:inherit;text-shadow:0 1px 3px rgba(0,0,0,.6)}
#msbReels .rl-ic{width:48px;height:48px;border-radius:50%;background:rgba(20,20,26,.5);backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);
  display:flex;align-items:center;justify-content:center;transition:transform .12s}
#msbReels .rl-act:active .rl-ic{transform:scale(.9)}
#msbReels .rl-ic svg{width:24px;height:24px;fill:none;stroke:#fff;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
#msbReels .rl-act.liked .rl-ic svg{fill:#ef4444;stroke:#ef4444;animation:rlpop .3s ease}
@keyframes rlpop{0%{transform:scale(.7)}60%{transform:scale(1.3)}100%{transform:scale(1)}}
#msbReels .rl-act span{min-height:14px;line-height:14px}

/* bottom: author + caption + scrubber */
#msbReels .rl-info{position:absolute;left:0;right:76px;bottom:0;z-index:3;
  padding:90px 16px calc(max(18px,env(safe-area-inset-bottom)) + 44px);
  background:linear-gradient(to top,rgba(0,0,0,.78) 25%,transparent)}
#msbReels .rl-info.expanded{background:linear-gradient(to top,rgba(0,0,0,.9) 65%,transparent)}
#msbReels .rl-author{display:inline-flex;align-items:center;gap:10px;font-weight:800;font-size:15px;cursor:pointer;max-width:100%}
#msbReels .rl-author img{width:38px;height:38px;border-radius:50%;object-fit:cover;background:#4f46e5;border:2px solid rgba(255,255,255,.85);flex:none}
#msbReels .rl-author span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#msbReels .rl-cap{margin-top:10px;font-size:14.5px;line-height:1.45;white-space:pre-wrap;word-break:break-word;max-height:2.9em;overflow:hidden}
#msbReels .rl-cap.has-more:not(.open){-webkit-mask-image:linear-gradient(to bottom,#000 35%,transparent 100%);mask-image:linear-gradient(to bottom,#000 35%,transparent 100%);cursor:pointer}
#msbReels .rl-cap.open{max-height:36vh;overflow-y:auto;overscroll-behavior:contain;touch-action:pan-y;-webkit-overflow-scrolling:touch;padding-right:4px}
#msbReels .rl-more{display:none;margin-top:2px;background:none;border:none;color:#fff;font-weight:800;font-size:13px;padding:6px 0;cursor:pointer;font-family:inherit;opacity:.92}
#msbReels .rl-more.show{display:inline-block}

#msbReels .rl-scrub{position:absolute;left:0;right:0;bottom:0;z-index:5;padding:0 16px max(14px,env(safe-area-inset-bottom));
  height:calc(34px + max(14px,env(safe-area-inset-bottom)));display:flex;align-items:center;gap:10px;touch-action:none;cursor:pointer}
#msbReels .rl-track{position:relative;flex:1;height:4px;border-radius:2px;background:rgba(255,255,255,.28);transition:height .12s}
#msbReels .rl-scrub.drag .rl-track{height:8px}
#msbReels .rl-fill{position:absolute;left:0;top:0;bottom:0;width:0;border-radius:2px;background:#fff}
#msbReels .rl-knob{position:absolute;top:50%;left:0;width:14px;height:14px;margin:-7px 0 0 -7px;border-radius:50%;background:#fff;
  box-shadow:0 1px 6px rgba(0,0,0,.5);transform:scale(.0);transition:transform .12s}
#msbReels .rl-scrub.drag .rl-knob,#msbReels .rl-slide.paused .rl-knob{transform:scale(1)}
#msbReels .rl-time{font-size:12px;font-weight:700;font-variant-numeric:tabular-nums;color:rgba(255,255,255,.9);min-width:74px;text-align:right;text-shadow:0 1px 3px rgba(0,0,0,.6)}

#msbReels .rl-hint{position:fixed;left:50%;bottom:calc(max(18px,env(safe-area-inset-bottom)) + 120px);transform:translateX(-50%);z-index:7;
  background:rgba(20,20,26,.7);backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);padding:9px 16px;border-radius:99px;font-size:13px;font-weight:700;
  pointer-events:none;animation:rlhint 3s ease forwards;display:flex;gap:8px;align-items:center}
@keyframes rlhint{0%{opacity:0;transform:translate(-50%,10px)}12%{opacity:1;transform:translate(-50%,0)}80%{opacity:1}100%{opacity:0}}
body.msb-reels-open .toast{z-index:100001!important}
body.msb-reels-open .auth-sheet{z-index:100003!important}
body.msb-reels-open .overlay{z-index:100002!important}
`;
  var st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);

  var I = {
    back:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>',
    heart:'<svg viewBox="0 0 24 24"><path d="M20.84 4.61a5.5 5.5 0 00-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 00-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 000-7.78z"/></svg>',
    comment:'<svg viewBox="0 0 24 24"><path d="M21 11.5a8.38 8.38 0 01-.9 3.8 8.5 8.5 0 01-7.6 4.7 8.38 8.38 0 01-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 01-.9-3.8 8.5 8.5 0 014.7-7.6 8.38 8.38 0 013.8-.9h.5a8.48 8.48 0 018 8v.5z"/></svg>',
    link:'<svg viewBox="0 0 24 24"><path d="M10 13a5 5 0 007.54.54l3-3a5 5 0 00-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 00-7.54-.54l-3 3a5 5 0 007.07 7.07l1.71-1.71"/></svg>',
    open:'<svg viewBox="0 0 24 24"><path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>',
    play:'<svg viewBox="0 0 24 24"><polygon points="6 3 20 12 6 21 6 3"/></svg>',
    up:'<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="#fff" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><polyline points="18 15 12 9 6 15"/></svg>'
  };
  function esc(s){ return String(s==null?'':s).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];}); }
  function fmt(t){ t = Math.max(0, Math.floor(t||0)); return Math.floor(t/60)+':'+String(t%60).padStart(2,'0'); }

  var scrollerEl = null, loadingMore = false, exhausted = false, endFlashed = false, prevOv = ['',''], muted = false, speed = 1, observer = null, pushed = false, syncTimer = null, cfg = null, activeId = null, items = [];
  var SPEEDS = [1, 1.5, 2, 0.5];

  function muteIcon(){
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
      (muted
        ? '<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/>'
        : '<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 010 7.07"/><path d="M19.07 4.93a10 10 0 010 14.14"/>') + '</svg>';
  }
  function speedLabel(){ return (speed===1?'1':String(speed))+'×'; }

  function slideHtml(p){
    return '<section class="rl-slide buffering" data-id="'+esc(p.id)+'"><div class="rl-frame">'+
      '<video src="'+esc(p.videoUrl)+'" poster="'+esc(p.thumbnailUrl||'')+'" loop playsinline webkit-playsinline preload="metadata"></video>'+
      '<div class="rl-spin"></div><div class="rl-err">Couldn\u2019t load this video</div>'+
      '<div class="rl-tap"></div><div class="rl-pause">'+I.play+'</div>'+
      '<div class="rl-rail">'+
        '<button class="rl-act" data-a="like" aria-label="Like"><div class="rl-ic">'+I.heart+'</div><span data-c="like"></span></button>'+
        (p.commentsOff ? '' : '<button class="rl-act" data-a="comment" aria-label="Comments"><div class="rl-ic">'+I.comment+'</div><span data-c="comment"></span></button>')+
        '<button class="rl-act" data-a="link" aria-label="Copy link"><div class="rl-ic">'+I.link+'</div><span>Copy</span></button>'+
        '<button class="rl-act" data-a="open" aria-label="Open post"><div class="rl-ic">'+I.open+'</div><span>Post</span></button>'+
      '</div>'+
      '<div class="rl-info">'+
        '<div class="rl-author" data-a="author"><img src="'+esc(p.avatar||'logo.jpg')+'" alt="" onerror="this.style.background=\'linear-gradient(135deg,#4f46e5,#06b6d4)\'"><span>'+esc(p.author||'MindShift Books User')+'</span></div>'+
        (p.text ? '<div class="rl-cap">'+esc(p.text)+'</div><button class="rl-more" data-a="more">more</button>' : '')+
      '</div>'+
      '<div class="rl-scrub" data-scrub><div class="rl-track"><div class="rl-fill"></div><div class="rl-knob"></div></div><div class="rl-time">0:00 / 0:00</div></div>'+
    '</div></section>';
  }

  function stateOf(id){
    if(cfg.getState){ var s = cfg.getState(id) || {}; return { liked: !!s.liked, likes: s.likes==null?'':s.likes, comments: s.comments==null?'':s.comments }; }
    var a = document.getElementById('lc-'+id), b = document.getElementById('pcc-'+id);
    return { liked: !!(cfg.isLiked && cfg.isLiked(id)), likes: a ? a.textContent : '', comments: b ? b.textContent : '' };
  }
  function sync(slide){
    if(!slide || !cfg) return;
    var id = slide.getAttribute('data-id'), s = stateOf(id);
    var lb = slide.querySelector('[data-a="like"]');
    if(lb){ lb.classList.toggle('liked', s.liked); lb.querySelector('[data-c="like"]').textContent = s.likes; }
    var cc = slide.querySelector('[data-c="comment"]'); if(cc) cc.textContent = s.comments;
  }

  function applySpeed(){
    document.querySelectorAll('#msbReels video').forEach(function(v){ v.playbackRate = speed; });
    var sb = document.getElementById('rlSpeedBtn'); if(sb) sb.textContent = speedLabel();
  }
  function play(slide){
    var v = slide.querySelector('video');
    v.muted = muted; v.playbackRate = speed; slide.classList.remove('paused');
    var pr = v.play();
    if(pr && pr.catch) pr.catch(function(){
      // Browser refused sound-on autoplay — fall back to muted instead of a dead screen.
      muted = true; v.muted = true; v.play().catch(function(){});
      var mb = document.getElementById('rlMuteBtn'); if(mb) mb.innerHTML = muteIcon();
    });
  }
  function measureCaption(slide){
    var cap = slide.querySelector('.rl-cap'), more = slide.querySelector('.rl-more');
    if(!cap || !more) return;
    var over = cap.scrollHeight > cap.clientHeight + 2;
    cap.classList.toggle('has-more', over); more.classList.toggle('show', over);
  }
  function toggleCaption(slide){
    var cap = slide.querySelector('.rl-cap'), more = slide.querySelector('.rl-more'), info = slide.querySelector('.rl-info');
    var o = !cap.classList.contains('open');
    cap.classList.toggle('open', o); info.classList.toggle('expanded', o);
    more.textContent = o ? 'less' : 'more';
    if(!o) cap.scrollTop = 0;
  }
  function burst(slide, x, y){
    var frame = slide.querySelector('.rl-frame'), r = frame.getBoundingClientRect();
    var b = document.createElement('div'); b.className = 'rl-burst'; b.innerHTML = I.heart;
    b.style.left = (x - r.left)+'px'; b.style.top = (y - r.top)+'px';
    frame.appendChild(b); setTimeout(function(){ b.remove(); }, 850);
  }

  function wireSlide(slide){
    var v = slide.querySelector('video'), id = slide.getAttribute('data-id');
    var fill = slide.querySelector('.rl-fill'), knob = slide.querySelector('.rl-knob'), time = slide.querySelector('.rl-time');
    var scrub = slide.querySelector('[data-scrub]'), track = slide.querySelector('.rl-track');
    var dragging = false;
    function paint(){
      var d = v.duration || 0, p = d ? Math.min(1, v.currentTime / d) : 0;
      fill.style.width = (p*100)+'%'; knob.style.left = (p*100)+'%';
      time.textContent = fmt(v.currentTime)+' / '+fmt(d);
    }
    v.addEventListener('timeupdate', function(){ if(!dragging) paint(); });
    v.addEventListener('loadedmetadata', function(){
      paint();
      // Tall clips fill a tall phone screen; everything else is letterboxed so nothing is cropped.
      var vr = v.videoHeight / (v.videoWidth || 1), sr = innerHeight / innerWidth;
      v.classList.toggle('fill', innerWidth < 600 && vr >= 1.6 && Math.abs(sr - vr) < 0.3);
    });
    ['waiting','loadstart','seeking'].forEach(function(ev){ v.addEventListener(ev, function(){ slide.classList.add('buffering'); }); });
    ['playing','canplay','seeked','loadeddata'].forEach(function(ev){ v.addEventListener(ev, function(){ slide.classList.remove('buffering'); }); });
    v.addEventListener('error', function(){ slide.classList.remove('buffering'); slide.classList.add('failed'); });

    // Tap = pause/play, double-tap = like (with heart burst)
    var last = 0, timer = null, tap = slide.querySelector('.rl-tap');
    tap.addEventListener('click', function(e){
      var now = Date.now();
      if(now - last < 300){
        clearTimeout(timer); last = 0;
        burst(slide, e.clientX, e.clientY);
        if(!stateOf(id).liked){ cfg.like(id); setTimeout(function(){ sync(slide); }, 0); setTimeout(function(){ sync(slide); }, 250); }
        return;
      }
      last = now;
      timer = setTimeout(function(){
        if(v.paused){ v.play().catch(function(){}); slide.classList.remove('paused'); }
        else { v.pause(); slide.classList.add('paused'); }
      }, 300);
    });

    // Draggable seek bar
    function seekTo(clientX){
      var r = track.getBoundingClientRect(), p = Math.max(0, Math.min(1, (clientX - r.left) / r.width));
      if(v.duration){ v.currentTime = p * v.duration; }
      fill.style.width = (p*100)+'%'; knob.style.left = (p*100)+'%';
      time.textContent = fmt(p*(v.duration||0))+' / '+fmt(v.duration||0);
    }
    scrub.addEventListener('pointerdown', function(e){
      dragging = true; scrub.classList.add('drag'); try{ scrub.setPointerCapture(e.pointerId); }catch(_){}
      seekTo(e.clientX); e.stopPropagation();
    });
    scrub.addEventListener('pointermove', function(e){ if(dragging) seekTo(e.clientX); });
    function endDrag(){ if(!dragging) return; dragging = false; scrub.classList.remove('drag'); paint(); }
    scrub.addEventListener('pointerup', endDrag);
    scrub.addEventListener('pointercancel', endDrag);
    scrub.addEventListener('click', function(e){ e.stopPropagation(); });

    measureCaption(slide); sync(slide);
  }

  function open(startId, config){
    cfg = config;
    if(cfg.items){ items = cfg.items.filter(function(p){ return p && p.videoUrl; }); }
    else {
      var seen = {}, ids = [];
      document.querySelectorAll('.pcard-video-el').forEach(function(el){
        var id = el.getAttribute('data-post-id');
        if(id && !seen[id]){ seen[id] = 1; ids.push(id); }
      });
      if(!seen[startId]) ids.unshift(startId);
      items = ids.map(function(id){ return cfg.lookup(id); }).filter(function(p){ return p && p.videoUrl; });
    }
    if(!items.length){ cfg.openPost(startId); return; }

    document.querySelectorAll('.pcard-video-el, #pvEl').forEach(function(v){ v.pause(); });
    var ov = document.getElementById('msbReels');
    if(!ov){ ov = document.createElement('div'); ov.id = 'msbReels'; document.body.appendChild(ov); }
    ov.innerHTML =
      '<div class="rl-top"><div class="rl-top-in">'+
        '<button class="rl-chip" data-a="close" aria-label="Back">'+I.back+'</button><div class="rl-sp"></div>'+
        '<button class="rl-chip" id="rlSpeedBtn" data-a="speed" aria-label="Playback speed">'+speedLabel()+'</button>'+
        '<button class="rl-chip" id="rlMuteBtn" data-a="mute" aria-label="Sound">'+muteIcon()+'</button>'+
      '</div></div>'+
      '<div class="rl-scroller">'+items.map(slideHtml).join('')+'</div>';
    ov.classList.add('open');
    prevOv = [document.documentElement.style.overflow, document.body.style.overflow];
    document.documentElement.style.overflow = 'hidden'; document.body.style.overflow = 'hidden';
    document.body.classList.add('msb-reels-open');

    loadingMore = false; exhausted = false; endFlashed = false;
    var scroller = ov.querySelector('.rl-scroller');
    scrollerEl = scroller;
    var startIdx = Math.max(0, items.findIndex(function(p){ return p.id === startId; }));
    scroller.scrollTop = startIdx * scroller.clientHeight;

    if(observer) observer.disconnect();
    observer = new IntersectionObserver(function(entries){
      entries.forEach(function(en){
        var slide = en.target, v = slide.querySelector('video');
        if(en.isIntersecting){
          activeId = slide.getAttribute('data-id'); play(slide); sync(slide);
          if(cfg.onActive) cfg.onActive(activeId);
          var idx = Array.prototype.indexOf.call(scroller.children, slide);
          maybeLoadMore(idx);
          if(exhausted && idx === items.length - 1 && !endFlashed){ endFlashed = true; flash('You\u2019ve reached the end'); }
          var next = slide.nextElementSibling; if(next){ var nv = next.querySelector('video'); if(nv) nv.preload = 'auto'; }
        } else { v.pause(); try{ v.currentTime = 0; }catch(_){} slide.classList.remove('paused'); }
      });
    }, { root: scroller, threshold: 0.7 });
    scroller.querySelectorAll('.rl-slide').forEach(function(slide){ wireSlide(slide); observer.observe(slide); });

    ov.onclick = function(e){
      var slide = e.target.closest('.rl-slide');
      var capEl = e.target.closest('.rl-cap.has-more:not(.open)');
      if(capEl && slide){ toggleCaption(slide); return; }
      var t = e.target.closest('[data-a]'); if(!t) return;
      var a = t.getAttribute('data-a'), id = slide ? slide.getAttribute('data-id') : null;
      var item = id ? items.find(function(p){ return p.id === id; }) : null;
      if(a === 'close') close();
      else if(a === 'mute') toggleMute();
      else if(a === 'speed'){ speed = SPEEDS[(SPEEDS.indexOf(speed)+1) % SPEEDS.length]; applySpeed(); }
      else if(a === 'more') toggleCaption(slide);
      else if(a === 'like'){ cfg.like(id); setTimeout(function(){ sync(slide); }, 0); setTimeout(function(){ sync(slide); }, 250); }
      else if(a === 'comment') cfg.comment(id);
      else if(a === 'link') cfg.link(id);
      else if(a === 'open') cfg.openPost(id);
      else if(a === 'author') cfg.author(item);
    };

    // Keep like/comment counts fresh (the page's own handlers update asynchronously).
    clearInterval(syncTimer);
    syncTimer = setInterval(function(){
      var s = activeId && ov.querySelector('.rl-slide[data-id="'+activeId+'"]'); if(s) sync(s);
    }, 400);

    // One-time "swipe up" hint
    try{
      if(items.length > 1 && !localStorage.getItem('msb_reels_hint')){
        localStorage.setItem('msb_reels_hint', '1');
        flash('Swipe up for more', I.up);
      }
    }catch(_){}

    maybeLoadMore(startIdx);     // short list? start fetching more right away

    history.pushState({ msbReels: 1 }, ''); pushed = true;
  }


  function flash(text, icon){
    var ov = document.getElementById('msbReels'); if(!ov) return;
    var h = document.createElement('div'); h.className = 'rl-hint'; h.innerHTML = (icon||'') + esc(text);
    ov.appendChild(h); setTimeout(function(){ h.remove(); }, 3100);
  }
  // Append freshly loaded videos to the end of the open scroller.
  function appendItems(list){
    var ov = document.getElementById('msbReels');
    if(!ov || !ov.classList.contains('open') || !scrollerEl) return;
    var have = {}; items.forEach(function(p){ have[p.id] = 1; });
    var fresh = list.filter(function(p){ return p && p.videoUrl && !have[p.id]; });
    if(!fresh.length) return;
    fresh.forEach(function(p){
      items.push(p);
      scrollerEl.insertAdjacentHTML('beforeend', slideHtml(p));
      var slide = scrollerEl.lastElementChild;
      wireSlide(slide); observer.observe(slide);
    });
    if(cfg.onAppend) cfg.onAppend(fresh);
  }
  // Called when you're within 3 videos of the end: ask the page for more.
  function maybeLoadMore(idx){
    if(!cfg || !cfg.loadMore || loadingMore || exhausted) return;
    if(idx < items.length - 4) return;
    loadingMore = true;
    var cur = cfg;
    Promise.resolve(cfg.loadMore(items.map(function(p){ return p.id; }))).then(function(list){
      loadingMore = false;
      if(cur !== cfg) return;                       // reels were closed/reopened meanwhile
      if(!list || !list.length){ exhausted = true; return; }
      appendItems(list);
    }).catch(function(){ loadingMore = false; });
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
    document.documentElement.style.overflow = prevOv[0]; document.body.style.overflow = prevOv[1];
    document.body.classList.remove('msb-reels-open');
    // Resume whichever feed videos are actually on screen (muted, like before).
    document.querySelectorAll('.pcard-video-el').forEach(function(v){
      var b = v.getBoundingClientRect(); if(!b.height) return;
      var vis = Math.max(0, Math.min(b.bottom, innerHeight) - Math.max(b.top, 0)) / b.height;
      if(vis >= 0.6) v.play().catch(function(){});
    });
  }
  function close(){
    if(pushed){ pushed = false; history.back(); }   // popstate performs the teardown
    else teardown();
  }
  window.addEventListener('popstate', function(){ pushed = false; teardown(); });
  document.addEventListener('keydown', function(e){
    var ov = document.getElementById('msbReels'); if(!ov || !ov.classList.contains('open')) return;
    var sc = ov.querySelector('.rl-scroller');
    if(e.key === 'Escape') close();
    else if(e.key === 'ArrowDown'){ sc.scrollBy({top: sc.clientHeight, behavior:'smooth'}); e.preventDefault(); }
    else if(e.key === 'ArrowUp'){ sc.scrollBy({top: -sc.clientHeight, behavior:'smooth'}); e.preventDefault(); }
  });

  window.MSBReels = { open: open, close: close };
})();
