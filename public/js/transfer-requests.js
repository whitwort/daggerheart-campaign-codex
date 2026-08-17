// transfer-requests.js — Phase 14 S8. Approve/reject logic for
// transferRequests docs, extracted out of admin.js so it can also be
// called from characters.js (GM view's own duplicate of the pending-
// claims notification, alongside the existing Admin tab queue) without
// adding a new admin.js<->characters.js import edge -- admin.js already
// imports renderCharactersTab from characters.js, and characters.js
// already imports from codex.js which imports from admin.js (a real
// 3-node cycle, see characters.js's own header comment); a direct
// characters.js -> admin.js import would have closed that into a
// tighter 2-node cycle instead. This module has no dependency on either,
// so both can import it with zero cycle risk.

import { getFirestore, doc, updateDoc, deleteDoc, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import { firebaseApp } from './firebase.js';

const db = getFirestore(firebaseApp);

function approveTransferRequest(req) {
  return updateDoc(doc(db, 'entities', req.characterId), { ownerId: req.toEmail, updatedAt: serverTimestamp() })
    .then(function () { return deleteDoc(doc(db, 'transferRequests', req.id)); })
    .catch(function (err) { window.alert('Approve failed: ' + err.message); });
}

function rejectTransferRequest(req) {
  return deleteDoc(doc(db, 'transferRequests', req.id)).catch(function (err) {
    window.alert('Reject failed: ' + err.message);
  });
}

export { approveTransferRequest, rejectTransferRequest };
