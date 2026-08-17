// character-cards.js — Phase 14 S9. Shared "cards" editing UI for
// Character-category entities (ancestry, community, class/subclass/
// tier, abilities, badge color).
//
// Previously this lived entirely inside characters.js and was only
// reachable from the player-view Characters tab; the Codex tab's own
// entity edit form had a much thinner, divergent ancestry-only field.
// This module is the single implementation now -- codex.js's entity
// edit form (GM or player editing a Character, from the Codex tab) and
// characters.js's player-view detail pane both call the SAME functions
// here, so the two surfaces render byte-identical DOM/behavior. Zero
// dependency on codex.js or characters.js (same "small shared module"
// pattern as badge-color.js/transfer-requests.js/entity-images-cache.js)
// to avoid an import cycle -- codex.js imports from here, characters.js
// imports from here, this module imports from neither.
//
// buildCardSlot's "open in Codex" name-chip is opt-in via a caller-
// supplied onOpenInCodex callback rather than a direct import of
// switchToCodexTabForEntity, for the same cycle-avoidance reason.

import {
  getFirestore, doc, updateDoc, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import { firebaseApp } from './firebase.js';
import { state } from './state.js';
import { trackWrite } from './connectivity.js';
import { canSee } from './visibility.js';
import { getTemplateSchema } from './templates.js';
import { renderMarkdownInto } from './markdown.js';
import { generateDefaultBadgeColor } from './badge-color.js';

const db = getFirestore(firebaseApp);

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
  subclassTier: 'foundation', abilityIds: []
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

// Current tier + every tier below it, in TIER_OPTIONS order -- e.g.
// 'specialization' -> ['foundation', 'specialization']. A character at
// a given tier has actually unlocked all lower tiers' features too, so
// this is what the subclass card's description should show (S9), not
// just the single selected tier in isolation. Unknown/unset tier key
// falls back to itself alone (defensive; shouldn't happen since the
// tier select only ever offers TIER_OPTIONS' own keys).
function cumulativeTierKeys(tierKey) {
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

export function saveCardsPatch(entity, patch, onWriteStart) {
  const cards = Object.assign({}, DEFAULT_CARDS, entity.cards || {}, patch);
  if (onWriteStart) onWriteStart();
  trackWrite(
    updateDoc(doc(db, 'entities', entity.id), { cards: cards, updatedAt: serverTimestamp() }),
    'Saving character card'
  ).catch(function (err) { window.alert('Save failed: ' + err.message); });
}

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
// filtered where relevant. opts.skipNameChip (edit contexts -- S9):
// the entity's name is already shown by the dropdown/list that picked
// it, so the name-chip button here would just re-display the same
// info with no added value; the description text below it is what
// actually helps the user verify they picked the right thing, so that
// stays either way. Viewer contexts (opts.onOpenInCodex given, no
// skipNameChip) keep the full chip -- there's no dropdown there to
// already show the name.
export function buildCardSlot(entity, opts) {
  const o = opts || {};
  const wrap = document.createElement('div');
  wrap.className = 'character-card-slot';
  if (!entity) {
    if (o.skipNameChip) return wrap; // nothing to verify against -- empty, no placeholder needed alongside a "-- none --" select
    const none = document.createElement('p');
    none.className = 'lore-empty';
    none.textContent = '\u2014 none selected \u2014';
    wrap.appendChild(none);
    return wrap;
  }
  if (!o.skipNameChip) {
    const nameBtn = document.createElement('button');
    nameBtn.type = 'button';
    nameBtn.className = 'character-name-chip';
    nameBtn.textContent = entity.name;
    nameBtn.title = 'Open in Codex';
    nameBtn.addEventListener('click', function () { if (o.onOpenInCodex) o.onOpenInCodex(entity.id); });
    wrap.appendChild(nameBtn);
  }
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
function buildAncestrySlotEditor(entity, cards, ancestryEntities, onWriteStart) {
  const wrap = document.createElement('div');
  wrap.className = 'character-ancestry-field';

  const flavorIds = normalizeAncestryIds(cards);
  const firstId = flavorIds[0] || null;
  const secondId = flavorIds[1] || null;
  const functionalIds = resolveFunctionalIds(flavorIds);
  const picks = cards.ancestryFeaturePicks || {};

  function save(newFlavorIds, newPicks) {
    saveCardsPatch(entity, { ancestryIds: newFlavorIds, ancestryFeaturePicks: newPicks || {} }, onWriteStart);
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
      if (typeof entity.__rerenderCards === 'function') entity.__rerenderCards();
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
        else if (typeof entity.__rerenderCards === 'function') entity.__rerenderCards();
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
function buildFloatingPickerPanel() {
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

function openAbilityPickerPopup(title, candidates, onSelect) {
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

export function buildBadgeColorPicker(entity, onWriteStart) {
  const wrap = document.createElement('div');
  wrap.className = 'entity-edit-field';
  const label = document.createElement('label');
  label.textContent = 'Badge color';
  wrap.appendChild(label);
  const row = document.createElement('div');
  row.className = 'character-badge-swatch-row';

  function save(color) {
    if (onWriteStart) onWriteStart();
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

// Full editable "cards" block for a Character entity: badge color (only
// when the character is owned -- rule 1, S9; applies on BOTH the Codex
// tab's entity edit form and the Characters tab, not just the latter as
// before), ancestry (progressive 1-2 slot picker + Ancestry Features),
// Community, Class, Subclass (hidden entirely with no class selected)
// + Subclass tier (hidden with no subclass selected), Abilities. Single
// assembly function so both call sites render identical DOM in
// identical order -- see module header. ctx must be the REAL viewer's
// ctx (never a synthesized preview identity); callers already only
// reach this when hasFullAuthority is true, this doesn't re-check.
//
// entity.__rerenderCards: a caller-supplied no-arg callback this module
// invokes for UI-only state changes that don't themselves write to
// Firestore (e.g. opening the second-ancestry add picker) -- setting a
// throwaway property on the plain entity object avoids a third
// parameter threaded through every nested builder for something that's
// only needed by two buttons deep inside the ancestry editor.
//
// onWriteStart (optional, S9): called synchronously right before each
// Firestore write this editor issues (ancestry/community/class/
// subclass/tier/abilities/badge). codex.js passes a callback that bumps
// state.detailEditPendingCardWrites -- these writes happen immediately,
// independent of this entity's own Codex-tab edit-form Save/Cancel
// flow, and were otherwise indistinguishable from someone ELSE editing
// the same entity, tripping the "saved elsewhere" conflict banner on
// every single card change made through this very form. characters.js
// has no such banner and passes nothing.
export function buildCharacterCardEditor(entity, ctx, rerender, onWriteStart) {
  const wrap = document.createElement('div');
  wrap.className = 'character-card-editor';
  entity.__rerenderCards = rerender;

  if (entity.ownerId) {
    wrap.appendChild(buildBadgeColorPicker(entity, onWriteStart));
  }

  const cards = Object.assign({}, DEFAULT_CARDS, entity.cards || {});
  const visible = function (e) { return ctx.gmView || canSee(e, ctx); };
  const ancestries = state.allEntities.filter(function (e) { return e.category === 'Ancestry' && visible(e); }).sort(byName);
  const communities = state.allEntities.filter(function (e) { return e.category === 'Community' && visible(e); }).sort(byName);
  const classes = state.allEntities.filter(function (e) { return e.category === 'Game Mechanics' && e.subtype === 'classes' && visible(e); }).sort(byName);
  const subclasses = state.allEntities.filter(function (e) { return e.category === 'Game Mechanics' && e.subtype === 'subclasses' && visible(e); }).sort(byName);
  const abilities = state.allEntities.filter(function (e) { return e.category === 'Game Mechanics' && e.subtype === 'abilities' && visible(e); });

  wrap.appendChild(buildAncestrySlotEditor(entity, cards, ancestries, onWriteStart));

  wrap.appendChild(buildSingleEntityPicker('Community', communities, cards.communityId,
    function (v) { saveCardsPatch(entity, { communityId: v }, onWriteStart); }));
  wrap.appendChild(buildCardSlot(communities.find(function (e) { return e.id === cards.communityId; }), { skipNameChip: true }));

  wrap.appendChild(buildSingleEntityPicker('Class', classes, cards.classId,
    function (v) { saveCardsPatch(entity, { classId: v }, onWriteStart); }));
  wrap.appendChild(buildCardSlot(classes.find(function (e) { return e.id === cards.classId; }), { skipNameChip: true }));

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
      function (v) { saveCardsPatch(entity, { subclassId: v }, onWriteStart); }));

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
      tierSelect.addEventListener('change', function () { saveCardsPatch(entity, { subclassTier: tierSelect.value }, onWriteStart); });
      tierWrap.appendChild(tierSelect);
      wrap.appendChild(tierWrap);
      wrap.appendChild(buildCardSlot(selectedSubclass, { tier: cumulativeTierKeys(cards.subclassTier), skipNameChip: true }));
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

  wrap.appendChild(buildAbilitiesPicker(cards, abilities, function (ids) { saveCardsPatch(entity, { abilityIds: ids }, onWriteStart); }, abilityOptionsDeduped));
  const abilityCardsWrap = document.createElement('div');
  cards.abilityIds.forEach(function (id) {
    const a = abilities.find(function (e) { return e.id === id; });
    if (a) abilityCardsWrap.appendChild(buildCardSlot(a, { skipNameChip: true }));
  });
  wrap.appendChild(abilityCardsWrap);

  return wrap;
}

// Read-only card-slot viewer (GM's "Players & Characters" detail pane —
// unaffected by the S9 editor-unification ask, kept as-is). Full name
// chips (onOpenInCodex) since there's no dropdown here already showing
// the name.
export function buildCardSlotViewer(entity, onOpenInCodex) {
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
      wrap.appendChild(buildCardSlot(statEntity, { tier: groupFilter, onOpenInCodex: onOpenInCodex }));
    });
  } else {
    wrap.appendChild(buildCardSlot(null));
  }
  wrap.appendChild(buildCardSlot(state.allEntities.find(function (e) { return e.id === cards.communityId; }), { onOpenInCodex: onOpenInCodex }));
  wrap.appendChild(buildCardSlot(state.allEntities.find(function (e) { return e.id === cards.classId; }), { onOpenInCodex: onOpenInCodex }));
  wrap.appendChild(buildCardSlot(
    state.allEntities.find(function (e) { return e.id === cards.subclassId; }),
    { tier: cumulativeTierKeys(cards.subclassTier), onOpenInCodex: onOpenInCodex }
  ));
  (cards.abilityIds || []).forEach(function (id) {
    const a = state.allEntities.find(function (e) { return e.id === id; });
    if (a) wrap.appendChild(buildCardSlot(a, { onOpenInCodex: onOpenInCodex }));
  });
  return wrap;
}
