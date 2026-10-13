/* MindShift Books — full-screen image viewer for feed/profile post images.
   Same look + behaviour as the viewer on the post/article pages: swipe sideways between photos,
   "1/3" counter, tap the dark area or ✕ to close. Also closes on the phone back button / Esc.
   MSBImageViewer.fromEl(imgEl)   -> opens that photo, with its sibling photos from the same post carousel
   MSBImageViewer.open(urls, i)   -> open an explicit list */
(function(){
  if(window.MSBImageViewer) return;
  var css = `
#msbImgV{position:fixed;inset:0;background:rgba(10,8,20,.94);z-index:99990;opacity:0;pointer-events:none;transition:opacity .2s;touch-action:pan-x}
#msbImgV.show{opacity:1;pointer-events:all}
#msbImgV .iv-close{position:absolute;top:max(16px,env(safe-area-inset-top));right:16px;width:42px;height:42px;border-radius:50%;background:rgba(0,0,0,.55);
  border:none;color:#fff;display:flex;align-items:center;justify-content:center;cursor:pointer;z-index:2;-webkit-tap-highlight-color:transparent}
#msbImgV .iv-close svg{width:18px;height:18px;fill:none;stroke:currentColor;stroke-width:2.5;stroke-linecap:round;stroke-linejoin:round}
#msbImgV .iv-count{position:absolute;top:max(22px,calc(env(safe-area-inset-top) + 6px));left:50%;transform:translateX(-50%);background:rgba(0,0,0,.55);color:#fff;
  font-size:12.5px;font-weight:700;padding:5px 13px;border-radius:99px;z-index:2;letter-spacing:.2px}
#msbImgV .iv-track{display:flex;width:100vw;height:100vh;height:100dvh;overflow-x:auto;scroll-snap-type:x mandatory;-webkit-overflow-scrolling:touch;scrollbar-width:none}
#msbImgV .iv-track::-webkit-scrollbar{display:none}
#msbImgV .iv-slide{flex:0 0 100vw;scroll-snap-align:center;scroll-snap-stop:always;display:flex;align-items:center;justify-content:center}
#msbImgV .iv-slide img{max-width:94vw;max-height:86vh;max-height:86dvh;object-fit:contain;border-radius:8px;-webkit-user-select:none;user-select:none}
.pcard-single img,.pcard-slide img{cursor:pointer}
`;
  var st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);

  var el = null, track = null, countEl = null, n = 0, pushed = false, prevOv = '';
  function build(){
    el = document.createElement('div'); el.id = 'msbImgV';
    el.innerHTML = '<button class="iv-close" aria-label="Close"><svg viewBox="0 0 24 24"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>'+
      '<div class="iv-count"></div><div class="iv-track"></div>';
    document.body.appendChild(el);
    track = el.querySelector('.iv-track'); countEl = el.querySelector('.iv-count');
    el.addEventListener('click', function(){ close(); });
    track.addEventListener('scroll', updateCount, { passive:true });
  }
  function esc(s){ return String(s).replace(/"/g,'&quot;'); }
  function updateCount(){
    if(!n || !track.clientWidth) return;
    countEl.textContent = (Math.round(track.scrollLeft / track.clientWidth) + 1) + '/' + n;
  }
  function open(list, start){
    if(!list || !list.length) return;
    if(!el) build();
    n = list.length;
    track.innerHTML = list.map(function(src){ return '<div class="iv-slide"><img src="'+esc(src)+'" alt="" draggable="false"></div>'; }).join('');
    track.querySelectorAll('img').forEach(function(im){ im.addEventListener('click', function(e){ e.stopPropagation(); }); });
    countEl.style.display = n > 1 ? '' : 'none';
    prevOv = document.body.style.overflow; document.body.style.overflow = 'hidden';
    el.classList.add('show');
    track.scrollLeft = (start || 0) * track.clientWidth;
    updateCount();
    if(!pushed){ history.pushState({ msbImgV:1 }, ''); pushed = true; }
  }
  function hide(){
    if(!el || !el.classList.contains('show')) return;
    el.classList.remove('show'); document.body.style.overflow = prevOv;
  }
  function close(){
    if(pushed){ pushed = false; history.back(); }   // popstate hides it
    else hide();
  }
  function fromEl(img){
    var wrap = img.closest('.pcard-carousel');
    var imgs = wrap ? Array.prototype.slice.call(wrap.querySelectorAll('.pcard-slide img')) : [img];
    open(imgs.map(function(i){ return i.currentSrc || i.src; }), Math.max(0, imgs.indexOf(img)));
  }
  window.addEventListener('popstate', function(){ pushed = false; hide(); });
  document.addEventListener('keydown', function(e){
    if(!el || !el.classList.contains('show')) return;
    if(e.key === 'Escape') close();
    else if(e.key === 'ArrowRight') track.scrollBy({ left: track.clientWidth, behavior:'smooth' });
    else if(e.key === 'ArrowLeft') track.scrollBy({ left: -track.clientWidth, behavior:'smooth' });
  });
  window.MSBImageViewer = { open: open, close: close, fromEl: fromEl };
})();
