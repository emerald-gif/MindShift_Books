/* Shared @mention display helper.
   msbLinkMentions(escapedHtml, mentions) turns @username into a profile link, but ONLY for
   usernames stored in the post's own `mentions` list (validated when the post was published) —
   so a random "@word" in a post never becomes a dead link. Pass text that is already HTML-escaped. */
(function(){
  if(!document.getElementById('msb-mention-css')){
    var st=document.createElement('style'); st.id='msb-mention-css';
    st.textContent='a.mention{color:#4f46e5;font-weight:700;text-decoration:none}a.mention:hover{text-decoration:underline}';
    document.head.appendChild(st);
  }
  window.msbLinkMentions=function(html, mentions){
    if(!html || !Array.isArray(mentions) || !mentions.length) return html;
    var ok={}; mentions.forEach(function(m){ if(m && m.username) ok[String(m.username).toLowerCase()]=1; });
    return String(html).replace(/(^|[^a-z0-9_])@([a-z0-9_]{3,20})(?![a-z0-9_])/gi, function(all,pre,h){
      var l=h.toLowerCase();
      return ok[l] ? pre+'<a class="mention" href="/profile/@'+l+'" onclick="event.stopPropagation()">@'+h+'</a>' : all;
    });
  };
})();
