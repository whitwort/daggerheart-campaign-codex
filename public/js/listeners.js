import { state } from './state.js';

// Centralized onSnapshot lifecycle (Aug 2026 refactor). The same invariant
// has been hand-maintained — and broken — three separate times across this
// codebase's history (see auth.js and map.js comments):
//   1. Never attach a listener before the caller has confirmed the current
//      role authorizes it — Firestore permanently kills a listener on
//      permission-denied and never auto-retries.
//   2. Detach on every auth change, and null the stored unsub so a later
//      attach can resubscribe (a stale truthy guard blocks resubscription
//      forever).
//   3. Attach must be idempotent — double-subscribing duplicates reads and
//      leaks the first unsub.
// This helper mechanizes 2 and 3 (1 remains the caller's judgment call).
// The per-map image listener (state.mapImageUnsub) deliberately does NOT
// use this helper: its attach/teardown is interleaved with the loadMap()
// race guard (state.loadingMapId) and cache-vs-live rendering logic, and
// hiding that behind the generic helper would obscure it.

// subscribe(onError): returns an unsubscribe function (i.e. wrap the
// onSnapshot(...) call), passing `onError` as onSnapshot's error
// callback. Not called at all if a listener is already attached under
// this key.
//
// onError (Sep 2026 -- Gregg's "Delete stopped working / lore edits
// discarded, but a reload shows both actually happened"): Firestore
// cancels a listener for good the moment its error callback fires --
// any stream error, not just permission-denied; a token-refresh hiccup
// after an iPad has slept is enough. Every call site used to just
// console.error there, so `state[key]` kept a truthy reference to a
// dead subscription and this helper's idempotency guard then refused
// to ever re-attach it: writes kept succeeding (they fetch a fresh
// token on demand) while the UI silently stopped reflecting them for
// the rest of the session. onError nulls the guard and resubscribes
// with capped exponential backoff (1s, 2s, ... 30s); detachListener
// cancels any pending retry so a logged-out/role-changed session can't
// resurrect a listener it no longer has rights to (invariant 1 above
// still holds: the retry re-runs the caller's own subscribe, under the
// same role gating the original attach ran under).
const retryTimers = {};
const retryCounts = {};

function clearRetry(stateKey) {
  if (retryTimers[stateKey]) {
    clearTimeout(retryTimers[stateKey]);
    retryTimers[stateKey] = null;
  }
}

function attachListener(stateKey, subscribe) {
  if (state[stateKey]) return;
  clearRetry(stateKey);
  function onError(err) {
    const code = err && err.code ? ' (' + err.code + ')' : '';
    console.error('[' + stateKey + '] listener error' + code + ':', err && err.message ? err.message : err);
    if (window.__showDebugBanner) {
      window.__showDebugBanner('[' + stateKey + '] listener error' + code + ': ' +
        (err && err.message ? err.message : err) + ' -- resubscribing');
    }
    state[stateKey] = null;                       // the SDK already cancelled it
    const n = (retryCounts[stateKey] || 0) + 1;
    retryCounts[stateKey] = n;
    const delayMs = Math.min(30000, 1000 * Math.pow(2, n - 1));
    clearRetry(stateKey);
    retryTimers[stateKey] = setTimeout(function () {
      retryTimers[stateKey] = null;
      attachListener(stateKey, subscribe);
    }, delayMs);
  }
  state[stateKey] = subscribe(onError);
}

function detachListener(stateKey) {
  clearRetry(stateKey);
  retryCounts[stateKey] = 0;
  if (state[stateKey]) {
    state[stateKey]();
    state[stateKey] = null;
  }
}

// Wrap a snapshot callback so an exception in render code cannot
// propagate into the Firestore SDK's async queue. An uncaught throw
// inside an onSnapshot observer permanently wedges the SDK client —
// EVERY listener silently stops delivering events until page reload,
// while state already holds the update that was being processed. That's
// exactly the observed failure: live updates freeze everywhere, but
// clicking (which re-renders from state) or reloading shows correct
// data. Errors are surfaced on the in-page debug banner (no devtools on
// iOS) instead of killing the client.
function safeSnapshotHandler(name, fn) {
  return function () {
    try {
      return fn.apply(null, arguments);
    } catch (err) {
      console.error('[' + name + '] snapshot handler error:', err);
      if (window.__showDebugBanner) {
        window.__showDebugBanner('[' + name + '] snapshot handler error: ' +
          (err && err.message ? err.message : err) +
          (err && err.stack ? '\n' + err.stack.split('\n').slice(0, 3).join('\n') : ''));
      }
    }
  };
}

export { attachListener, detachListener, safeSnapshotHandler };
