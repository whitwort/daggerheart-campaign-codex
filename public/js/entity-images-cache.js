// entity-images-cache.js — Phase 14 S8 bugfix. A per-entity `images`
// collection watcher, INDEPENDENT of codex.js's own global
// state.entityImagesTargetId/currentEntityImages -- that cache is
// scoped to whichever entity is currently selected on the CODEX tab
// specifically (setEntityImagesTarget is only ever called from
// renderDetailForSelected). Map/Timeline tab entity cards were reading
// portraitImageFor() against that same shared cache without ever
// retargeting it themselves, so a portrait silently wouldn't show on
// the Map tab until the same entity had also been opened on the Codex
// tab at least once that session (whatever populated the cache last).
//
// createEntityImagesCache(onChange) gives each caller its OWN
// independent target/cache/listener -- multiple simultaneous surfaces
// (Map tab pin card, Timeline tab scene card, Codex tab's own detail
// pane) never fight over a single shared target, same reasoning as
// characters.js's GM-preview card deliberately not reusing codex.js's
// stateful renderEntityViewCard machinery (see that module's header
// comment).

import { getFirestore, collection, query, where, onSnapshot } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import { firebaseApp } from './firebase.js';

const db = getFirestore(firebaseApp);

// onChange(images) fires whenever the target's images change (including
// immediately, synchronously-ish, on setTarget(null) with an empty
// array) -- callers typically just re-render their card from it.
function createEntityImagesCache(onChange) {
  let targetId = null;
  let images = [];
  let unsub = null;

  function setTarget(entityId) {
    if (targetId === entityId && (unsub || !entityId)) return;
    if (unsub) { unsub(); unsub = null; }
    targetId = entityId;
    images = [];
    if (!entityId) { onChange(images); return; }
    unsub = onSnapshot(
      query(collection(db, 'images'), where('ownerId', '==', entityId)),
      function (snapshot) {
        if (targetId !== entityId) return; // stale snapshot after retarget
        images = [];
        snapshot.forEach(function (docSnap) {
          images.push(Object.assign({ id: docSnap.id }, docSnap.data()));
        });
        onChange(images);
      },
      function (err) { console.error('entity images cache listener error:', err.message); }
    );
  }

  function getImages() { return images; }

  function destroy() {
    if (unsub) { unsub(); unsub = null; }
    targetId = null;
    images = [];
  }

  return { setTarget: setTarget, getImages: getImages, destroy: destroy };
}

export { createEntityImagesCache };
