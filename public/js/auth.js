import { CONFIG, firebaseApp } from './firebase.js';
import {
  getAuth, GoogleAuthProvider, GithubAuthProvider,
  signInWithPopup, signOut, onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import {
  getFirestore, doc, setDoc, serverTimestamp, onSnapshot
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import { state } from './state.js';
import { attachListener, detachListener, safeSnapshotHandler } from './listeners.js';
import { attachCodexListeners, detachCodexListeners, renderList, renderDetailForSelected } from './codex.js';
import { attachPinsListener, attachConfigListener, detachMapDataListeners } from './map.js';
import { attachAdminListeners, detachAdminListeners } from './admin.js';

export const auth = getAuth(firebaseApp);
const db = getFirestore(firebaseApp);

// DOM refs owned by other tabs/modules, needed here only for
// updateAccessUI's show/hide toggles.
const newEntryBtn = document.getElementById('codex-new-btn');
const mapGmControlsEl = document.getElementById('map-gm-controls');

    // --- Auth: signInWithPopup works here because this app is served from
    // Firebase Hosting on daggerheart-campaign-codex.web.app/.firebaseapp.com
    // — the same origin as authDomain. Under the old Apps Script hosting
    // (script.googleusercontent.com), this same call hit an unfixable origin
    // restriction — see auth-pivot-context.md for that postmortem, and the
    // separate Option A attempt (native Apps Script auth) that followed and
    // was abandoned when it turned out unable to force a sign-in prompt for
    // logged-out visitors. Auth-model overhaul (Aug 2026): Google + GitHub
    // now, Apple deliberately excluded (Sign in with Apple requires a paid
    // Apple Developer account). GitHub sign-in with no public email is a
    // known open edge case — punted for now, revisit if it happens; the
    // whitelist is keyed by email so such a user would just resolve to
    // 'viewer' and hit the login gate.
    const roleBadge = document.getElementById('role-badge');
    const userEmailEl = document.getElementById('user-email');
    const signInButtonsEl = document.getElementById('signin-buttons');
    const signOutBtn = document.getElementById('sign-out-btn');
    const loginGateEl = document.getElementById('login-gate');
    const mainAppEl = document.getElementById('main-app');
    const loginGateSignedOutEl = document.getElementById('login-gate-signed-out');
    const loginGateUnlistedEl = document.getElementById('login-gate-unlisted');
    const requestJoinBtn = document.getElementById('request-join-btn');
    const requestJoinStatusEl = document.getElementById('request-join-status');
    const adminTabBtn = document.getElementById('tab-btn-admin');

    function signInWith(providerFactory) {
      return function () {
        signInWithPopup(auth, providerFactory()).catch(function (err) {
          alert('Sign-in failed: ' + err.message);
        });
      };
    }

    document.getElementById('signin-google').addEventListener('click', signInWith(function () {
      return new GoogleAuthProvider();
    }));

    document.getElementById('signin-github').addEventListener('click', signInWith(function () {
      return new GithubAuthProvider();
    }));

    signOutBtn.addEventListener('click', function () {
      signOut(auth);
    });

    // --- Role resolution ---------------------------------------------------
    // GM: signed-in email matches CONFIG.gmEmail (checked once, static).
    // Player: signed-in email exists in players/{email} whitelist collection
    // — watched live via onSnapshot so a GM's accept/reject lands in this
    // user's UI immediately, no reload needed.
    // 'viewer': everyone else, unauthenticated OR authenticated-but-not-
    // whitelisted. Auth-model overhaul (Aug 2026): 'viewer' gets no app
    // access; the login-gate splits signed-out vs. signed-in-unlisted
    // (Phase 7a-4 join-request flow) via state.currentUser below.

    function detachLiveRoleListeners() {
      detachListener('playerDocUnsub');
      detachListener('joinRequestDocUnsub');
    }

    // No *Attached flag needed anymore: each attach*Listener call is
    // per-key idempotent via listeners.js.
    function attachDataListeners() {
      attachCodexListeners();
      attachPinsListener();
      attachConfigListener();
    }

    // Bugfix: attachDataListeners()/attachAdminListeners() only ever ran
    // once (guarded by their *Attached flags), but nothing ever detached
    // the underlying onSnapshot listeners on sign-out. Firestore kills a
    // listener permanently on a permission-denied error (e.g. from the
    // auth token disappearing) and never auto-retries it -- so signing
    // out then back in left every tab stuck on its last error state,
    // since the *Attached guard prevented ever resubscribing. Fix:
    // explicitly detach + reset the guard on every auth change, same
    // pattern as detachLiveRoleListeners() below.
    function detachDataListeners() {
      detachCodexListeners();
      detachMapDataListeners();
      detachAdminListeners();
    }

    function updateAccessUI(role) {
      state.currentRole = role;
      roleBadge.textContent = role;
      newEntryBtn.style.display = (role === 'gm') ? 'inline-block' : 'none';
      mapGmControlsEl.style.display = (role === 'gm') ? 'flex' : 'none';
      adminTabBtn.style.display = (role === 'gm') ? 'inline-block' : 'none';
      if (role === 'gm') attachAdminListeners();
      const hasAccess = (role === 'gm' || role === 'player');
      if (hasAccess) attachDataListeners();
      loginGateEl.style.display = hasAccess ? 'none' : 'block';
      mainAppEl.style.display = hasAccess ? 'block' : 'none';
      renderList();  // player-visibility filter depends on role
      renderDetailForSelected();
    }

    requestJoinBtn.addEventListener('click', function () {
      if (!state.currentUser || !state.currentUser.email) return;
      requestJoinBtn.disabled = true;
      setDoc(doc(db, 'joinRequests', state.currentUser.email), {
        email: state.currentUser.email,
        displayName: state.currentUser.displayName || '',
        provider: (state.currentUser.providerData[0] && state.currentUser.providerData[0].providerId) || '',
        requestedAt: serverTimestamp()
      }).catch(function (err) {
        requestJoinBtn.disabled = false;
        alert('Request failed: ' + err.message);
      });
      // No manual UI flip here — the state.joinRequestDocUnsub listener below
      // picks up the new doc and updates the button/status itself.
    });


    onAuthStateChanged(auth, function (user) {
      state.currentUser = user;
      detachLiveRoleListeners();
      detachDataListeners();

      if (user) {
        signInButtonsEl.style.display = 'none';
        signOutBtn.style.display = 'inline';
        userEmailEl.textContent = user.email || '(no email shared)';
      } else {
        signInButtonsEl.style.display = 'flex';
        signOutBtn.style.display = 'none';
        userEmailEl.textContent = '';
      }

      if (!user || !user.email) {
        loginGateSignedOutEl.style.display = 'block';
        loginGateUnlistedEl.style.display = 'none';
        updateAccessUI('viewer');
        return;
      }

      if (user.email === CONFIG.gmEmail) {
        updateAccessUI('gm');
        return;
      }

      // Signed in, not GM: candidate player. Live-listen on their own
      // players/{email} doc so a GM's Accept lands immediately, and on
      // their own joinRequests/{email} doc so Reject (doc deleted) flips
      // the UI back to the "Request to join" button without a reload.
      loginGateSignedOutEl.style.display = 'none';
      loginGateUnlistedEl.style.display = 'block';

      attachListener('playerDocUnsub', function () {
        return onSnapshot(doc(db, 'players', user.email), safeSnapshotHandler('playerDoc', function (snap) {
          updateAccessUI(snap.exists() ? 'player' : 'viewer');
        }), function (err) {
          console.error('players doc listener failed:', err.message);
        });
      });

      requestJoinBtn.disabled = true;
      attachListener('joinRequestDocUnsub', function () {
        return onSnapshot(doc(db, 'joinRequests', user.email), safeSnapshotHandler('joinRequestDoc', function (snap) {
          if (snap.exists()) {
            requestJoinBtn.style.display = 'none';
            requestJoinStatusEl.style.display = 'block';
          } else {
            requestJoinBtn.style.display = 'inline-block';
            requestJoinBtn.disabled = false;
            requestJoinStatusEl.style.display = 'none';
          }
        }), function (err) {
          console.error('joinRequest doc listener failed:', err.message);
        });
      });
    });

