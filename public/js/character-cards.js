// character-cards.js — Phase 14 S9/S10. Shared "cards" editing UI for
// Character-category entities (ancestry, community, class/subclass/
// tier, abilities, badge color).
//
// S10 (per Gregg, after S9 caused more confusion than it fixed): this
// is now the ONLY place character cards are viewed or edited, full
// stop. Characters tab no longer has its own viewer (GM) or editor
// (player) -- both were dropped. The single surface is: Codex tab ->
// select a Character entry -> Edit -> change fields -> Save/Cancel.
//
// Also S10: this editor no longer writes to Firestore directly on
// every field change. It mutates the SAME draft object codex.js's
// entity edit form already uses for name/tags/aliases/etc (draft.cards,
// draft.badgeColor), so Save commits everything in one write and Cancel
// discards everything -- previously cards fields wrote immediately,
// independent of the surrounding form's Save/Cancel, which meant
// Cancel silently did NOT revert an ancestry/class/ability change (bug
// Gregg caught) and every card edit fought with the edit form's own
// "saved elsewhere" conflict detector (fixed in S9, now moot -- there's
// no more immediate write to race against).
//
// Zero dependency on codex.js (same "small shared module" pattern as
// badge-color.js/transfer-requests.js/entity-images-cache.js).

import { state } from './state.js';
import { canSee } from './visibility.js';
import { getTemplateSchema } from './templates.js';
import { renderMarkdownInto } from './markdown.js';
import { generateDefaultBadgeColor } from './badge-color.js';

function byName(a, b) { return (a.name || '').localeCompare(b.name || ''); }

// Display-only ancestry name for a Character entity, resolved from
// cards.ancestryIds (S9 -- replaces the old free-text entity.ancestry
// field, which had no editing UI left after the S9 unification and is
// PC-only anyway; Gregg's call). Shows the FLAVOR ancestry name(s) --
// i.e. what's actually selected in the ancestry dropdown -- not the
// resolved functional/meta name, since that's what a viewer picked and
// expects to see. Dual ancestry joins as "A / B". Empty string (falsy,
// same as the old entity.ancestry-unset case) when nothing's picked,
// or for non-Character entities.
export function characterAncestryDisplayName(entity) {
  if (!entity || entity.category !== 'Character') return '';
  const cards = Object.assign({}, DEFAULT_CARDS, entity.cards || {});
  const flavorIds = normalizeAncestryIds(cards);
  const names = flavorIds
    .map(function (id) { const e = state.allEntities.find(function (x) { return x.id === id; }); return e ? e.name : null; })
    .filter(Boolean);
  return names.join(' / ');
}

function humanizeKey(key) {
  return key.replace(/_/g, ' ').replace(/\b\w/g, function (c) { return c.toUpperCase(); });
}

export const DEFAULT_CARDS = {
  ancestryId: null, ancestryIds: [], ancestryFeaturePicks: {}, communityId: null, classId: null, subclassId: null,
  subclassTier: 'foundation', abilityIds: [],
  // Phase 14 S17: character level (1-10), independent of subclassTier
  // (foundation/specialization/mastery is a WITHIN-tier progression
  // marker, not the numeric level). Editable from both this build-time
  // editor AND the Characters tab's play-time detail pane (characters.js)
  // -- see tierForCharacterLevel below for the level->tier mapping used
  // to filter Add Ability/Add Item candidates and the Sheet tab's
  // threshold suggestion (§12.3 addendum).
  level: 1,
  // Phase 14 S15 (character deck viewer): vaultAbilityIds is a SUBSET
  // of abilityIds -- Active is derived as "abilityIds minus
  // vaultAbilityIds", not stored as its own separate list. One source
  // of truth for ownership (abilityIds, unchanged, still governed by
  // the Codex tab's existing Abilities picker) avoids the two ever
  // drifting out of sync; the deck viewer's swap just toggles
  // membership here. conditions/equipment are wholly new, deck-viewer-
  // owned lists with no Codex-tab edit-form counterpart -- entityId
  // links a Codex entry when picked from one (Game Mechanics/
  // conditions, or any Equipment subtype), null for a free-text
  // custom entry; label is always stored so a renamed/deleted linked
  // entity doesn't break display. Experiences are ALWAYS freeform
  // (name+text typed by the player) -- no entityId at all, unlike
  // conditions/equipment, since no Codex entry ever backs one.
  vaultAbilityIds: [], conditions: [], equipment: [], experiences: []
};

// Tier progression order: Foundation (unlocked at character creation)
// -> Specialization -> Mastery (highest). Hardcoded rather than derived
// from the subclasses template schema's own featureGroups array order
// (templates.js declares foundation/mastery/specialization, which is
// NOT this game's actual unlock order) -- this ordering is fixed
// Daggerheart domain knowledge the dropdown and the cumulative-tier
// display below both depend on, not something that should silently
// follow whatever order a schema happens to list its groups in.
export const TIER_OPTIONS = [
  { key: 'foundation', label: 'Foundation' },
  { key: 'specialization', label: 'Specialization' },
  { key: 'mastery', label: 'Mastery' }
];

// Character level (1-10) -> campaign tier (1-4), per Gregg's mapping:
// Tier 1: Level 1. Tier 2: Levels 2-4. Tier 3: Levels 5-7.
// Tier 4: Levels 8-10. Drives Add Ability/Add Item filtering (character-
// deck.js) and the Sheet tab's threshold suggestion (character-sheet.js)
// -- an ability/item with no level/tier of its own is always available
// (unfiltered), one above the character's current tier is hidden.
export const CHARACTER_LEVEL_OPTIONS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
export function tierForCharacterLevel(level) {
  const n = parseInt(level, 10) || 1;
  if (n <= 1) return 1;
  if (n <= 4) return 2;
  if (n <= 7) return 3;
  return 4;
}

// Current tier + every tier below it, in TIER_OPTIONS order -- e.g.
// 'specialization' -> ['foundation', 'specialization']. A character at
// a given tier has actually unlocked all lower tiers' features too, so
// this is what the subclass card's description should show (S9), not
// just the single selected tier in isolation. Unknown/unset tier key
// falls back to itself alone (defensive; shouldn't happen since the
// tier select only ever offers TIER_OPTIONS' own keys).
export function cumulativeTierKeys(tierKey) {
  const idx = TIER_OPTIONS.findIndex(function (t) { return t.key === tierKey; });
  if (idx === -1) return tierKey ? [tierKey] : [];
  return TIER_OPTIONS.slice(0, idx + 1).map(function (t) { return t.key; });
}

// --- Mixed/meta ancestry resolution (Phase 14 S7, §11.1/§11.2) ---------
// cards.ancestryIds: the FLAVOR ancestries the player actually picked (1
// or 2, what displays on the card). A flavor ancestry may itself be
// "meta" (entity.metaAncestryTargetIds set) -- flavor-only, its features/
// details resolve through 1-2 TARGET ancestries instead of its own.
// Chaining (a target that's itself meta) is disallowed by construction
// (the Ancestry entity edit form excludes already-meta ancestries from
// the target picker) -- resolveFunctionalAncestryIds does one lookup,
// not a walk.
export function normalizeAncestryIds(cards) {
  if (cards.ancestryIds && cards.ancestryIds.length) return cards.ancestryIds;
  if (cards.ancestryId) return [cards.ancestryId];
  return [];
}
export function resolveFunctionalAncestryIds(ancestryId) {
  const anc = state.allEntities.find(function (e) { return e.id === ancestryId; });
  if (!anc) return [];
  const targets = anc.metaAncestryTargetIds;
  return (targets && targets.length) ? targets.slice(0, 2) : [ancestryId];
}
// Flattened, deduped list of the FUNCTIONAL ancestry ids a character's
// flavor picks resolve to -- length 1 or 2 in valid data (the add-select
// in buildAncestrySlotEditor prevents exceeding 2; a stale/edited-outside
// doc that somehow exceeds it is truncated here, not thrown on).
export function resolveFunctionalIds(flavorIds) {
  const out = [];
  flavorIds.forEach(function (id) {
    resolveFunctionalAncestryIds(id).forEach(function (fid) {
      if (out.indexOf(fid) === -1) out.push(fid);
    });
  });
  return out.slice(0, 2);
}

// Cards field changes mutate the SAME draft object as the rest of this
// entity's edit form (S10) -- no direct Firestore write here. Save
// commits everything together; Cancel discards the draft, which
// discards these too. patchCards() (used by buildCharacterCardEditor
// and threaded down to buildAncestrySlotEditor) merges a partial patch
// into draft.cards and re-renders; DEFAULT_CARDS keeps the merge total
// (a field never touched this session still resolves to its default,
// same as it always did against the live entity pre-S10).

// tierFilter: a single featureGroups key (equality -- ancestry feature
// picks, always exactly one of 'first'/'second'), or an array of keys
// (membership -- subclass tier, S9: "current tier" now means current +
// all lower tiers, so a subclass card shows everything actually
// unlocked, not just the one tier in isolation).
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
    ? feats.filter(function (f) {
        return Array.isArray(tierFilter) ? tierFilter.indexOf(f.group) !== -1 : f.group === tierFilter;
      })
    : feats;
  const featLines = relevantFeats.map(function (f) { return '**' + f.name + '.** ' + f.text; });
  const blocks = [];
  if (lines.length) blocks.push(lines.join('\n'));
  if (featLines.length) blocks.push(featLines.join('\n\n'));
  return blocks.join('\n\n');
}

// A single "card": description text for the given stat entity, tier-
// filtered where relevant. Every remaining caller is inside this edit
// form's own dropdown/list, which already shows the picked name --
// so there's no separate name-chip button here (S10, once the read-
// only Characters-tab viewer that needed one was removed entirely);
// this is description-only, purely to help verify the right thing got
// picked. entity==null renders nothing (an empty "-- none --" slot
// needs no placeholder of its own here).
export function buildCardSlot(entity, opts) {
  const o = opts || {};
  const wrap = document.createElement('div');
  wrap.className = 'character-card-slot';
  if (!entity) return wrap;
  const md = slotStatMarkdown(entity, o.tier);
  if (md) {
    const body = document.createElement('div');
    body.className = 'character-card-slot-body';
    renderMarkdownInto(body, md);
    wrap.appendChild(body);
  }
  return wrap;
}

// Ancestry feature-group option label: the ancestry's own actual
// feature NAME for that group (e.g. "Fungril Resilience"), not a
// generic "First"/"Second" -- falls back to the generic label if the
// entity/feature can't be resolved (deleted ancestry, blank feature
// name).
function ancestryFeatureLabel(statEntity, groupKey) {
  const fallback = groupKey === 'first' ? 'First' : 'Second';
  if (!statEntity) return fallback;
  const feat = (statEntity.features || []).find(function (f) { return f.group === groupKey; });
  return (feat && feat.name) ? feat.name : fallback;
}

// Progressive-reveal ancestry picker (Phase 14 S8, state machine fixed
// S9): a single dropdown for the first ancestry; once set, an "Add
// ancestry" button appears; clicking it reveals a second dropdown
// (options excluding whatever's picked in the other slot) -- never a
// third slot. Clearing EITHER slot while both are set demotes to the
// other (single-slot state), not a wipe of both -- clearing the sole
// remaining slot from there drops to none. Same underlying
// cards.ancestryIds/[0,1] schema throughout, no data-shape change.
function buildAncestrySlotEditor(cards, ancestryEntities, patchCards, rerender) {
  const wrap = document.createElement('div');
  wrap.className = 'character-ancestry-field';

  const flavorIds = normalizeAncestryIds(cards);
  const firstId = flavorIds[0] || null;
  const secondId = flavorIds[1] || null;
  const functionalIds = resolveFunctionalIds(flavorIds);
  const picks = cards.ancestryFeaturePicks || {};

  function save(newFlavorIds, newPicks) {
    patchCards({ ancestryIds: newFlavorIds, ancestryFeaturePicks: newPicks || {} });
  }

  // Single row: "Ancestry" label, then the dropdown(s)/button inline --
  // three states only (S9 layout fix, per Gregg's exact spec):
  //   1. no ancestry:      Ancestry   [-- none --]
  //   2. one ancestry:     Ancestry   [SOMETHING]        [Add Ancestry]
  //   3. two ancestries:   Ancestry   [SOMETHING]  [SOMETHING ELSE]
  // No separate Remove/Cancel button in state 3 -- clearing EITHER
  // dropdown back to "-- none --" is itself the way out (first
  // clearing promotes the second into the sole slot -> state 2; second
  // clearing just drops it -> state 2; clearing the sole slot in state
  // 2 -> state 1). Both dropdowns share one flex row so they're the
  // same size, not stacked on separate rows.
  const row = document.createElement('div');
  row.className = 'character-ancestry-row related-edit-add';
  const label = document.createElement('label');
  label.textContent = 'Ancestry';
  row.appendChild(label);

  // Slot 1: always a single dropdown. Its own option list excludes
  // whatever's picked in slot 2 (can't pick the same ancestry twice).
  const firstSelect = document.createElement('select');
  const firstNoneOpt = document.createElement('option');
  firstNoneOpt.value = '';
  firstNoneOpt.textContent = '-- none --';
  firstSelect.appendChild(firstNoneOpt);
  ancestryEntities.forEach(function (e) {
    if (e.id === secondId) return;
    const opt = document.createElement('option');
    opt.value = e.id;
    opt.textContent = e.name;
    firstSelect.appendChild(opt);
  });
  firstSelect.value = firstId || '';
  firstSelect.addEventListener('change', function () {
    const newFirst = firstSelect.value || null;
    state.charactersAncestryAddOpen = false;
    if (!newFirst) {
      if (secondId) { save([secondId], {}); return; }
      save([], {});
      return;
    }
    save(secondId ? [newFirst, secondId] : [newFirst], picks);
  });
  row.appendChild(firstSelect);

  // Slot 2, same row: "Add ancestry" button (exactly one picked,
  // add-picker not yet open, and at least one candidate would keep the
  // FUNCTIONAL ancestry count at or under 2 -- a meta ancestry can
  // resolve one flavor pick to 2 functional ancestries on its own, in
  // which case there's nothing eligible to add and the button doesn't
  // appear at all) OR the second dropdown itself (add-picker open, or
  // a second ancestry is already picked -- shown immediately on
  // reopen, not just mid-pick).
  const secondCandidates = ancestryEntities.filter(function (e) {
    if (e.id === firstId) return false;
    const candidateFunctional = resolveFunctionalAncestryIds(e.id);
    const merged = functionalIds.concat(candidateFunctional.filter(function (fid) { return functionalIds.indexOf(fid) === -1; }));
    return merged.length <= 2;
  });
  if (firstId && !secondId && !state.charactersAncestryAddOpen && secondCandidates.length) {
    const addBtn = document.createElement('button');
    addBtn.type = 'button';
    addBtn.textContent = 'Add Ancestry';
    addBtn.addEventListener('click', function () {
      state.charactersAncestryAddOpen = true;
      if (typeof rerender === 'function') rerender();
    });
    row.appendChild(addBtn);
  } else if (firstId && (secondId || state.charactersAncestryAddOpen)) {
    const secondSelect = document.createElement('select');
    const secondNoneOpt = document.createElement('option');
    secondNoneOpt.value = '';
    secondNoneOpt.textContent = '-- none --';
    secondSelect.appendChild(secondNoneOpt);
    secondCandidates.forEach(function (e) {
      const opt = document.createElement('option');
      opt.value = e.id;
      opt.textContent = e.name;
      secondSelect.appendChild(opt);
    });
    secondSelect.value = secondId || '';
    secondSelect.addEventListener('change', function () {
      const newSecond = secondSelect.value || null;
      state.charactersAncestryAddOpen = false;
      if (!newSecond) {
        if (secondId) save([firstId], {});
        else if (typeof rerender === 'function') rerender();
        return;
      }
      save([firstId, newSecond], picks);
    });
    row.appendChild(secondSelect);
  }
  wrap.appendChild(row);

  // ANCESTRY FEATURES section (S9 restructure): heading, then per
  // functional ancestry, its label+dropdown immediately followed by
  // that ancestry's description -- interleaved, not two separate
  // blocks. Only meaningful/shown when resolution yields exactly 2
  // functional ancestries. Two selects, each constrained to differ
  // from the other -- picking a group on one auto-flips the other to
  // the opposite group rather than exposing an invalid both-same state
  // (this IS the "auto-fill": picking ancestry A's first feature
  // auto-sets ancestry B to its second, and vice versa).
  if (functionalIds.length === 2) {
    const featuresHeading = document.createElement('h4');
    featuresHeading.className = 'character-card-subheading';
    featuresHeading.textContent = 'Ancestry Features';
    wrap.appendChild(featuresHeading);

    const fEntities = functionalIds.map(function (fid) {
      return ancestryEntities.find(function (e) { return e.id === fid; })
        || state.allEntities.find(function (e) { return e.id === fid; });
    });
    const selects = functionalIds.map(function (fid, i) {
      const fEnt = fEntities[i];
      const row = document.createElement('div');
      row.className = 'entity-edit-field';
      const rowLabel = document.createElement('label');
      rowLabel.textContent = (fEnt ? fEnt.name : fid) + ':';
      row.appendChild(rowLabel);
      const sel = document.createElement('select');
      ['first', 'second'].forEach(function (g) {
        const opt = document.createElement('option');
        opt.value = g;
        opt.textContent = ancestryFeatureLabel(fEnt, g);
        sel.appendChild(opt);
      });
      row.appendChild(sel);
      wrap.appendChild(row);
      return { fid: fid, sel: sel, fEnt: fEnt };
    });
    selects[0].sel.value = picks[selects[0].fid] || 'first';
    selects[1].sel.value = picks[selects[1].fid] || (selects[0].sel.value === 'first' ? 'second' : 'first');
    selects.forEach(function (entry, i) {
      const desc = document.createElement('div');
      desc.className = 'character-card-slot-body';
      renderMarkdownInto(desc, slotStatMarkdown(entry.fEnt, entry.sel.value));
      wrap.appendChild(desc);
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
  } else if (functionalIds.length === 1) {
    const statEntity = state.allEntities.find(function (e) { return e.id === functionalIds[0]; });
    const md = slotStatMarkdown(statEntity, null);
    if (md) {
      const desc = document.createElement('div');
      desc.className = 'character-card-slot-body';
      renderMarkdownInto(desc, md);
      wrap.appendChild(desc);
    }
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

// --- Minimal floating popup panel, self-contained (no codex.js import,
// see module header) -- same visual language as codex.js's
// buildGalleryPickerPanel/openEntityPickerPopup (shares CSS classes),
// duplicated rather than imported to avoid a codex.js <-> here cycle. ---
export function buildFloatingPickerPanel() {
  const panel = document.createElement('div');
  panel.className = 'gallery-picker-panel entity-picker-panel';
  const header = document.createElement('div');
  header.className = 'gallery-picker-header';
  panel.appendChild(header);
  const body = document.createElement('div');
  body.className = 'gallery-picker-body';
  panel.appendChild(body);
  document.body.appendChild(panel);
  return { panel: panel, header: header, body: body };
}

// Ability add-picker: search + domain-grouped list, same interaction
// pattern (search input, click-away/Escape close) as codex.js's
// openEntityPickerPopup for Related entries.
// Ability level -> character tier (Daggerheart's fixed tier bands: Tier
// 1 = level 1 only; Tier 2 = levels 2-4; Tier 3 = levels 5-7; Tier 4 =
// levels 8-10 -- same mapping the core rules use for PC tiers generally,
// not to be confused with a Subclass's own Foundation/Specialization/
// Mastery tiers). Abilities carry details.level (SRD schema,
// templates.js); an unparseable/missing level sorts last under "Other".
function abilityLevelTier(entity) {
  const n = parseInt(entity.details && entity.details.level, 10);
  if (!n || isNaN(n)) return null;
  if (n === 1) return 1;
  if (n <= 4) return 2;
  if (n <= 7) return 3;
  return 4;
}

// Experience add popup: no candidates, no search, no linking -- an
// Experience is always freeform (Name + Text), never Codex-backed.
// Shared by BOTH the Characters tab deck viewer's Experience tab
// (character-deck.js) and this module's own Codex-tab edit-form
// Experiences editor below -- one dialog, one layout, not two near-
// duplicates. Layout is deliberately explicit block rows (each field
// wrapped in .entity-edit-field, same as every other edit-form field
// in this app) rather than appending input/textarea/button directly
// into .gallery-picker-body -- those are inline-level by default with
// no layout of their own, which is what made the previous version
// look "strange" (fields and buttons packed onto one line instead of
// stacking). Save/Cancel in a right-aligned .modal-actions row, Save
// first in DOM (same order every other Save/Cancel pair in the app
// uses, e.g. codex.js's gallery upload dialog) -- flex-end packs it
// left of Cancel.
export function openExperiencePickerPopup(onAdd) {
  if (document.querySelector('.entity-picker-panel')) return;
  const built = buildFloatingPickerPanel();
  built.header.textContent = 'Add experience';

  const nameField = document.createElement('div');
  nameField.className = 'entity-edit-field';
  const nameLabel = document.createElement('label');
  nameLabel.textContent = 'Experience name';
  nameField.appendChild(nameLabel);
  const nameInput = document.createElement('input');
  nameInput.type = 'text';
  nameField.appendChild(nameInput);
  built.body.appendChild(nameField);

  const textField = document.createElement('div');
  textField.className = 'entity-edit-field';
  const textLabel = document.createElement('label');
  textLabel.textContent = 'Experience text';
  textField.appendChild(textLabel);
  const textInput = document.createElement('textarea');
  textInput.rows = 4;
  textField.appendChild(textInput);
  built.body.appendChild(textField);

  const actions = document.createElement('div');
  actions.className = 'modal-actions';
  const saveBtn = document.createElement('button');
  saveBtn.type = 'button';
  saveBtn.textContent = 'Save';
  saveBtn.addEventListener('click', function () {
    const name = nameInput.value.trim();
    if (!name) return;
    onAdd(name, textInput.value.trim());
    close();
  });
  actions.appendChild(saveBtn);
  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.textContent = 'Cancel';
  cancelBtn.addEventListener('click', close);
  actions.appendChild(cancelBtn);
  built.body.appendChild(actions);

  nameInput.focus();
  function onDocClick(ev) { if (!built.panel.contains(ev.target)) close(); }
  function onKeydown(ev) { if (ev.key === 'Escape') close(); }
  setTimeout(function () { document.addEventListener('click', onDocClick); }, 0);
  document.addEventListener('keydown', onKeydown);
  function close() {
    document.removeEventListener('click', onDocClick);
    document.removeEventListener('keydown', onKeydown);
    built.panel.remove();
  }
}

export function openAbilityPickerPopup(title, candidates, onSelect) {
  if (document.querySelector('.entity-picker-panel')) return;
  const built = buildFloatingPickerPanel();
  built.header.textContent = title;

  const searchInput = document.createElement('input');
  searchInput.type = 'text';
  searchInput.placeholder = 'Search\u2026';
  searchInput.className = 'entity-picker-search';
  built.body.appendChild(searchInput);

  const listEl = document.createElement('div');
  listEl.className = 'entity-picker-list';
  built.body.appendChild(listEl);

  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.textContent = 'Cancel';
  cancelBtn.addEventListener('click', close);
  built.body.appendChild(cancelBtn);

  function renderResults() {
    listEl.innerHTML = '';
    const q = searchInput.value.trim().toLowerCase();
    const pool = candidates.filter(function (e) { return !q || (e.name || '').toLowerCase().indexOf(q) !== -1; });
    if (!pool.length) {
      const p = document.createElement('p');
      p.className = 'lore-empty';
      p.textContent = 'No matches.';
      listEl.appendChild(p);
      return;
    }
    const byDomain = {};
    pool.forEach(function (e) {
      const dom = (e.details && e.details.domain) || 'Other';
      (byDomain[dom] = byDomain[dom] || []).push(e);
    });
    Object.keys(byDomain).sort().forEach(function (dom) {
      const header = document.createElement('div');
      header.className = 'entity-group-header';
      const titleSpan = document.createElement('span');
      titleSpan.className = 'entity-group-title';
      titleSpan.textContent = dom;
      const countSpan = document.createElement('span');
      countSpan.className = 'entity-group-count';
      countSpan.textContent = '(' + byDomain[dom].length + ')';
      header.appendChild(titleSpan);
      header.appendChild(countSpan);
      listEl.appendChild(header);

      // Sub-divide by Tier within this Domain -- Tier 1-4 in order,
      // then "Other" (missing/unparseable level) last.
      const byTier = {};
      byDomain[dom].forEach(function (e) {
        const tier = abilityLevelTier(e);
        const key = tier == null ? 'other' : String(tier);
        (byTier[key] = byTier[key] || []).push(e);
      });
      const tierKeys = ['1', '2', '3', '4', 'other'].filter(function (k) { return byTier[k]; });
      tierKeys.forEach(function (tierKey) {
        const tierHeader = document.createElement('div');
        tierHeader.className = 'ability-tier-subheader';
        tierHeader.textContent = tierKey === 'other' ? 'Other' : 'Tier ' + tierKey;
        listEl.appendChild(tierHeader);

        const ul = document.createElement('ul');
        ul.className = 'entity-group-list';
        byTier[tierKey].sort(byName).forEach(function (e) {
          const li = document.createElement('li');
          const nameDiv = document.createElement('div');
          nameDiv.className = 'entity-name';
          nameDiv.textContent = e.name;
          li.appendChild(nameDiv);
          li.addEventListener('click', function () { onSelect(e); close(); });
          ul.appendChild(li);
        });
        listEl.appendChild(ul);
      });
    });
  }

  searchInput.addEventListener('input', renderResults);
  renderResults();
  searchInput.focus();

  function onDocClick(ev) { if (!built.panel.contains(ev.target)) close(); }
  function onKeydown(ev) { if (ev.key === 'Escape') close(); }
  setTimeout(function () { document.addEventListener('click', onDocClick); }, 0);
  document.addEventListener('keydown', onKeydown);
  function close() {
    document.removeEventListener('click', onDocClick);
    document.removeEventListener('keydown', onKeydown);
    built.panel.remove();
  }
}

// Abilities: list+Remove, "+ Add ability" opens a search/domain-grouped
// popup -- same UI pattern as codex.js's Related-entries editor
// (buildRelatedEditor + openEntityPickerPopup), S9. addCandidates
// (defaults to displayEntities): the domain/class-filtered set the
// popup offers -- see the classId-derived filtering below. displayEntities:
// full visible-abilities pool, used to look up names for already-picked
// ids so a class/domain change doesn't make a previously-added ability
// show as "(deleted ability)".
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
  addRow.className = 'actions-row';
  const addRowRight = document.createElement('div');
  addRowRight.className = 'actions-row-right';
  const addBtn = document.createElement('button');
  addBtn.type = 'button';
  addBtn.className = 'action-btn-compact';
  addBtn.textContent = '+ Add ability';
  const available = abilityEntities.filter(function (e) { return abilityIds.indexOf(e.id) === -1; });
  addBtn.disabled = !available.length;
  addBtn.addEventListener('click', function () {
    openAbilityPickerPopup('Add ability', available, function (e) {
      if (abilityIds.indexOf(e.id) === -1) onChange(abilityIds.concat([e.id]));
    });
  });
  addRowRight.appendChild(addBtn);
  addRow.appendChild(addRowRight);
  wrap.appendChild(addRow);
  return wrap;
}

// Experiences editor: flat add/remove list (S16 -- previously only
// existed in the Characters tab deck viewer's Experience tab; Gregg's
// ask was for parity here too). No Active/Vault split -- that's a
// deck-viewer-only, play-time concept, this is the same flat-list
// pattern buildAbilitiesPicker above already uses. Shares the exact
// same add popup (openExperiencePickerPopup) as the deck viewer.
export function buildExperiencesEditor(cards, onChange) {
  const wrap = document.createElement('div');
  wrap.className = 'entity-edit-field';
  const label = document.createElement('label');
  label.textContent = 'Experiences';
  wrap.appendChild(label);

  const experiences = cards.experiences || [];
  const list = document.createElement('ul');
  list.className = 'related-edit-list';
  experiences.forEach(function (exp) {
    const li = document.createElement('li');
    const span = document.createElement('span');
    span.textContent = exp.name;
    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.textContent = 'Remove';
    removeBtn.addEventListener('click', function () {
      onChange(experiences.filter(function (x) { return x.id !== exp.id; }));
    });
    li.appendChild(span);
    li.appendChild(removeBtn);
    list.appendChild(li);
  });
  wrap.appendChild(list);

  const addRow = document.createElement('div');
  addRow.className = 'actions-row';
  const addRowRight = document.createElement('div');
  addRowRight.className = 'actions-row-right';
  const addBtn = document.createElement('button');
  addBtn.type = 'button';
  addBtn.className = 'action-btn-compact';
  addBtn.textContent = '+ Add experience';
  addBtn.addEventListener('click', function () {
    openExperiencePickerPopup(function (name, text) {
      onChange(experiences.concat([{ id: 'x' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7), name: name, text: text }]));
    });
  });
  addRowRight.appendChild(addBtn);
  addRow.appendChild(addRowRight);
  wrap.appendChild(addRow);
  return wrap;
}

// Owner-picked badge color (D3/S4's badge mechanism gains its picker
// here -- every badge rendered light-grey (--badge-default) until then).
// Palette is the app's own existing --cat-* category accent family
// (styles.css) -- already a curated, visually distinct 12-hue set that
// matches the established aesthetic, not a new ad-hoc palette. An
// explicit "Default" swatch (badgeColor -> null, the same light-grey
// fallback every other display already uses when unset) and a custom
// RGB/hex picker (native <input type="color">) cover anything outside
// the curated 12.
const BADGE_COLORS = [
  '#6E8E7A', '#B0785A', '#C2A24D', '#7A6C9E', '#9A5F6B', '#5E8296',
  '#8C8072', '#7C7A45', '#5A7690', '#8E6A4F', '#5C5A66', '#4F7A6E'
];

export function buildBadgeColorPicker(draft, entityName, rerender) {
  const wrap = document.createElement('div');
  wrap.className = 'entity-edit-field';
  const label = document.createElement('label');
  label.textContent = 'Badge color';
  wrap.appendChild(label);
  const row = document.createElement('div');
  row.className = 'character-badge-swatch-row';

  function save(color) {
    draft.badgeColor = color;
    rerender();
  }

  const defaultBtn = document.createElement('button');
  defaultBtn.type = 'button';
  defaultBtn.className = 'character-badge-swatch character-badge-swatch-default';
  defaultBtn.style.background = generateDefaultBadgeColor(entityName);
  if (!draft.badgeColor) defaultBtn.classList.add('selected');
  defaultBtn.title = 'Default (auto, from name)';
  defaultBtn.addEventListener('click', function () { save(null); });
  row.appendChild(defaultBtn);

  BADGE_COLORS.forEach(function (color) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'character-badge-swatch';
    if ((draft.badgeColor || '') === color) btn.classList.add('selected');
    btn.style.background = color;
    btn.title = color;
    btn.addEventListener('click', function () { save(color); });
    row.appendChild(btn);
  });

  // Custom color: badgeColor is already stored as a hex string
  // everywhere (the 12 presets above are hex literals), so the native
  // color input's value format is a direct match -- no conversion
  // needed either direction. 'change' (fires once the picker closes),
  // not 'input' (fires continuously while dragging), to avoid a
  // re-render per pixel of drag.
  const isCustom = !!draft.badgeColor && BADGE_COLORS.indexOf(draft.badgeColor) === -1;
  const customLabel = document.createElement('label');
  customLabel.className = 'character-badge-swatch character-badge-swatch-custom' + (isCustom ? ' selected' : '');
  customLabel.title = 'Custom color';
  const customInput = document.createElement('input');
  customInput.type = 'color';
  customInput.value = isCustom ? draft.badgeColor : '#B7B2A6';
  customInput.addEventListener('change', function () { save(customInput.value); });
  customLabel.appendChild(customInput);
  row.appendChild(customLabel);

  wrap.appendChild(row);
  return wrap;
}

// Full editable "cards" block for a Character entity: badge color (only
// when the character is owned -- rule 1, S9; applies on BOTH the Codex
// tab's entity edit form and the Characters tab, not just the latter as
// before), ancestry (progressive 1-2 slot picker + Ancestry Features),
// Community, Class, Subclass (hidden entirely with no class selected)
// + Subclass tier (hidden with no subclass selected), Abilities.
//
// S10: entity is read-only here (id/name/ownerId -- identity and the
// badge-color gate, never mutated). All actual edits mutate `draft`
// (draft.cards, draft.badgeColor) via the local patchCards() closure
// below; rerender() is called after every change to redraw with the
// updated draft, same re-render-on-every-keystroke pattern the rest of
// this entity's edit form already uses. Nothing here writes to
// Firestore -- codex.js's saveEntityEdit does, in the same single write
// as name/tags/aliases/etc, when the user clicks Save; Cancel discards
// the whole draft, cards included.
export function buildCharacterCardEditor(entity, draft, ctx, rerender) {
  const wrap = document.createElement('div');
  wrap.className = 'character-card-editor';

  function patchCards(patch) {
    draft.cards = Object.assign({}, DEFAULT_CARDS, draft.cards || {}, patch);
    rerender();
  }

  if (entity.ownerId) {
    wrap.appendChild(buildBadgeColorPicker(draft, entity.name, rerender));
  }

  const cards = Object.assign({}, DEFAULT_CARDS, draft.cards || {});
  const visible = function (e) { return ctx.gmView || canSee(e, ctx); };

  // Level (Phase 14 S17): plain 1-10 dropdown, independent of the
  // Ancestry/Community/Class/Subclass build-out below -- placed first
  // since it applies regardless of what else is picked yet.
  const levelWrap = document.createElement('div');
  levelWrap.className = 'entity-edit-field';
  const levelLabel = document.createElement('label');
  levelLabel.textContent = 'Level';
  levelWrap.appendChild(levelLabel);
  const levelSelect = document.createElement('select');
  CHARACTER_LEVEL_OPTIONS.forEach(function (n) {
    const opt = document.createElement('option');
    opt.value = String(n);
    opt.textContent = String(n);
    levelSelect.appendChild(opt);
  });
  levelSelect.value = String(cards.level || 1);
  levelSelect.addEventListener('change', function () { patchCards({ level: parseInt(levelSelect.value, 10) || 1 }); });
  levelWrap.appendChild(levelSelect);
  wrap.appendChild(levelWrap);

  const ancestries = state.allEntities.filter(function (e) { return e.category === 'Ancestry' && visible(e); }).sort(byName);
  const communities = state.allEntities.filter(function (e) { return e.category === 'Community' && visible(e); }).sort(byName);
  const classes = state.allEntities.filter(function (e) { return e.category === 'Game Mechanics' && e.subtype === 'classes' && visible(e); }).sort(byName);
  const subclasses = state.allEntities.filter(function (e) { return e.category === 'Game Mechanics' && e.subtype === 'subclasses' && visible(e); }).sort(byName);
  const abilities = state.allEntities.filter(function (e) { return e.category === 'Game Mechanics' && e.subtype === 'abilities' && visible(e); });

  wrap.appendChild(buildAncestrySlotEditor(cards, ancestries, patchCards, rerender));

  wrap.appendChild(buildSingleEntityPicker('Community', communities, cards.communityId,
    function (v) { patchCards({ communityId: v }); }));
  wrap.appendChild(buildCardSlot(communities.find(function (e) { return e.id === cards.communityId; })));

  wrap.appendChild(buildSingleEntityPicker('Class', classes, cards.classId,
    function (v) { patchCards({ classId: v }); }));
  wrap.appendChild(buildCardSlot(classes.find(function (e) { return e.id === cards.classId; })));

  // Phase 14 S7 (§11.7): class.details.subclass_1/subclass_2 and
  // ability.details.domain are plain strings that already exact-match
  // Subclass/Domain entity names (verified against live SRD data) --
  // no schema/rules needed, just a name-match filter. S9: Subclass
  // select (and its Tier select) hidden entirely with no class
  // selected -- an empty subclass list was previously still shown as a
  // dropdown with only "-- none --" in it, which read as broken rather
  // than "pick a class first". Tier is additionally hidden on its own
  // with no subclass selected, same reasoning.
  const selectedClass = classes.find(function (e) { return e.id === cards.classId; });
  if (selectedClass) {
    const subclassOptions = subclasses.filter(function (s) {
      const d = selectedClass.details || {};
      return s.name === d.subclass_1 || s.name === d.subclass_2;
    });
    wrap.appendChild(buildSingleEntityPicker('Subclass', subclassOptions, cards.subclassId,
      function (v) { patchCards({ subclassId: v }); }));

    const selectedSubclass = subclasses.find(function (e) { return e.id === cards.subclassId; });
    if (selectedSubclass) {
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
      tierSelect.addEventListener('change', function () { patchCards({ subclassTier: tierSelect.value }); });
      tierWrap.appendChild(tierSelect);
      wrap.appendChild(tierWrap);
      wrap.appendChild(buildCardSlot(selectedSubclass, { tier: cumulativeTierKeys(cards.subclassTier) }));
    }
  }

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

  // S10: no per-ability description dump below the list -- Domain/
  // Level/Type bullets for every chosen ability read as clutter, not
  // verification aid (unlike ancestry/community/class/subclass, which
  // keep their single description card -- see buildCardSlot's own
  // header comment). The picker's own domain/tier-grouped popup is
  // where a player confirms what they're adding, not this list.
  wrap.appendChild(buildAbilitiesPicker(cards, abilities, function (ids) { patchCards({ abilityIds: ids }); }, abilityOptionsDeduped));
  wrap.appendChild(buildExperiencesEditor(cards, function (experiences) { patchCards({ experiences: experiences }); }));

  return wrap;
}
