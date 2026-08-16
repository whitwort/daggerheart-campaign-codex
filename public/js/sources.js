import {
  getFirestore, collection, doc, addDoc, updateDoc, deleteDoc, onSnapshot, serverTimestamp, writeBatch
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import { firebaseApp } from './firebase.js';
import { state } from './state.js';
import { attachListener, detachListener, safeSnapshotHandler } from './listeners.js';
import { renderMarkdownInto } from './markdown.js';

const db = getFirestore(firebaseApp);

// Sources: GM-maintained list of attribution entries ({text: markdown}).
// Read for GM+player (attribution is always shown to players per Gregg's
// call), write GM-only. Entities/loreItems/images each carry an optional
// sourceId pointing here — see codex.js/images.js for the per-entry
// dropdown and lower-left label rendering.
function attachSourcesListener() {
  attachListener('sourcesUnsub', function () {
    return onSnapshot(collection(db, 'sources'), safeSnapshotHandler('sources', function (snapshot) {
      state.allSources = [];
      snapshot.forEach(function (docSnap) {
        state.allSources.push(Object.assign({ id: docSnap.id }, docSnap.data()));
      });
      notifySourcesChange();
    }), function (err) {
      console.error('sources listener failed:', err.message);
    });
  });
}
function detachSourcesListener() {
  detachListener('sourcesUnsub');
}

// Modules that render source labels (codex.js, images.js) register here
// so a Sources edit in the Admin tab live-updates any already-rendered
// label/dropdown — same inverted-dependency pubsub pattern as
// registerVisibilityChangeHandler in codex.js.
const sourcesChangeHandlers = [];
function registerSourcesChangeHandler(fn) {
  sourcesChangeHandlers.push(fn);
}
function notifySourcesChange() {
  sourcesChangeHandlers.forEach(function (fn) { fn(); });
}

// GM-controlled display order (Admin > Sources drag handle), also used
// everywhere a source dropdown is built. Sources predating this field
// (just the auto-created SRD source, at time of writing) have no
// `order` — sortedSources() below treats a missing order as sorting
// last, stable-tiebroken by text, so they don't jump around
// unpredictably until the GM drags them into place once.
function sortedSources() {
  return state.allSources.slice().sort(function (a, b) {
    const orderA = (typeof a.order === 'number') ? a.order : Infinity;
    const orderB = (typeof b.order === 'number') ? b.order : Infinity;
    if (orderA !== orderB) return orderA - orderB;
    return plainTextPreview(a.text).localeCompare(plainTextPreview(b.text));
  });
}

function nextSourceOrder() {
  return state.allSources.reduce(function (max, s) {
    return (typeof s.order === 'number' && s.order > max) ? s.order : max;
  }, -1) + 1;
}

function addSource(text) {
  return addDoc(collection(db, 'sources'), {
    text: text, order: nextSourceOrder(), createdAt: serverTimestamp(), updatedAt: serverTimestamp()
  });
}
function updateSource(id, text) {
  return updateDoc(doc(db, 'sources', id), { text: text, updatedAt: serverTimestamp() });
}
function deleteSource(id) {
  return deleteDoc(doc(db, 'sources', id));
}

// Called after a drag-reorder in Admin > Sources. orderedIds is the full
// list of source ids in their new display order; writes 0..n-1 as each
// doc's order field in one batch.
function reorderSources(orderedIds) {
  const batch = writeBatch(db);
  orderedIds.forEach(function (id, idx) {
    batch.update(doc(db, 'sources', id), { order: idx, updatedAt: serverTimestamp() });
  });
  return batch.commit();
}

function sourceById(id) {
  if (!id) return null;
  return state.allSources.find(function (s) { return s.id === id; }) || null;
}

// <option> elements can't render Markdown, so the dropdown shows a
// stripped-down plain-text preview of each source's first line; the full
// Markdown is only rendered where it's actually displayed (labels, the
// Admin list).
function plainTextPreview(md) {
  const firstLine = (md || '').split('\n')[0];
  const stripped = firstLine.replace(/[*_`#>[\]]/g, '').trim();
  return stripped.slice(0, 36) || '(untitled source)';
}

// Builds a <select> of all defined sources (value = source id, "" = none),
// in the GM's Admin > Sources display order.
function buildSourceSelect(currentSourceId, onChange) {
  const select = document.createElement('select');
  select.className = 'source-select';
  const noneOpt = document.createElement('option');
  noneOpt.value = '';
  noneOpt.textContent = '-- no source --';
  select.appendChild(noneOpt);
  sortedSources().forEach(function (s) {
    const opt = document.createElement('option');
    opt.value = s.id;
    opt.textContent = plainTextPreview(s.text);
    select.appendChild(opt);
  });
  select.value = currentSourceId || '';
  select.addEventListener('change', function () { onChange(select.value || null); });
  return select;
}

// Renders the lower-left attribution label into el, prefixed with
// "Source: " (plain text, not part of the GM-authored Markdown) followed
// by the source's Markdown content. Hides el and returns false if
// there's no resolvable source (empty sourceId, or a dangling id from a
// deleted source) so callers can collapse the label's layout space --
// UNLESS alwaysShow is true, in which case it renders "Source: none"
// instead of hiding.
// containingEntitySourceId (optional): the entity/entry this item lives
// under. If the item's own source is the SAME as the entity's, the
// label is suppressed as redundant — but the item's sourceId is left
// untouched in the database either way; this only affects display.
// Ignored when alwaysShow is true (Gallery tab image cards and the Map
// tab's map-image label always show their own source regardless of the
// owning entity's, per Gregg's call).
function renderSourceLabel(el, sourceId, containingEntitySourceId, alwaysShow) {
  const source = sourceById(sourceId);
  const redundant = !alwaysShow && containingEntitySourceId != null && sourceId === containingEntitySourceId;
  if ((!source && !alwaysShow) || redundant) {
    el.style.display = 'none';
    return false;
  }
  el.style.display = '';
  el.innerHTML = '';
  el.appendChild(document.createTextNode('Source: '));
  const contentSpan = document.createElement('span');
  el.appendChild(contentSpan);
  if (source) {
    renderMarkdownInto(contentSpan, source.text);
  } else {
    contentSpan.textContent = 'none';
  }
  return true;
}

// Called from every Hidden->Visible toggle site (entity, lore item,
// gallery image) before the write goes out. Returns true if the reveal
// should proceed (source is set, or the GM confirmed anyway), false if
// the caller should revert its checkbox and abort.
function confirmRevealWithoutSource(sourceId) {
  if (sourceById(sourceId)) return true;
  return window.confirm('This entry has no source set. Reveal it to the party anyway?');
}

export {
  attachSourcesListener, detachSourcesListener, registerSourcesChangeHandler,
  addSource, updateSource, deleteSource, reorderSources, sortedSources, nextSourceOrder,
  sourceById, buildSourceSelect, renderSourceLabel, confirmRevealWithoutSource
};
