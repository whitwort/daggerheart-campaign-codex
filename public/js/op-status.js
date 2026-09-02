// op-status.js -- broadcasts "a Restore/Import/Upload operation is
// running" to EVERY connected client (GM and players alike), so nobody
// tries to use the app while its data is mid-flight. Backed by a single
// well-known doc, opStatus/current (GM-write, any-signed-in-user-read --
// see firestore.rules).
//
// Two halves in one file since they share the doc shape:
//   - Writer side (beginOp/updateOp/endOp): called from the GM-only
//     operations that already report progress via a local log(line)
//     callback -- backup.js's restore/entry-restore/purge-images,
//     import.js's bulk import, srd-import.js's SRD import. Each call
//     already has its own inline Admin-tab status text; these calls
//     mirror the same line to the shared doc rather than replacing
//     anything.
//   - Listener side (attachOpStatusListener/detachOpStatusListener):
//     attached for ANY signed-in user right alongside
//     attachVersionListener() (auth.js) -- shows/hides a blocking modal
//     with the current label/progress/percent.
//
// Self-heal: if a client observes an active doc whose updatedAt is stale
// (GM's tab crashed/closed mid-operation, so nothing ever wrote
// active:false), the GM's OWN next session clears it on attach. Other
// clients just stop showing the dialog once it's cleared -- no one else
// is authorized to write the doc, and there's no reason to leave players
// staring at a dialog for an op that will never finish.

import {
  getFirestore, doc, setDoc, onSnapshot
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import { firebaseApp } from './firebase.js';
import { state } from './state.js';
import { attachListener, detachListener, safeSnapshotHandler } from './listeners.js';

const db = getFirestore(firebaseApp);
const opStatusRef = doc(db, 'opStatus', 'current');

const STALE_MS = 5 * 60 * 1000;

// --- Writer side (GM only -- callers are all GM-gated Admin actions) ----

// op: short machine key ('restore' | 'entry-restore' | 'purge-images' |
//   'import' | 'srd-import'), label: human-readable title shown in the
// dialog ("Restoring database…"). Resets progress/percent for a fresh run.
function beginOp(op, label) {
  return setDoc(opStatusRef, {
    active: true, op: op, label: label, progress: '', percent: null,
    startedAt: Date.now(), updatedAt: Date.now()
  }).catch(function () { /* best-effort broadcast; never block the op on it */ });
}

// text: latest status line (same text already going to the local log()).
// percent: 0-100 if computable this step, or null for indeterminate.
function updateOp(text, percent) {
  return setDoc(opStatusRef, {
    progress: text,
    percent: (typeof percent === 'number') ? percent : null,
    updatedAt: Date.now()
  }, { merge: true }).catch(function () { /* best-effort */ });
}

// finalText: last line shown briefly before clients hide the dialog.
function endOp(finalText) {
  return setDoc(opStatusRef, {
    active: false, progress: finalText || '', percent: null, updatedAt: Date.now()
  }, { merge: true }).catch(function () { /* best-effort */ });
}

// --- Listener side (any signed-in user) ----------------------------------

let dialogEls = null;

function ensureDialog() {
  if (dialogEls) return dialogEls;
  const overlay = document.createElement('div');
  overlay.id = 'op-status-overlay';
  overlay.className = 'modal-overlay';
  overlay.innerHTML =
    '<div class="modal-box op-status-box">' +
      '<h3 id="op-status-label"></h3>' +
      '<p id="op-status-progress" class="op-status-progress-text"></p>' +
      '<div class="op-status-bar-track">' +
        '<div id="op-status-bar-fill" class="op-status-bar-fill"></div>' +
      '</div>' +
      '<p class="op-status-hint">The app isn\u2019t usable until this finishes \u2014 hang tight.</p>' +
    '</div>';
  document.body.appendChild(overlay);
  dialogEls = {
    overlay: overlay,
    label: document.getElementById('op-status-label'),
    progress: document.getElementById('op-status-progress'),
    fill: document.getElementById('op-status-bar-fill')
  };
  return dialogEls;
}

function showDialog(data) {
  const els = ensureDialog();
  els.label.textContent = data.label || 'Working\u2026';
  els.progress.textContent = data.progress || '';
  if (typeof data.percent === 'number') {
    els.fill.classList.remove('op-status-bar-indeterminate');
    els.fill.style.width = Math.max(0, Math.min(100, data.percent)) + '%';
  } else {
    els.fill.classList.add('op-status-bar-indeterminate');
    els.fill.style.width = '';
  }
  els.overlay.classList.add('open');
}

function hideDialog() {
  if (dialogEls) dialogEls.overlay.classList.remove('open');
}

function attachOpStatusListener() {
  attachListener('opStatusUnsub', function () {
    return onSnapshot(opStatusRef, safeSnapshotHandler('opStatus', function (snap) {
      const data = snap.data();
      if (!data || !data.active) { hideDialog(); return; }

      const age = Date.now() - (data.updatedAt || 0);
      if (age > STALE_MS) {
        if (state.currentRole === 'gm') {
          endOp('(cleared automatically -- previous run appears to have been interrupted)');
        }
        hideDialog();
        return;
      }

      showDialog(data);
    }));
  });
}

function detachOpStatusListener() {
  detachListener('opStatusUnsub');
  hideDialog();
}

export { beginOp, updateOp, endOp, attachOpStatusListener, detachOpStatusListener };
