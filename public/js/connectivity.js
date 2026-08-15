/**
 * connectivity.js — Phase 13: online/offline/reconnecting status.
 *
 * Firestore's web SDK has no direct "am I connected" API. Two signals
 * are combined instead:
 *   1. navigator.onLine / window online-offline events — device-level
 *      network presence. Cheap, instant, but doesn't know whether
 *      Firestore itself is actually reachable (e.g. captive portal,
 *      corporate proxy blocking the Firestore domain).
 *   2. onSnapshot metadata.fromCache on the existing _meta/version doc
 *      (version.js already subscribes here for deploy-detection —
 *      reused rather than opening a second listener) — fromCache:true
 *      means this snapshot was served from local cache, not a live
 *      server round-trip, which is the actual "is Firestore live"
 *      signal. {includeMetadataChanges:true} is required or metadata-
 *      only transitions (cache -> live, with no data change) never
 *      fire a callback.
 *
 * Combined state: 'offline' (device offline) > 'reconnecting' (device
 * online, Firestore still serving from cache) > 'online' (live).
 * Deliberately not started until attachConnectivityListener() is
 * called post-auth (same access-gated lifecycle as every other
 * listener in listeners.js) — an unauthenticated pre-login screen has
 * nothing worth flagging as offline.
 */

import {
  getFirestore, doc, onSnapshot
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import { firebaseApp } from './firebase.js';
import { attachListener, detachListener, safeSnapshotHandler } from './listeners.js';

const db = getFirestore(firebaseApp);

let deviceOnline = navigator.onLine;
let firestoreFromCache = true; // pessimistic until the first snapshot arrives
let currentState = 'offline';

const statusEl = document.getElementById('connectivity-status');

function computeState() {
  if (!deviceOnline) return 'offline';
  if (firestoreFromCache) return 'reconnecting';
  return 'online';
}

function render() {
  if (!statusEl) return;
  if (currentState === 'online') {
    statusEl.style.display = 'none';
    return;
  }
  statusEl.style.display = '';
  statusEl.className = 'connectivity-pill connectivity-' + currentState;
  statusEl.textContent = currentState === 'offline'
    ? 'Offline — changes will sync when reconnected'
    : 'Reconnecting…';
}

function update() {
  const next = computeState();
  if (next === currentState) return;
  currentState = next;
  render();
}

window.addEventListener('online', function () { deviceOnline = true; update(); });
window.addEventListener('offline', function () { deviceOnline = false; update(); });

function attachConnectivityListener() {
  attachListener('connectivityUnsub', function () {
    return onSnapshot(doc(db, '_meta', 'version'), { includeMetadataChanges: true },
      safeSnapshotHandler('connectivity', function (snapshot) {
        firestoreFromCache = snapshot.metadata.fromCache;
        update();
      }));
  });
}

function detachConnectivityListener() {
  detachListener('connectivityUnsub');
  // No listener left to tell us — assume best-case rather than stuck
  // showing a stale "offline"/"reconnecting" pill through sign-out.
  firestoreFromCache = false;
  update();
}

// hasPendingWrites indicator (Phase 13 §B): call from a save action to
// show "Saving…" while a write is still local-only. Firestore resolves
// the returned promise once the write reaches the server OR is queued
// locally when offline — it does NOT wait for server ack when offline,
// so callers can't tell success from queued via the promise alone.
// This just centralizes the visual language; callers own when to call it.
function flashPendingWrite(label) {
  if (!statusEl || currentState === 'offline') return; // offline pill already covers it
  const prevText = statusEl.textContent;
  const prevDisplay = statusEl.style.display;
  const prevClass = statusEl.className;
  statusEl.style.display = '';
  statusEl.className = 'connectivity-pill connectivity-pending';
  statusEl.textContent = (label || 'Saving') + '…';
  setTimeout(function () {
    if (currentState === 'online') {
      statusEl.style.display = prevDisplay;
      statusEl.className = prevClass;
      statusEl.textContent = prevText;
    } else {
      render();
    }
  }, 1200);
}

export { attachConnectivityListener, detachConnectivityListener, flashPendingWrite };
