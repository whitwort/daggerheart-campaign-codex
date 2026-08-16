// sharing.js — Phase 14 S1. The single write seam for every mutation of
// visibility / characterId / characterShared on any lore element (entity,
// loreItem, image). This is the seam S6 hooks notification fan-out into
// (phase-14-design.md §5.2/§6.7) — a write site that bypasses this file is
// a silent missing notification (Risk R4).
//
// S1 migrates all EXISTING share-writes through here (see call sites
// below). Future sessions' new share-writes (S2's kebab-menu 3-state
// picker, S3's player characterShared toggle, S4's note cannon toggle)
// call these same functions with richer patches — the functions
// themselves don't change shape, only the patches callers pass in.
//
// Known-exempt writes — literal defaults / bulk-import writes, NOT
// "shares" (nothing was newly exposed to anyone by a GM/player choice —
// these set an initial or re-imported value) — deliberately left as
// direct writes at their own call sites, not routed through here:
//   - codex.js saveNewEntity(): new entity default visibility:'gm-only'
//   - images.js uploadEntityGalleryImage(): new upload default visibility:'gm-only'
//   - images.js migrateLegacyMapImageIfNeeded(): legacy-doc migration default visibility:'gm-only'
//   - import.js bulk JSON import (creates/replaces): literal visibility:'gm-only'
//   - srd-import.js SRD import (create/update): literal visibility:'all-players' (public SRD text)
// If a future session adds a new literal-default write site, document it
// here rather than leaving it implicit.

import {
  getFirestore, doc, updateDoc, writeBatch, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import { firebaseApp } from './firebase.js';
import { state } from './state.js';

const db = getFirestore(firebaseApp);

// entities: GM binary toggle (codex.js buildEntityVisibilityToggle) today;
// S2's kebab popover will pass richer patches ({visibility, characterId,
// characterShared}) through this same function.
function shareEntityVisibility(entityId, patch) {
  return updateDoc(doc(db, 'entities', entityId), Object.assign({}, patch, { updatedAt: serverTimestamp() }));
}

// loreItems: covers both the quick toggle switch (visibility only) and
// saveLoreEdit's combined content+visibility+meta+sourceId write — both
// mutate visibility, so both route through here as a single Firestore
// call each (no separate visibility-only write, to avoid a second
// round-trip / a race between two writes to the same doc).
function shareLoreItemVisibility(itemId, patch) {
  return updateDoc(doc(db, 'loreItems', itemId), Object.assign({}, patch, { updatedAt: serverTimestamp() }));
}

// images: mirrors the map-sync batch logic that lived in images.js's old
// setGalleryImageVisibility (moved here verbatim, same reasoning as that
// function's original comment — if the image being shared is the current
// map image, entities.mapImageVisibleToPlayers must stay in sync in the
// same batch, using the extended §3.1 semantics: all-players OR
// (character && characterShared)).
function shareImageVisibility(imageDocId, patch) {
  const img = state.currentEntityImages.find(function (i) { return i.id === imageDocId; });
  const merged = Object.assign({}, img, patch);
  const wholePartyVisible = merged.visibility === 'all-players' ||
    (merged.visibility === 'character' && !!merged.characterShared);
  if (img && img.isMap) {
    const batch = writeBatch(db);
    batch.update(doc(db, 'images', imageDocId), patch);
    batch.update(doc(db, 'entities', img.ownerId), {
      mapImageVisibleToPlayers: wholePartyVisible, updatedAt: serverTimestamp()
    });
    return batch.commit();
  }
  return updateDoc(doc(db, 'images', imageDocId), patch);
}

export { shareEntityVisibility, shareLoreItemVisibility, shareImageVisibility };
