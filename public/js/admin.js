import {
  getFirestore, doc, setDoc, deleteDoc, onSnapshot, collection, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import { firebaseApp } from './firebase.js';
import { state } from './state.js';

const db = getFirestore(firebaseApp);

    // --- Admin: root map selector (Phase 7b-4). GM-only control, but
    // reads state.allMaps/state.rootMapId which are already live for any authorized
    // user — no separate admin-gated listener needed, just render calls
    // from the existing maps/config listeners.

    function renderAdminRootMapSelect() {
      if (state.adminRootMapUpdating) return;
      const previousValue = adminRootMapSelectEl.value;
      adminRootMapSelectEl.innerHTML = '<option value="">-- none --</option>';
      state.allMaps.forEach(function (m) {
        const opt = document.createElement('option');
        opt.value = m.id;
        opt.textContent = m.name || m.id;
        adminRootMapSelectEl.appendChild(opt);
      });
      adminRootMapSelectEl.value = state.rootMapId || '';
      if (adminRootMapSelectEl.value !== (state.rootMapId || '')) {
        // state.rootMapId points at a map that no longer exists in state.allMaps.
        adminRootMapSelectEl.value = previousValue;
      }
    }

    adminRootMapSelectEl.addEventListener('change', function () {
      const newRootMapId = adminRootMapSelectEl.value || null;
      state.adminRootMapUpdating = true;
      adminRootMapStatusEl.textContent = 'Saving...';
      setDoc(doc(db, 'config', 'campaign'), { rootMapId: newRootMapId }, { merge: true })
        .then(function () {
          adminRootMapStatusEl.textContent = 'Saved.';
        })
        .catch(function (err) {
          adminRootMapStatusEl.textContent = 'Save failed: ' + err.message;
        })
        .finally(function () {
          state.adminRootMapUpdating = false;
        });
    });

    // --- Admin tab (Phase 7a-5/6): GM-only. Listeners are only attached
    // once role first resolves to 'gm' — a query across the whole
    // joinRequests/players collections isn't authorized by the rules for
    // anyone else, so attaching this unconditionally would just error for
    // Players.

    function attachAdminListeners() {
      if (state.adminListenersAttached) return;
      state.adminListenersAttached = true;
      onSnapshot(collection(db, 'joinRequests'), function (snapshot) {
        state.allJoinRequests = [];
        snapshot.forEach(function (docSnap) {
          state.allJoinRequests.push(Object.assign({ id: docSnap.id }, docSnap.data()));
        });
        renderAdminJoinRequests();
      }, function (err) {
        console.error('joinRequests listener failed:', err.message);
      });

      onSnapshot(collection(db, 'players'), function (snapshot) {
        state.allPlayers = [];
        snapshot.forEach(function (docSnap) {
          state.allPlayers.push(Object.assign({ id: docSnap.id }, docSnap.data()));
        });
        renderAdminPlayersList();
      }, function (err) {
        console.error('players listener failed:', err.message);
      });
    }

    function renderAdminJoinRequests() {
      adminJoinRequestsEl.innerHTML = '';
      if (state.allJoinRequests.length === 0) {
        const empty = document.createElement('li');
        empty.textContent = 'No pending requests.';
        adminJoinRequestsEl.appendChild(empty);
        adminPendingBadge.style.display = 'none';
        adminPendingBadge.textContent = '';
        return;
      }
      adminPendingBadge.style.display = 'inline';
      adminPendingBadge.textContent = ' (' + state.allJoinRequests.length + ')';
      state.allJoinRequests.forEach(function (req) {
        const li = document.createElement('li');
        const label = document.createElement('span');
        label.textContent = (req.displayName ? req.displayName + ' — ' : '') + req.email
          + ' (' + (req.provider || 'unknown') + ')';
        const acceptBtn = document.createElement('button');
        acceptBtn.textContent = 'Accept';
        acceptBtn.addEventListener('click', function () { acceptJoinRequest(req); });
        const rejectBtn = document.createElement('button');
        rejectBtn.textContent = 'Reject';
        rejectBtn.addEventListener('click', function () { rejectJoinRequest(req); });
        li.appendChild(label);
        li.appendChild(acceptBtn);
        li.appendChild(rejectBtn);
        adminJoinRequestsEl.appendChild(li);
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
      adminPlayersListEl.innerHTML = '';
      if (state.allPlayers.length === 0) {
        const empty = document.createElement('li');
        empty.textContent = 'No whitelisted players yet.';
        adminPlayersListEl.appendChild(empty);
        return;
      }
      state.allPlayers.slice().sort(function (a, b) { return a.id.localeCompare(b.id); }).forEach(function (p) {
        const li = document.createElement('li');
        const label = document.createElement('span');
        label.textContent = p.id + (p.displayName ? ' (' + p.displayName + ')' : '');
        const removeBtn = document.createElement('button');
        removeBtn.textContent = 'Remove';
        removeBtn.addEventListener('click', function () {
          const confirmed = window.confirm('Remove ' + p.id + ' from the player whitelist?');
          if (!confirmed) return;
          deleteDoc(doc(db, 'players', p.id)).catch(function (err) {
            alert('Remove failed: ' + err.message);
          });
        });
        li.appendChild(label);
        li.appendChild(removeBtn);
        adminPlayersListEl.appendChild(li);
      });
    }

    adminAddPlayerBtn.addEventListener('click', function () {
      const email = adminAddPlayerEmailEl.value.trim().toLowerCase();
      adminAddPlayerErrorEl.textContent = '';
      if (!email || email.indexOf('@') === -1) {
        adminAddPlayerErrorEl.textContent = 'Enter a valid email.';
        return;
      }
      adminAddPlayerBtn.disabled = true;
      setDoc(doc(db, 'players', email), { addedAt: serverTimestamp() }, { merge: true }).then(function () {
        adminAddPlayerBtn.disabled = false;
        adminAddPlayerEmailEl.value = '';
      }).catch(function (err) {
        adminAddPlayerBtn.disabled = false;
        adminAddPlayerErrorEl.textContent = 'Add failed: ' + err.message;
      });
    });


export { attachAdminListeners, renderAdminRootMapSelect };
