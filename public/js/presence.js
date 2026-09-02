// presence.js -- last-online heartbeat for the Admin > Manage Party Status
// column (admin.js). No presence backend exists (no Realtime Database), so
// "online" is approximated: stamp presence/{email}.lastOnline on sign-in
// (auth.js calls stampPresenceNow when role resolves to player) and on
// every tab-foreground, plus a background heartbeat every 4 min while the
// tab stays open/focused. admin.js treats a stamp under 5 min old as
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
// Lifecycle (redesigned Sep 2026, after the "Never online" saga -- see
// HANDOFF item 5 of that era): the interval + visibilitychange listener
// are registered ONCE at module load and NEVER torn down. The old
// attach/detach lifecycle -- inherited from the "every listener tears
// down on auth change" convention -- was the design flaw behind two
// successive silent-failure patches: that convention exists because
// Firestore permanently kills an onSnapshot READ on a permission error,
// but a fire-and-forget WRITE has no such failure mode, so tying the
// heartbeat to auth-listener plumbing bought nothing and made every
// stamp depend on a fragile auth -> attach -> snapshot chain. Instead,
// stampOnline() self-guards (no-op unless a signed-in player), so a
// permanently-running timer is correct by construction: signed out or
// GM, it silently does nothing; the moment state says "player", the
// next tick/foreground/sign-in stamp works. No attach ordering, no
// teardown races, nothing to re-establish.
//
// Player-only: GM has no players/ doc (role resolved via CONFIG.gmEmail,
// not the whitelist), so there's nothing to stamp for a GM session.

import {
  getFirestore, doc, setDoc, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import { firebaseApp } from './firebase.js';
import { state } from './state.js';

const db = getFirestore(firebaseApp);

const HEARTBEAT_MS = 4 * 60 * 1000;

function stampOnline() {
  if (state.currentRole !== 'player') return;
  const email = state.currentUser && state.currentUser.email;
  if (!email) return;
  setDoc(doc(db, 'presence', email), { lastOnline: serverTimestamp() }, { merge: true })
    .catch(function (err) { console.error('presence heartbeat failed:', err.message); });
}

// Immediate stamp for auth.js to call when role resolves to 'player', so
// the GM sees "Online" right after a sign-in instead of up to one
// heartbeat period later. Fire-and-forget; self-guarded like every stamp.
function stampPresenceNow() {
  stampOnline();
}

// Registered once, for the life of the page (see lifecycle comment above).
setInterval(stampOnline, HEARTBEAT_MS);
document.addEventListener('visibilitychange', function () {
  if (document.visibilityState === 'visible') stampOnline();
});

export { stampPresenceNow };
