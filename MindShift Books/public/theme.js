/* ═══════════════════════════════════════════════════════════════════════
   MindShift Books — theme.js  (dark / light / system)
   Load as the FIRST script in <head>, as a plain blocking script, so the right theme is on <html>
   before the first paint (no white flash). Everything else is in /theme.css.

   The saved choice is 'system' | 'light' | 'dark' (default 'system' = follow the phone).
   Pages never need their own dark-mode code: they use the shared colour variables, and this file just
   flips   <html data-theme="dark|light">   and tells the browser (color-scheme + theme-color bar).

   API (for the Settings page and the sidebar):
     MSBTheme.get()        -> 'system' | 'light' | 'dark'   (what the person chose)
     MSBTheme.resolved()   -> 'light' | 'dark'              (what is actually showing)
     MSBTheme.set(choice)  -> saves, applies, and fires a 'msb-theme' event on window
   ═══════════════════════════════════════════════════════════════════════ */
(function () {
  var KEY = 'msb_theme';
  var BAR = { light: '#ffffff', dark: '#0a0d14' };
  var mq = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;

  function read() {
    try { var v = localStorage.getItem(KEY); return (v === 'light' || v === 'dark') ? v : 'system'; }
    catch (e) { return 'system'; }
  }
  function resolve(choice) {
    if (choice === 'light' || choice === 'dark') return choice;
    return (mq && mq.matches) ? 'dark' : 'light';
  }
  function apply() {
    var t = resolve(read());
    var root = document.documentElement;
    root.setAttribute('data-theme', t);
    root.style.colorScheme = t;                       // native inputs, scrollbars, overscroll
    var m = document.querySelector('meta[name="theme-color"]');
    if (!m) { m = document.createElement('meta'); m.name = 'theme-color'; document.head.appendChild(m); }
    m.setAttribute('content', BAR[t]);                // phone's top bar colour
    return t;
  }

  apply();

  // follow the phone while the choice is 'system'
  if (mq) {
    var onSys = function () { if (read() === 'system') { apply(); fire(); } };
    if (mq.addEventListener) mq.addEventListener('change', onSys); else if (mq.addListener) mq.addListener(onSys);
  }
  // another open tab changed it
  window.addEventListener('storage', function (e) { if (e.key === KEY) { apply(); fire(); } });

  function fire() {
    try { window.dispatchEvent(new CustomEvent('msb-theme', { detail: { choice: read(), resolved: resolve(read()) } })); } catch (e) {}
  }

  window.MSBTheme = {
    get: read,
    resolved: function () { return resolve(read()); },
    set: function (choice) {
      if (choice !== 'light' && choice !== 'dark') choice = 'system';
      try { if (choice === 'system') localStorage.removeItem(KEY); else localStorage.setItem(KEY, choice); } catch (e) {}
      apply(); fire();
    }
  };
})();
