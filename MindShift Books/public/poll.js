/* MindShift Books — polls (display + voting), shared by the feed, profiles and the post page.
   A poll lives on the post doc:  posts/{id}.poll = { options:[{text}], endsAt:<ms>, days }
   Votes:   pollVotes/{postId}_{uid} = { postId, uid, option, createdAt }   (one per person, can't change)
   Counts:  pollCounts/{postId}      = { counts:[n0,n1,..], total }          (updated in the same transaction as the vote)

   Pages call  MSBPoll.init({ db, doc, getDoc, runTransaction, serverTimestamp, getUser, openAuth, toast })  once,
   and put  MSBPoll.html(post)  inside the post card. Polls are filled in automatically wherever they appear
   (a MutationObserver finds new .msb-poll blocks), so feed re-renders / infinite scroll just work. */
(function(){
  if(window.MSBPoll) return;
  var css = `
.msb-poll{margin-top:12px;cursor:default}
.mp-opt{display:block;width:100%;text-align:left;margin:0 0 8px;padding:11px 14px;border:1.5px solid var(--border2,#e2e8f0);border-radius:12px;background:#fff;
  color:var(--txt,#0f172a);font-size:14px;font-weight:600;font-family:inherit;cursor:pointer;line-height:1.3;word-break:break-word;
  transition:background .15s,border-color .15s,transform .1s;-webkit-tap-highlight-color:transparent}
.mp-opt:hover{border-color:var(--p,#4f46e5);background:#f5f7ff}
.mp-opt:active{transform:scale(.985)}
.mp-res{position:relative;display:flex;align-items:center;justify-content:space-between;gap:10px;margin:0 0 8px;padding:11px 14px;border:1.5px solid var(--border2,#e2e8f0);
  border-radius:12px;overflow:hidden;font-size:14px;font-weight:600;color:var(--txt,#0f172a);background:#fff}
.mp-bar{position:absolute;left:0;top:0;bottom:0;background:rgba(79,70,229,.1);transition:width .5s cubic-bezier(.2,.8,.2,1)}
.mp-res.lead .mp-bar{background:rgba(79,70,229,.2)}
.mp-res.lead{font-weight:800}
.mp-res.mine{border-color:var(--p,#4f46e5)}
.mp-t{position:relative;display:flex;align-items:center;gap:7px;min-width:0;word-break:break-word}
.mp-t svg{width:15px;height:15px;flex:none;fill:none;stroke:var(--p,#4f46e5);stroke-width:3;stroke-linecap:round;stroke-linejoin:round}
.mp-p{position:relative;flex:none;font-variant-numeric:tabular-nums}
.mp-foot{font-size:12.5px;color:var(--mute,#94a3b8);font-weight:600;margin-top:2px}
`;
  var st0 = document.createElement('style'); st0.textContent = css; document.head.appendChild(st0);

  var cfg = null, polls = {}, st = {}, userSeen = null, deb = null;
  var CHECK = '<svg viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"/></svg>';
  function esc(s){ return String(s==null?'':s).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];}); }
  function sum(a){ return a.reduce(function(x,y){ return x + (y||0); }, 0); }
  function fill(arr, n){ var a = (arr||[]).slice(0,n); while(a.length < n) a.push(0); return a; }
  function ended(p){ return !!(p && p.endsAt && Date.now() >= p.endsAt); }
  function timeLeft(ms){
    var d = ms - Date.now(); if(d <= 0) return 'Final results';
    var m = Math.ceil(d/60000); if(m < 60) return Math.max(1,m) + 'm left';     // round UP so a fresh 3-day poll says "3d", not "2d"
    var h = Math.ceil(d/3600000); if(h < 24) return h + 'h left';
    return Math.ceil(h/24) + 'd left';
  }
  function valid(p){ return !!(p && p.poll && Array.isArray(p.poll.options) && p.poll.options.length >= 2); }

  function body(id){
    var poll = polls[id]; if(!poll) return '';
    var n = poll.options.length, s = st[id] || { counts:fill([],n), total:0, myVote:null };
    var done = ended(poll), showRes = done || s.myVote != null;
    var max = Math.max.apply(null, s.counts.concat([0]));
    var rows = poll.options.map(function(o, i){
      if(!showRes) return '<button type="button" class="mp-opt" data-i="'+i+'">'+esc(o.text)+'</button>';
      var c = s.counts[i] || 0, pct = s.total ? Math.round(c / s.total * 100) : 0;
      return '<div class="mp-res'+(s.myVote===i?' mine':'')+(c===max && c>0?' lead':'')+'"><div class="mp-bar" style="width:'+pct+'%"></div>'+
        '<span class="mp-t">'+(s.myVote===i?CHECK:'')+esc(o.text)+'</span><span class="mp-p">'+pct+'%</span></div>';
    }).join('');
    var votes = s.total + ' vote' + (s.total===1?'':'s');
    var foot = showRes ? votes + ' \u00b7 ' + (poll.endsAt ? timeLeft(poll.endsAt) : '') : (poll.endsAt ? timeLeft(poll.endsAt) + ' \u00b7 tap an option to vote' : 'Tap an option to vote');
    return rows + '<div class="mp-foot">'+foot+'</div>';
  }
  function html(p){
    if(!valid(p)) return '';
    polls[p.id] = p.poll;
    return '<div class="msb-poll" data-id="'+esc(p.id)+'" onclick="event.stopPropagation()">'+body(p.id)+'</div>';
  }
  function refresh(id){
    var sel = '.msb-poll[data-id="'+(window.CSS && CSS.escape ? CSS.escape(id) : id)+'"]';
    document.querySelectorAll(sel).forEach(function(el){ el.innerHTML = body(id); });
  }

  async function load(id){
    var poll = polls[id]; if(!poll || !cfg) return;
    var u = cfg.getUser(), n = poll.options.length;
    var r = await Promise.all([
      cfg.getDoc(cfg.doc(cfg.db,'pollCounts',id)).catch(function(){ return null; }),
      u ? cfg.getDoc(cfg.doc(cfg.db,'pollVotes',id+'_'+u.uid)).catch(function(){ return null; }) : null
    ]);
    var cs = r[0], vs = r[1];
    var counts = fill(cs && cs.exists() ? cs.data().counts : [], n);
    st[id] = { counts:counts, total: sum(counts), myVote: vs && vs.exists() ? vs.data().option : null };
  }

  async function vote(id, i){
    if(!cfg) return;
    var u = cfg.getUser(); if(!u){ cfg.openAuth(); return; }
    var poll = polls[id]; if(!poll || ended(poll)) return;
    var n = poll.options.length;
    var s = st[id] || (st[id] = { counts:fill([],n), total:0, myVote:null });
    if(s.myVote != null || s.busy) return;
    s.busy = true;
    var prev = { counts:s.counts.slice(), total:s.total, myVote:s.myVote };
    s.myVote = i; s.counts = fill(s.counts, n); s.counts[i]++; s.total = sum(s.counts);   // optimistic
    refresh(id);
    try{
      var res = await cfg.runTransaction(cfg.db, async function(tx){
        var vRef = cfg.doc(cfg.db,'pollVotes',id+'_'+u.uid), cRef = cfg.doc(cfg.db,'pollCounts',id);
        var v = await tx.get(vRef);
        if(v.exists()) return { existed:true };                     // already voted (other tab/device) — never double count
        var c = await tx.get(cRef);
        var counts = fill(c.exists() ? c.data().counts : [], n); counts[i] = (counts[i]||0) + 1;
        tx.set(vRef, { postId:id, uid:u.uid, option:i, createdAt:cfg.serverTimestamp() });
        tx.set(cRef, { counts:counts, total:sum(counts) });
        return { existed:false };
      });
      if(res.existed){ await load(id); refresh(id); }
    }catch(e){
      console.warn('poll vote failed:', e && (e.code || e.message));
      st[id] = { counts:prev.counts, total:prev.total, myVote:prev.myVote };
      refresh(id);
      if(cfg.toast) cfg.toast('Could not record your vote \u2014 try again');
    }
    st[id].busy = false;
  }

  function hydrate(){
    if(!cfg) return;
    document.querySelectorAll('.msb-poll:not([data-h])').forEach(function(el){
      el.setAttribute('data-h','1');
      var id = el.getAttribute('data-id'); if(!polls[id]) return;
      load(id).then(function(){ refresh(id); });
    });
  }

  function init(c){
    cfg = c; hydrate();
    new MutationObserver(function(){ clearTimeout(deb); deb = setTimeout(hydrate, 120); }).observe(document.body, { childList:true, subtree:true });
    // sign-in usually finishes after the first render: when it does, re-read "did I vote?" for every poll on screen
    var tries = 0, t = setInterval(function(){
      var u = cfg.getUser(), uid = u && u.uid;
      if(uid && uid !== userSeen){
        userSeen = uid; st = {};
        document.querySelectorAll('.msb-poll').forEach(function(el){ el.removeAttribute('data-h'); });
        hydrate();
      }
      if(uid || ++tries > 30) clearInterval(t);
    }, 1000);
  }

  // capture phase: the poll block stops clicks from reaching the post card, so listen before that
  document.addEventListener('click', function(e){
    var b = e.target.closest && e.target.closest('.mp-opt'); if(!b) return;
    var el = b.closest('.msb-poll'); if(!el) return;
    e.stopPropagation(); e.preventDefault();
    vote(el.getAttribute('data-id'), +b.getAttribute('data-i'));
  }, true);

  window.MSBPoll = { init:init, html:html, _t:{ body:body, vote:vote, load:load, st:function(){ return st; }, polls:polls, setCfg:function(c){ cfg = c; } } };
})();
