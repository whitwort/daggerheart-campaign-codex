// stables.js — Phase 17 B3/B4. The Stables tab (GM-only), first resident:
// Lore Drops. A drop is a batch of visibility from→to changes recorded in
// the Codex (codex.js's "+ New drop" recorder, sharing.js interception);
// this tab lists them (Current = not yet run, Previous = ran), summarizes
// the selected drop with the same badge-language change lines as the
// recorder, and Runs / Undoes / Deletes them.
//
// Run applies every change's `to` in ONE writeBatch (entities/loreItems
// get an updatedAt bump; images a bare patch; an isMap image change also
// syncs the owning entity's mapImageVisibleToPlayers in the same batch,
// extended §3.1 semantics), writes ONE consolidated 'lore-drop'
// notification per newly-exposed player ("Lore drop: through <name> you
// have discovered <entity links>" — messages.js renders it), and flips
// status→'previous'. Undo applies every `from` (+ map sync), flips back
// to 'current', and is silent (no notifications — un-learning isn't an
// announcement). `from` is record-time state: undoing clobbers any
// interim manual changes to the same elements (design doc, accepted).

import {
  getFirestore, doc, collection, onSnapshot, writeBatch, deleteDoc, updateDoc, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import { firebaseApp } from './firebase.js';
import { state } from './state.js';
import { attachListener, detachListener, safeSnapshotHandler } from './listeners.js';
import { trackWrite } from './connectivity.js';
import { buildDropChangeLine, DROP_TYPES, dropTypeLabel, openDropRecorder } from './codex.js';
import { canSee } from './visibility.js';
import { playersUniverse, exposedEmailSet, recipientCtxFor } from './sharing.js';

const db = getFirestore(firebaseApp);

const listEl = document.getElementById('stables-drops-list');
const detailEl = document.getElementById('stables-detail-pane');
const tabsEl = document.getElementById('stables-drops-tabs');

// --- Listener lifecycle (GM-only; attach called from auth.js only in ---
// --- the GM branch, per listeners.js invariant 1) ----------------------

function attachStablesListener() {
  attachListener('loreDropsUnsub', function () {
    return onSnapshot(collection(db, 'loreDrops'), safeSnapshotHandler('loreDrops', function (snapshot) {
      state.allLoreDrops = [];
      snapshot.forEach(function (docSnap) {
        state.allLoreDrops.push(Object.assign({ id: docSnap.id }, docSnap.data()));
      });
      renderStablesTab();
    }), function (err) {
      console.error('loreDrops listener failed:', err.message);
    });
  });
}

function detachStablesListener() {
  detachListener('loreDropsUnsub');
  state.allLoreDrops = [];
  state.stablesSelectedId = null;
}

// --- helpers -----------------------------------------------------------

function tsMs(ts) {
  return (ts && ts.toMillis) ? ts.toMillis() : null;
}

function formatDropDate(ts) {
  const ms = tsMs(ts);
  if (ms == null) return '';
  return new Date(ms).toLocaleDateString();
}

function dropsForTab() {
  const status = state.stablesDropsTab;
  return state.allLoreDrops
    .filter(function (d) { return (d.status || 'current') === status; })
    .sort(function (a, b) {
      // Current: newest recorded first. Previous: most recently ran first.
      const ka = status === 'previous' ? tsMs(a.ranAt) : tsMs(a.createdAt);
      const kb = status === 'previous' ? tsMs(b.ranAt) : tsMs(b.createdAt);
      return (kb || 0) - (ka || 0);
    });
}

function selectedDrop() {
  return state.allLoreDrops.find(function (d) { return d.id === state.stablesSelectedId; }) || null;
}

// Reconstructs the element-shaped object exposedEmailSet/canSee expect
// from a stored change + one of its endpoint states. Only the fields
// those functions read are populated (visibility triple, author fields,
// parent-id discriminators).
function changeElem(change, endpoint) {
  const base = {
    id: change.elementId,
    visibility: endpoint.visibility,
    characterId: endpoint.characterId,
    characterShared: endpoint.characterShared
  };
  if (change.elementType === 'loreItem') {
    base.entityId = change.entityId;
    base.authorType = change.authorType || null;
    base.authorId = change.authorId || null;
  } else if (change.elementType === 'image') {
    base.ownerType = 'entity';
    base.ownerId = change.entityId;
  }
  return base;
}

const COLLECTION_FOR = { entity: 'entities', loreItem: 'loreItems', image: 'images' };

// Appends one change's element write (and, for an isMap image, the
// owning entity's mapImageVisibleToPlayers sync) to `batch`. `endpoint`
// is change.to (Run) or change.from (Undo).
function appendChangeWrite(batch, change, endpoint) {
  const patch = {
    visibility: endpoint.visibility,
    characterId: endpoint.characterId,
    characterShared: endpoint.characterShared
  };
  if (change.elementType !== 'image') patch.updatedAt = serverTimestamp();
  batch.update(doc(db, COLLECTION_FOR[change.elementType], change.elementId), patch);
  let ops = 1;
  if (change.elementType === 'image' && change.isMap && change.entityId) {
    const wholeParty = endpoint.visibility === 'all-players' ||
      (endpoint.visibility === 'character' && !!endpoint.characterShared);
    batch.update(doc(db, 'entities', change.entityId), {
      mapImageVisibleToPlayers: wholeParty, updatedAt: serverTimestamp()
    });
    ops += 1;
  }
  return ops;
}

// --- Run / Undo / Delete -----------------------------------------------

// entityIds each player is NEWLY exposed to by this drop: per change, the
// exposedEmailSet before/after diff (same machinery as per-share fan-out),
// child elements mapped to their parent entity and gated on the recipient
// seeing the parent in the POST-drop state (the drop may reveal the
// parent in the same batch).
function computeDropRecipients(drop) {
  const universe = playersUniverse();
  const gmEmail = (state.currentUser && state.currentUser.email) || null;

  // Post-drop entity states: live docs merged with this drop's own
  // entity-type `to` endpoints.
  const entityTo = {};
  drop.changes.forEach(function (c) {
    if (c.elementType === 'entity') entityTo[c.elementId] = c.to;
  });
  function postEntity(entityId) {
    const live = state.allEntities.find(function (e) { return e.id === entityId; });
    if (!live) return null;
    return entityTo[entityId] ? Object.assign({}, live, entityTo[entityId]) : live;
  }

  const perEmail = {};
  drop.changes.forEach(function (c) {
    const before = exposedEmailSet(changeElem(c, c.from), universe);
    const after = exposedEmailSet(changeElem(c, c.to), universe);
    Object.keys(after).forEach(function (email) {
      if (before[email] || email === gmEmail) return;
      if (!c.entityId) return;
      if (c.elementType !== 'entity') {
        const parent = postEntity(c.entityId);
        if (!parent || !canSee(parent, recipientCtxFor(email))) return;
      }
      if (!perEmail[email]) perEmail[email] = {};
      perEmail[email][c.entityId] = true;
    });
  });
  return Object.keys(perEmail).map(function (email) {
    return { email: email, entityIds: Object.keys(perEmail[email]) };
  });
}

function runDrop(drop) {
  const recipients = computeDropRecipients(drop);
  const batch = writeBatch(db);
  let ops = 0;
  drop.changes.forEach(function (c) { ops += appendChangeWrite(batch, c, c.to); });
  recipients.forEach(function (r) {
    batch.set(doc(collection(db, 'notifications')), {
      recipientEmail: r.email,
      kind: 'lore-drop',
      dropName: drop.name || '(unnamed drop)',
      entityIds: r.entityIds,
      createdAt: serverTimestamp(),
      seenAt: null
    });
    ops += 1;
  });
  batch.update(doc(db, 'loreDrops', drop.id), { status: 'previous', ranAt: serverTimestamp() });
  ops += 1;
  if (ops > 500) {
    window.alert('This drop needs ' + ops + ' writes — over the 500-per-batch limit. Split it into smaller drops.');
    return;
  }
  trackWrite(batch.commit(), 'Running drop').then(function () {
    state.stablesDropsTab = 'previous';
    renderStablesTab();
  }).catch(function (err) {
    window.alert('Run failed: ' + err.message);
  });
}

function undoDrop(drop) {
  const batch = writeBatch(db);
  let ops = 0;
  drop.changes.forEach(function (c) { ops += appendChangeWrite(batch, c, c.from); });
  batch.update(doc(db, 'loreDrops', drop.id), { status: 'current', ranAt: null });
  ops += 1;
  if (ops > 500) {
    window.alert('This drop needs ' + ops + ' writes — over the 500-per-batch limit.');
    return;
  }
  trackWrite(batch.commit(), 'Undoing drop').then(function () {
    state.stablesDropsTab = 'current';
    renderStablesTab();
  }).catch(function (err) {
    window.alert('Undo failed: ' + err.message);
  });
}

function deleteDrop(drop) {
  if (!window.confirm('Delete drop "' + (drop.name || '(unnamed)') + '"? This does not revert any changes it made.')) return;
  trackWrite(deleteDoc(doc(db, 'loreDrops', drop.id)), 'Deleting drop').catch(function (err) {
    window.alert('Delete failed: ' + err.message);
  });
}

// Pulls one change out of a not-yet-run drop (View pane's per-line "x").
// Only meaningful pre-Run: an already-run drop's changes are real
// history of writes that happened, not a to-do list to edit. No confirm
// -- low-stakes (the element just goes back to whatever "+ Add more"
// or a future recording would find it at) and reversible via "+ Add
// more" re-toggling.
function removeChangeFromDrop(drop, change) {
  const changes = (drop.changes || []).filter(function (c) { return c !== change; });
  trackWrite(updateDoc(doc(db, 'loreDrops', drop.id), { changes: changes }), 'Updating drop').catch(function (err) {
    window.alert('Remove failed: ' + err.message);
  });
}

// --- render ------------------------------------------------------------

function renderDropsList() {
  tabsEl.querySelectorAll('button').forEach(function (b) {
    b.classList.toggle('active', b.dataset.dropsTab === state.stablesDropsTab);
  });
  const drops = dropsForTab();
  listEl.innerHTML = '';
  if (!drops.length) {
    const p = document.createElement('p');
    p.className = 'lore-empty';
    p.textContent = state.stablesDropsTab === 'current'
      ? 'No drops waiting. Record one from the Codex tab.'
      : 'No drops have been run yet.';
    listEl.appendChild(p);
    return;
  }
  // Type hierarchy (Phase 17 follow-up): drops grouped under their type
  // label, in DROP_TYPES order. Missing/legacy type reads as 'lore'.
  const byType = {};
  drops.forEach(function (d) {
    const t = d.type || 'lore';
    if (!byType[t]) byType[t] = [];
    byType[t].push(d);
  });
  const orderedTypes = DROP_TYPES.map(function (t) { return t.key; })
    .filter(function (k) { return byType[k]; });
  Object.keys(byType).forEach(function (k) {
    if (orderedTypes.indexOf(k) === -1) orderedTypes.push(k);
  });
  orderedTypes.forEach(function (typeKey) {
    const header = document.createElement('div');
    header.className = 'stables-drop-type-header';
    header.textContent = dropTypeLabel(typeKey) + 's';
    listEl.appendChild(header);
    const ul = document.createElement('ul');
    ul.className = 'stables-drop-list';
    byType[typeKey].forEach(function (d) {
      const li = document.createElement('li');
      li.className = 'stables-drop-row' + (d.id === state.stablesSelectedId ? ' active' : '');
      const name = document.createElement('span');
      name.className = 'stables-drop-name';
      name.textContent = d.name || '(unnamed)';
      li.appendChild(name);
      const meta = document.createElement('span');
      meta.className = 'stables-drop-meta';
      meta.textContent = (d.changes ? d.changes.length : 0) + ' changes \u00B7 ' +
        (state.stablesDropsTab === 'previous' ? 'ran ' + formatDropDate(d.ranAt) : formatDropDate(d.createdAt));
      li.appendChild(meta);
      li.addEventListener('click', function () {
        state.stablesSelectedId = d.id;
        renderStablesTab();
      });
      ul.appendChild(li);
    });
    listEl.appendChild(ul);
  });
}

function renderDropDetail() {
  const drop = selectedDrop();
  detailEl.innerHTML = '';
  if (!drop) {
    const p = document.createElement('p');
    p.className = 'lore-empty';
    p.textContent = 'Select a drop. Record new drops from the Codex tab\u2019s \u201C+ New drop\u201D button.';
    detailEl.appendChild(p);
    return;
  }
  const isPrevious = (drop.status || 'current') === 'previous';

  const h = document.createElement('h3');
  h.className = 'pane-title';
  h.textContent = drop.name || '(unnamed)';
  detailEl.appendChild(h);

  const meta = document.createElement('p');
  meta.className = 'stables-drop-detail-meta';
  meta.textContent = dropTypeLabel(drop.type || 'lore') + ' \u00B7 Recorded ' + formatDropDate(drop.createdAt) +
    (isPrevious ? ' \u00B7 Ran ' + formatDropDate(drop.ranAt) : '');
  detailEl.appendChild(meta);

  const summary = document.createElement('div');
  summary.className = 'stables-drop-summary';
  const changes = drop.changes || [];
  if (!changes.length) {
    const emptyP = document.createElement('p');
    emptyP.className = 'lore-empty';
    emptyP.textContent = 'No changes recorded.';
    summary.appendChild(emptyP);
  } else {
    changes.forEach(function (c) {
      summary.appendChild(buildDropChangeLine(c, isPrevious ? null : function (change) { removeChangeFromDrop(drop, change); }));
    });
  }
  detailEl.appendChild(summary);

  if (!isPrevious) {
    const addMoreBtn = document.createElement('button');
    addMoreBtn.type = 'button';
    addMoreBtn.className = 'stables-add-more-btn';
    addMoreBtn.textContent = '+ Add more';
    addMoreBtn.disabled = !!state.dropRecording;
    addMoreBtn.addEventListener('click', function () { openDropRecorder(drop); });
    detailEl.appendChild(addMoreBtn);
  }

  const actions = document.createElement('div');
  actions.className = 'stables-drop-actions';
  if (!isPrevious) {
    const runBtn = document.createElement('button');
    runBtn.textContent = 'Run';
    runBtn.disabled = !changes.length;
    runBtn.addEventListener('click', function () { runDrop(drop); });
    actions.appendChild(runBtn);
  } else {
    const undoBtn = document.createElement('button');
    undoBtn.textContent = 'Undo';
    undoBtn.addEventListener('click', function () { undoDrop(drop); });
    actions.appendChild(undoBtn);
  }
  const delBtn = document.createElement('button');
  delBtn.textContent = 'Delete';
  delBtn.addEventListener('click', function () { deleteDrop(drop); });
  actions.appendChild(delBtn);
  detailEl.appendChild(actions);
}

function renderStablesTab() {
  // Hidden-panel guard, same reasoning as renderCharactersTab's
  // (ensureStablesTabReady re-renders on activation).
  if (!document.getElementById('stables-panel').classList.contains('active')) return;
  renderDropsList();
  renderDropDetail();
}

tabsEl.querySelectorAll('button').forEach(function (btn) {
  btn.addEventListener('click', function () {
    state.stablesDropsTab = btn.dataset.dropsTab;
    state.stablesSelectedId = null;
    renderStablesTab();
  });
});

function ensureStablesTabReady() {
  renderStablesTab();
}

export { attachStablesListener, detachStablesListener, ensureStablesTabReady };
