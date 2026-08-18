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
// Commit 2 of the 6-commit S17 plan (handoff 34): traits row only.
// Resources block / gold / equipment slots / suggestion indicator land
// in later commits against this same module.

import {
  getFirestore, doc, updateDoc, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import { firebaseApp } from './firebase.js';
import { trackWrite } from './connectivity.js';

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
  gold: { handfuls: 0, bags: 0, chest: 0 }
};

function resolveSheet(entity) {
  const cards = entity.cards || {};
  const sheet = Object.assign({}, DEFAULT_SHEET, cards.sheet || {});
  sheet.traits = Object.assign({}, DEFAULT_SHEET.traits, sheet.traits || {});
  return sheet;
}

function patchSheet(entity, patch) {
  const cards = entity.cards || {};
  const newSheet = Object.assign({}, resolveSheet(entity), patch);
  const newCards = Object.assign({}, cards, { sheet: newSheet });
  trackWrite(updateDoc(doc(db, 'entities', entity.id), { cards: newCards, updatedAt: serverTimestamp() }), 'Saving character sheet')
    .catch(function (err) { window.alert('Save failed: ' + err.message); });
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

function buildNumberField(labelText, value, editable, onChange, extraClass) {
  const field = document.createElement('div');
  field.className = 'character-sheet-field' + (extraClass ? ' ' + extraClass : '');
  const label = document.createElement('div');
  label.className = 'character-sheet-field-label';
  label.textContent = labelText;
  field.appendChild(label);
  const input = document.createElement('input');
  input.type = 'number';
  input.className = 'character-sheet-field-value';
  input.value = value;
  input.disabled = !editable;
  input.addEventListener('change', function () {
    onChange(parseInt(input.value, 10) || 0);
  });
  field.appendChild(input);
  return field;
}

// HP/Stress/Hope: Max + Marked pair, one Firestore write shape
// ({max, marked}) shared by all three (§12.1). Marked isn't clamped to
// max here -- same "UI nudges, rules don't enforce" convention as the
// rest of this module; a player over-marking is visible, not blocked.
function buildTrackField(entity, sheet, key, labelText, editable) {
  const wrap = document.createElement('div');
  wrap.className = 'character-sheet-track-field';
  const label = document.createElement('div');
  label.className = 'character-sheet-field-label';
  label.textContent = labelText;
  wrap.appendChild(label);

  const row = document.createElement('div');
  row.className = 'character-sheet-track-row';

  const maxInput = document.createElement('input');
  maxInput.type = 'number';
  maxInput.className = 'character-sheet-field-value';
  maxInput.title = 'Max';
  maxInput.value = sheet[key].max;
  maxInput.disabled = !editable;
  maxInput.addEventListener('change', function () {
    patchSheet(entity, { [key]: Object.assign({}, sheet[key], { max: parseInt(maxInput.value, 10) || 0 }) });
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

function buildResourcesBlock(entity, sheet, editable) {
  const wrap = document.createElement('div');
  wrap.className = 'character-sheet-resources';

  const trackRow = document.createElement('div');
  trackRow.className = 'character-sheet-resources-row';
  trackRow.appendChild(buildTrackField(entity, sheet, 'hp', 'HP', editable));
  trackRow.appendChild(buildTrackField(entity, sheet, 'stress', 'Stress', editable));
  trackRow.appendChild(buildTrackField(entity, sheet, 'hope', 'Hope', editable));
  wrap.appendChild(trackRow);

  const statsRow = document.createElement('div');
  statsRow.className = 'character-sheet-resources-row';
  statsRow.appendChild(buildNumberField('Evasion', sheet.evasion, editable, function (v) {
    patchSheet(entity, { evasion: v });
  }));
  statsRow.appendChild(buildNumberField('Armor Score', sheet.armorScore, editable, function (v) {
    patchSheet(entity, { armorScore: v });
  }));
  statsRow.appendChild(buildNumberField('Proficiency', sheet.proficiency, editable, function (v) {
    patchSheet(entity, { proficiency: v });
  }));
  statsRow.appendChild(buildNumberField('Major Threshold', sheet.thresholds.major, editable, function (v) {
    patchSheet(entity, { thresholds: Object.assign({}, sheet.thresholds, { major: v }) });
  }));
  statsRow.appendChild(buildNumberField('Severe Threshold', sheet.thresholds.severe, editable, function (v) {
    patchSheet(entity, { thresholds: Object.assign({}, sheet.thresholds, { severe: v }) });
  }));
  wrap.appendChild(statsRow);

  return wrap;
}

export function buildCharacterSheet(entity, ctx, editable) {
  const sheet = resolveSheet(entity);

  const wrap = document.createElement('div');
  wrap.className = 'character-sheet';

  const traitsRow = document.createElement('div');
  traitsRow.className = 'character-sheet-traits-row';
  TRAIT_KEYS.forEach(function (key) {
    traitsRow.appendChild(buildTraitCard(entity, sheet, key, editable));
  });
  wrap.appendChild(traitsRow);

  wrap.appendChild(buildResourcesBlock(entity, sheet, editable));

  return wrap;
}
