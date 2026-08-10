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

// subscribe: a zero-arg function returning an unsubscribe function
// (i.e. wrap the onSnapshot(...) call). Not called at all if a listener
// is already attached under this key.
function attachListener(stateKey, subscribe) {
  if (state[stateKey]) return;
  state[stateKey] = subscribe();
}

function detachListener(stateKey) {
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
