// Shared Firestore resilience helpers (used by articles, article-read, post-read).
//
// Firestore reads can hang or fail with `unavailable` when a tab has been idle
// for a long time (dead websocket) or the network blips while navigating.
// resilient() gives every read: a timeout per attempt, retries with backoff,
// and a forced reconnect after the 2nd consecutive failure. Permanent errors
// (permission-denied, missing index, ...) are NOT retried.
//
//   import { createResilient } from '/resilient.js';
//   const { resilient, reconnectFirestore } = createResilient({ db, enableNetwork, disableNetwork });
//   const snap = await resilient(() => getDoc(doc(db, 'articles', id)));

const RETRYABLE_CODES = new Set([
  'unavailable', 'deadline-exceeded', 'resource-exhausted',
  'aborted', 'internal', 'unknown', 'cancelled'
]);

export function createResilient({ db, enableNetwork, disableNetwork }) {
  function withTimeout(promise, ms) {
    let timer;
    const timeout = new Promise((_, rej) => {
      timer = setTimeout(() => rej(Object.assign(new Error('timeout'), { code: 'deadline-exceeded' })), ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
  }

  let _reconnecting = null;
  function reconnectFirestore() {
    // Several callers can ask at once — share a single disable/enable cycle.
    if (!_reconnecting) {
      _reconnecting = (async () => {
        try { await disableNetwork(db); await enableNetwork(db); }
        catch (e) { console.warn('Firestore reconnect failed:', e && e.message); }
        finally { _reconnecting = null; }
      })();
    }
    return _reconnecting;
  }

  async function resilient(fn, { tries = 3, timeoutMs = 8000 } = {}) {
    let lastErr;
    for (let i = 0; i < tries; i++) {
      try { return await withTimeout(fn(), timeoutMs); }
      catch (e) {
        lastErr = e;
        const code = (e && e.code) || '';
        const retryable = !code || RETRYABLE_CODES.has(code);
        if (!retryable || i === tries - 1) break;
        if (i === 1) await reconnectFirestore(); // 2nd failure in a row = stale connection
        await new Promise(r => setTimeout(r, 500 * (i + 1)));
      }
    }
    throw lastErr;
  }

  return { resilient, withTimeout, reconnectFirestore };
}
