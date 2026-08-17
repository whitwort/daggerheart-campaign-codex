import {
  getFirestore, doc, setDoc, updateDoc, deleteDoc, onSnapshot, collection, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import { firebaseApp } from './firebase.js';
import { state } from './state.js';
import { attachListener, detachListener, safeSnapshotHandler } from './listeners.js';
import { trackWrite } from './connectivity.js';
import { runSrdImport } from './srd-import.js';
import { renderMarkdownInto } from './markdown.js';
import { addSource, updateSource, deleteSource, reorderSources, sortedSources, registerSourcesChangeHandler } from './sources.js';
import { renderCharactersTab } from './characters.js';
import { approveTransferRequest, rejectTransferRequest } from './transfer-requests.js';

const db = getFirestore(firebaseApp);

const adminPendingBadge = document.getElementById('admin-pending-badge');
const adminJoinRequestsEl = document.getElementById('admin-join-requests');
const adminAddPlayerEmailEl = document.getElementById('admin-add-player-email');
const adminNewPlayerBtn = document.getElementById('admin-new-player-btn');
const adminNewPlayerFormEl = document.getElementById('admin-new-player-form');
const adminAddPlayerSaveBtn = document.getElementById('admin-add-player-save-btn');
const adminAddPlayerCancelBtn = document.getElementById('admin-add-player-cancel-btn');
const adminAddPlayerErrorEl = document.getElementById('admin-add-player-error');
const adminPlayersTbodyEl = document.getElementById('admin-players-tbody');
const adminRootEntitySelectEl = document.getElementById('admin-root-entity-select');
const adminRootEntityStatusEl = document.getElementById('admin-root-entity-status');
const adminCampaignTypeSelectEl = document.getElementById('admin-campaign-type-select');
const adminCampaignTypeStatusEl = document.getElementById('admin-campaign-type-status');
const adminDbSrdTabBtnEl = document.getElementById('admin-db-srd-tab-btn');
const adminSrdRepoEl = document.getElementById('admin-srd-repo');
const adminSrdRepoStatusEl = document.getElementById('admin-srd-repo-status');
const adminSrdUpdateBtnEl = document.getElementById('admin-srd-update-btn');
const adminSrdUpdateStatusEl = document.getElementById('admin-srd-update-status');
const adminSourcesListEl = document.getElementById('admin-sources-list');
const adminSourceNewBtn = document.getElementById('admin-source-new-btn');
const adminNewSourceFormEl = document.getElementById('admin-new-source-form');
const adminNewSourceTextEl = document.getElementById('admin-new-source-text');
const adminSourceSaveBtn = document.getElementById('admin-source-save-btn');
const adminSourceCancelBtn = document.getElementById('admin-source-cancel-btn');
const adminSourceErrorEl = document.getElementById('admin-source-error');

    // --- Admin: root map selector (Phase 7b-4). GM-only control, but
    // Root location: which Location entity's map image is the top-level
    // map. Reads state.allEntities/state.rootEntityId, which are already
    // live for any authorized user — render calls come from the entities
    // listener (codex.js) and config listener (map.js).

    function renderAdminRootEntitySelect() {
      if (state.adminRootSelectUpdating) return;
      const previousValue = adminRootEntitySelectEl.value;
      adminRootEntitySelectEl.innerHTML = '<option value="">-- none --</option>';
      state.allEntities
        .filter(function (e) { return e.category === 'Location'; })
        .sort(function (a, b) { return (a.name || '').localeCompare(b.name || ''); })
        .forEach(function (e) {
          const opt = document.createElement('option');
          opt.value = e.id;
          opt.textContent = e.name || e.id;
          adminRootEntitySelectEl.appendChild(opt);
        });
      adminRootEntitySelectEl.value = state.rootEntityId || '';
      if (adminRootEntitySelectEl.value !== (state.rootEntityId || '')) {
        // state.rootEntityId points at an entity that no longer exists (or
        // is no longer a Location).
        adminRootEntitySelectEl.value = previousValue;
      }
    }

    adminRootEntitySelectEl.addEventListener('change', function () {
      const newRootEntityId = adminRootEntitySelectEl.value || null;
      state.adminRootSelectUpdating = true;
      adminRootEntityStatusEl.textContent = 'Saving...';
      setDoc(doc(db, 'config', 'campaign'), { rootEntityId: newRootEntityId }, { merge: true })
        .then(function () {
          adminRootEntityStatusEl.textContent = 'Saved.';
        })
        .catch(function (err) {
          adminRootEntityStatusEl.textContent = 'Save failed: ' + err.message;
        })
        .finally(function () {
          state.adminRootSelectUpdating = false;
        });
    });

    // --- Admin: campaign type (Phase 12b). Gates Daggerheart-specific UI
    // (e.g. the Import from SRD tab). Same config/campaign doc as the
    // root-entity setting above; updated via the shared config listener
    // in map.js.

    function renderAdminCampaignTypeSelect() {
      adminCampaignTypeSelectEl.value = state.campaignType || 'daggerheart';
      adminDbSrdTabBtnEl.style.display = state.campaignType === 'daggerheart' ? '' : 'none';
      if (state.campaignType !== 'daggerheart' && adminDbSrdTabBtnEl.classList.contains('active')) {
        // Selected tab just got hidden — fall back to Backup.
        adminDbSrdTabBtnEl.classList.remove('active');
        document.getElementById('admin-db-srd').classList.remove('active');
        document.querySelector('#admin-db-tabs button[data-db-tab="admin-db-backup"]').classList.add('active');
        document.getElementById('admin-db-backup').classList.add('active');
      }
    }

    adminCampaignTypeSelectEl.addEventListener('change', function () {
      const newCampaignType = adminCampaignTypeSelectEl.value;
      adminCampaignTypeStatusEl.textContent = '';
      setDoc(doc(db, 'config', 'campaign'), { campaignType: newCampaignType }, { merge: true })
        .catch(function (err) {
          adminCampaignTypeStatusEl.textContent = 'Save failed: ' + err.message;
        });
    });

    // --- Admin: SRD import repo setting (Phase 12b scaffolding). Actual
    // SRD parsing/import lands in a future session (Phase 13); this wires
    // the repo setting to config/campaign and stubs the button.

    function renderAdminSrdRepo() {
      if (document.activeElement === adminSrdRepoEl) return;
      adminSrdRepoEl.value = state.srdRepo || '';
    }

    adminSrdRepoEl.addEventListener('change', function () {
      const newSrdRepo = adminSrdRepoEl.value.trim() || 'seansbox/daggerheart-srd';
      adminSrdRepoEl.value = newSrdRepo;
      adminSrdRepoStatusEl.textContent = 'Saving...';
      setDoc(doc(db, 'config', 'campaign'), { srdRepo: newSrdRepo }, { merge: true })
        .then(function () {
          adminSrdRepoStatusEl.textContent = 'Saved.';
        })
        .catch(function (err) {
          adminSrdRepoStatusEl.textContent = 'Save failed: ' + err.message;
        });
    });

    adminSrdUpdateBtnEl.addEventListener('click', function () {
      adminSrdUpdateBtnEl.disabled = true;
      const repo = (state.srdRepo || 'seansbox/daggerheart-srd').trim();
      adminSrdUpdateStatusEl.textContent = 'Starting...';
      runSrdImport(repo, function (line) {
        adminSrdUpdateStatusEl.textContent = line;
      }).then(function (results) {
        adminSrdUpdateBtnEl.disabled = false;
        let summary = 'Done: ' + results.created + ' created, ' + results.updated + ' updated';
        if (results.skipped) summary += ', ' + results.skipped + ' skipped (no name)';
        if (results.errors.length) summary += '. Errors: ' + results.errors.join('; ');
        adminSrdUpdateStatusEl.textContent = summary;
      }).catch(function (err) {
        adminSrdUpdateBtnEl.disabled = false;
        adminSrdUpdateStatusEl.textContent = 'Update failed: ' + err.message;
      });
    });

    // --- Admin tab (Phase 7a-5/6): GM-only. Listeners are only attached
    // once role first resolves to 'gm' — a query across the whole
    // joinRequests/players collections isn't authorized by the rules for
    // anyone else, so attaching this unconditionally would just error for
    // Players.

    function attachAdminListeners() {
      attachListener('joinRequestsUnsub', function () {
        return onSnapshot(collection(db, 'joinRequests'), safeSnapshotHandler('joinRequests', function (snapshot) {
          state.allJoinRequests = [];
          snapshot.forEach(function (docSnap) {
            state.allJoinRequests.push(Object.assign({ id: docSnap.id }, docSnap.data()));
          });
          renderAdminJoinRequests();
        }), function (err) {
          console.error('joinRequests listener failed:', err.message);
        });
      });

      attachListener('playersUnsub', function () {
        return onSnapshot(collection(db, 'players'), safeSnapshotHandler('players', function (snapshot) {
          state.allPlayers = [];
          snapshot.forEach(function (docSnap) {
            state.allPlayers.push(Object.assign({ id: docSnap.id }, docSnap.data()));
          });
          renderAdminPlayersList();
          renderCharactersTab();  // GM flipper groups PCs by player displayName -- needs a re-render on any players change too, not just entities/role (Phase 14 S5)
        }), function (err) {
          console.error('players listener failed:', err.message);
        });
      });

      // Character transfer requests (Phase 14 §3.5/§6.5/§8 D8, S5): GM's
      // full collection, consolidated with joinRequests into one Requests
      // section per Gregg's placement call (extend the existing Admin tab
      // section + nav badge, not a separate nav element).
      attachListener('transferRequestsUnsub', function () {
        return onSnapshot(collection(db, 'transferRequests'), safeSnapshotHandler('transferRequests', function (snapshot) {
          state.allTransferRequests = [];
          snapshot.forEach(function (docSnap) {
            state.allTransferRequests.push(Object.assign({ id: docSnap.id }, docSnap.data()));
          });
          renderAdminJoinRequests();
          renderCharactersTab();  // Characters tab GM view duplicates the pending-claims notification (Phase 14 S8) -- needs its own re-render on every transferRequests change, not just Admin's queue
        }), function (err) {
          console.error('transferRequests listener failed:', err.message);
        });
      });
    }

    // Unified Requests queue (D8/§6.5, S5): join requests (existing) +
    // character transfer requests, one list, one nav badge counting both.
    // Kept as one function (not split renderers) since Gregg's placement
    // call was to extend this exact existing section rather than add a
    // separate surface -- transfer rows reuse the same
    // .admin-notification/.admin-notification-warning box + Accept/Reject
    // actions-row pattern as join-request rows, just with different
    // label/action wiring.
    function renderAdminJoinRequests() {
      adminJoinRequestsEl.innerHTML = '';
      const totalPending = state.allJoinRequests.length + state.allTransferRequests.length;
      if (totalPending === 0) {
        adminPendingBadge.style.display = 'none';
        adminPendingBadge.textContent = '';
        return;
      }
      adminPendingBadge.style.display = 'inline';
      adminPendingBadge.textContent = ' (' + totalPending + ')';
      state.allJoinRequests.forEach(function (req) {
        const box = document.createElement('div');
        box.className = 'admin-notification admin-notification-warning';
        const label = document.createElement('span');
        label.textContent = (req.displayName ? req.displayName + ' — ' : '') + req.email
          + ' (' + (req.provider || 'unknown') + ') wants to join';
        box.appendChild(label);

        const actions = document.createElement('div');
        actions.className = 'actions-row-right';
        const acceptBtn = document.createElement('button');
        acceptBtn.textContent = 'Accept';
        acceptBtn.addEventListener('click', function () { acceptJoinRequest(req); });
        actions.appendChild(acceptBtn);
        const rejectBtn = document.createElement('button');
        rejectBtn.textContent = 'Reject';
        rejectBtn.addEventListener('click', function () { rejectJoinRequest(req); });
        actions.appendChild(rejectBtn);
        box.appendChild(actions);

        adminJoinRequestsEl.appendChild(box);
      });
      state.allTransferRequests.forEach(function (req) {
        const character = state.allEntities.find(function (e) { return e.id === req.characterId; });
        const requester = state.allPlayers.find(function (p) { return p.id === req.toEmail; });
        const box = document.createElement('div');
        box.className = 'admin-notification admin-notification-warning';
        const label = document.createElement('span');
        label.textContent = (requester && requester.displayName ? requester.displayName + ' — ' : '') + req.toEmail
          + ' wants to take over ' + (character ? character.name : '(deleted character)');
        box.appendChild(label);

        const actions = document.createElement('div');
        actions.className = 'actions-row-right';
        const approveBtn = document.createElement('button');
        approveBtn.textContent = 'Approve';
        approveBtn.disabled = !character;
        approveBtn.addEventListener('click', function () { approveTransferRequest(req); });
        actions.appendChild(approveBtn);
        const rejectBtn = document.createElement('button');
        rejectBtn.textContent = 'Reject';
        rejectBtn.addEventListener('click', function () { rejectTransferRequest(req); });
        actions.appendChild(rejectBtn);
        box.appendChild(actions);

        adminJoinRequestsEl.appendChild(box);
      });
    }


    function acceptJoinRequest(req) {
      setDoc(doc(db, 'players', req.email), {
        addedAt: serverTimestamp(),
        displayName: req.displayName || ''
      }).then(function () {
        return deleteDoc(doc(db, 'joinRequests', req.id));
      }).catch(function (err) {
        alert('Accept failed: ' + err.message);
      });
    }

    function rejectJoinRequest(req) {
      deleteDoc(doc(db, 'joinRequests', req.id)).catch(function (err) {
        alert('Reject failed: ' + err.message);
      });
    }

    function renderAdminPlayersList() {
      adminPlayersTbodyEl.innerHTML = '';
      if (state.allPlayers.length === 0) {
        const row = document.createElement('tr');
        const cell = document.createElement('td');
        cell.colSpan = 3;
        cell.className = 'lore-empty';
        cell.textContent = 'No whitelisted party members yet.';
        row.appendChild(cell);
        adminPlayersTbodyEl.appendChild(row);
        return;
      }
      state.allPlayers.slice().sort(function (a, b) { return a.id.localeCompare(b.id); }).forEach(function (p) {
        const editing = state.adminPlayerEditId === p.id;
        const row = document.createElement('tr');

        const idCell = document.createElement('td');
        idCell.textContent = p.id;
        row.appendChild(idCell);

        const nameCell = document.createElement('td');
        if (editing) {
          const nameInput = document.createElement('input');
          nameInput.type = 'text';
          nameInput.value = state.adminPlayerEditDraft;
          nameInput.addEventListener('input', function () { state.adminPlayerEditDraft = nameInput.value; });
          nameCell.appendChild(nameInput);
        } else {
          nameCell.textContent = p.displayName || '';
        }
        row.appendChild(nameCell);

        const actionsCell = document.createElement('td');
        const actions = document.createElement('div');
        actions.className = 'actions-row-right';
        if (editing) {
          const saveBtn = document.createElement('button');
          saveBtn.textContent = 'Save';
          saveBtn.addEventListener('click', function () {
            // Phase 13: optimistic close -- see saveEntityEdit's comment
            // in codex.js. This row is rebuilt on every players/
            // joinRequests snapshot, so gating the close on the write
            // Promise left a stale enabled Save button re-appearing
            // while offline, same duplicate-submission risk.
            trackWrite(setDoc(doc(db, 'players', p.id), { displayName: state.adminPlayerEditDraft.trim() }, { merge: true }), 'Saving player').catch(function (err) {
              alert('Save failed: ' + err.message);
            });
            state.adminPlayerEditId = null;
            renderAdminPlayersList();
          });
          const cancelBtn = document.createElement('button');
          cancelBtn.textContent = 'Cancel';
          cancelBtn.addEventListener('click', function () {
            state.adminPlayerEditId = null;
            renderAdminPlayersList();
          });
          actions.appendChild(saveBtn);
          actions.appendChild(cancelBtn);
        } else {
          const editBtn = document.createElement('button');
          editBtn.textContent = 'Edit';
          editBtn.addEventListener('click', function () {
            state.adminPlayerEditId = p.id;
            state.adminPlayerEditDraft = p.displayName || '';
            renderAdminPlayersList();
          });
          const removeBtn = document.createElement('button');
          removeBtn.textContent = 'Remove';
          removeBtn.addEventListener('click', function () {
            const confirmed = window.confirm('Remove ' + p.id + ' from the party whitelist?');
            if (!confirmed) return;
            deleteDoc(doc(db, 'players', p.id)).catch(function (err) {
              alert('Remove failed: ' + err.message);
            });
          });
          actions.appendChild(editBtn);
          actions.appendChild(removeBtn);
        }
        actionsCell.appendChild(actions);
        row.appendChild(actionsCell);

        adminPlayersTbodyEl.appendChild(row);
      });
    }

    adminNewPlayerBtn.addEventListener('click', function () {
      adminNewPlayerFormEl.style.display = 'block';
      adminAddPlayerErrorEl.textContent = '';
      adminAddPlayerEmailEl.value = '';
      adminAddPlayerEmailEl.focus();
    });

    adminAddPlayerCancelBtn.addEventListener('click', function () {
      adminNewPlayerFormEl.style.display = 'none';
      adminAddPlayerErrorEl.textContent = '';
    });

    adminAddPlayerSaveBtn.addEventListener('click', function () {
      const email = adminAddPlayerEmailEl.value.trim().toLowerCase();
      adminAddPlayerErrorEl.textContent = '';
      if (!email || email.indexOf('@') === -1) {
        adminAddPlayerErrorEl.textContent = 'Enter a valid email.';
        return;
      }
      adminAddPlayerSaveBtn.disabled = true;
      setDoc(doc(db, 'players', email), { addedAt: serverTimestamp() }, { merge: true }).then(function () {
        adminAddPlayerSaveBtn.disabled = false;
        adminNewPlayerFormEl.style.display = 'none';
        adminAddPlayerEmailEl.value = '';
      }).catch(function (err) {
        adminAddPlayerSaveBtn.disabled = false;
        adminAddPlayerErrorEl.textContent = 'Add failed: ' + err.message;
      });
    });


function detachAdminListeners() {
  detachListener('joinRequestsUnsub');
  detachListener('playersUnsub');
  detachListener('transferRequestsUnsub');
}

// --- Admin: Sources (interjected before Phase 13). GM-only CRUD UI over
// the sources collection (data layer + live listener in sources.js,
// shared with codex.js/images.js for label/dropdown rendering). Listener
// lifecycle is NOT admin-only (players need state.allSources too, for
// their own attribution labels) — attached in auth.js's
// attachDataListeners, not here. This module just renders the list and
// registers for re-render on change.

// Same lazy-CDN SortableJS pattern as the Gallery tab's drag-reorder
// (codex.js) — shares state.sortableModulePromise so the two don't
// double-fetch if both tabs get used in one session.
function loadSortable() {
  if (!state.sortableModulePromise) {
    state.sortableModulePromise = import('https://esm.sh/sortablejs@1.15.2')
      .then(function (mod) { return mod.default || mod; });
  }
  return state.sortableModulePromise;
}

let sourcesSortableInstance = null;

function renderAdminSourcesList() {
  adminSourcesListEl.innerHTML = '';
  if (state.allSources.length === 0) {
    const emptyP = document.createElement('p');
    emptyP.className = 'lore-empty';
    emptyP.textContent = 'No sources defined yet.';
    adminSourcesListEl.appendChild(emptyP);
    return;
  }
  const sorted = sortedSources();
  sorted.forEach(function (s) {
      const editing = state.adminSourceEditId === s.id;
      const row = document.createElement('div');
      row.className = 'admin-source-row';
      row.dataset.sourceId = s.id;

      const handle = document.createElement('div');
      handle.className = 'source-drag-handle';
      handle.title = 'Drag to reorder';
      handle.textContent = '\u2261';
      row.appendChild(handle);

      const rowBody = document.createElement('div');
      rowBody.className = 'admin-source-row-body';

      if (editing) {
        const textarea = document.createElement('textarea');
        textarea.rows = 3;
        textarea.style.width = '100%';
        textarea.style.boxSizing = 'border-box';
        textarea.value = state.adminSourceEditDraft;
        textarea.addEventListener('input', function () { state.adminSourceEditDraft = textarea.value; });
        rowBody.appendChild(textarea);

        const actions = document.createElement('div');
        actions.className = 'actions-row-right';
        const saveBtn = document.createElement('button');
        saveBtn.className = 'action-btn-compact';
        saveBtn.textContent = 'Save';
        saveBtn.addEventListener('click', function () {
          const text = state.adminSourceEditDraft.trim();
          if (!text) { window.alert('Source text is required.'); return; }
          // Phase 13: optimistic close -- see saveEntityEdit's comment
          // in codex.js.
          trackWrite(updateSource(s.id, text), 'Saving source').catch(function (err) { window.alert('Save failed: ' + err.message); });
          state.adminSourceEditId = null;
          renderAdminSourcesList();
        });
        const cancelBtn = document.createElement('button');
        cancelBtn.className = 'action-btn-compact';
        cancelBtn.textContent = 'Cancel';
        cancelBtn.addEventListener('click', function () {
          state.adminSourceEditId = null;
          renderAdminSourcesList();
        });
        actions.appendChild(saveBtn);
        actions.appendChild(cancelBtn);
        rowBody.appendChild(actions);
      } else {
        const bodyDiv = document.createElement('div');
        bodyDiv.className = 'admin-source-body';
        renderMarkdownInto(bodyDiv, s.text);
        rowBody.appendChild(bodyDiv);

        const actions = document.createElement('div');
        actions.className = 'actions-row-right';
        const editBtn = document.createElement('button');
        editBtn.className = 'action-btn-compact';
        editBtn.textContent = 'Edit';
        editBtn.addEventListener('click', function () {
          state.adminSourceEditId = s.id;
          state.adminSourceEditDraft = s.text || '';
          renderAdminSourcesList();
        });
        const removeBtn = document.createElement('button');
        removeBtn.className = 'action-btn-compact';
        removeBtn.textContent = 'Remove';
        removeBtn.addEventListener('click', function () {
          const confirmed = window.confirm('Remove this source? Entries citing it will show as having no source.');
          if (!confirmed) return;
          deleteSource(s.id).catch(function (err) { window.alert('Remove failed: ' + err.message); });
        });
        actions.appendChild(editBtn);
        actions.appendChild(removeBtn);
        rowBody.appendChild(actions);
      }

      row.appendChild(rowBody);
      adminSourcesListEl.appendChild(row);
  });

  if (sourcesSortableInstance) {
    sourcesSortableInstance.destroy();
    sourcesSortableInstance = null;
  }
  if (sorted.length > 1) {
    loadSortable().then(function (Sortable) {
      sourcesSortableInstance = new Sortable(adminSourcesListEl, {
        handle: '.source-drag-handle',
        // forceFallback: with a handle restriction, native HTML5 DnD
        // (SortableJS's default for mouse) doesn't reliably respect the
        // handle scoping in every browser — this makes mouse dragging
        // silently not start while touch (which never uses native DnD,
        // hence unaffected) works fine. Forcing SortableJS's own
        // JS-simulated drag for both input types fixes that asymmetry.
        forceFallback: true,
        animation: 150,
        onEnd: function () {
          const orderedIds = Array.prototype.slice.call(adminSourcesListEl.children)
            .map(function (el) { return el.dataset.sourceId; });
          reorderSources(orderedIds).catch(function (err) {
            window.alert('Reorder failed: ' + err.message);
            renderAdminSourcesList();
          });
        }
      });
    }).catch(function () { /* drag-reorder unavailable; edit/remove still work */ });
  }
}

registerSourcesChangeHandler(renderAdminSourcesList);

adminSourceNewBtn.addEventListener('click', function () {
  adminNewSourceFormEl.style.display = 'block';
  adminSourceErrorEl.textContent = '';
  adminNewSourceTextEl.value = '';
  adminNewSourceTextEl.focus();
});

adminSourceCancelBtn.addEventListener('click', function () {
  adminNewSourceFormEl.style.display = 'none';
  adminSourceErrorEl.textContent = '';
});

adminSourceSaveBtn.addEventListener('click', function () {
  const text = adminNewSourceTextEl.value.trim();
  adminSourceErrorEl.textContent = '';
  if (!text) {
    adminSourceErrorEl.textContent = 'Source text is required.';
    return;
  }
  adminSourceSaveBtn.disabled = true;
  // Phase 13: optimistic close -- see saveEntityEdit's comment in
  // codex.js. This form is persistent (not rebuilt per render) so it
  // wasn't at risk of the duplicate-submission variant of the bug, but
  // gating the close on the write Promise left it stuck open until
  // reconnect while offline.
  trackWrite(addSource(text), 'Saving source').catch(function (err) {
    window.alert('Add failed: ' + err.message);
  });
  adminSourceSaveBtn.disabled = false;
  adminNewSourceFormEl.style.display = 'none';
  adminNewSourceTextEl.value = '';
});

// --- Database subsection: Import | Export sub-tabs ------------------------
document.querySelectorAll('#admin-db-tabs button').forEach(function (btn) {
  btn.addEventListener('click', function () {
    document.querySelectorAll('#admin-db-tabs button').forEach(function (b) { b.classList.remove('active'); });
    document.querySelectorAll('.admin-db-tab-panel').forEach(function (p) { p.classList.remove('active'); });
    btn.classList.add('active');
    document.getElementById(btn.dataset.dbTab).classList.add('active');
  });
});

export {
  attachAdminListeners, detachAdminListeners, renderAdminRootEntitySelect, renderAdminPlayersList,
  renderAdminCampaignTypeSelect, renderAdminSrdRepo
};
