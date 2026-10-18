/* new-badge.js — the ONE date that decides how long the "New" pill shows beside Messages (sidebar AND the Messages screen header).
 * Change NEW_UNTIL here to extend or shorten it; both pills disappear together on their own. */
export const NEW_UNTIL = new Date('2026-10-30T00:00:00');   // local time
export const isNewActive = () => Date.now() < NEW_UNTIL.getTime();
/* the pill itself, so both places look identical */
export function makeNewPill(){
  const np = document.createElement('span');
  np.textContent = 'New';
  np.setAttribute('data-msb-new', '1');
  np.style.cssText = 'margin-left:8px;padding:2px 7px;border-radius:99px;background:#dbeafe;color:#1d4ed8;font-size:10.5px;font-weight:800;letter-spacing:.04em;text-transform:uppercase;line-height:1.5;flex-shrink:0;vertical-align:middle;white-space:nowrap';
  return np;
}
