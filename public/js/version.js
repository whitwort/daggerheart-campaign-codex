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
 *               back to the banner instead).
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
import { attachListener, detachListener, safeSnapshotHandler } from './listeners.js';

const db = getFirestore(firebaseApp);

const AUTO_RELOAD_KEY = 'versionAutoReloadedFor';

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

function handleRemoteHash(remoteHash) {
  const local = localBuildHash();
  if (!local || !remoteHash) return;
  if (remoteHash === local) {
    // Up to date (e.g. banner was showing, then user reloaded some other
    // way, or the doc was rewritten with our own hash). Clear guard.
    try { sessionStorage.removeItem(AUTO_RELOAD_KEY); } catch (e) { /* private mode */ }
    hideUpdateBanner(false);
    return;
  }
  if (isDevProject()) {
    let already = null;
    try { already = sessionStorage.getItem(AUTO_RELOAD_KEY); } catch (e) { /* private mode */ }
    if (already !== remoteHash) {
      try { sessionStorage.setItem(AUTO_RELOAD_KEY, remoteHash); } catch (e) { /* private mode */ }
      location.reload();
      return;
    }
    // Already auto-reloaded once for this hash and we're still stale
    // (likely CDN edge lag) — don't loop; degrade to the banner.
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
