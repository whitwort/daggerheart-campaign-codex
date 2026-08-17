// characters.js — Phase 14 S5, restyled S8, cards UI removed S10. The
// Characters tab.
//
// S10 (per Gregg): the Characters tab no longer shows or edits card
// data at all -- that briefly lived here (S5-S9 -- editable in the
// player's own view, read-only in the GM's), then moved to be shared
// with the Codex tab's entity edit form (S9), and finally got dropped
// from this tab entirely (S10) once having it in two places caused
// more confusion than it solved. The ONLY place character cards are
// viewed/edited now is: Codex tab -> select a Character entry -> Edit
// -> Save/Cancel (character-cards.js). Both detail panes below are
// deliberately left empty on selection for now -- Gregg's planned
// "character deck" viewer (a different, not-yet-designed feature) will
// live here later.
//
// GM view ("Players & Characters"): left pane lists every party member
// with an inline "+ assign"/"x remove" UI for the ownerId association
// (moved here from the Codex-tab entity-edit form in S8 -- see codex.js);
// right pane just shows the selected character's name for now (see
// above -- no card viewer).
//
// Player view: left pane lists the player's own characters (name +
// active-toggle + self-release "x", same pattern as the GM pane's
// remove); right pane just shows the selected character's name for now
// (see above -- no card editor); "Claim Character"/"+ Create Character"
// live at the bottom (S8) -- Claim opens a popup over the existing
// PC-tagged/unowned/visible transferRequests flow, Create routes
// through codex.js's New Entity dialog (category Character, tag PC
// preset).
//
// The GM's FULL transferRequests collection listener (unfiltered --
// needed for the unified Requests queue) lives in admin.js beside
// joinRequests, per Gregg's placement call: extend the existing Admin
// tab section + its nav badge, not a separate nav element. This module
// only owns the player-scoped "my own pending requests" listener
// (state.myTransferRequests, `where toEmail==self` -- an unfiltered
// collection listener would be rules-denied for a non-GM, same reason
// joinRequests/players are GM-only collection reads elsewhere in this
// app) -- used here to gray out an already-requested "Request transfer"
// button, and to show a "(pending)" label in the Claim popup.

import {
  getFirestore, doc, collection, addDoc, deleteDoc, updateDoc,
  onSnapshot, query, where, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import { firebaseApp } from './firebase.js';
import { state } from './state.js';
import { attachListener, detachListener, safeSnapshotHandler } from './listeners.js';
import { trackWrite } from './connectivity.js';
import { canSee, viewerContext, hasFullAuthority } from './visibility.js';
import { switchToCodexTabForEntity, openNewEntityDialog } from './codex.js';
import { generateDefaultBadgeColor } from './badge-color.js';
import { approveTransferRequest, rejectTransferRequest } from './transfer-requests.js';

const db = getFirestore(firebaseApp);

function byName(a, b) { return (a.name || '').localeCompare(b.name || ''); }

const charactersGmViewEl = document.getElementById('characters-gm-view');
const charactersPlayerViewEl = document.getElementById('characters-player-view');
const charactersFlipperListEl = document.getElementById('characters-flipper-list');
const charactersDetailPaneEl = document.getElementById('characters-detail-pane');
const charactersGmNewBtnEl = document.getElementById('characters-gm-new-btn');
const charactersPlayerOwnListEl = document.getElementById('characters-player-own-list');
const charactersPlayerSelectedEl = document.getElementById('characters-player-selected');
const charactersClaimBtnEl = document.getElementById('characters-claim-btn');
const charactersCreateBtnEl = document.getElementById('characters-create-btn');
const charactersClaimPopupEl = document.getElementById('characters-claim-popup');
const charactersSetActiveBtnEl = document.getElementById('characters-set-active-btn');
const charactersPendingClaimsEl = document.getElementById('characters-pending-claims');

// --- transferRequests: player-scoped listener (own requests only) --------
function attachCharacterTransferListeners() {
  const email = state.currentUser && state.currentUser.email;
  if (!email) return;
  attachListener('myTransferRequestsUnsub', function () {
    return onSnapshot(
      query(collection(db, 'transferRequests'), where('toEmail', '==', email)),
      safeSnapshotHandler('myTransferRequests', function (snapshot) {
        state.myTransferRequests = [];
        snapshot.forEach(function (docSnap) {
          state.myTransferRequests.push(Object.assign({ id: docSnap.id }, docSnap.data()));
        });
        renderCharactersTab();
      }),
      function (err) { console.error('myTransferRequests listener failed:', err.message); }
    );
  });
}
function detachCharacterTransferListeners() {
  detachListener('myTransferRequestsUnsub');
}


// GM-only: assign an unowned PC-tagged Character to a player (Phase 14
// S8's "Players & Characters" panel replaces the old owner-reassign
// <select> in the detail pane -- assignment now lives in the list
// itself, next to each player, per Gregg's explicit layout ask).
function assignCharacterToPlayer(entityId, email) {
  trackWrite(
    updateDoc(doc(db, 'entities', entityId), { ownerId: email, updatedAt: serverTimestamp() }),
    'Assigning character'
  ).catch(function (err) { window.alert('Assign failed: ' + err.message); });
}

// GM-only: unassign (NOT delete) -- also clears the player's
// activeCharacterId if it pointed at this now-unowned character, so no
// dangling reference survives the unassign.
function unassignCharacterGm(entity) {
  trackWrite(
    updateDoc(doc(db, 'entities', entity.id), { ownerId: null, updatedAt: serverTimestamp() }),
    'Removing character from player'
  ).then(function () {
    const p = state.allPlayers.find(function (pl) { return pl.id === entity.ownerId; });
    if (p && p.activeCharacterId === entity.id) {
      updateDoc(doc(db, 'players', entity.ownerId), { activeCharacterId: null }).catch(function () {});
    }
  }).catch(function (err) { window.alert('Remove failed: ' + err.message); });
  if (state.charactersSelectedId === entity.id) state.charactersSelectedId = null;
}

// Player self-service: drop your own Character's ownerId to null (NOT a
// delete) -- rules-permitted via firestore.rules' dedicated "self-
// release" clause (ownerId -> null, nothing else, in the same write;
// players otherwise can't touch their own ownerId at all).
function unassignCharacterSelf(entity) {
  trackWrite(
    updateDoc(doc(db, 'entities', entity.id), { ownerId: null, updatedAt: serverTimestamp() }),
    'Removing character from your list'
  ).catch(function (err) { window.alert('Remove failed: ' + err.message); });
  if (state.charactersSelectedId === entity.id) state.charactersSelectedId = null;
}


// Builds a `.entity-group-list` <li> matching the Codex tab's own
// entity-row markup exactly (entity-name / entity-right-col) -- see
// codex.js's buildEntityLi. Reused for every character row across GM/
// player views and the Claim popup, per Gregg's explicit styling-parity
// Small solid dot showing a character's badgeColor, same visual language
// as the Codex tab's entity-group-dot (category-color cue). Falls back
// to a deterministic per-name generated color (badge-color.js) when
// unset, rather than a flat grey -- two un-colored characters still
// read as visually distinct in a list.
function buildBadgeDot(entity) {
  const dot = document.createElement('span');
  dot.className = 'character-badge-dot';
  dot.style.background = entity.badgeColor || generateDefaultBadgeColor(entity.name);
  return dot;
}

// ask (S8): Codex category headers <-> Characters tab player headers,
// Codex entity rows <-> Characters tab character rows. onClickOverride,
// when given, replaces the default "select for viewing" click behavior
// -- used by the player view's "Set active" picking mode (S8).
function buildCharacterLi(entity, rightColBuilder, onClickOverride) {
  const li = document.createElement('li');
  if (entity.id === state.charactersSelectedId) li.classList.add('active');
  if (entity.id === state.activeCharacterId) li.classList.add('characters-active-pc');
  const nameGroup = document.createElement('div');
  nameGroup.className = 'characters-name-group';
  nameGroup.appendChild(buildBadgeDot(entity));
  const nameDiv = document.createElement('div');
  nameDiv.className = 'entity-name';
  nameDiv.textContent = entity.name;
  nameGroup.appendChild(nameDiv);
  li.appendChild(nameGroup);
  const rightCol = document.createElement('div');
  rightCol.className = 'entity-right-col';
  rightColBuilder(rightCol);
  if (rightCol.children.length) li.appendChild(rightCol);
  li.addEventListener('click', function () {
    if (onClickOverride) { onClickOverride(); return; }
    state.charactersSelectedId = entity.id;
    state.charactersSelectedAutoPicked = false;
    renderCharactersTab();
  });
  return li;
}

// --- GM view: "Players & Characters" ------------------------------------
function buildRemoveIconBtn(title, onClick) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'characters-remove-btn';
  btn.title = title;
  btn.textContent = '\u00d7';
  btn.addEventListener('click', function (ev) { ev.stopPropagation(); onClick(); });
  return btn;
}

// GM view's own copy of the pending-transfer-request notifications
// (Admin tab's unified Requests queue is the other place these show,
// D8/§6.5/S5 -- this is a deliberate DUPLICATE, not a replacement, so
// the GM can approve/reject a claim without leaving the Characters tab
// while still testing/reviewing player-character assignments there).
// Rendered as a banner spanning the full tab width, above both panes
// (#characters-pending-claims sits outside .characters-layout in the
// HTML) -- not tucked inside the "Players & Characters" list-pane,
// since a pending claim is worth surfacing at a glance regardless of
// which pane the GM's attention is on.
// state.allTransferRequests is populated by admin.js's listener, which
// attaches for the whole GM session regardless of active tab (auth.js),
// so this reads live data with no listener of its own needed here.
// Reuses the same .admin-notification/.admin-notification-warning
// styling as the Admin tab row for visual consistency between the two
// surfaces. Join requests (player account access, not character
// ownership) are deliberately NOT duplicated here -- out of scope for
// a Characters tab.
function renderPendingClaims() {
  charactersPendingClaimsEl.innerHTML = '';
  if (!state.allTransferRequests.length) return;
  state.allTransferRequests.forEach(function (req) {
    const character = state.allEntities.find(function (e) { return e.id === req.characterId; });
    const requester = state.allPlayers.find(function (p) { return p.id === req.toEmail; });
    const box = document.createElement('div');
    box.className = 'admin-notification admin-notification-warning';
    const label = document.createElement('span');
    label.textContent = (requester && requester.displayName ? requester.displayName + ' \u2014 ' : '') + req.toEmail
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

    charactersPendingClaimsEl.appendChild(box);
  });
}

function renderCharactersGmView(ctx) {
  renderPendingClaims();
  charactersFlipperListEl.innerHTML = '';
  const allCharacters = state.allEntities.filter(function (e) { return e.category === 'Character'; });
  const owned = allCharacters.filter(function (e) { return e.ownerId; });
  // PC-tagged, unowned -- eligible for the inline "+ assign" picker,
  // same claimability gate as the player-side "Claim Character" list
  // (§11.6: tags include 'pc', case-insensitive).
  const assignable = allCharacters.filter(function (e) {
    return !e.ownerId && (e.tags || []).some(function (t) { return t.toLowerCase() === 'pc'; });
  }).sort(byName);

  const byPlayer = {};
  owned.forEach(function (e) { (byPlayer[e.ownerId] = byPlayer[e.ownerId] || []).push(e); });

  const playersSorted = state.allPlayers.slice().sort(function (a, b) {
    return (a.displayName || a.id).localeCompare(b.displayName || b.id);
  });

  if (!playersSorted.length) {
    const p = document.createElement('p');
    p.className = 'lore-empty';
    p.textContent = 'No party members yet -- add one on the Admin tab.';
    charactersFlipperListEl.appendChild(p);
  } else {
    playersSorted.forEach(function (player) {
      const email = player.id;
      const ownedList = (byPlayer[email] || []).slice().sort(byName);
      const header = document.createElement('div');
      header.className = 'entity-group-header';
      const titleSpan = document.createElement('span');
      titleSpan.className = 'entity-group-title';
      titleSpan.textContent = player.displayName || email;
      const countSpan = document.createElement('span');
      countSpan.className = 'entity-group-count';
      countSpan.textContent = '(' + ownedList.length + ')';
      const addBtn = document.createElement('button');
      addBtn.type = 'button';
      addBtn.className = 'characters-add-btn';
      addBtn.title = 'Assign a character to ' + (player.displayName || email);
      addBtn.textContent = '+';
      addBtn.addEventListener('click', function (ev) {
        ev.stopPropagation();
        state.charactersAssignOpenPlayerEmail = (state.charactersAssignOpenPlayerEmail === email) ? null : email;
        renderCharactersTab();
      });
      header.appendChild(titleSpan);
      header.appendChild(countSpan);
      header.appendChild(addBtn);
      charactersFlipperListEl.appendChild(header);

      const ul = document.createElement('ul');
      ul.className = 'entity-group-list';
      ownedList.forEach(function (e) {
        ul.appendChild(buildCharacterLi(e, function (rightCol) {
          rightCol.appendChild(buildRemoveIconBtn('Remove from ' + (player.displayName || email), function () {
            unassignCharacterGm(e);
          }));
        }));
      });
      charactersFlipperListEl.appendChild(ul);

      if (state.charactersAssignOpenPlayerEmail === email) {
        const assignList = document.createElement('ul');
        assignList.className = 'entity-group-list characters-assign-picker';
        if (!assignable.length) {
          const li = document.createElement('li');
          li.className = 'lore-empty';
          li.textContent = '(no unassigned PC-tagged characters)';
          assignList.appendChild(li);
        } else {
          assignable.forEach(function (e) {
            const li = document.createElement('li');
            const nameGroup = document.createElement('div');
            nameGroup.className = 'characters-name-group';
            nameGroup.appendChild(buildBadgeDot(e));
            const nameDiv = document.createElement('div');
            nameDiv.className = 'entity-name';
            nameDiv.textContent = e.name;
            nameGroup.appendChild(nameDiv);
            li.appendChild(nameGroup);
            li.addEventListener('click', function () {
              assignCharacterToPlayer(e.id, email);
              state.charactersAssignOpenPlayerEmail = null;
            });
            assignList.appendChild(li);
          });
        }
        charactersFlipperListEl.appendChild(assignList);
      }
    });
  }

  charactersDetailPaneEl.innerHTML = '';
  const selected = owned.find(function (e) { return e.id === state.charactersSelectedId; });
  if (!selected) {
    const p = document.createElement('p');
    p.className = 'lore-empty';
    p.textContent = "Select a party member's character.";
    charactersDetailPaneEl.appendChild(p);
    return;
  }
  // S10: no card viewer here anymore -- see module header. Just the
  // name, confirming the selection landed; deck viewer (Gregg's planned
  // feature, not yet designed) will replace this.
  const heading = document.createElement('h3');
  heading.textContent = selected.name;
  charactersDetailPaneEl.appendChild(heading);
}

// --- Player view ---------------------------------------------------------
function renderCharactersPlayerView(ctx) {
  const own = state.allEntities
    .filter(function (e) { return e.category === 'Character' && e.ownerId === ctx.email; })
    .sort(byName);

  // Default-active guard (S8): if the player owns at least one character
  // but activeCharacterId is unset OR points at something they no longer
  // own (stale after an unassign/reassign elsewhere), fall back to the
  // first character in the same sorted order the list itself uses. Runs
  // every render, but only ever WRITES when the condition is actually
  // true -- the resulting player-doc update lands back here via the live
  // listener with a now-valid activeCharacterId, so the condition goes
  // false and this is self-limiting, not a render loop.
  if (ctx.email && own.length && !own.some(function (e) { return e.id === state.activeCharacterId; })) {
    updateDoc(doc(db, 'players', ctx.email), { activeCharacterId: own[0].id }).catch(function () {});
  }

  // Default-select guard: if the player owns at least one character but
  // charactersSelectedId is unset/stale, auto-select their ACTIVE
  // character (S13 -- was always own[0]/first-alphabetically, which on
  // app load is usually just an artifact of name sort, not what the
  // player is actually playing right now). Falls back to own[0] if
  // activeCharacterId isn't valid/known yet. Client-only state, no
  // write -- just falls through to the render below.
  //
  // activeCharacterId arrives via its own live listener (auth.js) that
  // can genuinely lag one render behind this one, especially right on
  // app load -- charactersSelectedAutoPicked tracks whether the CURRENT
  // selection was this guard's own fallback pick (not a real click), so
  // if activeCharacterId shows up valid on a later render, an interim
  // own[0] pick still gets corrected to the real active character. Once
  // the player actually clicks a character, buildCharacterLi clears the
  // flag and this guard never touches the selection again.
  if (own.length) {
    const stillValid = own.some(function (e) { return e.id === state.charactersSelectedId; });
    const activeIsValid = own.some(function (e) { return e.id === state.activeCharacterId; });
    const shouldCorrectToActive = state.charactersSelectedAutoPicked && activeIsValid && state.charactersSelectedId !== state.activeCharacterId;
    if (!stillValid || shouldCorrectToActive) {
      const activeMatch = own.find(function (e) { return e.id === state.activeCharacterId; });
      state.charactersSelectedId = (activeMatch || own[0]).id;
      state.charactersSelectedAutoPicked = true;
    }
  }

  // S11: with only one character, there's nothing to switch between --
  // hide "Set active" entirely rather than show a picker with a single
  // (already-active, per the guard above) option. Defensive reset of
  // picking mode alongside, in case it was somehow left on from when a
  // second character still existed (e.g. released down to one while
  // picking was active).
  if (charactersSetActiveBtnEl) {
    const showSetActive = own.length > 1;
    charactersSetActiveBtnEl.style.display = showSetActive ? '' : 'none';
    if (!showSetActive) state.charactersPickingActive = false;
    charactersSetActiveBtnEl.textContent = state.charactersPickingActive ? 'Cancel' : 'Set active';
    charactersSetActiveBtnEl.classList.toggle('picking', state.charactersPickingActive);
  }

  charactersPlayerOwnListEl.innerHTML = '';
  if (state.charactersPickingActive) {
    const hint = document.createElement('p');
    hint.className = 'admin-hint';
    hint.textContent = 'Click a character to set them active.';
    charactersPlayerOwnListEl.appendChild(hint);
  }
  if (!own.length) {
    const p = document.createElement('p');
    p.className = 'lore-empty';
    p.textContent = 'No characters yet -- claim or create one below.';
    charactersPlayerOwnListEl.appendChild(p);
  } else {
    const ul = document.createElement('ul');
    ul.className = 'entity-group-list';
    own.forEach(function (e) {
      const onClickOverride = state.charactersPickingActive ? function () {
        trackWrite(updateDoc(doc(db, 'players', ctx.email), { activeCharacterId: e.id }), 'Setting active character')
          .catch(function (err) { window.alert('Save failed: ' + err.message); });
        state.charactersPickingActive = false;
        renderCharactersTab();
      } : null;
      ul.appendChild(buildCharacterLi(e, function (rightCol) {
        rightCol.appendChild(buildRemoveIconBtn('Remove from your characters', function () {
          unassignCharacterSelf(e);
        }));
      }, onClickOverride));
    });
    charactersPlayerOwnListEl.appendChild(ul);
  }

  charactersPlayerSelectedEl.innerHTML = '';
  const selected = own.find(function (e) { return e.id === state.charactersSelectedId; });
  if (selected) {
    // S10: no card editor here anymore -- see module header. Just the
    // name, confirming the selection landed; deck viewer (Gregg's
    // planned feature, not yet designed) will replace this. Editing now
    // only happens via Codex tab -> Edit.
    const heading = document.createElement('h3');
    heading.textContent = selected.name;
    charactersPlayerSelectedEl.appendChild(heading);
  } else {
    const p = document.createElement('p');
    p.className = 'lore-empty';
    p.textContent = 'Select a character to view.';
    charactersPlayerSelectedEl.appendChild(p);
  }

  renderClaimPopup(ctx);
}

// "Claim Character" popup (§11.6/S8): PC-tagged, unowned Character
// entities -- same eligibility as the old inline "Available characters"
// list, now behind a button rather than always-on real estate. Pending
// state (already-filed transferRequest) shown inline, same as before --
// "Cancel request" swap IS the pending-visual-feedback Gregg asked for
// (S8's "provide visual feedback that this claim is pending"), plus an
// explicit "(pending)" label so it reads clearly even at a glance.
// Deliberately NOT canSee-gated (S8): a player can request a still
// gm-only-hidden PC-tagged character, not just ones the GM has already
// shared -- consistent with the app's own "read-hardening is client-
// side render filtering, not a security boundary" model (firestore.rules
// already grants every player read on the whole entities collection
// regardless of visibility; this is a UI choice to surface some of that
// already-readable data, not a new access grant).
function renderClaimPopup(ctx) {
  charactersClaimPopupEl.innerHTML = '';
  if (!state.charactersClaimPopupOpen) {
    charactersClaimPopupEl.style.display = 'none';
    return;
  }
  charactersClaimPopupEl.style.display = 'block';
  charactersClaimPopupEl.className = 'characters-claim-popup';

  const heading = document.createElement('h4');
  heading.textContent = 'Claim a character';
  charactersClaimPopupEl.appendChild(heading);

  const available = state.allEntities
    .filter(function (e) {
      return e.category === 'Character' && !e.ownerId
        && (e.tags || []).some(function (t) { return t.toLowerCase() === 'pc'; });
    })
    .sort(byName);

  if (!available.length) {
    const p = document.createElement('p');
    p.className = 'lore-empty';
    p.textContent = 'None available right now.';
    charactersClaimPopupEl.appendChild(p);
  } else {
    const ul = document.createElement('ul');
    ul.className = 'entity-group-list';
    available.forEach(function (e) {
      const li = document.createElement('li');
      const nameGroup = document.createElement('div');
      nameGroup.className = 'characters-name-group';
      nameGroup.appendChild(buildBadgeDot(e));
      const nameDiv = document.createElement('div');
      nameDiv.className = 'entity-name';
      nameDiv.textContent = e.name;
      nameGroup.appendChild(nameDiv);
      li.appendChild(nameGroup);
      const rightCol = document.createElement('div');
      rightCol.className = 'entity-right-col';
      const pendingReq = state.myTransferRequests.find(function (r) { return r.characterId === e.id; });
      if (pendingReq) {
        const pendingLabel = document.createElement('span');
        pendingLabel.className = 'characters-active-label';
        pendingLabel.textContent = '(pending)';
        rightCol.appendChild(pendingLabel);
      }
      const reqBtn = document.createElement('button');
      reqBtn.type = 'button';
      reqBtn.className = 'action-btn-compact characters-claim-req-btn';
      reqBtn.textContent = pendingReq ? 'Cancel' : 'Claim';
      reqBtn.addEventListener('click', function (ev) {
        ev.stopPropagation();
        if (pendingReq) {
          deleteDoc(doc(db, 'transferRequests', pendingReq.id)).catch(function (err) { window.alert('Cancel failed: ' + err.message); });
        } else {
          addDoc(collection(db, 'transferRequests'), { characterId: e.id, toEmail: ctx.email, requestedAt: serverTimestamp() })
            .catch(function (err) { window.alert('Request failed: ' + err.message); });
        }
      });
      rightCol.appendChild(reqBtn);
      li.appendChild(rightCol);
      li.addEventListener('click', function () { switchToCodexTabForEntity(e.id); });
      ul.appendChild(li);
    });
    charactersClaimPopupEl.appendChild(ul);
  }

  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'action-btn-compact';
  closeBtn.textContent = 'Close';
  closeBtn.addEventListener('click', function () {
    state.charactersClaimPopupOpen = false;
    renderCharactersTab();
  });
  charactersClaimPopupEl.appendChild(closeBtn);
}

// --- Dispatch --------------------------------------------------------
function renderCharactersTab() {
  const ctx = viewerContext();
  charactersGmViewEl.style.display = ctx.gmView ? '' : 'none';
  charactersPlayerViewEl.style.display = ctx.gmView ? 'none' : '';
  if (ctx.gmView) {
    renderCharactersGmView(ctx);
    return;
  }
  if (state.charactersSelectedId) {
    const stillOwn = state.allEntities.some(function (e) {
      return e.id === state.charactersSelectedId && e.category === 'Character' && e.ownerId === ctx.email;
    });
    if (!stillOwn) state.charactersSelectedId = null;
  }
  renderCharactersPlayerView(ctx);
}

function ensureCharactersTabReady() {
  renderCharactersTab();
}

// "+ New Entity" (GM) / "+ Create Character" (player): both route through
// codex.js's New Entity dialog, preset to category Character + tag PC
// (§8.5/§8.4 -- "follow #5 above exactly"). saveNewEntity itself handles
// setting ownerId=self for a non-GM creator (rules require it in the
// same write) -- see codex.js.
if (charactersGmNewBtnEl) {
  charactersGmNewBtnEl.addEventListener('click', function () {
    openNewEntityDialog({ category: 'Character', tags: ['PC'] });
  });
}
if (charactersCreateBtnEl) {
  charactersCreateBtnEl.addEventListener('click', function () {
    openNewEntityDialog({ category: 'Character', tags: ['PC'] });
  });
}
if (charactersClaimBtnEl) {
  charactersClaimBtnEl.addEventListener('click', function () {
    state.charactersClaimPopupOpen = !state.charactersClaimPopupOpen;
    renderCharactersTab();
  });
}
if (charactersSetActiveBtnEl) {
  charactersSetActiveBtnEl.addEventListener('click', function () {
    state.charactersPickingActive = !state.charactersPickingActive;
    renderCharactersTab();
  });
}

// NOTE: this module deliberately does NOT call
// registerVisibilityChangeHandler(renderCharactersTab) at its own top
// level, unlike map.js/timeline.js's equivalent registrations. codex.js
// -> admin.js -> characters.js -> codex.js is a real import cycle (this
// module imports switchToCodexTabForEntity/applyWikiLinks from codex.js;
// admin.js now imports renderCharactersTab from this module to feed the
// unified Requests queue re-render). A top-level call back into codex.js
// here would run WHILE codex.js's own module body is still mid-
// evaluation further up that same cycle (codex.js hasn't reached its
// `const visibilityChangeHandlers = []` yet) -- a live ReferenceError
// (TDZ), not a hypothetical. main.js sits outside the cycle and only
// runs its own top-level code after every static import has FULLY
// resolved, so it's the safe place for this registration -- see main.js.
export { ensureCharactersTabReady, renderCharactersTab, attachCharacterTransferListeners, detachCharacterTransferListeners };
