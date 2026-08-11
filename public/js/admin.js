import {
  getFirestore, doc, setDoc, deleteDoc, onSnapshot, collection, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import { firebaseApp } from './firebase.js';
import { state } from './state.js';
import { attachListener, detachListener, safeSnapshotHandler } from './listeners.js';

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
        }), function (err) {
          console.error('players listener failed:', err.message);
        });
      });
    }

    function renderAdminJoinRequests() {
      adminJoinRequestsEl.innerHTML = '';
      if (state.allJoinRequests.length === 0) {
        adminPendingBadge.style.display = 'none';
        adminPendingBadge.textContent = '';
        return;
      }
      adminPendingBadge.style.display = 'inline';
      adminPendingBadge.textContent = ' (' + state.allJoinRequests.length + ')';
      state.allJoinRequests.forEach(function (req) {
        const box = document.createElement('div');
        box.className = 'admin-notification admin-notification-message';
        const label = document.createElement('span');
        label.textContent = (req.displayName ? req.displayName + ' — ' : '') + req.email
          + ' (' + (req.provider || 'unknown') + ')';
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

    function charactersOwnedBy(email) {
      return state.allEntities
        .filter(function (e) { return e.category === 'Character' && e.ownerId === email; })
        .map(function (e) { return e.name; });
    }

    function renderAdminPlayersList() {
      adminPlayersTbodyEl.innerHTML = '';
      if (state.allPlayers.length === 0) {
        const row = document.createElement('tr');
        const cell = document.createElement('td');
        cell.colSpan = 4;
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

        const charsCell = document.createElement('td');
        charsCell.textContent = charactersOwnedBy(p.id).join(', ');
        row.appendChild(charsCell);

        const actionsCell = document.createElement('td');
        const actions = document.createElement('div');
        actions.className = 'actions-row-right';
        if (editing) {
          const saveBtn = document.createElement('button');
          saveBtn.textContent = 'Save';
          saveBtn.addEventListener('click', function () {
            setDoc(doc(db, 'players', p.id), { displayName: state.adminPlayerEditDraft.trim() }, { merge: true }).then(function () {
              state.adminPlayerEditId = null;
              renderAdminPlayersList();
            }).catch(function (err) {
              alert('Save failed: ' + err.message);
            });
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
}

// --- Database subsection: Import | Export sub-tabs ------------------------
document.querySelectorAll('#admin-db-tabs button').forEach(function (btn) {
  btn.addEventListener('click', function () {
    document.querySelectorAll('#admin-db-tabs button').forEach(function (b) { b.classList.remove('active'); });
    document.querySelectorAll('.admin-db-tab-panel').forEach(function (p) { p.classList.remove('active'); });
    btn.classList.add('active');
    document.getElementById(btn.dataset.dbTab).classList.add('active');
  });
});

export { attachAdminListeners, detachAdminListeners, renderAdminRootEntitySelect, renderAdminPlayersList };
