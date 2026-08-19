// Encounters tab (Phase 15, phase-15-encounter-workflow-design.md).
// GM-only builder/tracker over the `encounters` collection: one live view
// per encounter (build-time and play-time are the same surface — E1/§1),
// battle-point difficulty calculator ported from
// daggerheart-encounter-builder (§4), per-instance HP/Stress tracking.

import {
  getFirestore, doc, collection, addDoc, deleteDoc, updateDoc,
  onSnapshot, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import { firebaseApp } from './firebase.js';
import { state } from './state.js';
import { attachListener, detachListener, safeSnapshotHandler } from './listeners.js';
import { trackWrite } from './connectivity.js';

const db = getFirestore(firebaseApp);

const listEl = document.getElementById('encounters-list');
const detailEl = document.getElementById('encounters-detail-pane');
const newBtn = document.getElementById('encounters-new-btn');

// --- Listener lifecycle (GM-only; attach called from auth.js only in ---
// --- the GM branch, per listeners.js invariant 1) ----------------------

function attachEncountersListener() {
  attachListener('encountersUnsub', function () {
    return onSnapshot(collection(db, 'encounters'), safeSnapshotHandler('encounters', function (snapshot) {
      state.allEncounters = [];
      snapshot.forEach(function (docSnap) {
        state.allEncounters.push(Object.assign({ id: docSnap.id }, docSnap.data()));
      });
      renderEncountersTab();
    }), function (err) {
      console.error('encounters listener failed:', err.message);
    });
  });
}

function detachEncountersListener() {
  detachListener('encountersUnsub');
  state.allEncounters = [];
  state.encountersSelectedId = null;
}

// --- CRUD --------------------------------------------------------------

function createEncounter() {
  const data = {
    name: 'New encounter',
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
    partySize: 4,
    partyTier: 2,
    highDamage: false,
    environmentId: null,
    instances: []
  };
  trackWrite(addDoc(collection(db, 'encounters'), data), 'Creating encounter')
    .then(function (ref) { state.encountersSelectedId = ref.id; renderEncountersTab(); });
}

// Every mutation goes through here: partial field update + updatedAt
// bump (OI4 list ordering rides on updatedAt).
function updateEncounter(encId, fields) {
  const data = Object.assign({ updatedAt: serverTimestamp() }, fields);
  return trackWrite(updateDoc(doc(db, 'encounters', encId), data), 'Saving encounter');
}

function deleteEncounter(encId) {
  if (!window.confirm('Delete this encounter? This cannot be undone.')) return;
  if (state.encountersSelectedId === encId) state.encountersSelectedId = null;
  trackWrite(deleteDoc(doc(db, 'encounters', encId)), 'Deleting encounter');
}

// --- Rendering ---------------------------------------------------------

function getSelectedEncounter() {
  return state.allEncounters.find(function (e) { return e.id === state.encountersSelectedId; }) || null;
}

function renderEncountersTab() {
  if (state.currentRole !== 'gm') return;
  renderEncounterList();
  renderEncounterDetail();
}

function renderEncounterList() {
  listEl.innerHTML = '';
  const encounters = state.allEncounters.slice().sort(function (a, b) {
    // updatedAt desc (OI4); serverTimestamp is briefly null on the
    // local echo of a fresh write — treat null as newest.
    const am = a.updatedAt ? a.updatedAt.toMillis() : Infinity;
    const bm = b.updatedAt ? b.updatedAt.toMillis() : Infinity;
    return bm - am;
  });
  if (!encounters.length) {
    const p = document.createElement('p');
    p.className = 'lore-empty';
    p.textContent = 'No encounters yet.';
    listEl.appendChild(p);
    return;
  }
  const ul = document.createElement('ul');
  ul.className = 'entity-group-list';
  encounters.forEach(function (enc) {
    const li = document.createElement('li');
    if (enc.id === state.encountersSelectedId) li.classList.add('active');
    const nameDiv = document.createElement('div');
    nameDiv.className = 'entity-name';
    nameDiv.textContent = enc.name || '(unnamed)';
    li.appendChild(nameDiv);
    li.addEventListener('click', function () {
      state.encountersSelectedId = enc.id;
      renderEncountersTab();
    });
    ul.appendChild(li);
  });
  listEl.appendChild(ul);
}

function renderEncounterDetail() {
  detailEl.innerHTML = '';
  const enc = getSelectedEncounter();
  if (!enc) {
    const p = document.createElement('p');
    p.className = 'lore-empty';
    p.textContent = 'Select an encounter, or create a new one.';
    detailEl.appendChild(p);
    return;
  }
  detailEl.appendChild(buildHeaderRow(enc));
  // Config row / difficulty panel / adversaries / environment land in
  // the follow-up commits (§5.2 items 2–5).
}

function buildHeaderRow(enc) {
  const row = document.createElement('div');
  row.className = 'encounter-header-row';

  const nameInput = document.createElement('input');
  nameInput.type = 'text';
  nameInput.className = 'encounter-name-input';
  nameInput.value = enc.name || '';
  nameInput.addEventListener('change', function () {
    const v = nameInput.value.trim();
    if (v && v !== enc.name) updateEncounter(enc.id, { name: v });
  });
  row.appendChild(nameInput);

  const delBtn = document.createElement('button');
  delBtn.className = 'action-btn-compact';
  delBtn.textContent = 'Delete';
  delBtn.addEventListener('click', function () { deleteEncounter(enc.id); });
  row.appendChild(delBtn);

  return row;
}

// --- Tab wiring --------------------------------------------------------

newBtn.addEventListener('click', createEncounter);

function ensureEncountersTabReady() {
  renderEncountersTab();
}

export { attachEncountersListener, detachEncountersListener, ensureEncountersTabReady, renderEncountersTab, updateEncounter, getSelectedEncounter };
