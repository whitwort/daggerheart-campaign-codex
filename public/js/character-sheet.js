// character-sheet.js — Phase 14 S17. The "Sheet" tab content beside
// character-deck.js's "Cards" tab (see characters.js's
// buildCharacterDetailShell, S17 commit 1). Owns `cards.sheet`, a
// wholly separate PLAY-TIME field from anything character-deck.js or
// character-cards.js touches -- see phase-14-design.md §12.
//
// Same "write straight to Firestore per interaction, no draft/Save-
// Cancel" convention as character-deck.js's patchCards -- there's no
// "cancel out of" a trait mark or an HP tick taken mid-scene. patchSheet
// here mirrors that module's own patchCards shape (full DEFAULT_CARDS-
// style backfill on every write), scoped one level deeper into
// `cards.sheet`.
//
// Commit 2 of the original 6-commit S17 plan (handoff 34) added the
// traits row; resources/gold/suggestion-indicator landed in later
// commits. Equipment slot assignment (Primary/Secondary/Armor) moved
// here from character-deck.js's Cards tab after S17 review -- see
// buildEquipmentSlotsPanel below.

import {
  getFirestore, doc, updateDoc, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import { firebaseApp } from './firebase.js';
import { trackWrite } from './connectivity.js';
import { state } from './state.js';
import { canSee } from './visibility.js';
import { DEFAULT_CARDS } from './character-cards.js';

const db = getFirestore(firebaseApp);

const TRAIT_KEYS = ['agility', 'strength', 'finesse', 'instinct', 'presence', 'knowledge'];
const TRAIT_LABELS = {
  agility: 'Agility', strength: 'Strength', finesse: 'Finesse',
  instinct: 'Instinct', presence: 'Presence', knowledge: 'Knowledge'
};

// Default blank sheet -- per §12.1, absent cards.sheet renders as this,
// same "tolerant of missing keys" convention cards.equipment/
// cards.experiences already use. Not yet all consumed (evasion etc.
// land in commit 3) but declared in full now so patchSheet's backfill
// write shape is stable across commits.
const DEFAULT_SHEET = {
  traits: TRAIT_KEYS.reduce(function (acc, k) { acc[k] = { value: 0, marked: false }; return acc; }, {}),
  evasion: 0, armorScore: 0, proficiency: 0,
  hp: { max: 0, marked: 0 }, stress: { max: 0, marked: 0 }, hope: { max: 0, marked: 0 },
  thresholds: { major: 0, severe: 0 },
  gold: { handfuls: 0, bags: 0, chest: 0 },
  // §12.3, commit 6: what liveSuggestion WAS at the time each
  // suggestible field was last written (manual edit or icon-click-
  // apply, both go through patchSuggestibleField below). null = never
  // set. Keys match SUGGESTIBLE_KEYS.
  suggestedSnapshot: { hpMax: null, evasion: null, armorScore: null, thresholdMajor: null, thresholdSevere: null }
};

function resolveSheet(entity) {
  const cards = entity.cards || {};
  const sheet = Object.assign({}, DEFAULT_SHEET, cards.sheet || {});
  sheet.traits = Object.assign({}, DEFAULT_SHEET.traits, sheet.traits || {});
  sheet.suggestedSnapshot = Object.assign({}, DEFAULT_SHEET.suggestedSnapshot, sheet.suggestedSnapshot || {});
  return sheet;
}

function patchSheet(entity, patch) {
  const cards = entity.cards || {};
  const newSheet = Object.assign({}, resolveSheet(entity), patch);
  const newCards = Object.assign({}, cards, { sheet: newSheet });
  trackWrite(updateDoc(doc(db, 'entities', entity.id), { cards: newCards, updatedAt: serverTimestamp() }), 'Saving character sheet')
    .catch(function (err) { window.alert('Save failed: ' + err.message); });
}

// Top-level cards write (NOT cards.sheet) -- used by the Equipped slot
// panel below, which mutates cards.equipment[i].slot, the same
// top-level field character-deck.js's Equipment section owns. Same
// full-DEFAULT_CARDS-backfill convention as that module's own local
// patchCards; entity.cards.sheet is preserved via the spread (DEFAULT_
// CARDS doesn't declare a `sheet` key, so it's never clobbered).
function writeCardsPatch(entity, patch) {
  const cards = Object.assign({}, DEFAULT_CARDS, entity.cards || {}, patch);
  trackWrite(updateDoc(doc(db, 'entities', entity.id), { cards: cards, updatedAt: serverTimestamp() }), 'Saving character')
    .catch(function (err) { window.alert('Save failed: ' + err.message); });
}

// Writes a field patch AND (when this field has a live suggestion right
// now) stamps suggestedSnapshot[key] with that live value in the same
// write -- covers both "player typed a value by hand" and "clicked the
// icon to apply the suggestion" with one code path (§12.3: "whether via
// manual edit or via clicking the icon to apply it").
function patchSuggestibleField(entity, sheet, fieldPatch, suggestKey, liveSuggestion) {
  const patch = Object.assign({}, fieldPatch);
  if (suggestKey && liveSuggestion !== null) {
    patch.suggestedSnapshot = Object.assign({}, sheet.suggestedSnapshot, {});
    patch.suggestedSnapshot[suggestKey] = liveSuggestion;
  }
  patchSheet(entity, patch);
}

// Live-suggestion sources (§12.3): Class entity's details.hp/evasion,
// the armor-slot equipment item's linked Armor entity's
// details.base_score/base_thresholds + current cards.level. Recomputed
// fresh on every render -- no write until the player clicks an icon.
// Each returned entry is {value, source} (or null) -- source is shown
// in the suggestion popup so the player can see WHERE a number came
// from, not just what it is.
function computeLiveSuggestions(entity, ctx) {
  const topCards = Object.assign({}, DEFAULT_CARDS, entity.cards || {});
  const visible = function (e) { return ctx.gmView || canSee(e, ctx); };

  const selectedClass = topCards.classId
    ? state.allEntities.find(function (e) { return e.id === topCards.classId && visible(e); })
    : null;
  const classDetails = selectedClass ? (selectedClass.details || {}) : {};
  const hpMaxRaw = classDetails.hp ? parseInt(classDetails.hp, 10) : NaN;
  const evasionRaw = classDetails.evasion ? parseInt(classDetails.evasion, 10) : NaN;
  const className = selectedClass ? selectedClass.name : null;

  const armorItem = (topCards.equipment || []).find(function (it) { return it.slot === 'armor'; });
  const armorEntity = armorItem && armorItem.entityId
    ? state.allEntities.find(function (e) { return e.id === armorItem.entityId && visible(e); })
    : null;
  const armorDetails = armorEntity ? (armorEntity.details || {}) : {};
  const armorScoreRaw = armorDetails.base_score ? parseInt(armorDetails.base_score, 10) : NaN;
  const armorName = armorEntity ? armorEntity.name : null;

  // base_thresholds is stored as the SRD's own "5 / 11" (major/severe)
  // string -- split on '/', trim, parse both sides; only a suggestion
  // if both parse cleanly.
  let thresholdMajorRaw = NaN, thresholdSevereRaw = NaN, level = parseInt(topCards.level, 10) || 1;
  let baseMajor = null, baseSevere = null;
  if (armorDetails.base_thresholds) {
    const parts = String(armorDetails.base_thresholds).split('/');
    if (parts.length === 2) {
      const major = parseInt(parts[0].trim(), 10);
      const severe = parseInt(parts[1].trim(), 10);
      if (!isNaN(major) && !isNaN(severe)) {
        baseMajor = major; baseSevere = severe;
        thresholdMajorRaw = major + level;
        thresholdSevereRaw = severe + level;
      }
    }
  }

  return {
    hpMax: isNaN(hpMaxRaw) ? null : { value: hpMaxRaw, source: 'From ' + className + ' class' },
    evasion: isNaN(evasionRaw) ? null : { value: evasionRaw, source: 'From ' + className + ' class' },
    armorScore: isNaN(armorScoreRaw) ? null : { value: armorScoreRaw, source: 'From ' + armorName + ' (base score ' + armorScoreRaw + ')' },
    thresholdMajor: isNaN(thresholdMajorRaw) ? null : { value: thresholdMajorRaw, source: armorName + ' base ' + baseMajor + ' + level ' + level },
    thresholdSevere: isNaN(thresholdSevereRaw) ? null : { value: thresholdSevereRaw, source: armorName + ' base ' + baseSevere + ' + level ' + level }
  };
}

// Single-open-popup tracker, same "only one at a time" convention as
// openCardPickerPopup (character-deck.js) -- a second icon opening
// closes whatever the first one had open.
let closeOpenSuggestionPopup = null;

// Suggested-value indicator (§12.3, reworked per Gregg's direction):
// first hover (desktop) or tap (touch) shows a popup with the
// suggested value + where it came from, WITHOUT applying anything.
// Hovering-then-clicking, or a second tap with the popup already open,
// applies it. This is one click handler doing double duty for both
// input styles -- desktop hover already opens the popup, so a
// subsequent click always finds one open and applies; touch has no
// hover, so a first tap opens it and a second tap (finding it already
// open) applies.
function buildSuggestionControl(fieldContainer, suggestKey, currentValue, suggestion, snapshot, onApply) {
  if (!suggestion) return null;
  const liveValue = suggestion.value;
  let cls;
  if (currentValue === liveValue) {
    cls = 'match';
  } else if (liveValue !== snapshot[suggestKey]) {
    cls = 'updated';
  } else {
    return null; // deliberate override, suggestion hasn't moved -- don't nag
  }

  const icon = document.createElement('button');
  icon.type = 'button';
  icon.className = 'character-sheet-suggestion-icon ' + cls;
  icon.textContent = 'i';

  let popup = null;
  function onDocClick(ev) {
    if (popup && !popup.contains(ev.target) && ev.target !== icon) closePopup();
  }
  function closePopup() {
    if (!popup) return;
    document.removeEventListener('click', onDocClick);
    if (popup.parentNode) popup.parentNode.removeChild(popup);
    popup = null;
    if (closeOpenSuggestionPopup === closePopup) closeOpenSuggestionPopup = null;
  }
  function openPopup() {
    if (popup) return;
    if (closeOpenSuggestionPopup) closeOpenSuggestionPopup();
    popup = document.createElement('div');
    popup.className = 'character-sheet-suggestion-popup';
    const valueLine = document.createElement('div');
    valueLine.className = 'character-sheet-suggestion-popup-value';
    valueLine.textContent = 'Suggested: ' + liveValue;
    popup.appendChild(valueLine);
    if (suggestion.source) {
      const sourceLine = document.createElement('div');
      sourceLine.className = 'character-sheet-suggestion-popup-source';
      sourceLine.textContent = suggestion.source;
      popup.appendChild(sourceLine);
    }
    fieldContainer.appendChild(popup);
    closeOpenSuggestionPopup = closePopup;
    setTimeout(function () { document.addEventListener('click', onDocClick); }, 0);
  }

  icon.addEventListener('mouseenter', openPopup);
  icon.addEventListener('click', function (e) {
    e.stopPropagation();
    if (popup) {
      onApply();
      closePopup();
    } else {
      openPopup();
    }
  });

  return icon;
}

function buildTraitCard(entity, sheet, key, editable) {
  const trait = sheet.traits[key];
  const card = document.createElement('div');
  card.className = 'character-sheet-trait-card' + (trait.marked ? ' marked' : '');

  const label = document.createElement('div');
  label.className = 'character-sheet-trait-label';
  label.textContent = TRAIT_LABELS[key];
  card.appendChild(label);

  const valueInput = document.createElement('input');
  valueInput.type = 'number';
  valueInput.className = 'character-sheet-trait-value';
  valueInput.value = trait.value;
  valueInput.disabled = !editable;
  // Editing the value shouldn't also toggle the mark -- the card's own
  // click handler (below) owns marking, this stops that click from
  // bubbling up from the input.
  valueInput.addEventListener('click', function (e) { e.stopPropagation(); });
  valueInput.addEventListener('change', function () {
    const v = parseInt(valueInput.value, 10) || 0;
    const newTraits = Object.assign({}, sheet.traits);
    newTraits[key] = Object.assign({}, trait, { value: v });
    patchSheet(entity, { traits: newTraits });
  });
  card.appendChild(valueInput);

  // Whole-card click toggles marked -- mirrors the PDF's tier-up
  // mechanic (mark two traits, clear all marks later), §12.1. No
  // enforcement of the 2-per-tier-up cap here, same "UI nudges, rules
  // don't" convention as abilityIds' 2-ability minimum.
  if (editable) {
    card.addEventListener('click', function () {
      const newTraits = Object.assign({}, sheet.traits);
      newTraits[key] = Object.assign({}, trait, { marked: !trait.marked });
      patchSheet(entity, { traits: newTraits });
    });
  }

  return card;
}

function buildNumberField(labelText, value, editable, onChange, opts) {
  opts = opts || {};
  const field = document.createElement('div');
  field.className = 'character-sheet-field' + (opts.extraClass ? ' ' + opts.extraClass : '');
  const labelRow = document.createElement('div');
  labelRow.className = 'character-sheet-field-label-row';
  const label = document.createElement('div');
  label.className = 'character-sheet-field-label';
  label.textContent = labelText;
  labelRow.appendChild(label);
  if (opts.suggestKey && opts.suggestion) {
    const icon = buildSuggestionControl(field, opts.suggestKey, value, opts.suggestion, opts.snapshot, function () {
      onChange(opts.suggestion.value, opts.suggestKey, opts.suggestion.value);
    });
    if (icon) labelRow.appendChild(icon);
  }
  field.appendChild(labelRow);
  const input = document.createElement('input');
  input.type = 'number';
  input.className = 'character-sheet-field-value';
  input.value = value;
  input.disabled = !editable;
  input.addEventListener('change', function () {
    onChange(parseInt(input.value, 10) || 0, opts.suggestKey, opts.suggestion ? opts.suggestion.value : null);
  });
  field.appendChild(input);
  return field;
}

// HP/Stress/Hope: Max + Marked pair, one Firestore write shape
// ({max, marked}) shared by all three (§12.1). Marked isn't clamped to
// max here -- same "UI nudges, rules don't enforce" convention as the
// rest of this module; a player over-marking is visible, not blocked.
// suggestion (commit 6): only HP's max carries a suggestion (Class
// details.hp) -- Stress/Hope have no structured source, callers simply
// omit it.
function buildTrackField(entity, sheet, key, labelText, editable, suggestKey, suggestion) {
  const wrap = document.createElement('div');
  wrap.className = 'character-sheet-track-field';
  const labelRow = document.createElement('div');
  labelRow.className = 'character-sheet-field-label-row';
  const label = document.createElement('div');
  label.className = 'character-sheet-field-label';
  label.textContent = labelText;
  labelRow.appendChild(label);
  if (suggestKey && suggestion) {
    const icon = buildSuggestionControl(wrap, suggestKey, sheet[key].max, suggestion, sheet.suggestedSnapshot, function () {
      patchSuggestibleField(entity, sheet, { [key]: Object.assign({}, sheet[key], { max: suggestion.value }) }, suggestKey, suggestion.value);
    });
    if (icon) labelRow.appendChild(icon);
  }
  wrap.appendChild(labelRow);

  const row = document.createElement('div');
  row.className = 'character-sheet-track-row';

  const maxInput = document.createElement('input');
  maxInput.type = 'number';
  maxInput.className = 'character-sheet-field-value';
  maxInput.title = 'Max';
  maxInput.value = sheet[key].max;
  maxInput.disabled = !editable;
  maxInput.addEventListener('change', function () {
    const v = parseInt(maxInput.value, 10) || 0;
    patchSuggestibleField(entity, sheet, { [key]: Object.assign({}, sheet[key], { max: v }) }, suggestKey, suggestion ? suggestion.value : null);
  });
  row.appendChild(maxInput);

  const slash = document.createElement('span');
  slash.className = 'character-sheet-track-slash';
  slash.textContent = '/';
  row.appendChild(slash);

  const markedInput = document.createElement('input');
  markedInput.type = 'number';
  markedInput.className = 'character-sheet-field-value';
  markedInput.title = 'Marked';
  markedInput.value = sheet[key].marked;
  markedInput.disabled = !editable;
  markedInput.addEventListener('change', function () {
    patchSheet(entity, { [key]: Object.assign({}, sheet[key], { marked: parseInt(markedInput.value, 10) || 0 }) });
  });
  row.appendChild(markedInput);

  wrap.appendChild(row);
  return wrap;
}

// Weapon/Armor slot assignment (moved here from the Cards tab's
// Equipment section -- that per-item <select> didn't have room on the
// cramped mini-cards and wasn't legible in practice). One row per slot
// (not per item) -- clearer framing: "what's in my Primary slot" reads
// better than hunting each inventory card for a dropdown. Candidates
// are the character's own cards.equipment items whose linked entity's
// subtype matches the slot (Weapons for primary/secondary, Armor for
// armor); unlinked/custom items have no subtype to key off and can't
// be assigned a slot, same limitation as before.
const SLOT_DEFS = [
  { slot: 'primary', label: 'Primary', subtype: 'weapons' },
  { slot: 'secondary', label: 'Secondary', subtype: 'weapons' },
  { slot: 'armor', label: 'Armor', subtype: 'armor' }
];
function applyEquipmentSlotAssignment(entity, equipment, slot, itemId) {
  const newEquipment = equipment.map(function (it) {
    if (it.id === itemId) return Object.assign({}, it, { slot: slot });
    if (it.slot === slot) return Object.assign({}, it, { slot: null });
    return it;
  });
  writeCardsPatch(entity, { equipment: newEquipment });
}
function buildEquipmentSlotsPanel(entity, topCards, editable) {
  const wrap = document.createElement('div');
  wrap.className = 'character-sheet-slots';
  const title = document.createElement('div');
  title.className = 'character-sheet-field-label';
  title.textContent = 'Equipped';
  wrap.appendChild(title);

  const equipment = topCards.equipment || [];
  SLOT_DEFS.forEach(function (def) {
    const row = document.createElement('div');
    row.className = 'character-sheet-slot-row';
    const label = document.createElement('span');
    label.className = 'character-sheet-slot-row-label';
    label.textContent = def.label;
    row.appendChild(label);

    const select = document.createElement('select');
    select.className = 'character-sheet-slot-select';
    select.disabled = !editable;
    const noneOpt = document.createElement('option');
    noneOpt.value = '';
    noneOpt.textContent = '(none)';
    select.appendChild(noneOpt);
    const candidates = equipment.filter(function (it) {
      const linked = it.entityId ? state.allEntities.find(function (e) { return e.id === it.entityId; }) : null;
      return linked && linked.subtype === def.subtype;
    });
    candidates.forEach(function (it) {
      const opt = document.createElement('option');
      opt.value = it.id;
      opt.textContent = it.label;
      if (it.slot === def.slot) opt.selected = true;
      select.appendChild(opt);
    });
    select.addEventListener('change', function () {
      applyEquipmentSlotAssignment(entity, equipment, def.slot, select.value || null);
    });
    row.appendChild(select);
    wrap.appendChild(row);
  });
  return wrap;
}

function buildResourcesBlock(entity, sheet, editable, suggestions, topCards) {
  const wrap = document.createElement('div');
  wrap.className = 'character-sheet-resources';

  const trackRow = document.createElement('div');
  trackRow.className = 'character-sheet-resources-row';
  trackRow.appendChild(buildTrackField(entity, sheet, 'hp', 'HP', editable, 'hpMax', suggestions.hpMax));
  trackRow.appendChild(buildTrackField(entity, sheet, 'stress', 'Stress', editable));
  trackRow.appendChild(buildTrackField(entity, sheet, 'hope', 'Hope', editable));
  wrap.appendChild(trackRow);

  const statsRow = document.createElement('div');
  statsRow.className = 'character-sheet-resources-row';
  statsRow.appendChild(buildNumberField('Evasion', sheet.evasion, editable, function (v, suggestKey, suggestValue) {
    patchSuggestibleField(entity, sheet, { evasion: v }, suggestKey, suggestValue);
  }, { suggestKey: 'evasion', suggestion: suggestions.evasion, snapshot: sheet.suggestedSnapshot }));
  statsRow.appendChild(buildNumberField('Armor Score', sheet.armorScore, editable, function (v, suggestKey, suggestValue) {
    patchSuggestibleField(entity, sheet, { armorScore: v }, suggestKey, suggestValue);
  }, { suggestKey: 'armorScore', suggestion: suggestions.armorScore, snapshot: sheet.suggestedSnapshot }));
  statsRow.appendChild(buildNumberField('Proficiency', sheet.proficiency, editable, function (v) {
    patchSheet(entity, { proficiency: v });
  }));
  statsRow.appendChild(buildNumberField('Major Threshold', sheet.thresholds.major, editable, function (v, suggestKey, suggestValue) {
    patchSuggestibleField(entity, sheet, { thresholds: Object.assign({}, sheet.thresholds, { major: v }) }, suggestKey, suggestValue);
  }, { suggestKey: 'thresholdMajor', suggestion: suggestions.thresholdMajor, snapshot: sheet.suggestedSnapshot }));
  statsRow.appendChild(buildNumberField('Severe Threshold', sheet.thresholds.severe, editable, function (v, suggestKey, suggestValue) {
    patchSuggestibleField(entity, sheet, { thresholds: Object.assign({}, sheet.thresholds, { severe: v }) }, suggestKey, suggestValue);
  }, { suggestKey: 'thresholdSevere', suggestion: suggestions.thresholdSevere, snapshot: sheet.suggestedSnapshot }));

  const mainRow = document.createElement('div');
  mainRow.className = 'character-sheet-resources-main';
  mainRow.appendChild(statsRow);
  mainRow.appendChild(buildEquipmentSlotsPanel(entity, topCards, editable));
  wrap.appendChild(mainRow);

  return wrap;
}

function buildGoldBlock(entity, sheet, editable) {
  const wrap = document.createElement('div');
  wrap.className = 'character-sheet-resources-row character-sheet-gold-row';
  wrap.appendChild(buildNumberField('Handfuls', sheet.gold.handfuls, editable, function (v) {
    patchSheet(entity, { gold: Object.assign({}, sheet.gold, { handfuls: v }) });
  }));
  wrap.appendChild(buildNumberField('Bags', sheet.gold.bags, editable, function (v) {
    patchSheet(entity, { gold: Object.assign({}, sheet.gold, { bags: v }) });
  }));
  wrap.appendChild(buildNumberField('Chest', sheet.gold.chest, editable, function (v) {
    patchSheet(entity, { gold: Object.assign({}, sheet.gold, { chest: v }) });
  }));
  return wrap;
}

export function buildCharacterSheet(entity, ctx, editable) {
  const sheet = resolveSheet(entity);
  const topCards = Object.assign({}, DEFAULT_CARDS, entity.cards || {});
  const suggestions = computeLiveSuggestions(entity, ctx);

  const wrap = document.createElement('div');
  wrap.className = 'character-sheet';

  const traitsRow = document.createElement('div');
  traitsRow.className = 'character-sheet-traits-row';
  TRAIT_KEYS.forEach(function (key) {
    traitsRow.appendChild(buildTraitCard(entity, sheet, key, editable));
  });
  wrap.appendChild(traitsRow);

  wrap.appendChild(buildResourcesBlock(entity, sheet, editable, suggestions, topCards));

  const goldLabel = document.createElement('div');
  goldLabel.className = 'character-deck-section-title';
  goldLabel.textContent = 'Gold';
  wrap.appendChild(goldLabel);
  wrap.appendChild(buildGoldBlock(entity, sheet, editable));

  return wrap;
}
