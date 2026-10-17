/* MindShift Books — ONE share drawer for the whole app (feed, reels, image viewer, post page, article page, profiles).
   MSBShare.open({
     url,            // link to share (default: current page)
     text, title,    // caption / headline — used for the preview and the shared message
     thumb, author,  // optional preview thumbnail + author line
     heading,        // optional drawer title (default "Share")
     onImage,        // optional fn — adds a "Share as image" tile
     onShare(kind),  // optional fn — called when the user picks any app / copy / 'chat' (for share counters)
   chat            // optional { kind:'post'|'article', id, title, snippet, image, author, authorPhoto }
                   //   -> turns on the people list (tick boxes + search of everyone) and the Send button.
                   //      Omit it (profiles, plain links) and the drawer stays the classic apps-only sheet.
   })
   Back button / Esc / tapping outside / dragging down all close it. Sits above every other layer. */
(function(){
  if(window.MSBShare) return;

  var css = `
#msbShare{position:fixed;inset:0;z-index:100010;background:rgba(15,23,42,.55);opacity:0;transition:opacity .22s;font-family:inherit;
  -webkit-tap-highlight-color:transparent}
#msbShare.in{opacity:1}
#msbShare .msd-sheet{position:absolute;left:0;right:0;bottom:0;max-width:520px;margin:0 auto;max-height:88vh;overflow-y:auto;background:#fff;color:#0f172a;
  border-radius:22px 22px 0 0;padding:8px 18px calc(max(18px,env(safe-area-inset-bottom)) + 6px);transform:translateY(100%);
  transition:transform .26s cubic-bezier(.2,.8,.2,1);box-shadow:0 -10px 40px rgba(0,0,0,.3);overscroll-behavior:contain}
#msbShare.in .msd-sheet{transform:translateY(0)}
#msbShare .msd-sheet.drag{transition:none}
#msbShare .msd-bar{width:40px;height:4px;border-radius:2px;background:#cbd5e1;margin:4px auto 10px}
#msbShare .msd-x{position:absolute;top:10px;right:12px;width:34px;height:34px;border:0;border-radius:50%;background:#f1f5f9;color:#475569;display:flex;align-items:center;justify-content:center;cursor:pointer;z-index:3;padding:0}
#msbShare .msd-x:active{background:#e2e8f0}
#msbShare .msd-x svg{width:16px;height:16px;fill:none;stroke:currentColor;stroke-width:2.6;stroke-linecap:round}
#msbShare .msd-hd{font-size:17px;font-weight:800;text-align:center;margin-bottom:12px}
#msbShare .msd-prev{display:flex;gap:11px;align-items:center;padding:10px;border:1px solid #e2e8f0;border-radius:14px;margin-bottom:16px;background:#f8fafc}
#msbShare .msd-prev img{width:46px;height:46px;border-radius:9px;object-fit:cover;background:linear-gradient(135deg,#4f46e5,#06b6d4);flex:none}
#msbShare .msd-prev div{min-width:0}
#msbShare .msd-prev b{display:block;font-size:13.5px;font-weight:800;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#msbShare .msd-prev span{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;font-size:12.5px;color:#64748b;line-height:1.35;margin-top:2px;word-break:break-word}
#msbShare .msd-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:16px 6px}
#msbShare .msd-app{background:none;border:none;display:flex;flex-direction:column;align-items:center;gap:7px;font-family:inherit;font-size:12px;font-weight:700;color:#334155;cursor:pointer;padding:0}
#msbShare .msd-app i{width:54px;height:54px;border-radius:50%;display:flex;align-items:center;justify-content:center;transition:transform .12s}
#msbShare .msd-app:active i{transform:scale(.9)}
#msbShare .msd-app svg{width:26px;height:26px;fill:none;stroke:#fff;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
#msbShare .msd-link{display:flex;gap:8px;margin-top:18px;align-items:center;background:#f1f5f9;border-radius:12px;padding:6px 6px 6px 14px}
#msbShare .msd-link input{flex:1;min-width:0;border:none;background:none;font-size:13px;color:#475569;font-family:inherit;outline:none}
#msbShare .msd-link button{border:none;background:#4f46e5;color:#fff;font-weight:800;font-size:13px;padding:9px 16px;border-radius:9px;cursor:pointer;font-family:inherit;white-space:nowrap}
#msbShare .msd-link button.ok{background:#16a34a}

#msbShare .msd-sheet.chat{display:flex;flex-direction:column;height:min(88vh,700px);max-height:88vh;overflow:hidden;padding:8px 0 0}
#msbShare .chat .msd-bar,#msbShare .chat .msd-hd{flex:none}
#msbShare .chat .msd-hd{margin-bottom:8px}
#msbShare .msd-srch{flex:none;margin:0 16px 6px}
#msbShare .msd-srch input{width:100%;height:42px;border-radius:21px;border:1.5px solid transparent;background:#f1f5f9;padding:0 16px;font:inherit;font-size:16px;outline:0;color:inherit}
#msbShare .msd-srch input:focus{background:#fff;border-color:#a5b4fc}
#msbShare .msd-list{flex:1;min-height:0;overflow-y:auto;padding:2px 8px 6px;overscroll-behavior:contain}
#msbShare .msd-gh{font-size:12.5px;font-weight:700;color:#64748b;padding:10px 12px 4px}
#msbShare .msd-row{display:flex;align-items:center;gap:12px;width:100%;padding:8px 10px;border-radius:14px;text-align:left;background:none;border:0;font:inherit;color:inherit;cursor:pointer}
#msbShare .msd-row:active{background:#f4f5fa}
#msbShare .msd-av{width:44px;height:44px;border-radius:50%;object-fit:cover;flex:none;display:flex;align-items:center;justify-content:center;font-weight:800;color:#fff;font-size:16px;background:linear-gradient(135deg,#6366f1,#06b6d4)}
#msbShare .msd-nm{flex:1;min-width:0}
#msbShare .msd-nm b{display:block;font-size:15px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#msbShare .msd-nm small{display:block;font-size:12.5px;color:#64748b}
#msbShare .msd-ck{width:24px;height:24px;border-radius:50%;border:2px solid #cbd0dc;flex:none;display:flex;align-items:center;justify-content:center;transition:all .12s}
#msbShare .msd-row.on .msd-ck{background:#4f46e5;border-color:#4f46e5}
#msbShare .msd-row.on .msd-ck::after{content:'';width:6px;height:11px;border:solid #fff;border-width:0 2.5px 2.5px 0;transform:rotate(45deg) translate(-1px,-1px)}
#msbShare .msd-empty{padding:30px 24px;text-align:center;color:#64748b;font-size:14.5px;line-height:1.5}
#msbShare .msd-empty a{color:#4f46e5;font-weight:800}
#msbShare .msd-sk{height:58px;margin:6px 10px;border-radius:14px;background:linear-gradient(90deg,#f1f5f9,#e8ebf4,#f1f5f9);background-size:200% 100%;animation:msdSk 1.2s infinite}
@keyframes msdSk{to{background-position:-200% 0}}
#msbShare .msd-send{flex:none;display:none;gap:10px;align-items:center;padding:10px 14px;border-top:1px solid #eceef5;background:#fff}
#msbShare .msd-send.on{display:flex}
#msbShare .msd-send input{flex:1;min-width:0;height:44px;border-radius:22px;border:1.5px solid transparent;background:#f1f5f9;padding:0 16px;font:inherit;font-size:16px;outline:0;color:inherit}
#msbShare .msd-send input:focus{background:#fff;border-color:#a5b4fc}
#msbShare .msd-send button{height:44px;padding:0 22px;border:0;border-radius:22px;background:linear-gradient(135deg,#4f46e5,#06b6d4);color:#fff;font:inherit;font-weight:800;font-size:15px;white-space:nowrap;cursor:pointer}
#msbShare .msd-send button:disabled{opacity:.5}
#msbShare .msd-apps{flex:none;display:flex;gap:14px;overflow-x:auto;padding:12px 16px calc(max(12px,env(safe-area-inset-bottom)) + 4px);border-top:1px solid #eceef5;background:#fff;-webkit-overflow-scrolling:touch;scrollbar-width:none}
#msbShare .msd-apps::-webkit-scrollbar{display:none}
#msbShare .msd-apps .msd-app{flex:none;width:62px}
#msbShare .msd-apps .msd-app i{width:48px;height:48px}
#msbShare .msd-apps .msd-app svg{width:23px;height:23px}
#msbShare .msd-url{position:absolute;opacity:0;pointer-events:none;width:1px;height:1px;left:-9999px}
#msbShare .msd-toast{position:absolute;left:50%;bottom:calc(30px + env(safe-area-inset-bottom));transform:translateX(-50%);background:#0f172a;color:#fff;padding:11px 18px;border-radius:99px;font-weight:600;font-size:14px;max-width:88vw;text-align:center;z-index:2}
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
    var chatOn = !!(o.chat && o.chat.id);
    var appsRow = order.map(function(k){ var a = APPS[k];
        return '<button type="button" class="msd-app" data-s="'+k+'"><i style="background:'+a.bg+'">'+a.svg+'</i><em style="font-style:normal">'+a.label+'</em></button>'; }).join('');
    if(chatOn){
      var cc = o.chat;
      el.innerHTML = '<div class="msd-sheet chat" role="dialog" aria-label="Share"><div class="msd-bar"></div>'+
        '<div class="msd-hd">'+esc(o.heading || 'Share')+'</div>'+
        '<div class="msd-srch"><input type="search" placeholder="Search anyone on MindShift" aria-label="Search people" autocomplete="off"></div>'+
        '<div class="msd-list"><div class="msd-sk"></div><div class="msd-sk"></div><div class="msd-sk"></div></div>'+
        '<div class="msd-send"><input type="text" maxlength="400" placeholder="Add a message (optional)" aria-label="Add a message"><button type="button" class="msd-sendbtn">Send</button></div>'+
        '<div class="msd-apps">'+appsRow+'</div>'+
        '<input class="msd-url" readonly tabindex="-1" aria-hidden="true" value="'+esc(url)+'"></div>';
      document.body.appendChild(el);
      chatInit(el, o);
    } else
    el.innerHTML = '<div class="msd-sheet" role="dialog" aria-label="Share"><div class="msd-bar"></div>'+
      '<div class="msd-hd">'+esc(o.heading || 'Share')+'</div>'+
      '<div class="msd-prev">'+(o.thumb ? '<img src="'+esc(o.thumb)+'" alt="" onerror="this.removeAttribute(\'src\')">' : '')+
        '<div>'+(o.author ? '<b>'+esc(o.author)+'</b>' : '')+'<span>'+esc(text)+'</span></div></div>'+
      '<div class="msd-grid">'+order.map(function(k){ var a = APPS[k];
        return '<button type="button" class="msd-app" data-s="'+k+'"><i style="background:'+a.bg+'">'+a.svg+'</i><em style="font-style:normal">'+a.label+'</em></button>'; }).join('')+'</div>'+
      '<div class="msd-link"><input readonly value="'+esc(url)+'"><button type="button" data-s="copy">Copy</button></div></div>';
    if(!chatOn) document.body.appendChild(el);
    prevOv = document.body.style.overflow; document.body.style.overflow = 'hidden';
    isOpen = true;
    requestAnimationFrame(function(){ requestAnimationFrame(function(){ el && el.classList.add('in'); }); });
    history.pushState({ msbShare:1 }, ''); pushed = true;

    var sheet = el.querySelector('.msd-sheet');
    var xb = document.createElement('button'); xb.type = 'button'; xb.className = 'msd-x'; xb.setAttribute('data-x', '1'); xb.setAttribute('aria-label', 'Close');
    xb.innerHTML = '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>'; sheet.appendChild(xb);
    el.addEventListener('click', function(e){
      if(e.target === el || e.target.closest('[data-x]')){ close(); return; }
      var b = e.target.closest('[data-s]'); if(!b) return;
      e.stopPropagation();
      act(b.getAttribute('data-s'), url, text, b);
    });
    // drag down to dismiss (only when the sheet is scrolled to the top)
    var y0 = null, dy = 0;
    sheet.addEventListener('touchstart', function(e){
      if(sheet.scrollTop > 0 || e.target.closest('input')) return;
      if(sheet.classList.contains('chat') && !e.target.closest('.msd-bar,.msd-hd')) return;   // chat layout: its list scrolls inside, so only the handle / title drags
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

  function chatInit(root, o){
    var c = o.chat, sheet = root.querySelector('.msd-sheet');
    var list = root.querySelector('.msd-list'), search = root.querySelector('.msd-srch input');
    var sendBar = root.querySelector('.msd-send'), note = sendBar.querySelector('input'), sendBtn = sendBar.querySelector('button');
    var picked = new Map(), base = [], found = [], sending = false, seq = 0, timer = 0, signedIn = true, loading = true, searching = false;
    var corePromise = import('/share-core.js');
    var MAX = 10;

    function say(t){
      var d = document.createElement('div'); d.className = 'msd-toast'; d.textContent = t; sheet.appendChild(d);
      setTimeout(function(){ d.remove(); }, 2600);
    }
    function paintBtn(){
      sendBar.classList.toggle('on', picked.size > 0);
      sendBtn.disabled = sending || !picked.size;
      sendBtn.textContent = sending ? 'Sending…' : picked.size > 1 ? 'Send to ' + picked.size : 'Send';
    }
    function row(p){
      var av = p.photo ? '<img class="msd-av" src="'+esc(p.photo)+'" alt="" referrerpolicy="no-referrer" onerror="this.outerHTML=\'<span class=msd-av>'+esc((p.name||'?').trim().charAt(0).toUpperCase())+'</span>\'">'
                       : '<span class="msd-av">'+esc((p.name||'?').trim().charAt(0).toUpperCase())+'</span>';
      return '<button type="button" class="msd-row'+(picked.has(p.uid)?' on':'')+'" data-uid="'+esc(p.uid)+'">'+av+
        '<span class="msd-nm"><b>'+esc(p.name || 'MindShift Books User')+'</b>'+(p.username ? '<small>@'+esc(p.username)+'</small>' : '')+'</span><span class="msd-ck"></span></button>';
    }
    function paint(){
      if(!signedIn){ list.innerHTML = '<div class="msd-empty">Log in to send this to people on MindShift Books.<br><br><a href="/signup?returnTo='+encodeURIComponent(location.pathname+location.search)+'">Log in or sign up</a><br><br>You can still share it with the apps below.</div>'; return; }
      if(loading){ return; }
      var q = search.value.trim().replace(/^@/, '').toLowerCase(), rows;
      if(q){
        var local = base.filter(function(p){ return (p.name+' '+(p.username||'')).toLowerCase().indexOf(q) > -1; });
        var have = {}; local.forEach(function(p){ have[p.uid] = 1; });
        rows = local.concat(found.filter(function(p){ return !have[p.uid]; }));
        if(!rows.length){ list.innerHTML = '<div class="msd-empty">'+(searching ? 'Searching…' : q.length < 2 ? 'Type at least 2 letters to search everyone.' : 'No one found for “'+esc(search.value.trim())+'”.')+'</div>'; return; }
      } else {
        rows = base;
        if(!rows.length){ list.innerHTML = '<div class="msd-empty">No chats yet.<br>Search for anyone above to send this to them.</div>'; return; }
      }
      var html = '', grp = '';
      rows.forEach(function(p){ if(p.group !== grp){ grp = p.group; html += '<div class="msd-gh">'+esc(grp)+'</div>'; } html += row(p); });
      list.innerHTML = html;
    }
    list.addEventListener('click', function(e){
      var b = e.target.closest('.msd-row'); if(!b || sending) return;
      var uid = b.getAttribute('data-uid');
      var p = base.concat(found).filter(function(x){ return x.uid === uid; })[0]; if(!p) return;
      if(picked.has(uid)) picked.delete(uid);
      else { if(picked.size >= MAX){ say('You can send to up to ' + MAX + ' people at once'); return; } picked.set(uid, p); }
      b.classList.toggle('on', picked.has(uid)); paintBtn();
    });
    search.addEventListener('input', function(){
      clearTimeout(timer);
      var q = search.value.trim().replace(/^@/, '');
      var my = ++seq;
      if(q.length < 2){ found = []; searching = false; paint(); return; }
      searching = true; paint();
      timer = setTimeout(function(){
        corePromise.then(function(core){ return core.searchPeople(q); }).then(function(r){
          if(my !== seq) return; found = r || []; searching = false; paint();
        }).catch(function(){ if(my !== seq) return; found = []; searching = false; paint(); });
      }, 320);
    });
    sendBtn.addEventListener('click', function(){
      if(sending || !picked.size) return;
      sending = true; paintBtn();
      var people = Array.from(picked.values());
      corePromise.then(function(core){ return core.sendCard(core.makeCard(c), people, note.value); }).then(function(r){
        sending = false;
        if(r.ok){
          try{ o.onShare && o.onShare('chat'); }catch(_){}
          var msg = !r.bad ? (r.ok === 1 ? 'Sent to ' + people[0].name : 'Sent to ' + r.ok + ' people') : 'Sent to ' + r.ok + ', but ' + r.bad + ' couldn’t be reached';
          close(); flash(msg);
        } else { paintBtn(); say('Couldn’t send. Check your connection and try again.'); }
      }).catch(function(){ sending = false; paintBtn(); say('Couldn’t send. Check your connection and try again.'); });
    });

    corePromise.then(function(core){ return core.currentUser().then(function(u){
      if(!u){ signedIn = false; loading = false; paint(); return; }
      return core.loadPeople().then(function(r){ base = r || []; loading = false; paint(); });
    }); }).catch(function(){ loading = false; paint(); });
    paintBtn();
  }
  /* small toast that outlives the drawer */
  function flash(t){
    var d = document.createElement('div');
    d.style.cssText = 'position:fixed;left:50%;bottom:calc(28px + env(safe-area-inset-bottom));transform:translateX(-50%);z-index:100020;background:#0f172a;color:#fff;padding:11px 18px;border-radius:99px;font:600 14px system-ui,sans-serif;max-width:88vw;text-align:center';
    d.textContent = t; document.body.appendChild(d); setTimeout(function(){ d.remove(); }, 2800);
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
        var cb = el && el.querySelector('.msd-link button'); if(cb){ cb.textContent = 'Copied ✓'; cb.classList.add('ok'); }
        var lbl = btn && btn.querySelector && btn.querySelector('em'); if(lbl) lbl.textContent = 'Copied ✓';
        setTimeout(close, 850);
      };
      if(navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(url).then(done).catch(fallback);
      else fallback();
      function fallback(){
        var inp = el && el.querySelector('.msd-url, .msd-link input'); if(!inp) return;
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
