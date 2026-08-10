import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import { initializeFirestore } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

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
initializeFirestore(firebaseApp, {
  experimentalForceLongPolling: true
});
