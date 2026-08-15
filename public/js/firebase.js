import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import { initializeFirestore, persistentLocalCache, persistentSingleTabManager } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

export const CONFIG = window.APP_CONFIG;
export const firebaseApp = initializeApp(CONFIG.firebase);

// Force long-polling transport for Firestore realtime listeners.
// Safari — especially private browsing, especially iOS — buffers the
// default streaming Listen channel so snapshots sit undelivered
// (sometimes minutes) until the connection recycles, then arrive in a
// burst. Observed as: blank initial load in the player view, live
// updates that "sometimes happen, sometimes don't", everything fixed by
// reload. The SDK's auto-detection of this condition (default-on in
// v10) demonstrably missed here. Long-polling costs a little latency
// but is reliable across this group's iOS-heavy browsers.
// Must run before any module's getFirestore(firebaseApp) call —
// guaranteed by ES module eval order, since firebase.js is a dependency
// of every module that calls getFirestore.
//
// persistentLocalCache (Phase 13): IndexedDB-backed cache instead of the
// default memory-only cache. Buys us two things: (1) cached reads
// survive a reload while offline; (2) writes made offline queue in
// IndexedDB and flush automatically on reconnect instead of being lost
// on reload. persistentSingleTabManager is explicit (not the multi-tab
// manager) — single device/tab per session is Gregg's confirmed
// assumption; if that's ever violated (same device, two tabs), the
// second tab's persistence layer just fails to acquire the lock and
// that tab falls back to memory-only (SDK-internal, logged, not a
// thrown exception here). Wrapped in try/catch as a defensive fallback
// for environments with no IndexedDB support at all (some iOS
// private-browsing configurations) — degrades to memory-only cache
// rather than failing app init.
try {
  initializeFirestore(firebaseApp, {
    localCache: persistentLocalCache({ tabManager: persistentSingleTabManager() }),
    experimentalForceLongPolling: true
  });
} catch (err) {
  console.error('[firebase] persistentLocalCache init failed, falling back to memory cache:', err);
  if (window.__showDebugBanner) {
    window.__showDebugBanner('[firebase] offline persistence unavailable, falling back to memory-only cache: ' + (err && err.message ? err.message : err));
  }
  initializeFirestore(firebaseApp, {
    experimentalForceLongPolling: true
  });
}
