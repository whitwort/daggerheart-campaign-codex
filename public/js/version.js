/**
 * version.js — deploy-detection via the existing Firestore realtime
 * connection (no polling). CI writes _meta/version (deployed commit hash)
 * right after each successful hosting deploy; this module subscribes to
 * that one doc and compares against the hash baked into this page at
 * build time (window.BUILD_HASH, stamped by CI from __BUILD_HASH__).
 *
 * Dev project:  auto location.reload() as soon as a newer deploy lands —
 *               with a sessionStorage guard so a stale CDN edge can't
 *               cause a reload loop (one auto-reload attempt per remote
 *               hash; if the mismatch persists after that reload, fall
 *               back to the banner instead). DEFERRED, though, while
 *               there's an open edit form the reload would silently
 *               discard (unsaved typed content, not yet written to
 *               Firestore) — see hasUnsavedEditInProgress. Retries every
 *               few seconds until it's safe, showing the banner in the
 *               meantime so a manual reload is still available sooner.
 * Prod project: never auto-reload (players may be mid-session at the
 *               table); show a dismissible "reload to update" banner.
 *
 * Local/unstamped builds (BUILD_HASH still the literal placeholder):
 * version checking is disabled entirely.
 */

import {
  getFirestore, doc, onSnapshot
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import { firebaseApp } from './firebase.js';
import { state } from './state.js';
import { attachListener, detachListener, safeSnapshotHandler } from './listeners.js';
import { hasPendingWrites } from './connectivity.js';

const db = getFirestore(firebaseApp);

const AUTO_RELOAD_KEY = 'versionAutoReloadedFor';
const RETRY_INTERVAL_MS = 4000;

// Not exhaustive (doesn't cover every admin sub-field), but covers the
// places someone is likely to spend real time composing unsaved text —
// entity/lore edit forms, the pin panel, admin source/player renames,
// and any open modal dialog (New Entity, gallery upload, Set portrait/
// map) — which is what actually matters for "don't discard a GM's
// in-progress data cleanup work" rather than trying to enumerate every
// possible open control app-wide.
function hasUnsavedEditInProgress() {
  // A write already in flight is the more important of the two checks --
  // even with no edit form open (Save just closed it optimistically),
  // reloading here could abort the network request before it reaches
  // Firestore. See connectivity.js's trackWrite comment.
  if (hasPendingWrites()) return true;
  if (state.detailEditMode) return true;
  if (state.loreEdit) return true;
  if (state.pinDraft) return true;
  if (state.adminSourceEditId) return true;
  if (state.adminPlayerEditId) return true;
  if (document.querySelector('.modal-overlay.open')) return true;
  if (document.querySelector('.portrait-picker-panel')) return true;
  return false;
}

function localBuildHash() {
  const h = window.BUILD_HASH;
  if (!h || h.indexOf('__') === 0) return null; // unstamped local build
  return h;
}

function isDevProject() {
  return !!(window.FIREBASE_ENV &&
    window.FIREBASE_ENV.projectId === 'daggerheart-campaign-codex-dev');
}

function showUpdateBanner() {
  const banner = document.getElementById('update-banner');
  if (!banner || banner.dataset.dismissed === '1') return;
  banner.style.display = 'flex';
}

function hideUpdateBanner(dismissed) {
  const banner = document.getElementById('update-banner');
  if (!banner) return;
  banner.style.display = 'none';
  if (dismissed) banner.dataset.dismissed = '1';
}

// State for the deferred-retry loop below.
let pendingDevReloadHash = null;
let retryTimer = null;

function performDevAutoReload(remoteHash) {
  let already = null;
  try { already = sessionStorage.getItem(AUTO_RELOAD_KEY); } catch (e) { /* private mode */ }
  if (already !== remoteHash) {
    try { sessionStorage.setItem(AUTO_RELOAD_KEY, remoteHash); } catch (e) { /* private mode */ }
    location.reload();
    return;
  }
  // Already auto-reloaded once for this hash and we're still stale
  // (likely CDN edge lag) — don't loop; degrade to the banner.
  showUpdateBanner();
}

function stopRetryLoop() {
  pendingDevReloadHash = null;
  if (retryTimer) {
    clearInterval(retryTimer);
    retryTimer = null;
  }
}

function tryDevAutoReload(remoteHash) {
  if (!hasUnsavedEditInProgress()) {
    stopRetryLoop();
    performDevAutoReload(remoteHash);
    return;
  }
  // An edit is in progress -- don't discard it. Show the banner (so a
  // manual reload is available the moment they're ready) and keep
  // re-checking until the edit closes.
  pendingDevReloadHash = remoteHash;
  showUpdateBanner();
  if (!retryTimer) {
    retryTimer = setInterval(function () {
      if (!pendingDevReloadHash) { stopRetryLoop(); return; }
      if (!hasUnsavedEditInProgress()) {
        const h = pendingDevReloadHash;
        stopRetryLoop();
        performDevAutoReload(h);
      }
    }, RETRY_INTERVAL_MS);
  }
}

function handleRemoteHash(remoteHash) {
  const local = localBuildHash();
  if (!local || !remoteHash) return;
  if (remoteHash === local) {
    // Up to date (e.g. banner was showing, then user reloaded some other
    // way, or the doc was rewritten with our own hash). Clear guards.
    try { sessionStorage.removeItem(AUTO_RELOAD_KEY); } catch (e) { /* private mode */ }
    stopRetryLoop();
    hideUpdateBanner(false);
    return;
  }
  if (isDevProject()) {
    tryDevAutoReload(remoteHash);
    return;
  }
  showUpdateBanner();
}

function attachVersionListener() {
  attachListener('versionUnsub', function () {
    return onSnapshot(doc(db, '_meta', 'version'),
      safeSnapshotHandler('version', function (snapshot) {
        const data = snapshot.data();
        handleRemoteHash(data && data.hash);
      }));
  });
}

function detachVersionListener() {
  detachListener('versionUnsub');
}

function initUpdateBanner() {
  const reloadBtn = document.getElementById('update-banner-reload');
  const dismissBtn = document.getElementById('update-banner-dismiss');
  if (reloadBtn) reloadBtn.addEventListener('click', function () { location.reload(); });
  if (dismissBtn) dismissBtn.addEventListener('click', function () { hideUpdateBanner(true); });
}

export { attachVersionListener, detachVersionListener, initUpdateBanner };
