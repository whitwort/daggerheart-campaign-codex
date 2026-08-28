// presence.js -- last-online heartbeat for the Admin > Manage Party Status
// column (admin.js). No presence backend exists (no Realtime Database), so
// "online" is approximated: stamp presence/{email}.lastOnline on attach and
// on every tab-foreground, plus a background heartbeat every 4 min while
// the tab stays open/focused. admin.js treats a stamp under 5 min old as
// "Online" -- comfortably wider than the heartbeat period so a client
// mid-interval doesn't flicker to stale.
//
// Lives in its own presence/{email} doc, NOT players/{email} (fixed Aug
// 2026 -- was originally on players/{email}.lastOnline). That put a
// high-frequency writer (every 4 min + every visibilitychange, and iOS
// Safari fires visibilitychange when a native <select> popup or the
// keyboard opens) on the same doc as role/activeCharacterId state, which
// auth.js's playerDocUnsub re-renders the whole app on. Every heartbeat
// was silently wiping the entity edit form mid-interaction for whoever's
// editing -- reported as "dropdown/textbox loses focus the moment you
// touch it," player-only because only players get a heartbeat. Splitting
// the doc removes the interaction entirely rather than special-casing
// around it.
//
// Player-only: GM has no players/ doc (role resolved via CONFIG.gmEmail,
// not the whitelist), so there's nothing to stamp for a GM session.
// Lifecycle mirrors connectivity.js -- attached post-auth once role
// resolves to 'player', detached on every auth change (detachDataListeners
// in auth.js), same "always tear down, never leave a stale timer running
// across sign-out/in" stance as every other listener in this app.

import {
  getFirestore, doc, setDoc, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import { firebaseApp } from './firebase.js';
import { state } from './state.js';

const db = getFirestore(firebaseApp);

const HEARTBEAT_MS = 4 * 60 * 1000;
let heartbeatTimer = null;

function stampOnline() {
  if (state.currentRole !== 'player') return;
  const email = state.currentUser && state.currentUser.email;
  if (!email) return;
  setDoc(doc(db, 'presence', email), { lastOnline: serverTimestamp() }, { merge: true })
    .catch(function (err) { console.error('presence heartbeat failed:', err.message); });
}

function onVisible() {
  if (document.visibilityState === 'visible') stampOnline();
}

function attachPresenceHeartbeat() {
  stampOnline(); // immediate stamp so "Online" is accurate right after sign-in
  if (heartbeatTimer) return; // idempotent, same guard style as listeners.js keys
  heartbeatTimer = setInterval(stampOnline, HEARTBEAT_MS);
  document.addEventListener('visibilitychange', onVisible);
}

function detachPresenceHeartbeat() {
  if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
  document.removeEventListener('visibilitychange', onVisible);
}

export { attachPresenceHeartbeat, detachPresenceHeartbeat };
