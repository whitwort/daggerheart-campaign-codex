// visibility.js — Phase 14 S1. The single effective-visibility function.
//
// Every visibility READ check in the app routes through canSee()/
// visibilityBadge() — no surface-local `visibility === 'all-players'`
// comparison survives S1 (see phase-14-design.md §4/§5.1; the map-leak bug
// class that motivated this module came from exactly one missed
// surface-local check). viewerContext() is the single place that resolves
// "who is looking" from live state.
//
// This module is read-only / pure — it never writes. Writes that mutate
// visibility/characterId/characterShared go through sharing.js.

import { state } from './state.js';

// --- viewerContext ----------------------------------------------------
// role: 'gm' | 'player' | 'viewer' — state.currentRole, unchanged.
// gmView: true only for an actual GM NOT currently previewing as player —
//   same definition as the old isGmView() in codex.js/map.js/timeline.js,
//   now keyed off state.gmPreview (Phase 14 S3: null | {playerEmail,
//   activeCharacterId} — was a bare bool pre-S3). S3's own nav toggle
//   only ever sets the generic {playerEmail:null, activeCharacterId:null}
//   shape (no specific-player picker yet — Characters tab flipper is
//   S5), so previewing still evaluates as a characterless player today;
//   the shape change lays the groundwork for S5 without altering current
//   behavior.
// email: signed-in user's email, or null.
// activeCharacterId: the viewer's current active character. For a real
//   player: players/{email}.activeCharacterId, delivered live via the
//   existing player-doc listener in auth.js (state.activeCharacterId).
//   For a previewing GM: state.gmPreview.activeCharacterId (S3 wiring;
//   always null until S5 gives the GM a way to set it). Null for gmView
//   and for a player with none set.
// ownedCharacterIds: entities.id[] where category=='Character' &&
//   ownerId==email. Computed uniformly regardless of role — a GM's email
//   won't normally match any PC's ownerId, so this is naturally empty for
//   GM unless Gregg owns a test Character himself (harmless either way:
//   own-PC authority is intentional per D4 in the design doc).
function viewerContext() {
  const role = state.currentRole;
  // Phase 14 S3: state.gmPreviewAsPlayer (bool) -> state.gmPreview
  // (null | {playerEmail, activeCharacterId}) per phase-14-design.md §5.3
  // -- preview now carries a character identity, not just a generic
  // "player" simulation. S3 itself only ever sets {playerEmail:null,
  // activeCharacterId:null} (no picker UI yet -- Characters tab flipper
  // is S5); this shape change lays the groundwork without behavior
  // change for the existing nav "View: Party" toggle.
  const previewing = role === 'gm' && !!state.gmPreview;
  const gmView = role === 'gm' && !previewing;
  const email = (state.currentUser && state.currentUser.email) || null;
  const ownedCharacterIds = state.allEntities
    .filter(function (e) { return e.category === 'Character' && e.ownerId && e.ownerId === email; })
    .map(function (e) { return e.id; });
  const activeCharacterId = gmView
    ? null
    : (previewing ? (state.gmPreview && state.gmPreview.activeCharacterId) : state.activeCharacterId) || null;
  return {
    role: role,
    gmView: gmView,
    email: email,
    activeCharacterId: activeCharacterId,
    ownedCharacterIds: ownedCharacterIds
  };
}

// Resolves the owning Character entity's id for any lore element:
//  - a loreItem: its entityId
//  - an image: its ownerId (when ownerType=='entity' — the only kind that
//    can belong to a character; non-entity-owned images never do)
//  - an entity itself (no entityId/ownerType field): its own id
// Only meaningful when that id is actually a Character owned by the
// viewer — callers check membership in ctx.ownedCharacterIds, which by
// construction only contains owned-Character ids, so no separate
// category check is needed here.
function elementParentCharacterId(element) {
  if (element.entityId) return element.entityId;
  if (element.ownerType === 'entity' && element.ownerId) return element.ownerId;
  return element.id || null;
}

function ownsParentCharacter(element, ctx) {
  const charId = elementParentCharacterId(element);
  return !!charId && ctx.ownedCharacterIds.indexOf(charId) !== -1;
}

// --- hasFullAuthority / isSharedWithActiveCharacter (Phase 14 S3) --------
// Edit-AUTHORITY checks, distinct from canSee (read access). Used to gate
// edit/delete chrome (§6.2): a viewer with hasFullAuthority over an
// element gets the exact same edit affordances as the GM (create/edit/
// delete, full visibility control); a viewer for whom only
// isSharedWithActiveCharacter is true gets edit-but-not-delete on
// loreItems/images (content/sourceId) plus a characterShared-only toggle
// -- entities in this state get ONLY the characterShared toggle, no
// content edit (rules asymmetry, see phase-14-design.md §7's entities row
// vs. loreItems/images rows). Callers must check hasFullAuthority first;
// isSharedWithActiveCharacter does not imply the absence of full
// authority on its own (though in practice an owned Character's own
// elements are never also `visibility:'character'`-shared to themselves).
function hasFullAuthority(element, ctx) {
  return ctx.gmView || ownsParentCharacter(element, ctx);
}

function isSharedWithActiveCharacter(element, ctx) {
  return !ctx.gmView && !!ctx.activeCharacterId &&
    element.visibility === 'character' && element.characterId === ctx.activeCharacterId;
}

// --- isNoteAuthor (Phase 14 S4) ------------------------------------------
// Full CRUD authority over a specific note (kind:'note'), independent of
// entity ownership -- a note's entityId can be ANY entity (e.g. a
// player's private note about a GM-owned NPC or another player's
// Character), so hasFullAuthority's entity-ownership check doesn't apply
// here. Mirrors the ownership half of canSee's 'author-only' case, but
// (unlike canSee) applies regardless of the note's CURRENT visibility --
// an author keeps full CRUD after their own note is canonized to
// all-players (§6.3's "Owner keeps full CRUD after canonization"), which
// canSee's author-only branch alone wouldn't cover once visibility flips
// away from 'author-only'.
function isNoteAuthor(item, ctx) {
  if (item.kind !== 'note') return false;
  if (item.authorType === 'gm') return ctx.gmView;
  if (item.authorType === 'character') {
    return !!item.authorId && ctx.ownedCharacterIds.indexOf(item.authorId) !== -1;
  }
  return false;
}

// --- belongsOnLoreSurface (Phase 14 S4) -----------------------------------
// Tab-placement rule, distinct from canSee's access decision: a note
// (kind:'note') only joins general Lore-tab-style surfaces
// (loreItemsForEntity's callers -- renderLoreTab, buildEntityPreviewCard)
// once canonized. A still-private note passes canSee for its own author
// (that's the whole point of author-only visibility) but should stay
// exclusive to the Notes tab even then, so it isn't duplicated across both
// surfaces. This is UI routing, not visibility, but lives here rather
// than at each call site so the grep-gate's "no surface-local visibility
// literal outside sharing.js/visibility.js/visibility-ui.js" invariant
// (§5.1) keeps holding.
function belongsOnLoreSurface(item) {
  return item.kind !== 'note' || item.visibility === 'all-players';
}

// --- canSee -------------------------------------------------------------
// Truth table per phase-14-design.md §4. `element` is any lore element:
// an entity, loreItem, or image doc (with its `id` attached, per the
// state.allEntities/allLoreItems/currentEntityImages convention).
//
// GM in gmView sees everything EXCEPT another author's author-only note
// (D5) — that's the one row where gmView != see-everything.
function canSee(element, ctx) {
  const v = element.visibility;

  // Missing/legacy visibility (pre-flag test data): treated as gm-only,
  // same safe default as the pre-S1 code's own comment on this.
  if (v == null) return !!ctx.gmView;

  switch (v) {
    case 'all-players':
      return true;

    case 'gm-only':
      if (ctx.gmView) return true;
      return ownsParentCharacter(element, ctx);

    case 'character':
      if (ctx.gmView) return true;
      if (ctx.activeCharacterId && element.characterId === ctx.activeCharacterId) return true;
      return !!element.characterShared;

    case 'author-only':
      // Notes only (kind=='note'). GM's own gm-authored private notes are
      // visible only in real gmView (not while previewing as player —
      // preview is a genuine simulation, so it shouldn't leak GM-private
      // content back to the GM's own preview screen either). A player
      // never sees the GM's author-only notes, full stop.
      if (element.authorType === 'gm') return ctx.gmView;
      if (element.authorType === 'character') return ownsParentCharacter({ entityId: element.authorId }, ctx);
      return false;

    default:
      return false;
  }
}

// --- visibilityBadge -----------------------------------------------------
// Returns {characterId} when the badge (D3) should render, else null.
// Badge renders iff the REASON the viewer can see the element is a
// player's onward-share (characterShared) or a cannon note authored by a
// character — never for GM-set states (all-players/gm-only/character-not-
// shared-but-viewer-is-GM). Does not itself call canSee — callers should
// only call this after already confirming canSee(element, ctx) is true.
function visibilityBadge(element, ctx) {
  if (element.visibility === 'character' && element.characterShared && element.characterId) {
    return { characterId: element.characterId };
  }
  if (element.kind === 'note' && element.visibility === 'all-players' &&
      element.authorType === 'character' && element.authorId) {
    return { characterId: element.authorId };
  }
  return null;
}

// --- isShareableToWholeParty ---------------------------------------------
// Viewer-independent: "would every player see this", used for denormalized
// party-wide flags (entities.mapImageVisibleToPlayers — see §3.1) AND for
// GM-facing literal-state displays (the entity/lore-item/gallery toggle's
// own checked state, the Entry Browser "hidden" badge) — those are the GM
// looking at what THEIR OWN element's stored state currently is, not an
// access gate, so reading the literal value (not filtering per-viewer) is
// correct there too. NOT a per-viewer check either way, so it does not
// take ctx and must not be used in place of canSee() for actual visibility
// gating (e.g. deciding whether a given player can see something).
function isShareableToWholeParty(element) {
  return element.visibility === 'all-players' ||
    (element.visibility === 'character' && !!element.characterShared);
}

// --- visibilityStateClass -------------------------------------------------
// Literal-state CSS class for GM-facing element chrome (lore-item/gallery-
// item/entity-card wells): 'vis-visible' | 'vis-character' | 'vis-hidden'.
// Same literal-not-per-viewer reasoning as isShareableToWholeParty above.
// In S1 only 'vis-visible'/'vis-hidden' are reachable (no writer sets
// visibility:'character' yet); S2 adds the seafoam CSS for 'vis-character'.
function visibilityStateClass(element) {
  if (element.visibility === 'all-players') return 'vis-visible';
  if (element.visibility === 'character') return 'vis-character';
  return 'vis-hidden';
}

export {
  viewerContext, canSee, visibilityBadge, isShareableToWholeParty, visibilityStateClass,
  hasFullAuthority, isSharedWithActiveCharacter, isNoteAuthor, belongsOnLoreSurface
};
