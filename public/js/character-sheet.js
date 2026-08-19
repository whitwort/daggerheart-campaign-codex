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
// mini-cards and wasn't legible in practice). One row per slot
// (not per item) -- clearer framing: "what's in my Primary slot" reads
// better than hunting each inventory card for a dropdown. Candidates
// are the character's own cards.equipment items whose linked entity's
// subtype matches the slot (Weapons for primary/secondary, Armor for
// armor); unlinked/custom items have no subtype to key off and can't
// be assigned a slot, same limitation as before. Primary/Secondary are
// further filtered by the weapon's own details.primary_or_secondary
// schema field (SRD: every weapon is categorized as one or the other,
// never both) -- a Primary weapon can't be offered for the Secondary
// slot and vice versa. A weapon missing that field entirely (data gap,
// not an SRD weapon) stays unfiltered for both, same "absent =
// unfiltered" convention as the Add Ability/Add Item level-gate.
const SLOT_DEFS = [
  { slot: 'primary', label: 'Primary', subtype: 'weapons', category: 'primary' },
  { slot: 'secondary', label: 'Secondary', subtype: 'weapons', category: 'secondary' },
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
      if (!linked || linked.subtype !== def.subtype) return false;
      if (!def.category) return true;
      const tag = linked.details && linked.details.primary_or_secondary;
      return !tag || tag.trim().toLowerCase() === def.category;
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
  }, { suggestKey: 'proficiency', suggestion: suggestions.proficiency, extraClass: 'character-sheet-proficiency-field' });
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
// checked box again clears it.
//
// Row icons (Gregg's pick from game-icons.net, chosen over Lucide --
// Lucide has no coin-sack/treasure-chest equivalent): Receive Money
// (Delapouite) for Handfuls, Swap Bag and Locked Chest (Lorc) for Bags/
// Chest. game-icons.net ships these as filled black-on-black-square
// SVGs (viewBox 512x512, opaque background rect, fill="#fff") -- a
// different convention from this app's Lucide stroke icons
// (fill="none" stroke="currentColor"). Adapted here rather than pasted
// verbatim: background rect dropped for transparency, fill swapped to
// "currentColor" so they pick up color the same way the app's other
// icons do. CC BY 3.0, NOT the no-attribution ISC license Lucide uses
// -- the required credit line lives in index.html's footer, next to
// the build-version stamp (#icon-credits), not just here in comments.
const GOLD_ICONS = {
  handfuls: '<svg viewBox="0 0 512 512" fill="currentColor"><path d="M258 21.89c-.5 0-1.2 0-1.8.12-4.6.85-10.1 5.1-13.7 14.81-3.8 9.7-4.6 23.53-1.3 38.34 3.4 14.63 10.4 27.24 18.2 34.94 7.6 7.7 14.5 9.8 19.1 9 4.8-.7 10.1-5.1 13.7-14.7 3.8-9.64 4.8-23.66 1.4-38.35-3.5-14.8-10.4-27.29-18.2-34.94-6.6-6.8-12.7-9.22-17.4-9.22zM373.4 151.4c-11 .3-24.9 3.2-38.4 8.9-15.6 6.8-27.6 15.9-34.2 24.5-6.6 8.3-7.2 14.6-5.1 18.3 2.2 3.7 8.3 7.2 20 7.7 11.7.7 27.5-2.2 43-8.8 15.5-6.7 27.7-15.9 34.3-24.3 6.6-8.3 7.1-14.8 5-18.5-2.1-3.8-8.3-7.1-20-7.5-1.6-.3-3-.3-4.6-.3zm-136.3 92.9c-6.6.1-12.6.9-18 2.3-11.8 3-18.6 8.4-20.8 14.9-2.5 6.5 0 14.3 7.8 22.7 8.2 8.2 21.7 16.1 38.5 20.5 16.7 4.4 32.8 4.3 44.8 1.1 12.1-3.1 18.9-8.6 21.1-15 2.3-6.5 0-14.2-8.1-22.7-7.9-8.2-21.4-16.1-38.2-20.4-9.5-2.5-18.8-3.5-27.1-3.4zm160.7 58.1L336 331.7c4.2.2 14.7.5 14.7.5l6.6 8.7 54.7-28.5-14.2-10zm-54.5.1l-57.4 27.2c5.5.3 18.5.5 23.7.8l49.8-23.6-16.1-4.4zm92.6 10.8l-70.5 37.4 14.5 18.7 74.5-44.6-18.5-11.5zm-278.8 9.1a40.33 40.33 0 0 0-9 1c-71.5 16.5-113.7 17.9-126.2 17.9H18v107.5s11.6-1.7 30.9-1.8c37.3 0 103 6.4 167 43.8 3.4 2.1 10.7 2.9 19.8 2.9 24.3 0 61.2-5.8 69.7-9C391 452.6 494 364.5 494 364.5l-32.5-28.4s-79.8 50.9-89.9 55.8c-91.1 44.7-164.9 16.8-164.9 16.8s119.9 3 158.4-27.3l-22.6-34s-82.8-2.3-112.3-6.2c-15.4-2-48.7-18.8-73.1-18.8z"/></svg>',
  bags: '<svg viewBox="0 0 512 512" fill="currentColor"><path d="M363.783 23.545c-9.782.057-16.583 3.047-20.744 10.22-17.51 30.18-38.432 61.645-48.552 97.245 2.836.83 5.635 1.787 8.373 2.853 7.353 2.863 14.38 6.482 20.542 10.858 27.534-25.542 58.165-45.21 87.45-65.462 11.356-7.854 12.273-13.584 10.183-20.83-2.09-7.246-9.868-16.365-20.525-23.176-10.658-6.81-23.87-11.33-34.73-11.68-.68-.022-1.345-.03-1.997-.027zm-68.998.746c-10.02-.182-17.792 6.393-23.924 20.24-8.94 20.194-10.212 53.436-1.446 83.185.156-.008.31-.023.467-.03 1.99-.087 3.99-.072 6 .03 9.436-34.822 27.966-64.72 44.013-91.528-10.31-8.496-18.874-11.782-25.108-11.896zM197.5 82.5L187 97.97c14.82 10.04 29.056 19.725 39.813 31.374 3.916 4.24 7.37 8.722 10.31 13.607 3.77-4.73 8.51-8.378 13.69-10.792.407-.188.82-.355 1.228-.53-3.423-5.44-7.304-10.418-11.51-14.972C227.765 102.83 212.29 92.52 197.5 82.5zm223.77 12.27c-29.255 20.228-58.575 39.152-84.348 62.78.438.576.848 1.168 1.258 1.76 20.68-6.75 49.486-15.333 73.916-19.41 11.484-1.916 15.66-6.552 17.574-13.228 1.914-6.676.447-16.71-5.316-26.983-.924-1.647-1.96-3.29-3.083-4.92zm-223.938 47.87c-14.95.2-29.732 4.3-43.957 12.766l9.563 16.03c21.657-12.89 42.626-14.133 65.232-4.563.52-5.592 1.765-10.66 3.728-15.21.35-.806.73-1.586 1.123-2.354-11.87-4.52-23.83-6.827-35.688-6.67zm75.8 3.934c-5.578-.083-10.597.742-14.427 2.526-4.377 2.038-7.466 4.914-9.648 9.97-.884 2.047-1.572 4.54-1.985 7.494.456-.007.91-.03 1.365-.033 16.053-.084 32.587 2.77 49.313 9.19 7.714 2.96 15.062 7.453 22.047 13.184 3.217-2.445 4.99-4.72 5.773-6.535 1.21-2.798 1.095-5.184-.634-8.82-3.46-7.275-15.207-16.955-28.856-22.27-6.824-2.658-13.98-4.224-20.523-4.614-.818-.05-1.627-.08-2.424-.092zm-24.757 38.457c-22.982.075-44.722 7.386-65 19.782-32.445 19.835-60.565 53.124-80.344 90.032-19.777 36.908-31.133 77.41-31.186 110.53-.053 33.06 10.26 57.27 32.812 67.782.043.02.082.043.125.063h.032c24.872 11.51 65.616 19.337 108.407 20.092 42.79.756 87.79-5.457 121.874-20.187 21.96-9.49 34.545-28.452 40.5-54.156 5.954-25.705 4.518-57.657-2.375-89.314-6.894-31.657-19.2-63.06-34.095-87.875-14.894-24.814-32.614-42.664-48.063-48.593-14.664-5.627-28.898-8.2-42.687-8.156z"/></svg>',
  chest: '<svg viewBox="0 0 512 512" fill="currentColor"><path d="M146.857 20.842c-12.535-.036-24.268 2.86-37.285 9.424h.004C61.356 54.6 19.966 120.734 17.982 175.91l41.848 14.236c4.33-61.89 47.057-128.37 101.527-155.86h.002c4.423-2.23 8.822-4.162 13.185-5.8l-22.26-7.45c-1.83-.123-3.637-.19-5.428-.194zm59.34 20.19c-10.478-.09-22.832 3.093-36.424 9.943l.004-.004c-48.23 24.34-89.625 90.513-91.548 145.436l156.485 53.24c3.865-62.22 46.797-129.372 101.613-157.035h.002l.002-.003c4.303-2.168 8.584-4.056 12.832-5.666l-134.54-45.036c-2.652-.542-5.458-.847-8.427-.873zm174.97 58.323c-10.476-.09-22.83 3.092-36.42 9.94l-.005.002c-48.577 24.518-90.225 91.473-91.586 146.623l46.205 15.72c3.914-62.188 46.825-129.274 101.607-156.92 4.522-2.283 9.04-4.258 13.53-5.91l-26.544-8.884c-2.164-.35-4.423-.55-6.785-.57zm63.554 22.014c-10.267.093-22.094 3.353-35.333 10.034-47.158 23.8-87.777 87.587-91.362 141.75l174.55-73.726c-.404-39.01-10.754-61.304-24.415-71.082-2.347-1.68-4.867-3.057-7.55-4.137l-.01.034-4.735-1.584c-3.48-.887-7.195-1.327-11.144-1.29zM17.9 195.622l-.035 187.484L59.46 397.58V209.764L17.9 195.624zM78.15 216.12v187.962l156.282 54.37V269.288l-29.053-9.886v119.43l-101.054-34.082V225.025L78.15 216.12zm414.22 3.683L318.433 293.27v189.236l173.935-73.504v-189.2zm-369.354 11.582v99.947l63.675 21.477v-99.763l-63.674-21.662zm31.306 28.797c9.705 0 17.573 7.867 17.573 17.572 0 6.34-3.37 11.88-8.407 14.97v28.53h-18.69v-28.746c-4.838-3.13-8.048-8.562-8.048-14.754 0-9.705 7.867-17.572 17.572-17.572zm98.797 15.464v189.307l46.626 16.22V291.51l-46.627-15.864z"/></svg>'
};
const GOLD_ROWS = [
  { key: 'handfuls', label: 'Handfuls', count: 9, icon: GOLD_ICONS.handfuls },
  { key: 'bags', label: 'Bags', count: 9, icon: GOLD_ICONS.bags },
  { key: 'chest', label: 'Chest', count: 1, icon: GOLD_ICONS.chest }
];
function buildGoldRow(entity, sheet, def, editable) {
  const current = Math.max(0, Math.min(def.count, sheet.gold[def.key] || 0));
  const row = document.createElement('div');
  row.className = 'character-sheet-gold-row-line';

  const label = document.createElement('span');
  label.className = 'character-sheet-gold-row-label';
  label.textContent = def.label;
  row.appendChild(label);

  // The icon itself IS the clickable checkbox (Gregg's follow-up: the
  // first pass still nested the icon inside a square box borrowed from
  // .character-sheet-track-box, whose fixed flex-basis/height didn't
  // match the icons' own proportions and pushed the row wider than its
  // container). .character-sheet-gold-icon-box is fully standalone now
  // -- no shared sizing with the plain HP/Stress/Hope boxes -- height-
  // driven with width:auto so each icon renders at its own natural
  // aspect ratio instead of being force-stretched into a fixed square.
  // Unfilled/filled are still the same icon at two colors/opacities.
  const boxesRow = document.createElement('div');
  boxesRow.className = 'character-sheet-track-boxes character-sheet-gold-boxes';
  for (let i = 0; i < def.count; i++) {
    const checked = i < current;
    const box = document.createElement('button');
    box.type = 'button';
    box.className = 'character-sheet-gold-icon-box' + (checked ? ' marked' : '');
    box.innerHTML = def.icon;
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
  renderMarkdownInto(footnote, 'Note: this sheet does not update automatically, you need to change values yourself. See (i) popups for a suggested value which may not account for all modifiers. [Download](https://www.daggerheart.com/downloads/) character sheet PDFs.');
  wrap.appendChild(footnote);

  return wrap;
}
