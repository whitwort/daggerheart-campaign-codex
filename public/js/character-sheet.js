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
import { DEFAULT_CARDS, tierForCharacterLevel } from './character-cards.js';
import { renderMarkdownInto } from './markdown.js';

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
  // Starting Active/Starting Checked, per Gregg: HP is class-defined (0
  // until a class suggestion is applied), Stress starts with 6 of its
  // 12 boxes active, Hope starts with 6 of its 6 active and 2 already
  // checked. Ceiling (12/12/6) is a fixed game-rule constant, not
  // stored -- see HP_CEILING/STRESS_CEILING/HOPE_CEILING below.
  hp: { max: 0, marked: 0 }, stress: { max: 6, marked: 0 }, hope: { max: 6, marked: 2 },
  thresholds: { major: 0, severe: 0 },
  gold: { handfuls: 0, bags: 0, chest: 0 },
  // §12.3: what liveSuggestion WAS at the time each suggestible field
  // was last written (manual edit or icon-click-apply, both go through
  // patchSuggestibleField below). null = never set.
  suggestedSnapshot: { hpMax: null, evasion: null, armorScore: null, thresholdMajor: null, thresholdSevere: null, proficiency: null }
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
//
// Every field always returns an object now -- either {value, source}
// (calculable) or {value: null, reason} (not yet calculable, e.g. no
// class/armor selected). The icon itself is never hidden for the
// "not yet calculable" case; only the pre-existing "deliberate
// override" case (buildSuggestionControl) still omits the icon.
function computeLiveSuggestions(entity, ctx) {
  const topCards = Object.assign({}, DEFAULT_CARDS, entity.cards || {});
  const visible = function (e) { return ctx.gmView || canSee(e, ctx); };
  const level = parseInt(topCards.level, 10) || 1;

  const selectedClass = topCards.classId
    ? state.allEntities.find(function (e) { return e.id === topCards.classId && visible(e); })
    : null;
  const classDetails = selectedClass ? (selectedClass.details || {}) : {};
  const className = selectedClass ? selectedClass.name : null;

  let hpMax, evasion;
  if (!selectedClass) {
    hpMax = { value: null, reason: 'Needs a Class selected (Cards tab \u2192 Class)' };
    evasion = { value: null, reason: 'Needs a Class selected (Cards tab \u2192 Class)' };
  } else {
    const hpMaxRaw = classDetails.hp ? parseInt(classDetails.hp, 10) : NaN;
    const evasionRaw = classDetails.evasion ? parseInt(classDetails.evasion, 10) : NaN;
    hpMax = isNaN(hpMaxRaw)
      ? { value: null, reason: className + ' has no HP value defined' }
      : { value: hpMaxRaw, source: 'From ' + className + ' class' };
    evasion = isNaN(evasionRaw)
      ? { value: null, reason: className + ' has no Evasion value defined' }
      : { value: evasionRaw, source: 'From ' + className + ' class' };
  }

  const armorItem = (topCards.equipment || []).find(function (it) { return it.slot === 'armor'; });
  const armorEntity = armorItem && armorItem.entityId
    ? state.allEntities.find(function (e) { return e.id === armorItem.entityId && visible(e); })
    : null;
  const armorDetails = armorEntity ? (armorEntity.details || {}) : {};
  const armorName = armorEntity ? armorEntity.name : null;
  const noArmorReason = 'Needs Armor equipped in the Armor slot (Sheet tab \u2192 Equipped)';

  let armorScore;
  if (!armorEntity) {
    armorScore = { value: null, reason: noArmorReason };
  } else {
    const armorScoreRaw = armorDetails.base_score ? parseInt(armorDetails.base_score, 10) : NaN;
    armorScore = isNaN(armorScoreRaw)
      ? { value: null, reason: armorName + ' has no base score defined' }
      : { value: armorScoreRaw, source: 'From ' + armorName + ' (base score ' + armorScoreRaw + ')' };
  }

  // base_thresholds is stored as the SRD's own "5 / 11" (major/severe)
  // string -- split on '/', trim, parse both sides; only a suggestion
  // if both parse cleanly.
  let thresholdMajor, thresholdSevere;
  if (!armorEntity) {
    thresholdMajor = { value: null, reason: noArmorReason };
    thresholdSevere = { value: null, reason: noArmorReason };
  } else {
    let baseMajor = null, baseSevere = null;
    if (armorDetails.base_thresholds) {
      const parts = String(armorDetails.base_thresholds).split('/');
      if (parts.length === 2) {
        const major = parseInt(parts[0].trim(), 10);
        const severe = parseInt(parts[1].trim(), 10);
        if (!isNaN(major) && !isNaN(severe)) { baseMajor = major; baseSevere = severe; }
      }
    }
    if (baseMajor === null) {
      thresholdMajor = { value: null, reason: armorName + ' has no valid thresholds defined' };
      thresholdSevere = { value: null, reason: armorName + ' has no valid thresholds defined' };
    } else {
      thresholdMajor = { value: baseMajor + level, source: armorName + ' base ' + baseMajor + ' + level ' + level };
      thresholdSevere = { value: baseSevere + level, source: armorName + ' base ' + baseSevere + ' + level ' + level };
    }
  }

  return {
    hpMax: hpMax,
    evasion: evasion,
    armorScore: armorScore,
    thresholdMajor: thresholdMajor,
    thresholdSevere: thresholdSevere,
    // Proficiency = campaign tier at the character's current level
    // (T1=1, T2=2, T3=3, T4=4), per Gregg's direction. Always
    // calculable -- cards.level always has a value (defaults to 1).
    proficiency: { value: tierForCharacterLevel(level), source: 'Tier ' + tierForCharacterLevel(level) + ' (level ' + level + ')' }
  };
}

// Single-open-popup tracker, same "only one at a time" convention as
// openCardPickerPopup (character-deck.js) -- a second icon opening
// closes whatever the first one had open.
let closeOpenSuggestionPopup = null;

// Suggested-value indicator (§12.3). Icon sits inside its own small
// position:relative wrapper (NOT the whole field box) -- same
// icon-wrap/popover anchoring convention as .vis-kebab-wrap/
// .vis-kebab-popover elsewhere in the app: popup hangs directly off
// the icon's own bottom-right corner, not pinned to the far edge of
// whatever container happens to hold it.
//
// Interaction: first hover (desktop) or tap (touch) shows the popup
// with the suggested value + where it came from, WITHOUT applying
// anything. Hovering-then-clicking, or a second tap with the popup
// already open, applies it -- one click handler serves both input
// styles, since desktop hover already opens the popup, so a click
// there always finds one open and applies.
//
// A suggestion that isn't calculable yet (suggestion.value === null)
// still gets an icon -- a distinct 'unavailable' style -- so the
// player can see a suggestion EXISTS for this field and find out what
// it needs (e.g. "Needs Armor equipped"). Clicking it just shows/hides
// that explanation; there's nothing to apply.
//
// The icon is NEVER hidden (per Gregg -- an earlier "deliberate
// override, suggestion hasn't moved, don't nag" case used to omit it
// entirely; that's gone). Three visible states now: unavailable (not
// yet calculable), match (current value equals the live suggestion),
// updated (current value differs from the live suggestion, whether
// that's because the suggestion just changed or because the player set
// something else entirely -- both look and behave the same: click to
// apply the live suggestion).
function buildSuggestionControl(currentValue, suggestion, onApply) {
  if (!suggestion) return null;
  const liveValue = suggestion.value;
  let cls, canApply;
  if (liveValue === null) {
    cls = 'unavailable';
    canApply = false;
  } else if (currentValue === liveValue) {
    cls = 'match';
    canApply = true;
  } else {
    cls = 'updated';
    canApply = true;
  }

  const wrap = document.createElement('span');
  wrap.className = 'character-sheet-suggestion-wrap';

  const icon = document.createElement('button');
  icon.type = 'button';
  icon.className = 'character-sheet-suggestion-icon ' + cls;
  icon.textContent = 'i';
  wrap.appendChild(icon);

  let popup = null;
  function onDocClick(ev) {
    if (popup && !wrap.contains(ev.target)) closePopup();
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
    valueLine.textContent = canApply ? ('Suggested: ' + liveValue) : 'Not yet available';
    popup.appendChild(valueLine);
    const detailText = canApply ? suggestion.source : suggestion.reason;
    if (detailText) {
      const sourceLine = document.createElement('div');
      sourceLine.className = 'character-sheet-suggestion-popup-source';
      sourceLine.textContent = detailText;
      popup.appendChild(sourceLine);
    }
    wrap.appendChild(popup);
    closeOpenSuggestionPopup = closePopup;
    setTimeout(function () { document.addEventListener('click', onDocClick); }, 0);
  }

  icon.addEventListener('mouseenter', openPopup);
  icon.addEventListener('click', function (e) {
    e.stopPropagation();
    if (popup) {
      if (canApply) onApply();
      closePopup();
    } else {
      openPopup();
    }
  });

  return wrap;
}

// Trait value editing. No tier-up "mark" tracking here (removed, per
// Gregg: which two traits to bump at tier-up is a call players make
// for themselves at the table -- this app isn't enforcing/tracking
// that rule). cards.sheet.traits[key].marked is still in the stored
// schema (harmless, unread) rather than migrated out, so no existing
// data is lost by this change.
function buildTraitCard(entity, sheet, key, editable) {
  const trait = sheet.traits[key];
  const card = document.createElement('div');
  card.className = 'character-sheet-trait-card';

  const label = document.createElement('div');
  label.className = 'character-sheet-trait-label';
  label.textContent = TRAIT_LABELS[key];
  card.appendChild(label);

  const valueInput = document.createElement('input');
  valueInput.type = 'number';
  valueInput.className = 'character-sheet-trait-value';
  valueInput.value = trait.value;
  valueInput.disabled = !editable;
  valueInput.addEventListener('change', function () {
    const v = parseInt(valueInput.value, 10) || 0;
    const newTraits = Object.assign({}, sheet.traits);
    newTraits[key] = Object.assign({}, trait, { value: v });
    patchSheet(entity, { traits: newTraits });
  });
  card.appendChild(valueInput);

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
    const control = buildSuggestionControl(value, opts.suggestion, function () {
      onChange(opts.suggestion.value, opts.suggestKey, opts.suggestion.value);
    });
    if (control) labelRow.appendChild(control);
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

// HP/Stress/Hope tracks: three-state boxes, per Gregg's exact
// interaction spec:
//   - solid border, unfilled  = Unlocked (available, unmarked)
//   - solid border, filled    = Checked (available, marked)
//   - dotted border, unfilled = Locked (not-yet-unlocked)
// Per-box interaction, single click/tap vs double click/tap:
//   Unlocked -> Checked : single
//   Checked -> Unlocked : single
//   Locked -> Unlocked  : double
//   Unlocked -> Locked  : double
// No separate "Active count" control of any kind (removed entirely,
// per Gregg -- the boxes ARE the control). Hope never has a Locked
// state at all (double-click is a no-op there) -- its Active count is
// always its own ceiling.
//
// Storage stays the existing {max, marked} shape (max = Active/unlocked
// count, marked = Checked count) -- contiguous-from-the-left, same as
// a physical HP track. Locked<->Unlocked double-click moves the
// max boundary; Unlocked<->Checked single-click moves the marked
// boundary (fill/empty through the clicked box, same fill-to-click
// idiom as before, just now reachable per-box via single-click and with
// the Locked state also directly click-editable instead of a number box).
//
// Double-click/double-tap is detected manually (click-then-wait, not
// the native `dblclick` event) since dblclick doesn't reliably fire
// from two quick taps on iOS Safari -- this app is iOS-first.
const HP_CEILING = 12;
const STRESS_CEILING = 12;
const HOPE_CEILING = 6;
const DOUBLE_CLICK_WINDOW_MS = 300;
function buildTrackBoxes(entity, sheet, key, labelText, editable, ceiling, allowLocked, suggestKey, suggestion) {
  const track = sheet[key];
  // Bug fix: when allowLocked is false (Hope), Active must be the fixed
  // ceiling, not read from stored track.max at all -- reading it caused
  // a real bug. Any character whose cards.sheet.hope was already saved
  // with max:0 (true of every character created before Hope's starting
  // default became 6/2 this session) got active=0 here, which then
  // clamped `marked` to 0 on every render regardless of what was just
  // written -- clicking looked like it did nothing, forever, since
  // Hope has no control that can raise max back up (no number input,
  // double-click is intentionally a no-op for it). Hope conceptually
  // never has an Active concept distinct from its ceiling -- "hope
  // never has a not-yet-unlocked box" -- so just hardcode it.
  const active = allowLocked ? Math.max(0, Math.min(ceiling, track.max || 0)) : ceiling;
  const marked = Math.max(0, Math.min(active, track.marked || 0));

  const wrap = document.createElement('div');
  wrap.className = 'character-sheet-track-field';

  const labelRow = document.createElement('div');
  labelRow.className = 'character-sheet-field-label-row';
  const label = document.createElement('div');
  label.className = 'character-sheet-field-label';
  label.textContent = labelText;
  labelRow.appendChild(label);
  if (suggestKey && suggestion) {
    const control = buildSuggestionControl(active, suggestion, function () {
      const v = Math.max(0, Math.min(ceiling, suggestion.value));
      patchSuggestibleField(entity, sheet, { [key]: Object.assign({}, track, { max: v, marked: Math.min(marked, v) }) }, suggestKey, suggestion.value);
    });
    if (control) labelRow.appendChild(control);
  }
  wrap.appendChild(labelRow);

  const boxesRow = document.createElement('div');
  boxesRow.className = 'character-sheet-track-boxes';
  for (let i = 0; i < ceiling; i++) {
    const locked = allowLocked && i >= active;
    const checked = i < marked;
    const box = document.createElement('button');
    box.type = 'button';
    box.className = 'character-sheet-track-box' + (checked ? ' marked' : '') + (locked ? ' locked' : '');
    box.disabled = !editable;
    box.title = locked ? 'Locked -- double-click/tap to unlock' : (checked ? 'Checked -- click to uncheck' : 'Click to check, double-click to lock');

    let pendingSingle = null;
    box.addEventListener('click', function () {
      if (pendingSingle) {
        clearTimeout(pendingSingle);
        pendingSingle = null;
        // Double click/tap: Locked<->Unlocked boundary. No-op on a
        // Checked box (that transition isn't specified) and no-op
        // entirely when this track has no Locked state (Hope).
        if (!allowLocked) return;
        if (locked) {
          const newActive = Math.min(ceiling, i + 1);
          patchSheet(entity, { [key]: Object.assign({}, track, { max: newActive }) });
        } else if (!checked) {
          const newActive = i;
          patchSheet(entity, { [key]: Object.assign({}, track, { max: newActive, marked: Math.min(marked, newActive) }) });
        }
        return;
      }
      pendingSingle = setTimeout(function () {
        pendingSingle = null;
        // Single click/tap: Unlocked<->Checked boundary. No-op on a
        // Locked box.
        if (locked) return;
        const newMarked = checked ? i : i + 1;
        patchSheet(entity, { [key]: Object.assign({}, track, { marked: newMarked }) });
      }, DOUBLE_CLICK_WINDOW_MS);
    });

    boxesRow.appendChild(box);
  }
  wrap.appendChild(boxesRow);

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

// Suggested damage rolls (appended below Proficiency): [current
// proficiency][weapon's damage string], e.g. proficiency 2 + weapon
// damage "d8+3 phy" -> "2d8+3 phy". Primary and Secondary are computed
// and shown independently now -- Primary always shows (em dash if
// nothing's equipped there), Secondary only shows a line at all when
// something is actually equipped in that slot. Purely a live display --
// not its own stored field, no suggestion icon of its own (Proficiency's
// icon already covers the number this is built from).
function weaponDamageRoll(topCards, slot, proficiencyValue) {
  const equipment = topCards.equipment || [];
  const item = equipment.find(function (it) { return it.slot === slot; });
  if (!item || !item.entityId) return null;
  const weapon = state.allEntities.find(function (e) { return e.id === item.entityId; });
  const damage = weapon && weapon.details && weapon.details.damage;
  if (!damage) return null;
  return { text: String(proficiencyValue) + damage, weaponName: weapon.name };
}

function buildResourcesBlock(entity, sheet, editable, suggestions, topCards) {
  const wrap = document.createElement('div');
  wrap.className = 'character-sheet-resources';

  // Row 2: HP, Stress, Hope
  const trackRow = document.createElement('div');
  trackRow.className = 'character-sheet-resources-row';
  trackRow.appendChild(buildTrackBoxes(entity, sheet, 'hp', 'HP', editable, HP_CEILING, true, 'hpMax', suggestions.hpMax));
  trackRow.appendChild(buildTrackBoxes(entity, sheet, 'stress', 'Stress', editable, STRESS_CEILING, true));
  trackRow.appendChild(buildTrackBoxes(entity, sheet, 'hope', 'Hope', editable, HOPE_CEILING, false));
  wrap.appendChild(trackRow);

  // Row 3: Evasion, Armor Score, Major Threshold, Severe Threshold
  const statsRow = document.createElement('div');
  statsRow.className = 'character-sheet-resources-row';
  statsRow.appendChild(buildNumberField('Evasion', sheet.evasion, editable, function (v, suggestKey, suggestValue) {
    patchSuggestibleField(entity, sheet, { evasion: v }, suggestKey, suggestValue);
  }, { suggestKey: 'evasion', suggestion: suggestions.evasion }));
  statsRow.appendChild(buildNumberField('Armor Score', sheet.armorScore, editable, function (v, suggestKey, suggestValue) {
    patchSuggestibleField(entity, sheet, { armorScore: v }, suggestKey, suggestValue);
  }, { suggestKey: 'armorScore', suggestion: suggestions.armorScore }));
  statsRow.appendChild(buildNumberField('Major Threshold', sheet.thresholds.major, editable, function (v, suggestKey, suggestValue) {
    patchSuggestibleField(entity, sheet, { thresholds: Object.assign({}, sheet.thresholds, { major: v }) }, suggestKey, suggestValue);
  }, { suggestKey: 'thresholdMajor', suggestion: suggestions.thresholdMajor }));
  statsRow.appendChild(buildNumberField('Severe Threshold', sheet.thresholds.severe, editable, function (v, suggestKey, suggestValue) {
    patchSuggestibleField(entity, sheet, { thresholds: Object.assign({}, sheet.thresholds, { severe: v }) }, suggestKey, suggestValue);
  }, { suggestKey: 'thresholdSevere', suggestion: suggestions.thresholdSevere }));
  wrap.appendChild(statsRow);

  // Row 4: Equipped, Proficiency, Gold
  const proficiencyField = buildNumberField('Proficiency', sheet.proficiency, editable, function (v, suggestKey, suggestValue) {
    patchSuggestibleField(entity, sheet, { proficiency: v }, suggestKey, suggestValue);
  }, { suggestKey: 'proficiency', suggestion: suggestions.proficiency });
  const primaryRoll = weaponDamageRoll(topCards, 'primary', sheet.proficiency);
  const primaryCaption = document.createElement('p');
  primaryCaption.className = 'admin-hint character-sheet-damage-roll';
  primaryCaption.textContent = 'Primary: ' + (primaryRoll ? primaryRoll.text : '\u2014');
  if (primaryRoll) primaryCaption.title = 'From ' + primaryRoll.weaponName;
  proficiencyField.appendChild(primaryCaption);
  const secondaryRoll = weaponDamageRoll(topCards, 'secondary', sheet.proficiency);
  if (secondaryRoll) {
    const secondaryCaption = document.createElement('p');
    secondaryCaption.className = 'admin-hint character-sheet-damage-roll';
    secondaryCaption.textContent = 'Secondary: ' + secondaryRoll.text;
    secondaryCaption.title = 'From ' + secondaryRoll.weaponName;
    proficiencyField.appendChild(secondaryCaption);
  }

  const bottomRow = document.createElement('div');
  bottomRow.className = 'character-sheet-resources-main';
  bottomRow.appendChild(buildEquipmentSlotsPanel(entity, topCards, editable));
  bottomRow.appendChild(proficiencyField);
  bottomRow.appendChild(buildGoldBlock(entity, sheet, editable));
  wrap.appendChild(bottomRow);

  return wrap;
}

// Gold: one panel, three rows of checked/unchecked boxes (Gregg's ask)
// -- 9 Handfuls, 9 Bags, 1 Chest, matching the SRD's auto-carry rule
// ("mark your tenth handful, instead mark a bag and erase all your
// handfuls" / same for bags -> chest). No locked state here (unlike
// HP/Stress/Hope) -- all boxes in a row are always available, so this
// reuses .character-sheet-track-box's plain/marked styling only, never
// .locked. Same fill-to-click marking as the resource boxes: single
// click sets the count to that box's position, clicking the last
// checked box again clears it. Icons pending Gregg's pick from the
// mockup -- rows are plain checkboxes for now.
const GOLD_ROWS = [
  { key: 'handfuls', label: 'Handfuls', count: 9 },
  { key: 'bags', label: 'Bags', count: 9 },
  { key: 'chest', label: 'Chest', count: 1 }
];
function buildGoldRow(entity, sheet, def, editable) {
  const current = Math.max(0, Math.min(def.count, sheet.gold[def.key] || 0));
  const row = document.createElement('div');
  row.className = 'character-sheet-gold-row-line';

  const label = document.createElement('span');
  label.className = 'character-sheet-gold-row-label';
  label.textContent = def.label;
  row.appendChild(label);

  const boxesRow = document.createElement('div');
  boxesRow.className = 'character-sheet-track-boxes character-sheet-gold-boxes';
  for (let i = 0; i < def.count; i++) {
    const checked = i < current;
    const box = document.createElement('button');
    box.type = 'button';
    box.className = 'character-sheet-track-box' + (checked ? ' marked' : '');
    box.disabled = !editable;
    box.title = checked ? 'Checked -- click to uncheck' : 'Click to check';
    box.addEventListener('click', function () {
      const newValue = current === i + 1 ? i : i + 1;
      patchSheet(entity, { gold: Object.assign({}, sheet.gold, { [def.key]: newValue }) });
    });
    boxesRow.appendChild(box);
  }
  row.appendChild(boxesRow);

  return row;
}
function buildGoldBlock(entity, sheet, editable) {
  const wrap = document.createElement('div');
  wrap.className = 'character-sheet-gold-panel';
  const title = document.createElement('div');
  title.className = 'character-sheet-field-label';
  title.textContent = 'Gold';
  wrap.appendChild(title);
  GOLD_ROWS.forEach(function (def) {
    wrap.appendChild(buildGoldRow(entity, sheet, def, editable));
  });
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

  // Standing disclaimer (Gregg's ask): nothing on this tab recomputes
  // itself -- values are only what the player/GM last set, the (i)
  // suggestions are a starting point, not a rules engine. Markdown for
  // the Download link; small/muted like the rest of this tab's hint
  // text, not styled as a warning.
  const footnote = document.createElement('div');
  footnote.className = 'admin-hint character-sheet-footnote';
  renderMarkdownInto(footnote, 'Note: this sheet does not update automatically, you need to changes values yourself. See (i) popups for suggested values, that may not take everything into account for your character. [Download](https://www.daggerheart.com/downloads/) character sheets here.');
  wrap.appendChild(footnote);

  return wrap;
}
