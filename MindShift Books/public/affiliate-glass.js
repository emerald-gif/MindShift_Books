/* Affiliate ecosystem — large title that shrinks into the header on scroll (iOS pattern).
   Only runs on pages whose <body> has data-large-title (dashboard, payout).
   The header text next to the logo swaps from "MindShift Books" to the page's section name
   once the big title scrolls out of view, and back again when it returns. */
(function(){
  if(!document.body || !document.body.hasAttribute('data-large-title')) return;
  var brand=document.querySelector('header .brand'); if(!brand) return;
  var nameEl=brand.querySelector('.brand-name');
  if(!nameEl){
    // wrap the plain text node ("MindShift Books") so we can swap it
    var tn=null; brand.childNodes.forEach(function(n){ if(n.nodeType===3 && n.textContent.trim()) tn=n; });
    if(!tn) return;
    nameEl=document.createElement('span'); nameEl.className='brand-name'; nameEl.textContent=tn.textContent.trim();
    brand.replaceChild(nameEl,tn);
  }
  var original=nameEl.textContent, io=null, target=null, showing=false;
  function setText(t){
    if(nameEl.textContent===t) return;
    nameEl.classList.add('swap');
    setTimeout(function(){ nameEl.textContent=t; nameEl.classList.remove('swap'); },120);
  }
  function titleFor(hero){
    var eb=hero.querySelector('.eyebrow'); var t=eb?eb.textContent.trim():'';
    if(!t){ var h=hero.querySelector('h1'); t=h?h.textContent.trim():''; }
    return t||original;
  }
  function arm(){
    var hero=document.querySelector('.hero'); var h1=hero&&hero.querySelector('h1');
    if(!h1||h1===target) return;
    if(io) io.disconnect();
    target=h1; showing=false; setText(original);
    var hh=(document.querySelector('header')||{}).offsetHeight||64;
    io=new IntersectionObserver(function(entries){
      var e=entries[0]; var gone=!e.isIntersecting && e.boundingClientRect.top < hh;
      if(gone===showing) return; showing=gone;
      setText(gone?titleFor(hero):original);
    },{rootMargin:'-'+hh+'px 0px 0px 0px'});
    io.observe(h1);
  }
  arm();
  // the pages render their content after sign-in, so re-arm when the hero (re)appears
  var mo=new MutationObserver(function(){ arm(); });
  mo.observe(document.body,{childList:true,subtree:true});
})();
