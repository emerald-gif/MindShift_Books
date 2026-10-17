/* share-to-chat.js — kept so older calls keep working. It no longer has its own sheet: it opens the one Share drawer
 * (share-drawer.js) with the people list on, so there is a single design and a single sending routine (share-core.js).
 *
 *   import('/share-to-chat.js').then(m => m.openShareToChat({ kind:'post'|'article', id, title, snippet, image, author, authorPhoto }));
 */
export function openShareToChat(item){
  item = item || {};
  const go = () => window.MSBShare.open({
    url: location.origin + (item.kind === 'article' ? '/article-read?id=' : '/post-read?id=') + encodeURIComponent(item.id || ''),
    title: item.title, text: item.title || item.snippet, author: item.author, thumb: item.image,
    chat: item
  });
  if(window.MSBShare) return go();
  const sc = document.createElement('script'); sc.src = '/share-drawer.js?v=2'; sc.onload = go; document.head.appendChild(sc);
}
if(typeof window !== 'undefined') window.openShareToChat = openShareToChat;
