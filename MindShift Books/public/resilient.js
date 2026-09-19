// Shared Firestore resilience helpers (used across the site's pages).
//
// Firestore reads can hang or fail with `unavailable` when a tab has been idle
// for a long time (dead websocket) or the network blips while navigating.
//
//   retryRead(fn, opts)      timeout per attempt + retries with backoff. No
//                            Firestore handle needed — usable from any module.
//   createResilient({db,..}) same, plus a forced Firestore reconnect after the
//                            2nd consecutive failure (stale connection).
//
// Permanent errors (permission-denied, missing index, ...) are NOT retried.
//
//   import { createResilient } from '/resilient.js';
//   const { resilient, reconnectFirestore } = createResilient({ db, enableNetwork, disableNetwork });
//   const snap = await resilient(() => getDoc(doc(db, 'articles', id)));

const RETRYABLE_CODES = new Set([
  'unavailable', 'deadline-exceeded', 'resource-exhausted',
  'aborted', 'internal', 'unknown', 'cancelled'
]);

// True for network-type failures (worth retrying / worth telling the user to
// try again), false for permanent ones (permission-denied, failed-precondition…).
export function isTransient(e) {
  const code = (e && e.code) || '';
  return !code || RETRYABLE_CODES.has(code);
}

export function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, rej) => {
    timer = setTimeout(() => rej(Object.assign(new Error('timeout'), { code: 'deadline-exceeded' })), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export async function retryRead(fn, { tries = 3, timeoutMs = 8000, onSecondFailure } = {}) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try { return await withTimeout(fn(), timeoutMs); }
    catch (e) {
      lastErr = e;
      if (!isTransient(e) || i === tries - 1) break;
      if (i === 1 && onSecondFailure) { try { await onSecondFailure(); } catch (_) {} }
      await new Promise(r => setTimeout(r, 500 * (i + 1)));
    }
  }
  throw lastErr;
}

export function createResilient({ db, enableNetwork, disableNetwork }) {
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

  const resilient = (fn, opts = {}) => retryRead(fn, { ...opts, onSecondFailure: reconnectFirestore });

  return { resilient, withTimeout, reconnectFirestore, isTransient };
}
