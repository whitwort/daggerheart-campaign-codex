// sharing.js — Phase 14 S1 (fan-out added S6). The single write seam for
// every mutation of visibility / characterId / characterShared on any lore
// element (entity, loreItem, image). S6 hooks notification fan-out
// (phase-14-design.md §5.2/§6.7) into this seam: every share write below
// computes which players it NEWLY exposes the element to and writes
// notification docs in the SAME batch as the share itself
// (write-at-share-time, never diff-detection) — a write site that
// bypasses this file is a silent missing notification (Risk R4).
//
// S1 migrated all EXISTING share-writes through here (see call sites
// below). S2's kebab-menu 3-state picker, S3's player characterShared
// toggle, and S4's note cannon toggle all call these same functions with
// richer patches. S6 adds createLoreItemShared() — new lore items/notes
// CAN be authored directly at a shared visibility (the edit box's
// visibility control works before first save), so creation is a share
// transition too (from "didn't exist" to visible) and must fan out; the
// old direct addDoc calls in codex.js's saveLoreEdit/saveNoteEdit create
// paths now route through it.
//
// Known-exempt writes — literal defaults / bulk-import writes, NOT
// "shares" (nothing was newly exposed to anyone by a GM/player choice —
// these set an initial or re-imported value) — deliberately left as
// direct writes at their own call sites, not routed through here:
//   - codex.js saveNewEntity(): new entity default visibility:'gm-only'
//   - characters.js "+ New character": new PC literal visibility:'gm-only'
//   - images.js uploadEntityGalleryImage(): new upload default visibility:'gm-only'
//   - import.js bulk JSON import (creates/replaces): literal visibility:'gm-only'
//   - srd-import.js SRD import (create/update): literal visibility:'all-players' (public SRD text)
//     (bulk imports are deliberately silent — re-importing the SRD must
//     not spam every player with hundreds of 'discovered' docs)
// Ownership changes (admin.js/characters.js ownerId reassignment,
// transfer approval) also don't route through here: they change WHO has
// own-PC authority, not any visibility field — not a "share" in §6.7's
// transition table, so no notification fires for them.
// If a future session adds a new literal-default write site, document it
// here rather than leaving it implicit.

import {
  getFirestore, doc, collection, writeBatch, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import { firebaseApp } from './firebase.js';
import { state } from './state.js';
import { viewerContext, canSee } from './visibility.js';

const db = getFirestore(firebaseApp);

// --- S6 fan-out helpers ------------------------------------------------------

// "All players" for fan-out purposes. The GM client always has the real
// whitelist (state.allPlayers, admin listener). A PLAYER client cannot
// read the players collection (rules: own doc only), so when a player is
// the sharing actor (characterShared flip / note cannon) recipients are
// derived from the distinct owners of Character entities instead — the
// party per §1's definition. Known limitation (flagged in the handoff):
// a whitelisted player who owns NO characters won't receive
// player-initiated 'shared' notifications; GM-initiated shares (which use
// the real whitelist) still reach them.
function playersUniverse() {
  if (state.allPlayers && state.allPlayers.length) {
    return state.allPlayers.map(function (p) { return p.id; });
  }
  const seen = {};
  state.allEntities.forEach(function (e) {
    if (e.category === 'Character' && e.ownerId) seen[e.ownerId] = true;
  });
  return Object.keys(seen);
}

function characterOwnerEmail(charId) {
  if (!charId) return null;
  const c = state.allEntities.find(function (e) { return e.id === charId; });
  return (c && c.ownerId) || null;
}

// The set of player emails that can currently see `elem`, per canSee's
// truth table (§4), expressed set-wise so a before/after diff yields the
// newly-exposed recipients. Mirrors canSee rather than calling it per
// player because canSee needs a per-viewer ctx and this needs the whole
// party at once.
function exposedEmailSet(elem, universe) {
  const out = {};
  if (!elem) return out;
  const v = elem.visibility;
  if (v === 'all-players') {
    universe.forEach(function (e) { out[e] = true; });
  } else if (v === 'character') {
    const o = characterOwnerEmail(elem.characterId);
    if (o) out[o] = true;
    if (elem.characterShared) universe.forEach(function (e) { out[e] = true; });
  } else if (v === 'author-only') {
    if (elem.authorType === 'character') {
      const o = characterOwnerEmail(elem.authorId);
      if (o) out[o] = true;
    }
  }
  // Own-PC authority (canSee's gm-only row 1): the parent Character's
  // owner sees the element regardless of its visibility state.
  let parentId = null;
  if (elem.entityId) parentId = elem.entityId;
  else if (elem.ownerType === 'entity') parentId = elem.ownerId;
  else if (elem.id) parentId = elem.id;
  if (parentId) {
    const pc = state.allEntities.find(function (e) {
      return e.id === parentId && e.category === 'Character';
    });
    if (pc && pc.ownerId) out[pc.ownerId] = true;
  }
  return out;
}

// Minimal per-recipient viewer ctx for the parent-entity gate below. On a
// player-actor client state.allPlayers is empty, so the recipient's
// activeCharacterId is unknown (null) — a parent entity visible to the
// recipient ONLY via their active character then fails the gate and that
// recipient is conservatively skipped rather than notified about an
// entity name this client can't confirm they see.
function recipientCtxFor(email) {
  const p = (state.allPlayers || []).find(function (pp) { return pp.id === email; });
  return {
    role: 'player',
    gmView: false,
    email: email,
    activeCharacterId: (p && p.activeCharacterId) || null,
    ownedCharacterIds: state.allEntities
      .filter(function (e) { return e.category === 'Character' && e.ownerId === email; })
      .map(function (e) { return e.id; })
  };
}

// Appends notification set()s to `batch` for every player this share
// newly exposes the element to (§6.7's transition table).
//   type: 'entity' | 'loreItem' | 'image'
//   beforeSet: exposedEmailSet of the element BEFORE the write — pass {}
//     for a create (the element exposed nobody because it didn't exist).
//   mergedElem: the element as it will exist AFTER the write (old fields
//     merged with the patch), with its id attached.
// kind mapping: GM actor → 'discovered' (entity) / 'learned' (child
// element); player actor → 'shared' with actorCharacterId. Child-element
// notifications are additionally gated on the recipient being able to
// see the PARENT entity — "learned more about Y" for a Y whose existence
// the recipient doesn't know would itself be a leak.
// Fan-out failure must never block the share itself, so this whole
// function is defensive: on any throw it logs and returns, leaving the
// batch with the share write (and any notifications appended before the
// throw) intact.
function appendShareNotifications(batch, type, beforeSet, mergedElem) {
  try {
    const ctx = viewerContext();
    const universe = playersUniverse();
    const after = exposedEmailSet(mergedElem, universe);

    let entityId = null;
    let loreItemId = null;
    if (type === 'entity') {
      entityId = mergedElem.id;
    } else if (type === 'loreItem') {
      entityId = mergedElem.entityId;
      loreItemId = mergedElem.id || null;
    } else if (type === 'image') {
      entityId = mergedElem.ownerType === 'entity' ? mergedElem.ownerId : null;
    }
    if (!entityId) return;

    const parentEntity = type === 'entity' ? null
      : (state.allEntities.find(function (e) { return e.id === entityId; }) || null);

    let kind;
    let actorCharacterId = null;
    if (ctx.gmView) {
      kind = type === 'entity' ? 'discovered' : 'learned';
    } else {
      kind = 'shared';
      if (mergedElem.kind === 'note' && mergedElem.authorType === 'character') {
        actorCharacterId = mergedElem.authorId || null;
      } else if (mergedElem.characterId) {
        // characterShared flip: the sharing character is the share target.
        actorCharacterId = mergedElem.characterId;
      } else {
        // Full-authority share on an owned Character's own element: the
        // acting character is the parent PC itself.
        const parentChar = type === 'entity' ? mergedElem.id : entityId;
        actorCharacterId = ctx.ownedCharacterIds.indexOf(parentChar) !== -1
          ? parentChar
          : (ctx.activeCharacterId || null);
      }
    }

    Object.keys(after).forEach(function (email) {
      if (beforeSet[email] || email === ctx.email) return;
      if (type !== 'entity' && parentEntity && !canSee(parentEntity, recipientCtxFor(email))) return;
      batch.set(doc(collection(db, 'notifications')), {
        recipientEmail: email,
        kind: kind,
        entityId: entityId,
        loreItemId: loreItemId,
        actorCharacterId: actorCharacterId,
        createdAt: serverTimestamp(),
        seenAt: null
      });
    });
  } catch (err) {
    console.error('notification fan-out failed (share write still applied):', err);
  }
}

// --- Drop-recording interception (Phase 17 B1) --------------------------------
// While state.dropRecording is set (GM opened the "+ New drop" recorder),
// a PURE visibility patch ({visibility, characterId, characterShared}
// subset only) on any of the three share functions below is recorded
// into the drop instead of written to Firestore; the read-time overlay
// in visibility.js makes every surface reflect it. A COMBINED patch
// (lore edit box's content+visibility save) writes through unchanged and
// is NOT recorded — documented v1 limitation (the recording gestures are
// the quick toggles/kebab). createLoreItemShared also writes through:
// creations aren't visibility CHANGES.
//
// `from` captures the element's REAL (pre-recording) state: a re-toggle
// of an already-recorded element keeps the original from and only moves
// `to`, so toggling somewhere and back yields a no-op entry rather than
// two contradictory ones. All three fields are normalized (null / bool)
// — Firestore rejects undefined, and Run/Undo apply these objects as
// literal update patches.

const VIS_FIELDS = ['visibility', 'characterId', 'characterShared'];

function isPureVisibilityPatch(patch) {
  return Object.keys(patch).every(function (k) { return VIS_FIELDS.indexOf(k) !== -1; });
}

function normalizeVisState(src) {
  return {
    visibility: src.visibility || 'gm-only',
    characterId: src.characterId || null,
    characterShared: !!src.characterShared
  };
}

function entityNameFor(entityId) {
  const e = state.allEntities.find(function (x) { return x.id === entityId; });
  return (e && e.name) || '(unknown entry)';
}

// Returns true when the write was captured by the recorder (caller must
// then skip its Firestore write). type: 'entity'|'loreItem'|'image'.
function maybeRecordDropChange(type, elementId, oldElem, patch) {
  const rec = state.dropRecording;
  if (!rec || !isPureVisibilityPatch(patch) || !oldElem) return false;
  const key = type + ':' + elementId;
  const existing = rec.overlay[key];
  const from = existing ? existing.from : normalizeVisState(oldElem);
  const base = existing ? existing.to : normalizeVisState(oldElem);
  const to = normalizeVisState(Object.assign({}, base, patch));
  const entityId = type === 'entity' ? elementId
    : (type === 'loreItem' ? oldElem.entityId
       : (oldElem.ownerType === 'entity' ? oldElem.ownerId : null));
  const change = {
    elementType: type,
    elementId: elementId,
    entityId: entityId,
    label: type === 'entity' ? (oldElem.name || '(unnamed)')
      : (type === 'loreItem' ? 'Lore on ' + entityNameFor(entityId)
         : 'Image on ' + entityNameFor(entityId)),
    isMap: type === 'image' ? !!oldElem.isMap : false,
    // loreItems only: exposedEmailSet's author-only branch needs these at
    // Run/Undo time (a GM note cannonized inside a drop records an
    // author-only endpoint). Null for entities/images.
    authorType: (type === 'loreItem' && oldElem.authorType) || null,
    authorId: (type === 'loreItem' && oldElem.authorId) || null,
    from: from,
    to: to
  };
  rec.overlay[key] = { from: from, to: to };
  const idx = rec.changes.findIndex(function (c) {
    return c.elementType === type && c.elementId === elementId;
  });
  if (idx === -1) rec.changes.push(change); else rec.changes[idx] = change;
  document.dispatchEvent(new CustomEvent('droprecording:change'));
  return true;
}

// --- share writes -------------------------------------------------------------

// entities: the GM 3-state kebab/toggle (codex.js buildEntityVisibilityToggle,
// patches {visibility, characterId[, characterShared]}) and the player's
// characterShared-only flip on their own shared PC entity.
function shareEntityVisibility(entityId, patch) {
  const old = state.allEntities.find(function (e) { return e.id === entityId; }) || null;
  if (maybeRecordDropChange('entity', entityId, old, patch)) return Promise.resolve();
  const batch = writeBatch(db);
  batch.update(doc(db, 'entities', entityId),
    Object.assign({}, patch, { updatedAt: serverTimestamp() }));
  if (old) {
    const universe = playersUniverse();
    appendShareNotifications(batch, 'entity',
      exposedEmailSet(old, universe),
      Object.assign({}, old, patch, { id: entityId }));
  }
  return batch.commit();
}

// loreItems: covers the quick toggle switch (visibility only), saveLoreEdit's
// combined content+visibility+meta+sourceId write, note saves/cannon flips,
// and the player's characterShared flip — all mutate visibility-family
// fields, so all route through here as a single Firestore batch each.
function shareLoreItemVisibility(itemId, patch) {
  const old = state.allLoreItems.find(function (i) { return i.id === itemId; }) || null;
  if (maybeRecordDropChange('loreItem', itemId, old, patch)) return Promise.resolve();
  const batch = writeBatch(db);
  batch.update(doc(db, 'loreItems', itemId),
    Object.assign({}, patch, { updatedAt: serverTimestamp() }));
  if (old) {
    const universe = playersUniverse();
    appendShareNotifications(batch, 'loreItem',
      exposedEmailSet(old, universe),
      Object.assign({}, old, patch, { id: itemId }));
  }
  return batch.commit();
}

// New lore items and notes (Phase 14 S6): the edit box's visibility
// control works BEFORE the first save, so a brand-new item can be born
// directly at all-players/character visibility — a share transition from
// "didn't exist" (exposed to nobody) to its initial state. The old direct
// addDoc calls in codex.js's saveLoreEdit/saveNoteEdit isNew paths route
// through here now so that transition fans out like any other.
function createLoreItemShared(fields) {
  const ref = doc(collection(db, 'loreItems'));
  const batch = writeBatch(db);
  batch.set(ref, fields);
  appendShareNotifications(batch, 'loreItem', {},
    Object.assign({}, fields, { id: ref.id }));
  return batch.commit();
}

// images: mirrors the map-sync batch logic that lived in images.js's old
// setGalleryImageVisibility (moved here in S1, same reasoning as that
// function's original comment — if the image being shared is the current
// map image, entities.mapImageVisibleToPlayers must stay in sync in the
// same batch, using the extended §3.1 semantics: all-players OR
// (character && characterShared)).
function shareImageVisibility(imageDocId, patch) {
  const img = state.currentEntityImages.find(function (i) { return i.id === imageDocId; });
  if (maybeRecordDropChange('image', imageDocId, img, patch)) return Promise.resolve();
  const merged = Object.assign({}, img, patch, { id: imageDocId });
  const wholePartyVisible = merged.visibility === 'all-players' ||
    (merged.visibility === 'character' && !!merged.characterShared);
  const batch = writeBatch(db);
  batch.update(doc(db, 'images', imageDocId), patch);
  if (img && img.isMap) {
    batch.update(doc(db, 'entities', img.ownerId), {
      mapImageVisibleToPlayers: wholePartyVisible, updatedAt: serverTimestamp()
    });
  }
  if (img) {
    const universe = playersUniverse();
    appendShareNotifications(batch, 'image', exposedEmailSet(img, universe), merged);
  }
  return batch.commit();
}

// playersUniverse/exposedEmailSet/recipientCtxFor exported for
// stables.js's Run-time
// consolidated 'lore-drop' notification computation (Phase 17 B4) — the
// same before/after set diff this module uses for per-share fan-out.
export {
  shareEntityVisibility, shareLoreItemVisibility, shareImageVisibility, createLoreItemShared,
  playersUniverse, exposedEmailSet, recipientCtxFor
};
