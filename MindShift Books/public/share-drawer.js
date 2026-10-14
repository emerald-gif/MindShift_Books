/* MindShift Books — ONE share drawer for the whole app (feed, reels, image viewer, post page, article page, profiles).
   MSBShare.open({
     url,            // link to share (default: current page)
     text, title,    // caption / headline — used for the preview and the shared message
     thumb, author,  // optional preview thumbnail + author line
     heading,        // optional drawer title (default "Share")
     onImage,        // optional fn — adds a "Share as image" tile
     onShare(kind)   // optional fn — called when the user picks any app / copy (for share counters)
   })
   Back button / Esc / tapping outside / dragging down all close it. Sits above every other layer. */
(function(){
  if(window.MSBShare) return;

  var css = `
#msbShare{position:fixed;inset:0;z-index:100010;background:rgba(15,23,42,.55);opacity:0;transition:opacity .22s;font-family:inherit;
  -webkit-tap-highlight-color:transparent}
#msbShare.in{opacity:1}
#msbShare .ms-sheet{position:absolute;left:0;right:0;bottom:0;max-width:520px;margin:0 auto;max-height:88vh;overflow-y:auto;background:#fff;color:#0f172a;
  border-radius:22px 22px 0 0;padding:8px 18px calc(max(18px,env(safe-area-inset-bottom)) + 6px);transform:translateY(100%);
  transition:transform .26s cubic-bezier(.2,.8,.2,1);box-shadow:0 -10px 40px rgba(0,0,0,.3);overscroll-behavior:contain}
#msbShare.in .ms-sheet{transform:translateY(0)}
#msbShare .ms-sheet.drag{transition:none}
#msbShare .ms-bar{width:40px;height:4px;border-radius:2px;background:#cbd5e1;margin:4px auto 10px}
#msbShare .ms-hd{font-size:17px;font-weight:800;text-align:center;margin-bottom:12px}
#msbShare .ms-prev{display:flex;gap:11px;align-items:center;padding:10px;border:1px solid #e2e8f0;border-radius:14px;margin-bottom:16px;background:#f8fafc}
#msbShare .ms-prev img{width:46px;height:46px;border-radius:9px;object-fit:cover;background:linear-gradient(135deg,#4f46e5,#06b6d4);flex:none}
#msbShare .ms-prev div{min-width:0}
#msbShare .ms-prev b{display:block;font-size:13.5px;font-weight:800;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#msbShare .ms-prev span{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;font-size:12.5px;color:#64748b;line-height:1.35;margin-top:2px;word-break:break-word}
#msbShare .ms-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:16px 6px}
#msbShare .ms-app{background:none;border:none;display:flex;flex-direction:column;align-items:center;gap:7px;font-family:inherit;font-size:12px;font-weight:700;color:#334155;cursor:pointer;padding:0}
#msbShare .ms-app i{width:54px;height:54px;border-radius:50%;display:flex;align-items:center;justify-content:center;transition:transform .12s}
#msbShare .ms-app:active i{transform:scale(.9)}
#msbShare .ms-app svg{width:26px;height:26px;fill:none;stroke:#fff;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
#msbShare .ms-link{display:flex;gap:8px;margin-top:18px;align-items:center;background:#f1f5f9;border-radius:12px;padding:6px 6px 6px 14px}
#msbShare .ms-link input{flex:1;min-width:0;border:none;background:none;font-size:13px;color:#475569;font-family:inherit;outline:none}
#msbShare .ms-link button{border:none;background:#4f46e5;color:#fff;font-weight:800;font-size:13px;padding:9px 16px;border-radius:9px;cursor:pointer;font-family:inherit;white-space:nowrap}
#msbShare .ms-link button.ok{background:#16a34a}
`;
  var st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);

  var LINK = '<svg viewBox="0 0 24 24"><path d="M10 13a5 5 0 007.54.54l3-3a5 5 0 00-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 00-7.54-.54l-3 3a5 5 0 007.07 7.07l1.71-1.71"/></svg>';
  var APPS = {
    native:  { label:'Share via…', bg:'#4f46e5', svg:'<svg viewBox="0 0 24 24"><path d="M4 12v7a2 2 0 002 2h12a2 2 0 002-2v-7"/><polyline points="16 6 12 2 8 6"/><line x1="12" y1="2" x2="12" y2="15"/></svg>' },
    whatsapp:{ label:'WhatsApp', bg:'#25D366', svg:'<svg viewBox="0 0 24 24"><path d="M21 11.5a8.4 8.4 0 01-12.4 7.4L3 21l1.9-5.5A8.4 8.4 0 1121 11.5z"/><path d="M9 8.5c0 3 3.5 6.5 6.5 6.5l1-1.6-2.2-1.1-.9.9c-.9-.4-2-1.5-2.4-2.4l.9-.9-1.1-2.2z" fill="#fff" stroke="none"/></svg>' },
    telegram:{ label:'Telegram', bg:'#229ED9', svg:'<svg viewBox="0 0 24 24"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>' },
    x:       { label:'X',        bg:'#0f172a', svg:'<svg viewBox="0 0 24 24" style="stroke-width:2.6"><line x1="4.5" y1="4.5" x2="19.5" y2="19.5"/><line x1="19.5" y1="4.5" x2="4.5" y2="19.5"/></svg>' },
    facebook:{ label:'Facebook', bg:'#1877F2', svg:'<svg viewBox="0 0 24 24"><path d="M18 2h-3a5 5 0 00-5 5v3H7v4h3v8h4v-8h3l1-4h-4V7a1 1 0 011-1h3z"/></svg>' },
    linkedin:{ label:'LinkedIn', bg:'#0A66C2', svg:'<svg viewBox="0 0 24 24"><path d="M16 8a6 6 0 016 6v7h-4v-7a2 2 0 00-4 0v7h-4v-7a6 6 0 016-6z"/><rect x="2" y="9" width="4" height="12"/><circle cx="4" cy="4" r="2"/></svg>' },
    email:   { label:'Email',    bg:'#64748b', svg:'<svg viewBox="0 0 24 24"><path d="M4 4h16a2 2 0 012 2v12a2 2 0 01-2 2H4a2 2 0 01-2-2V6a2 2 0 012-2z"/><polyline points="22 6 12 13 2 6"/></svg>' },
    sms:     { label:'Messages', bg:'#16a34a', svg:'<svg viewBox="0 0 24 24"><path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/></svg>' },
    image:   { label:'As image', bg:'#f59e0b', svg:'<svg viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg>' },
    copy:    { label:'Copy link',bg:'#475569', svg:LINK }
  };
  function esc(s){ return String(s==null?'':s).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];}); }

  var el = null, isOpen = false, pushed = false, closedByPop = false, prevOv = '', cur = null;

  function open(o){
    if(isOpen) return;
    o = o || {}; cur = o;
    var url = o.url || location.href;
    var raw = (o.text || o.title || 'Check this out on MindShift Books').replace(/\s+/g,' ').trim();
    var text = raw.length > 110 ? raw.slice(0,110) + '…' : raw;
    var order = [navigator.share ? 'native' : null, 'whatsapp','telegram','x','facebook','linkedin','email','sms', o.onImage ? 'image' : null, 'copy'].filter(Boolean);

    el = document.createElement('div'); el.id = 'msbShare';
    el.innerHTML = '<div class="ms-sheet" role="dialog" aria-label="Share"><div class="ms-bar"></div>'+
      '<div class="ms-hd">'+esc(o.heading || 'Share')+'</div>'+
      '<div class="ms-prev">'+(o.thumb ? '<img src="'+esc(o.thumb)+'" alt="" onerror="this.removeAttribute(\'src\')">' : '')+
        '<div>'+(o.author ? '<b>'+esc(o.author)+'</b>' : '')+'<span>'+esc(text)+'</span></div></div>'+
      '<div class="ms-grid">'+order.map(function(k){ var a = APPS[k];
        return '<button type="button" class="ms-app" data-s="'+k+'"><i style="background:'+a.bg+'">'+a.svg+'</i><em style="font-style:normal">'+a.label+'</em></button>'; }).join('')+'</div>'+
      '<div class="ms-link"><input readonly value="'+esc(url)+'"><button type="button" data-s="copy">Copy</button></div></div>';
    document.body.appendChild(el);
    prevOv = document.body.style.overflow; document.body.style.overflow = 'hidden';
    isOpen = true;
    requestAnimationFrame(function(){ requestAnimationFrame(function(){ el && el.classList.add('in'); }); });
    history.pushState({ msbShare:1 }, ''); pushed = true;

    var sheet = el.querySelector('.ms-sheet');
    el.addEventListener('click', function(e){
      if(e.target === el){ close(); return; }
      var b = e.target.closest('[data-s]'); if(!b) return;
      e.stopPropagation();
      act(b.getAttribute('data-s'), url, text, b);
    });
    // drag down to dismiss (only when the sheet is scrolled to the top)
    var y0 = null, dy = 0;
    sheet.addEventListener('touchstart', function(e){
      if(sheet.scrollTop > 0 || e.target.closest('input')) return;
      y0 = e.touches[0].clientY; dy = 0; sheet.classList.add('drag');
    }, { passive:true });
    sheet.addEventListener('touchmove', function(e){
      if(y0 == null) return; dy = Math.max(0, e.touches[0].clientY - y0); sheet.style.transform = 'translateY('+dy+'px)';
    }, { passive:true });
    sheet.addEventListener('touchend', function(){
      if(y0 == null) return; y0 = null; sheet.classList.remove('drag');
      if(dy > 90) close(); else sheet.style.transform = '';
    });
  }

  function hide(){
    isOpen = false;
    var node = el; el = null; cur = null;
    document.body.style.overflow = prevOv;
    if(!node) return;
    node.classList.remove('in'); setTimeout(function(){ node.remove(); }, 260);
  }
  function close(){
    if(!isOpen) return;
    if(pushed){ pushed = false; history.back(); }    // popstate -> hide()
    else hide();
  }

  function act(kind, url, text, btn){
    var o = cur || {};
    var u = encodeURIComponent(url), t = encodeURIComponent(text + ' — MindShift Books');
    if(kind === 'image'){ var fn = o.onImage; close(); setTimeout(function(){ try{ fn && fn(); }catch(_){} }, 300); return; }
    try{ o.onShare && o.onShare(kind); }catch(_){}
    if(kind === 'native'){
      navigator.share({ title:o.title || 'MindShift Books', text:text, url:url }).then(close).catch(function(){});
      return;
    }
    if(kind === 'copy'){
      var done = function(){
        var cb = el && el.querySelector('.ms-link button'); if(cb){ cb.textContent = 'Copied ✓'; cb.classList.add('ok'); }
        var lbl = btn && btn.querySelector && btn.querySelector('em'); if(lbl) lbl.textContent = 'Copied ✓';
        setTimeout(close, 850);
      };
      if(navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(url).then(done).catch(fallback);
      else fallback();
      function fallback(){
        var inp = el && el.querySelector('input'); if(!inp) return;
        inp.select(); inp.setSelectionRange(0, 9999);
        try{ document.execCommand('copy') ? done() : (inp.focus()); }catch(_){}
      }
      return;
    }
    var link = {
      whatsapp:'https://wa.me/?text=' + t + '%20' + u,
      telegram:'https://t.me/share/url?url=' + u + '&text=' + t,
      x:'https://twitter.com/intent/tweet?text=' + t + '&url=' + u,
      facebook:'https://www.facebook.com/sharer/sharer.php?u=' + u,
      linkedin:'https://www.linkedin.com/sharing/share-offsite/?url=' + u,
      email:'mailto:?subject=' + encodeURIComponent('MindShift Books') + '&body=' + t + '%0A' + u,
      sms:'sms:?body=' + t + '%20' + u
    }[kind];
    if(!link) return;
    if(kind === 'email' || kind === 'sms') location.href = link; else window.open(link, '_blank', 'noopener');
    close();
  }

  // Capture phase + registered early so we run BEFORE the reels / image viewer back-button handlers:
  // Back closes the drawer first and nothing underneath reacts to that same back press.
  window.addEventListener('popstate', function(){
    if(isOpen){
      pushed = false; hide();
      closedByPop = true; setTimeout(function(){ closedByPop = false; }, 0);
    }
  }, true);
  document.addEventListener('keydown', function(e){
    if(isOpen && e.key === 'Escape'){ e.stopImmediatePropagation(); close(); }
  });

  window.MSBShare = { open:open, close:close, isOpen:function(){ return isOpen; }, justClosed:function(){ return closedByPop; } };
})();
