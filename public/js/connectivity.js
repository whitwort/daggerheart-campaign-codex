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

// Pending-write counter: separate from (but paired with) the visual
// flashPendingWrite above. Every New/Edit save handler in this app
// closes its edit UI optimistically, synchronously, right after
// initiating the write -- NOT gated on the write Promise resolving
// (the offline-duplicate-save fix, Phase 13). That's correct for the
// edit UI, but it means "no edit form is open" stopped being a
// reliable signal for "safe to reload": version.js's dev auto-reload
// was checking only the former, so a reload landing in the window
// between "Save clicked, form closed" and "write actually reached
// Firestore" could tear down the page mid-request -- worse than a
// merely-annoying reload, this one could genuinely lose the edit.
// trackWrite() wraps a write promise so version.js has a real signal
// for "a write is still in flight" to check instead/as well.
let pendingWriteCount = 0;
function hasPendingWrites() { return pendingWriteCount > 0; }
function trackWrite(promise, label) {
  pendingWriteCount++;
  flashPendingWrite(label);
  const settle = function () { pendingWriteCount = Math.max(0, pendingWriteCount - 1); };
  promise.then(settle, settle);
  return promise;
}

export { attachConnectivityListener, detachConnectivityListener, flashPendingWrite, hasPendingWrites, trackWrite };
