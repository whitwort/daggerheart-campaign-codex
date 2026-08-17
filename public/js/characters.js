// characters.js — Phase 14 S5, restyled S8. The Characters tab.
//
// GM view ("Players & Characters"): left pane lists every party member
// with an inline "+ assign"/"x remove" UI for the ownerId association
// (moved here from the Codex-tab entity-edit form in S8 -- see codex.js);
// right pane is a READ-ONLY card-slot viewer (buildCardSlotViewer) for
// whichever character is selected -- deliberately NOT the editable
// buildCardSlotEditor (GM doesn't edit Character entries from this tab;
// that capacity already exists on the Codex tab) and NOT a re-mount of
// the Codex tab's own stateful renderEntityViewCard (that component owns
// several genuinely singular pieces of global state -- state.selectedId,
// state.entityImagesTargetId/currentEntityImages, a single live
// Firestore query pointed at ONE entity's images at a time -- two
// simultaneously-mounted instances would fight over it, and tab panels
// hide via CSS, not unmount, so both CAN be on screen at once).
//
// Player view: left pane lists the player's own characters (name +
// active-toggle + self-release "x", same pattern as the GM pane's
// remove); right pane is the editable buildCardSlotEditor + badgeColor
// picker for whichever is selected; "Claim Character"/"+ Create
// Character" live at the bottom (S8) -- Claim opens a popup over the
// existing PC-tagged/unowned/visible transferRequests flow, Create
// routes through codex.js's New Entity dialog (category Character, tag
// PC preset).
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
  getFirestore, doc, collection, addDoc, deleteDoc, updateDoc, setDoc,
  onSnapshot, query, where, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import { firebaseApp } from './firebase.js';
import { state } from './state.js';
import { attachListener, detachListener, safeSnapshotHandler } from './listeners.js';
import { trackWrite } from './connectivity.js';
import { canSee, viewerContext, hasFullAuthority } from './visibility.js';
import { switchToCodexTabForEntity, openNewEntityDialog } from './codex.js';
import { getTemplateSchema } from './templates.js';
import { renderMarkdownInto } from './markdown.js';
import { generateDefaultBadgeColor } from './badge-color.js';
import { approveTransferRequest, rejectTransferRequest } from './transfer-requests.js';

const db = getFirestore(firebaseApp);

// Kept in sync with the copy in codex.js/srd-import.js -- small, not
// worth a shared-utils module split, same convention as humanizeKey.
function slugify(name) {
  return name.toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function byName(a, b) { return (a.name || '').localeCompare(b.name || ''); }

// Kept in sync with the copies in codex.js/templates.js/srd-import.js --
// templates.js's own humanizeKey is internal-only (not exported; only
// getTemplateSchema/computeSearchIndex etc. are), same reasoning as
// slugify above for not splitting out a shared-utils module over one
// small function repeated a few places.
function humanizeKey(key) {
  return key.replace(/_/g, ' ').replace(/\b\w/g, function (c) { return c.toUpperCase(); });
}

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

// --- Card-slot stat display (§6.4: "linked entity's existing template
// display, tier-scoped for subclass via featureGroups") -- own compact
// Details+Features markdown builder, NOT a reuse of buildEntityPreviewCard
// (that shows only the entity's first raw loreItem verbatim, never the
// resolveLoreItemMarkdown-synthesized Details/Features view -- it would
// silently show nothing for a templated Ancestry/Class/Subclass with no
// free-text lore item of its own). tierFilter, when given, restricts
// features to that featureGroups key (subclass tier-scoping, D7) --
// otherwise every feature renders (ancestry/community/class, none of
// which are tiered).
function slotStatMarkdown(entity, tierFilter) {
  if (!entity) return '';
  const schema = getTemplateSchema(entity.category, entity.subtype);
  const details = entity.details || {};
  const lines = [];
  if (schema) {
    schema.detailKeys.forEach(function (d) {
      const val = details[d.key];
      if (val === undefined || val === null || val === '') return;
      lines.push('- **' + humanizeKey(d.key) + ':** ' + val);
    });
  }
  const feats = entity.features || [];
  const relevantFeats = (schema && schema.featureGroups && tierFilter)
    ? feats.filter(function (f) { return f.group === tierFilter; })
    : feats;
  const featLines = relevantFeats.map(function (f) { return '**' + f.name + '.** ' + f.text; });
  const blocks = [];
  if (lines.length) blocks.push(lines.join('\n'));
  if (featLines.length) blocks.push(featLines.join('\n\n'));
  return blocks.join('\n\n');
}

// Ancestry feature card slot: display identity (flavor entity, may be a
// meta ancestry) is decoupled from the STAT entity feature text is drawn
// from (the resolved functional ancestry) -- see resolveFunctionalAncestryIds.
// For a non-meta pick these are the same entity, so the common case
// renders identically to before this feature existed.
function buildAncestryFeatureCardSlot(statEntity, groupFilter) {
  return buildCardSlot(statEntity, { tier: groupFilter });
}

// Up to 2 ancestries, add/remove list (mirrors buildAbilitiesPicker's
// UX), each with per-functional-ancestry First/Second feature-group
// picks when resolution yields 2 functional ancestries -- whether that's
// 2 directly-picked ancestries, or a single meta pick whose own
// metaAncestryTargetIds has 2 entries (§11.2's "meta can be mixed").
function buildAncestrySlotEditor(entity, cards, ancestryEntities) {
  const wrap = document.createElement('div');
  const label = document.createElement('label');
  label.textContent = 'Ancestry';
  wrap.appendChild(label);

  const flavorIds = normalizeAncestryIds(cards);
  const functionalIds = resolveFunctionalIds(flavorIds);
  const picks = cards.ancestryFeaturePicks || {};

  function save(newFlavorIds, newPicks) {
    saveCardsPatch(entity, { ancestryIds: newFlavorIds, ancestryFeaturePicks: newPicks || {} });
  }

  const list = document.createElement('ul');
  list.className = 'related-edit-list';
  flavorIds.forEach(function (id) {
    const a = ancestryEntities.find(function (e) { return e.id === id; });
    const li = document.createElement('li');
    const span = document.createElement('span');
    span.textContent = a ? a.name : '(deleted ancestry)';
    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.textContent = 'Remove';
    removeBtn.addEventListener('click', function () {
      save(flavorIds.filter(function (x) { return x !== id; }), picks);
    });
    li.appendChild(span);
    li.appendChild(removeBtn);
    list.appendChild(li);
  });
  wrap.appendChild(list);

  const addRow = document.createElement('div');
  addRow.className = 'related-edit-add';
  const select = document.createElement('select');
  // Eligible = not already picked, and wouldn't push the resolved
  // functional-ancestry count past 2 (e.g. can't add a second pick once
  // a meta-mix ancestry already resolves to 2 targets on its own).
  const available = ancestryEntities.filter(function (e) {
    if (flavorIds.indexOf(e.id) !== -1) return false;
    const candidateFunctional = resolveFunctionalAncestryIds(e.id);
    const merged = functionalIds.concat(candidateFunctional.filter(function (fid) { return functionalIds.indexOf(fid) === -1; }));
    return merged.length <= 2;
  });
  if (!available.length) {
    const opt = document.createElement('option');
    opt.textContent = flavorIds.length ? '(no eligible ancestries to add)' : '-- choose --';
    opt.disabled = true;
    select.appendChild(opt);
  } else {
    const placeholder = document.createElement('option');
    placeholder.textContent = '-- choose --';
    placeholder.value = '';
    select.appendChild(placeholder);
    available.forEach(function (e) {
      const opt = document.createElement('option');
      opt.value = e.id;
      opt.textContent = e.name;
      select.appendChild(opt);
    });
  }
  const addBtn = document.createElement('button');
  addBtn.type = 'button';
  addBtn.textContent = 'Add';
  addBtn.addEventListener('click', function () {
    const id = select.value;
    if (!id || flavorIds.length >= 2) return;
    save(flavorIds.concat([id]), picks);
  });
  addRow.appendChild(select);
  addRow.appendChild(addBtn);
  wrap.appendChild(addRow);

  // Feature-group picks: only meaningful/shown when resolution yields
  // exactly 2 functional ancestries. Two selects, each constrained to
  // differ from the other -- picking 'first' on one auto-flips the other
  // to 'second' rather than exposing an invalid both-same state.
  if (functionalIds.length === 2) {
    const picksWrap = document.createElement('div');
    picksWrap.className = 'entity-edit-field';
    const picksLabel = document.createElement('label');
    picksLabel.textContent = 'Feature picks';
    picksWrap.appendChild(picksLabel);
    const selects = functionalIds.map(function (fid) {
      const fEnt = ancestryEntities.find(function (e) { return e.id === fid; })
        || state.allEntities.find(function (e) { return e.id === fid; });
      const row = document.createElement('div');
      row.className = 'entity-edit-field';
      const rowLabel = document.createElement('span');
      rowLabel.className = 'toggle-switch-label';
      rowLabel.textContent = (fEnt ? fEnt.name : fid) + ':';
      row.appendChild(rowLabel);
      const sel = document.createElement('select');
      ['first', 'second'].forEach(function (g) {
        const opt = document.createElement('option');
        opt.value = g;
        opt.textContent = g === 'first' ? 'First' : 'Second';
        sel.appendChild(opt);
      });
      row.appendChild(sel);
      picksWrap.appendChild(row);
      return { fid: fid, sel: sel };
    });
    selects[0].sel.value = picks[selects[0].fid] || 'first';
    selects[1].sel.value = picks[selects[1].fid] || (selects[0].sel.value === 'first' ? 'second' : 'first');
    selects.forEach(function (entry, i) {
      entry.sel.addEventListener('change', function () {
        const other = selects[1 - i];
        if (other.sel.value === entry.sel.value) {
          other.sel.value = entry.sel.value === 'first' ? 'second' : 'first';
        }
        const newPicks = {};
        newPicks[selects[0].fid] = selects[0].sel.value;
        newPicks[selects[1].fid] = selects[1].sel.value;
        save(flavorIds, newPicks);
      });
    });
    wrap.appendChild(picksWrap);
  }

  // Feature card(s): one per functional ancestry, named/statted off the
  // FUNCTIONAL entity (see buildAncestryFeatureCardSlot header comment).
  functionalIds.forEach(function (fid) {
    const statEntity = state.allEntities.find(function (e) { return e.id === fid; });
    const groupFilter = functionalIds.length === 2 ? (picks[fid] || null) : null;
    wrap.appendChild(buildAncestryFeatureCardSlot(statEntity, groupFilter));
  });
  if (!functionalIds.length) wrap.appendChild(buildCardSlot(null));

  return wrap;
}

function buildCardSlot(entity, opts) {
  const wrap = document.createElement('div');
  wrap.className = 'character-card-slot';
  if (!entity) {
    const none = document.createElement('p');
    none.className = 'lore-empty';
    none.textContent = '\u2014 none selected \u2014';
    wrap.appendChild(none);
    return wrap;
  }
  const nameBtn = document.createElement('button');
  nameBtn.type = 'button';
  nameBtn.className = 'character-name-chip';
  nameBtn.textContent = entity.name;
  nameBtn.title = 'Open in Codex';
  nameBtn.addEventListener('click', function () { switchToCodexTabForEntity(entity.id); });
  wrap.appendChild(nameBtn);
  const md = slotStatMarkdown(entity, opts && opts.tier);
  if (md) {
    const body = document.createElement('div');
    body.className = 'character-card-slot-body';
    renderMarkdownInto(body, md);
    wrap.appendChild(body);
  }
  return wrap;
}

function buildSingleEntityPicker(labelText, entities, currentId, onChange) {
  const wrap = document.createElement('div');
  wrap.className = 'entity-edit-field';
  const label = document.createElement('label');
  label.textContent = labelText;
  wrap.appendChild(label);
  const select = document.createElement('select');
  const noneOpt = document.createElement('option');
  noneOpt.value = '';
  noneOpt.textContent = '-- none --';
  select.appendChild(noneOpt);
  entities.forEach(function (e) {
    const opt = document.createElement('option');
    opt.value = e.id;
    opt.textContent = e.name;
    select.appendChild(opt);
  });
  select.value = currentId || '';
  select.addEventListener('change', function () { onChange(select.value || null); });
  wrap.appendChild(select);
  return wrap;
}

// Abilities: multi-select, add-one-at-a-time list+picker, same UX pattern
// as codex.js's buildRelatedEditor (Related entries) -- the add-select is
// additionally grouped into <optgroup>s by the ability's `domain` detail
// key (Game Mechanics/abilities schema, templates.js) since that's how
// players actually browse Daggerheart's ability list at the table.
// displayEntities: full visible-abilities pool, used to look up names for
// already-picked ids so a Phase 14 S7 class/domain change doesn't make a
// previously-added ability show as "(deleted ability)". addCandidates
// (defaults to displayEntities): the domain/class-filtered set the add-
// select offers -- see buildCardSlotEditor's abilityOptionsDeduped.
function buildAbilitiesPicker(cards, displayEntities, onChange, addCandidates) {
  const wrap = document.createElement('div');
  wrap.className = 'entity-edit-field';
  const label = document.createElement('label');
  label.textContent = 'Abilities (aim for at least 2)';
  wrap.appendChild(label);

  const abilityEntities = addCandidates || displayEntities;
  const abilityIds = cards.abilityIds || [];
  const list = document.createElement('ul');
  list.className = 'related-edit-list';
  abilityIds.forEach(function (id) {
    const a = displayEntities.find(function (e) { return e.id === id; });
    const li = document.createElement('li');
    const span = document.createElement('span');
    span.textContent = a ? a.name : '(deleted ability)';
    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.textContent = 'Remove';
    removeBtn.addEventListener('click', function () {
      onChange(abilityIds.filter(function (x) { return x !== id; }));
    });
    li.appendChild(span);
    li.appendChild(removeBtn);
    list.appendChild(li);
  });
  wrap.appendChild(list);

  const addRow = document.createElement('div');
  addRow.className = 'related-edit-add';
  const select = document.createElement('select');
  const available = abilityEntities.filter(function (e) { return abilityIds.indexOf(e.id) === -1; });
  if (!available.length) {
    const opt = document.createElement('option');
    opt.textContent = '(no more abilities to add)';
    opt.disabled = true;
    select.appendChild(opt);
  } else {
    const byDomain = {};
    available.forEach(function (e) {
      const dom = (e.details && e.details.domain) || 'Other';
      (byDomain[dom] = byDomain[dom] || []).push(e);
    });
    Object.keys(byDomain).sort().forEach(function (dom) {
      const group = document.createElement('optgroup');
      group.label = dom;
      byDomain[dom].sort(byName).forEach(function (e) {
        const opt = document.createElement('option');
        opt.value = e.id;
        opt.textContent = e.name;
        group.appendChild(opt);
      });
      select.appendChild(group);
    });
  }
  const addBtn = document.createElement('button');
  addBtn.type = 'button';
  addBtn.textContent = 'Add';
  addBtn.addEventListener('click', function () {
    const id = select.value;
    if (!id || abilityIds.indexOf(id) !== -1) return;
    onChange(abilityIds.concat([id]));
  });
  addRow.appendChild(select);
  addRow.appendChild(addBtn);
  wrap.appendChild(addRow);
  return wrap;
}

const DEFAULT_CARDS = {
  ancestryId: null, ancestryIds: [], ancestryFeaturePicks: {}, communityId: null, classId: null, subclassId: null,
  subclassTier: 'foundation', abilityIds: []
};
// Single source of truth for tier keys/labels: the same featureGroups
// the subclass template schema already defines (templates.js) -- falls
// back to the same three if that schema is ever removed/renamed.
const TIER_OPTIONS = (function () {
  const schema = getTemplateSchema('Game Mechanics', 'subclasses');
  return (schema && schema.featureGroups) || [
    { key: 'foundation', label: 'Foundation' },
    { key: 'mastery', label: 'Mastery' },
    { key: 'specialization', label: 'Specialization' }
  ];
})();

// --- Mixed/meta ancestry resolution (Phase 14 S7, §11.1/§11.2) ---------
// cards.ancestryIds: the FLAVOR ancestries the player actually picked (1
// or 2, what displays on the card). A flavor ancestry may itself be
// "meta" (entity.metaAncestryTargetIds set) -- flavor-only, its features/
// details resolve through 1-2 TARGET ancestries instead of its own.
// Chaining (a target that's itself meta) is disallowed by construction
// (the Ancestry entity edit form excludes already-meta ancestries from
// the target picker) -- resolveFunctionalAncestryIds does one lookup,
// not a walk.
function normalizeAncestryIds(cards) {
  if (cards.ancestryIds && cards.ancestryIds.length) return cards.ancestryIds;
  if (cards.ancestryId) return [cards.ancestryId];
  return [];
}
function resolveFunctionalAncestryIds(ancestryId) {
  const anc = state.allEntities.find(function (e) { return e.id === ancestryId; });
  if (!anc) return [];
  const targets = anc.metaAncestryTargetIds;
  return (targets && targets.length) ? targets.slice(0, 2) : [ancestryId];
}
// Flattened, deduped list of the FUNCTIONAL ancestry ids a character's
// flavor picks resolve to -- length 1 or 2 in valid data (the add-select
// in buildAncestrySlotEditor prevents exceeding 2; a stale/edited-outside
// doc that somehow exceeds it is truncated here, not thrown on).
function resolveFunctionalIds(flavorIds) {
  const out = [];
  flavorIds.forEach(function (id) {
    resolveFunctionalAncestryIds(id).forEach(function (fid) {
      if (out.indexOf(fid) === -1) out.push(fid);
    });
  });
  return out.slice(0, 2);
}

function saveCardsPatch(entity, patch) {
  const cards = Object.assign({}, DEFAULT_CARDS, entity.cards || {}, patch);
  trackWrite(
    updateDoc(doc(db, 'entities', entity.id), { cards: cards, updatedAt: serverTimestamp() }),
    'Saving character card'
  ).catch(function (err) { window.alert('Save failed: ' + err.message); });
}

// Editable card-slot editor. ctx must be the REAL viewer's ctx (never a
// synthesized one) -- edit authority is always the actual person at the
// keyboard, never a preview identity. Callers (GM flipper's own detail
// pane; a player's own-character selection) already only reach this when
// hasFullAuthority is true; the check here is a defensive backstop, not
// the primary gate.
function buildCardSlotEditor(entity, ctx) {
  const wrap = document.createElement('div');
  wrap.className = 'character-card-editor';
  if (!hasFullAuthority(entity, ctx)) return wrap;

  const cards = Object.assign({}, DEFAULT_CARDS, entity.cards || {});
  const visible = function (e) { return ctx.gmView || canSee(e, ctx); };
  const ancestries = state.allEntities.filter(function (e) { return e.category === 'Ancestry' && visible(e); }).sort(byName);
  const communities = state.allEntities.filter(function (e) { return e.category === 'Community' && visible(e); }).sort(byName);
  const classes = state.allEntities.filter(function (e) { return e.category === 'Game Mechanics' && e.subtype === 'classes' && visible(e); }).sort(byName);
  const subclasses = state.allEntities.filter(function (e) { return e.category === 'Game Mechanics' && e.subtype === 'subclasses' && visible(e); }).sort(byName);
  const abilities = state.allEntities.filter(function (e) { return e.category === 'Game Mechanics' && e.subtype === 'abilities' && visible(e); });

  // Phase 14 S7 (§11.7): class.details.subclass_1/subclass_2 and
  // ability.details.domain are plain strings that already exact-match
  // Subclass/Domain entity names (verified against live SRD data) --
  // no schema/rules needed, just a name-match filter. Empty until a
  // class is chosen (Gregg's call, deferring picker-UX refinement to a
  // later pass). Character-scoped ad hoc cards (§11.3) bypass the
  // domain filter -- they're already gated by ownership, not meant to
  // compete with class-domain access.
  const selectedClass = classes.find(function (e) { return e.id === cards.classId; });
  const subclassOptions = selectedClass
    ? subclasses.filter(function (s) {
        const d = selectedClass.details || {};
        return s.name === d.subclass_1 || s.name === d.subclass_2;
      })
    : [];
  const abilityOptions = selectedClass
    ? abilities.filter(function (a) {
        const d = selectedClass.details || {};
        const dom = a.details && a.details.domain;
        return dom && (dom === d.domain_1 || dom === d.domain_2);
      }).concat(abilities.filter(function (a) {
        return a.visibility === 'character' && a.characterId === entity.id;
      }))
    : abilities.filter(function (a) { return a.visibility === 'character' && a.characterId === entity.id; });
  // De-dupe (a character-scoped ability could theoretically also match
  // the domain filter above).
  const abilityOptionsDeduped = abilityOptions.filter(function (a, i) {
    return abilityOptions.findIndex(function (b) { return b.id === a.id; }) === i;
  });

  wrap.appendChild(buildAncestrySlotEditor(entity, cards, ancestries));

  wrap.appendChild(buildSingleEntityPicker('Community', communities, cards.communityId,
    function (v) { saveCardsPatch(entity, { communityId: v }); }));
  wrap.appendChild(buildCardSlot(communities.find(function (e) { return e.id === cards.communityId; })));

  wrap.appendChild(buildSingleEntityPicker('Class', classes, cards.classId,
    function (v) { saveCardsPatch(entity, { classId: v }); }));
  wrap.appendChild(buildCardSlot(classes.find(function (e) { return e.id === cards.classId; })));

  wrap.appendChild(buildSingleEntityPicker('Subclass', subclassOptions, cards.subclassId,
    function (v) { saveCardsPatch(entity, { subclassId: v }); }));
  const tierWrap = document.createElement('div');
  tierWrap.className = 'entity-edit-field';
  const tierLabel = document.createElement('label');
  tierLabel.textContent = 'Subclass tier';
  tierWrap.appendChild(tierLabel);
  const tierSelect = document.createElement('select');
  TIER_OPTIONS.forEach(function (t) {
    const opt = document.createElement('option');
    opt.value = t.key;
    opt.textContent = t.label;
    tierSelect.appendChild(opt);
  });
  tierSelect.value = cards.subclassTier || 'foundation';
  tierSelect.addEventListener('change', function () { saveCardsPatch(entity, { subclassTier: tierSelect.value }); });
  tierWrap.appendChild(tierSelect);
  wrap.appendChild(tierWrap);
  wrap.appendChild(buildCardSlot(subclasses.find(function (e) { return e.id === cards.subclassId; }), { tier: cards.subclassTier }));

  wrap.appendChild(buildAbilitiesPicker(cards, abilities, function (ids) { saveCardsPatch(entity, { abilityIds: ids }); }, abilityOptionsDeduped));
  const abilityCardsWrap = document.createElement('div');
  cards.abilityIds.forEach(function (id) {
    const a = abilities.find(function (e) { return e.id === id; });
    if (a) abilityCardsWrap.appendChild(buildCardSlot(a));
  });
  wrap.appendChild(abilityCardsWrap);

  // GM-only: creating a non-Character entity is rules-denied for
  // players (isValidEntity's player create path is category=='Character'
  // only) -- a player-owned-character context never gets this button.
  if (ctx.gmView) wrap.appendChild(buildAdHocCardButton(entity));

  return wrap;
}

// Phase 14 S7 (§11.3): convenience creation of a character-scoped ad hoc
// "card" (e.g. a campaign-specific mechanic like Aether Touched) without
// leaving the Characters tab to use the general Codex "+ New entity"
// flow + kebab manually. No new schema/rules -- this is exactly the
// existing visibility:'character' mechanism, pre-filled. Scoped to
// Game Mechanics/abilities only (matches the domain-optgroup UI it'll
// surface in); intentionally minimal (name-only prompt, same "stub now,
// fill in mechanics text via Codex" pattern as "+ New character") since
// there's no character-sheet ability cap this needs to respect or be
// exempted from.
function buildAdHocCardButton(entity) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'action-btn-compact';
  btn.textContent = '+ New card for this character';
  btn.addEventListener('click', function () {
    const name = window.prompt('Card name (e.g. "Aether Touched"):');
    if (!name || !name.trim()) return;
    const trimmed = name.trim();
    const newId = doc(collection(db, 'entities')).id;
    const entityData = {
      slug: slugify(trimmed), name: trimmed, category: 'Game Mechanics', subtype: 'abilities',
      ancestry: null, aliases: [], date: null, dateSort: null, dateEnd: null, dateEndSort: null,
      parentId: null, relatedIds: [], visibility: 'character', characterId: entity.id, characterShared: false,
      hasMapImage: false, mapImageVisibleToPlayers: false, tags: [], sourceId: null,
      useTemplate: false, details: {}, features: [], searchIndex: [],
      createdAt: serverTimestamp(), updatedAt: serverTimestamp()
    };
    trackWrite(setDoc(doc(db, 'entities', newId), entityData), 'Creating card')
      .then(function () { switchToCodexTabForEntity(newId); })
      .catch(function (err) { window.alert('Create failed: ' + err.message); });
  });
  return btn;
}

// Owner-picked badge color (D3/S4's badge mechanism gains its picker
// here -- every badge rendered light-grey (--badge-default) until this
// session). Palette is the app's own existing --cat-* category accent
// family (styles.css) -- already a curated, visually distinct 12-hue
// set that matches the established aesthetic, not a new ad-hoc palette.
// S8 adds an explicit "Default" swatch (badgeColor -> null, the same
// light-grey fallback every other display already uses when unset) and
// a custom RGB/hex picker (native <input type="color">) for anything
// outside the curated 12.
const BADGE_COLORS = [
  '#6E8E7A', '#B0785A', '#C2A24D', '#7A6C9E', '#9A5F6B', '#5E8296',
  '#8C8072', '#7C7A45', '#5A7690', '#8E6A4F', '#5C5A66', '#4F7A6E'
];

function buildBadgeColorPicker(entity) {
  const wrap = document.createElement('div');
  wrap.className = 'entity-edit-field';
  const label = document.createElement('label');
  label.textContent = 'Badge color';
  wrap.appendChild(label);
  const row = document.createElement('div');
  row.className = 'character-badge-swatch-row';

  function save(color) {
    trackWrite(
      updateDoc(doc(db, 'entities', entity.id), { badgeColor: color, updatedAt: serverTimestamp() }),
      'Saving badge color'
    ).catch(function (err) { window.alert('Save failed: ' + err.message); });
  }

  const defaultBtn = document.createElement('button');
  defaultBtn.type = 'button';
  defaultBtn.className = 'character-badge-swatch character-badge-swatch-default';
  defaultBtn.style.background = generateDefaultBadgeColor(entity.name);
  if (!entity.badgeColor) defaultBtn.classList.add('selected');
  defaultBtn.title = 'Default (auto, from name)';
  defaultBtn.addEventListener('click', function () { save(null); });
  row.appendChild(defaultBtn);

  BADGE_COLORS.forEach(function (color) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'character-badge-swatch';
    if ((entity.badgeColor || '') === color) btn.classList.add('selected');
    btn.style.background = color;
    btn.title = color;
    btn.addEventListener('click', function () { save(color); });
    row.appendChild(btn);
  });

  // Custom color: badgeColor is already stored as a hex string
  // everywhere (the 12 presets above are hex literals), so the native
  // color input's value format is a direct match -- no conversion
  // needed either direction. 'change' (fires once the picker closes),
  // not 'input' (fires continuously while dragging), to avoid a write
  // per pixel of drag.
  const isCustom = !!entity.badgeColor && BADGE_COLORS.indexOf(entity.badgeColor) === -1;
  const customLabel = document.createElement('label');
  customLabel.className = 'character-badge-swatch character-badge-swatch-custom' + (isCustom ? ' selected' : '');
  customLabel.title = 'Custom color';
  const customInput = document.createElement('input');
  customInput.type = 'color';
  customInput.value = isCustom ? entity.badgeColor : '#B7B2A6';
  customInput.addEventListener('change', function () { save(customInput.value); });
  customLabel.appendChild(customInput);
  row.appendChild(customLabel);

  wrap.appendChild(row);
  return wrap;
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

// Read-only card-slot view (§6.4/S8: GM's detail pane shows exactly what
// the owning player sees in their own Characters tab -- ancestry/
// community/class/subclass/ability cards -- with no editing chrome).
// Deliberately built from buildCardSlot (already display-only) rather
// than buildCardSlotEditor, which wraps every slot in picker/add/remove
// controls the GM doesn't need here (§8.1: GM doesn't edit Characters
// from this tab -- that's Codex-tab/card-slot-editor territory for the
// owning player only).
function buildCardSlotViewer(entity) {
  const wrap = document.createElement('div');
  wrap.className = 'character-card-editor';
  const cards = Object.assign({}, DEFAULT_CARDS, entity.cards || {});
  const flavorIds = normalizeAncestryIds(cards);
  const functionalIds = resolveFunctionalIds(flavorIds);
  const picks = cards.ancestryFeaturePicks || {};
  if (functionalIds.length) {
    functionalIds.forEach(function (fid) {
      const statEntity = state.allEntities.find(function (e) { return e.id === fid; });
      const groupFilter = functionalIds.length === 2 ? (picks[fid] || null) : null;
      wrap.appendChild(buildCardSlot(statEntity, { tier: groupFilter }));
    });
  } else {
    wrap.appendChild(buildCardSlot(null));
  }
  wrap.appendChild(buildCardSlot(state.allEntities.find(function (e) { return e.id === cards.communityId; })));
  wrap.appendChild(buildCardSlot(state.allEntities.find(function (e) { return e.id === cards.classId; })));
  wrap.appendChild(buildCardSlot(
    state.allEntities.find(function (e) { return e.id === cards.subclassId; }),
    { tier: cards.subclassTier }
  ));
  (cards.abilityIds || []).forEach(function (id) {
    const a = state.allEntities.find(function (e) { return e.id === id; });
    if (a) wrap.appendChild(buildCardSlot(a));
  });
  return wrap;
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
  const heading = document.createElement('h3');
  heading.textContent = selected.name;
  charactersDetailPaneEl.appendChild(heading);
  charactersDetailPaneEl.appendChild(buildCardSlotViewer(selected));
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

  if (charactersSetActiveBtnEl) {
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
    const heading = document.createElement('h3');
    heading.textContent = selected.name;
    charactersPlayerSelectedEl.appendChild(heading);
    charactersPlayerSelectedEl.appendChild(buildBadgeColorPicker(selected));
    charactersPlayerSelectedEl.appendChild(buildCardSlotEditor(selected, ctx));
  } else {
    const p = document.createElement('p');
    p.className = 'lore-empty';
    p.textContent = 'Select a character to view or edit their cards.';
    charactersPlayerSelectedEl.appendChild(p);
  }

  renderClaimPopup(ctx);
}

// "Claim Character" popup (§11.6/S8): PC-tagged, unowned, canSee-visible
// Character entities -- same eligibility as the old inline "Available
// characters" list, now behind a button rather than always-on real
// estate. Pending state (already-filed transferRequest) shown inline,
// same as before -- "Cancel request" swap IS the pending-visual-feedback
// Gregg asked for (S8's "provide visual feedback that this claim is
// pending"), plus an explicit "(pending)" label so it reads clearly even
// at a glance.
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
      return e.category === 'Character' && !e.ownerId && canSee(e, ctx)
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
      reqBtn.className = 'action-btn-compact';
      reqBtn.textContent = pendingReq ? 'Cancel request' : 'Request transfer';
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
