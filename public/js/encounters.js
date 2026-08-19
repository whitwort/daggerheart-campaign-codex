// Encounters tab (Phase 15, phase-15-encounter-workflow-design.md).
// GM-only builder/tracker over the `encounters` collection: one live view
// per encounter (build-time and play-time are the same surface — E1/§1),
// battle-point difficulty calculator ported from
// daggerheart-encounter-builder (§4), per-instance HP/Stress tracking.

import {
  getFirestore, doc, collection, addDoc, deleteDoc, updateDoc,
  onSnapshot, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import { firebaseApp } from './firebase.js';
import { state } from './state.js';
import { attachListener, detachListener, safeSnapshotHandler } from './listeners.js';
import { trackWrite } from './connectivity.js';
import { switchToCodexTabForEntity, entityMatchesQuery, resolveEntityStatBlockMarkdown } from './codex.js';
import { viewerContext } from './visibility.js';
import { renderMarkdownInto } from './markdown.js';

const db = getFirestore(firebaseApp);

const listEl = document.getElementById('encounters-list');
const detailEl = document.getElementById('encounters-detail-pane');
const newBtn = document.getElementById('encounters-new-btn');

// --- Listener lifecycle (GM-only; attach called from auth.js only in ---
// --- the GM branch, per listeners.js invariant 1) ----------------------

function attachEncountersListener() {
  attachListener('encountersUnsub', function () {
    return onSnapshot(collection(db, 'encounters'), safeSnapshotHandler('encounters', function (snapshot) {
      state.allEncounters = [];
      snapshot.forEach(function (docSnap) {
        state.allEncounters.push(Object.assign({ id: docSnap.id }, docSnap.data()));
      });
      renderEncountersTab();
    }), function (err) {
      console.error('encounters listener failed:', err.message);
    });
  });
}

function detachEncountersListener() {
  detachListener('encountersUnsub');
  state.allEncounters = [];
  state.encountersSelectedId = null;
}

// --- CRUD --------------------------------------------------------------

function createEncounter() {
  const data = {
    name: 'New encounter',
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
    partySize: 4,
    partyTier: 2,
    highDamage: false,
    environmentId: null,
    instances: []
  };
  trackWrite(addDoc(collection(db, 'encounters'), data), 'Creating encounter')
    .then(function (ref) { state.encountersSelectedId = ref.id; renderEncountersTab(); });
}

// Every mutation goes through here: partial field update + updatedAt
// bump (OI4 list ordering rides on updatedAt).
function updateEncounter(encId, fields) {
  const data = Object.assign({ updatedAt: serverTimestamp() }, fields);
  return trackWrite(updateDoc(doc(db, 'encounters', encId), data), 'Saving encounter');
}

function deleteEncounter(encId) {
  if (!window.confirm('Delete this encounter? This cannot be undone.')) return;
  if (state.encountersSelectedId === encId) state.encountersSelectedId = null;
  trackWrite(deleteDoc(doc(db, 'encounters', encId)), 'Deleting encounter');
}


// --- Battle-point calculator (design §4; ported from ------------------
// --- daggerheart-encounter-builder getDifficultyLevel/updateBattlePoints)

const BATTLE_VALUES = {
  Minion: 0, Standard: 2, Horde: 2, Skulk: 2, Ranged: 2,
  Support: 1, Social: 1, Leader: 3, Bruiser: 4, Solo: 5
};
const UNKNOWN_TYPE_VALUE = 2;
const BASE_MULTIPLIER = 3;
const BASE_ADDITION = 2;
const MULTIPLE_SOLOS_ADJUSTMENT = -2;
const MIN_SOLOS_FOR_ADJUSTMENT = 2;
const LOWER_TIER_BONUS = 1;
const NO_ELITES_BONUS = 1;
const HIGH_DAMAGE_PENALTY = -2;
const ELITE_TYPES = ['Bruiser', 'Horde', 'Leader', 'Solo'];

// Source data carries compound type strings ("Horde (2/HP)"); the Apps
// Script never saw them because its mapper pre-truncated. Match on the
// first word so Hordes don't silently score the unknown-type fallback
// (design §4).
function normalizeAdvType(typeStr) {
  return (typeStr || '').trim().split(/[\s(]/)[0];
}

function entityById(id) {
  return state.allEntities.find(function (e) { return e.id === id; }) || null;
}

// Groups instances by entityId preserving first-seen order; each group
// carries the live entity (or null if deleted — E4 fallback path).
function groupInstances(enc) {
  const groups = [];
  const byEntity = {};
  (enc.instances || []).forEach(function (inst) {
    let g = byEntity[inst.entityId];
    if (!g) {
      g = { entityId: inst.entityId, entity: entityById(inst.entityId), instances: [] };
      byEntity[inst.entityId] = g;
      groups.push(g);
    }
    g.instances.push(inst);
  });
  return groups;
}

// Pure: (encounter doc x entities cache) -> full calculation result.
// No memoization (the source's stateKey cache served its VDOM only).
function computeBattlePoints(enc) {
  const partySize = parseInt(enc.partySize, 10) || 4;
  const partyTier = parseInt(enc.partyTier, 10) || 2;
  const groups = groupInstances(enc);

  let totalPoints = 0;
  const breakdown = [];
  let soloCount = 0;
  let hasElites = false;
  let hasLowerTier = false;
  let anyInstances = false;

  groups.forEach(function (g) {
    const count = g.instances.length;
    if (!count) return;
    anyInstances = true;
    const name = g.entity ? g.entity.name : (g.instances[0].fallbackName || '(missing entry)');
    const details = (g.entity && g.entity.details) || {};
    const type = normalizeAdvType(details.type);
    let points;
    if (type === 'Minion') {
      const minionGroups = Math.ceil(count / partySize);
      points = minionGroups;
      breakdown.push(count + '\u00d7 ' + name + ' (' + minionGroups + ' group' + (minionGroups > 1 ? 's' : '') + ' = ' + points + ' pts)');
    } else {
      const value = Object.prototype.hasOwnProperty.call(BATTLE_VALUES, type) ? BATTLE_VALUES[type] : UNKNOWN_TYPE_VALUE;
      points = value * count;
      breakdown.push(count + '\u00d7 ' + name + ' (' + points + ' pts)');
    }
    totalPoints += points;
    if (type === 'Solo') soloCount += count;
    if (ELITE_TYPES.indexOf(type) !== -1) hasElites = true;
    const tier = parseInt(details.tier, 10);
    if (!isNaN(tier) && tier < partyTier) hasLowerTier = true;
  });

  const originalBase = (BASE_MULTIPLIER * partySize) + BASE_ADDITION;
  let adjustedBase = originalBase;
  const adjustments = [];
  if (soloCount >= MIN_SOLOS_FOR_ADJUSTMENT) {
    adjustedBase += MULTIPLE_SOLOS_ADJUSTMENT;
    adjustments.push(MULTIPLE_SOLOS_ADJUSTMENT + ' (multiple solos)');
  }
  if (hasLowerTier) {
    adjustedBase += LOWER_TIER_BONUS;
    adjustments.push('+' + LOWER_TIER_BONUS + ' (lower tier adversaries)');
  }
  if (!hasElites && anyInstances) {
    adjustedBase += NO_ELITES_BONUS;
    adjustments.push('+' + NO_ELITES_BONUS + ' (no elite types)');
  }
  if (enc.highDamage) {
    adjustedBase += HIGH_DAMAGE_PENALTY;
    adjustments.push(HIGH_DAMAGE_PENALTY + ' (high damage encounter)');
  }

  const easyThreshold = adjustedBase - 1;
  const normalMax = adjustedBase;
  const hardMax = adjustedBase + 2;
  let label, diffClass;
  if (totalPoints < easyThreshold) { label = 'Easy'; diffClass = 'easy'; }
  else if (totalPoints <= normalMax) { label = 'Normal'; diffClass = 'normal'; }
  else if (totalPoints <= hardMax) { label = 'Hard'; diffClass = 'hard'; }
  else { label = 'Deadly'; diffClass = 'deadly'; }

  return {
    totalPoints: totalPoints, breakdown: breakdown, anyInstances: anyInstances,
    label: label, diffClass: diffClass,
    originalBase: originalBase, adjustedBase: adjustedBase, adjustments: adjustments,
    easyThreshold: easyThreshold, normalMax: normalMax, hardMax: hardMax
  };
}

// --- Rendering ---------------------------------------------------------

function getSelectedEncounter() {
  return state.allEncounters.find(function (e) { return e.id === state.encountersSelectedId; }) || null;
}

function renderEncountersTab() {
  if (state.currentRole !== 'gm') return;
  // Run mode collapses the list pane -- every horizontal rem goes to
  // the tracker (session 38 feedback). Build restores it. Selection and
  // creation are Build activities anyway. Guarded on a selection so an
  // empty Run tab (nothing selected) still shows the list to pick from.
  var listPane = document.getElementById('encounters-list-pane');
  listPane.style.display = (state.encountersDetailTab === 'run' && getSelectedEncounter()) ? 'none' : '';
  renderEncounterList();
  renderEncounterDetail();
}

function renderEncounterList() {
  listEl.innerHTML = '';
  const encounters = state.allEncounters.slice().sort(function (a, b) {
    // updatedAt desc (OI4); serverTimestamp is briefly null on the
    // local echo of a fresh write — treat null as newest.
    const am = a.updatedAt ? a.updatedAt.toMillis() : Infinity;
    const bm = b.updatedAt ? b.updatedAt.toMillis() : Infinity;
    return bm - am;
  });
  if (!encounters.length) {
    const p = document.createElement('p');
    p.className = 'lore-empty';
    p.textContent = 'No encounters yet.';
    listEl.appendChild(p);
    return;
  }
  const ul = document.createElement('ul');
  ul.className = 'entity-group-list';
  encounters.forEach(function (enc) {
    const li = document.createElement('li');
    if (enc.id === state.encountersSelectedId) li.classList.add('active');
    const nameDiv = document.createElement('div');
    nameDiv.className = 'entity-name';
    nameDiv.textContent = enc.name || '(unnamed)';
    li.appendChild(nameDiv);
    li.addEventListener('click', function () {
      state.encountersSelectedId = enc.id;
      renderEncountersTab();
    });
    ul.appendChild(li);
  });
  listEl.appendChild(ul);
}

function renderEncounterDetail() {
  detailEl.innerHTML = '';
  const enc = getSelectedEncounter();
  if (!enc) {
    const p = document.createElement('p');
    p.className = 'lore-empty';
    p.textContent = 'Select an encounter, or create a new one.';
    detailEl.appendChild(p);
    return;
  }
  // A1: Build/Run tab shell (Characters Cards/Sheet pattern).
  const tabsRow = document.createElement('div');
  tabsRow.className = 'character-detail-tabs';
  [['build', 'Build'], ['run', 'Run']].forEach(function (pair) {
    const tabBtn = document.createElement('button');
    tabBtn.type = 'button';
    tabBtn.textContent = pair[1];
    if (state.encountersDetailTab === pair[0]) tabBtn.classList.add('active');
    tabBtn.addEventListener('click', function () {
      state.encountersDetailTab = pair[0];
      renderEncountersTab();
    });
    tabsRow.appendChild(tabBtn);
  });
  detailEl.appendChild(tabsRow);

  if (state.encountersDetailTab === 'run') {
    detailEl.appendChild(buildRunView(enc));
  } else {
    detailEl.appendChild(buildHeaderRow(enc));
    detailEl.appendChild(buildConfigRow(enc));
    detailEl.appendChild(buildDifficultyPanel(enc));
    detailEl.appendChild(buildAdversariesSection(enc));
  }
}

function buildRunView(enc) {
  const wrap = document.createElement('div');
  wrap.className = 'encounter-run-view';
  // Build-config flag the GM must remember at the table (its -2 target
  // adjustment means these fights swing harder) -- surface it on Run.
  if (enc.highDamage) {
    const banner = document.createElement('div');
    banner.className = 'encounter-run-highdamage';
    // SRD battle-points rule the flag's -2 adjustment corresponds to;
    // the banner reminds the GM what to actually apply at the table.
    banner.textContent = 'High damage encounter: all adversaries add +1d4 (or a static +2) to their damage rolls';
    wrap.appendChild(banner);
  }
  const groups = groupInstances(enc);
  if (!groups.length) {
    const p = document.createElement('p');
    p.className = 'lore-empty';
    p.textContent = 'No adversaries yet \u2014 add some on the Build tab.';
    wrap.appendChild(p);
  }
  groups.forEach(function (g) {
    wrap.appendChild(buildAdversaryGroup(enc, g, 'run'));
  });
  const envBlock = buildEnvironmentBlock(enc);
  if (envBlock) wrap.appendChild(envBlock);
  return wrap;
}

function buildHeaderRow(enc) {
  const row = document.createElement('div');
  row.className = 'encounter-header-row';

  const nameInput = document.createElement('input');
  nameInput.type = 'text';
  nameInput.className = 'encounter-name-input';
  nameInput.value = enc.name || '';
  nameInput.addEventListener('change', function () {
    const v = nameInput.value.trim();
    if (v && v !== enc.name) updateEncounter(enc.id, { name: v });
  });
  row.appendChild(nameInput);

  const delBtn = document.createElement('button');
  delBtn.className = 'action-btn-compact';
  delBtn.textContent = 'Delete';
  delBtn.addEventListener('click', function () { deleteEncounter(enc.id); });
  row.appendChild(delBtn);

  return row;
}


function buildConfigRow(enc) {
  const row = document.createElement('div');
  row.className = 'encounter-config-row';

  function field(labelText, control) {
    const wrap = document.createElement('label');
    wrap.className = 'encounter-config-field';
    const span = document.createElement('span');
    span.className = 'encounter-config-label';
    span.textContent = labelText;
    wrap.appendChild(span);
    wrap.appendChild(control);
    return wrap;
  }

  const playersInput = document.createElement('input');
  playersInput.type = 'number';
  playersInput.min = '1'; playersInput.max = '8';
  playersInput.value = enc.partySize || 4;
  playersInput.className = 'encounter-players-input';
  playersInput.addEventListener('change', function () {
    const v = Math.max(1, Math.min(8, parseInt(playersInput.value, 10) || 4));
    updateEncounter(enc.id, { partySize: v });
  });
  row.appendChild(field('Players', playersInput));

  const tierSelect = document.createElement('select');
  [1, 2, 3, 4].forEach(function (t) {
    const opt = document.createElement('option');
    opt.value = String(t);
    opt.textContent = 'Tier ' + t;
    if ((enc.partyTier || 2) === t) opt.selected = true;
    tierSelect.appendChild(opt);
  });
  tierSelect.addEventListener('change', function () {
    updateEncounter(enc.id, { partyTier: parseInt(tierSelect.value, 10) });
  });
  row.appendChild(field('Tier', tierSelect));

  const switchLabel = document.createElement('label');
  switchLabel.className = 'toggle-switch';
  const switchInput = document.createElement('input');
  switchInput.type = 'checkbox';
  switchInput.checked = !!enc.highDamage;
  const switchSlider = document.createElement('span');
  switchSlider.className = 'toggle-slider';
  switchLabel.appendChild(switchInput);
  switchLabel.appendChild(switchSlider);
  switchInput.addEventListener('change', function () {
    updateEncounter(enc.id, { highDamage: switchInput.checked });
  });
  row.appendChild(field('High damage', switchLabel));

  const envSelect = document.createElement('select');
  const noneOpt = document.createElement('option');
  noneOpt.value = '';
  noneOpt.textContent = 'No environment';
  envSelect.appendChild(noneOpt);
  state.allEntities
    .filter(function (e) { return e.category === 'Environment'; })
    .sort(function (a, b) { return (a.name || '').localeCompare(b.name || ''); })
    .forEach(function (e) {
      const opt = document.createElement('option');
      opt.value = e.id;
      opt.textContent = e.name;
      if (enc.environmentId === e.id) opt.selected = true;
      envSelect.appendChild(opt);
    });
  envSelect.addEventListener('change', function () {
    updateEncounter(enc.id, { environmentId: envSelect.value || null });
  });
  row.appendChild(field('Environment', envSelect));

  return row;
}

function buildDifficultyPanel(enc) {
  const calc = computeBattlePoints(enc);
  const panel = document.createElement('div');
  panel.className = 'encounter-difficulty-panel';

  const topRow = document.createElement('div');
  topRow.className = 'encounter-difficulty-top';
  const total = document.createElement('span');
  total.className = 'encounter-points-total';
  total.textContent = calc.totalPoints + ' Battle Points';
  topRow.appendChild(total);
  if (calc.anyInstances) {
    const chip = document.createElement('span');
    chip.className = 'encounter-difficulty-chip difficulty-' + calc.diffClass;
    chip.textContent = calc.label;
    topRow.appendChild(chip);
  }
  panel.appendChild(topRow);

  const breakdownDiv = document.createElement('div');
  breakdownDiv.className = 'encounter-points-breakdown';
  if (calc.anyInstances) {
    calc.breakdown.forEach(function (line) {
      const div = document.createElement('div');
      div.textContent = line;
      breakdownDiv.appendChild(div);
    });
  } else {
    breakdownDiv.textContent = 'Add adversaries to see difficulty.';
  }
  panel.appendChild(breakdownDiv);

  // Full calculation math, collapsed by default (OI2). Collapse state is
  // per-render-transient on purpose: it reopens fresh each selection,
  // and a snapshot re-render mid-look re-collapses it — acceptable for
  // an on-demand detail view (matches .collapse-toggle usage elsewhere).
  if (calc.anyInstances) {
    const toggle = document.createElement('button');
    toggle.className = 'collapse-toggle';
    toggle.textContent = 'Show calculation';
    const math = document.createElement('div');
    math.className = 'encounter-difficulty-math';
    math.style.display = 'none';
    const lines = [];
    lines.push('Base: (' + BASE_MULTIPLIER + ' \u00d7 ' + (parseInt(enc.partySize, 10) || 4) + ') + ' + BASE_ADDITION + ' = ' + calc.originalBase);
    if (calc.adjustments.length) {
      lines.push('Adjustments: ' + calc.adjustments.join(', '));
      lines.push('Target: ' + calc.adjustedBase + ' battle points');
    }
    lines.push('Easy: \u2264' + (calc.adjustedBase - 2) + ' | Normal: ' + (calc.adjustedBase - 1) + '\u2013' + calc.normalMax +
      ' | Hard: ' + (calc.adjustedBase + 1) + '\u2013' + calc.hardMax + ' | Deadly: ' + (calc.adjustedBase + 3) + '+');
    lines.forEach(function (l) {
      const div = document.createElement('div');
      div.textContent = l;
      math.appendChild(div);
    });
    toggle.addEventListener('click', function () {
      const open = math.style.display !== 'none';
      math.style.display = open ? 'none' : 'block';
      toggle.textContent = open ? 'Show calculation' : 'Hide calculation';
    });
    panel.appendChild(toggle);
    panel.appendChild(math);
  }

  return panel;
}


// --- Instance mutations (E3/E8/OI3) -----------------------------------

// E8: labels are "Name N" with N = max existing numeric suffix in the
// group + 1 — the next unused index, never a renumber of survivors.
function nextInstanceLabel(enc, entityId, name) {
  let maxN = 0;
  (enc.instances || []).forEach(function (inst) {
    if (inst.entityId !== entityId) return;
    const m = /(\d+)$/.exec(inst.label || '');
    if (m) maxN = Math.max(maxN, parseInt(m[1], 10));
  });
  return name + ' ' + (maxN + 1);
}

function addInstance(enc, entity) {
  const instances = (enc.instances || []).slice();
  instances.push({
    entityId: entity.id,
    fallbackName: entity.name,
    label: nextInstanceLabel(enc, entity.id, entity.name),
    hp: 0, stress: 0, conditions: []
  });
  updateEncounter(enc.id, { instances: instances });
}

// OI3: group "−" removes the highest-labeled undamaged (no hp AND no
// stress marks) instance if any exist, else the highest-labeled one.
function removeGroupInstance(enc, entityId) {
  const instances = (enc.instances || []).slice();
  const group = instances.filter(function (i) { return i.entityId === entityId; });
  if (!group.length) return;
  function suffix(inst) {
    const m = /(\d+)$/.exec(inst.label || '');
    return m ? parseInt(m[1], 10) : 0;
  }
  const undamaged = group.filter(function (i) { return !(i.hp > 0) && !(i.stress > 0); });
  const pool = undamaged.length ? undamaged : group;
  const victim = pool.reduce(function (a, b) { return suffix(b) > suffix(a) ? b : a; });
  updateEncounter(enc.id, { instances: instances.filter(function (i) { return i !== victim; }) });
}

function patchInstance(enc, target, fields) {
  const instances = (enc.instances || []).map(function (i) {
    return i === target ? Object.assign({}, i, fields) : i;
  });
  updateEncounter(enc.id, { instances: instances });
}

// --- Adversaries section (§5.2 item 4) --------------------------------

function buildAdversariesSection(enc) {
  const section = document.createElement('div');
  section.className = 'encounter-adversaries';

  groupInstances(enc).forEach(function (g) {
    section.appendChild(buildAdversaryGroup(enc, g, 'build'));
  });

  const actions = document.createElement('div');
  actions.className = 'actions-row';
  const right = document.createElement('div');
  right.className = 'actions-row-right';
  const addBtn = document.createElement('button');
  addBtn.id = 'encounter-add-adversary-btn';
  addBtn.className = 'action-btn-compact';
  addBtn.textContent = '+ Add adversary';
  addBtn.addEventListener('click', function () { openAdversaryPicker(enc); });
  right.appendChild(addBtn);
  actions.appendChild(right);
  section.appendChild(actions);

  return section;
}

function buildAdversaryGroup(enc, g, mode) {
  const wrap = document.createElement('div');
  wrap.className = 'encounter-adv-group';

  const header = document.createElement('div');
  header.className = 'encounter-adv-group-header';

  const title = document.createElement('span');
  title.className = 'encounter-adv-group-title';
  const countSpan = document.createElement('span');
  countSpan.textContent = g.instances.length + '\u00d7 ';
  title.appendChild(countSpan);
  if (g.entity) {
    const link = document.createElement('a');
    link.href = '#';
    link.className = 'entity-map-link';
    link.textContent = g.entity.name;
    link.addEventListener('click', function (ev) {
      ev.preventDefault();
      switchToCodexTabForEntity(g.entity.id);
    });
    title.appendChild(link);
  } else {
    const nameSpan = document.createElement('span');
    nameSpan.textContent = g.instances[0].fallbackName || '(missing entry)';
    title.appendChild(nameSpan);
    const missing = document.createElement('span');
    missing.className = 'encounter-adv-missing';
    missing.textContent = ' entry missing';
    title.appendChild(missing);
  }
  header.appendChild(title);

  // Build: one-line summary only. Run: the full stat block below
  // carries all of this, so no duplicate line in the header (A1).
  if (g.entity && mode === 'build') {
    const d = g.entity.details || {};
    const statLine = document.createElement('span');
    statLine.className = 'encounter-adv-statline';
    const bits = [];
    if (d.tier) bits.push('Tier ' + d.tier);
    if (d.type) bits.push(d.type);
    if (d.difficulty) bits.push('Difficulty ' + d.difficulty);
    if (d.thresholds) bits.push('Thresholds ' + d.thresholds);
    if (d.attack_name) bits.push(d.attack_name + ' ' + (d.attack_modifier || '') + (d.attack_range ? ' (' + d.attack_range + ')' : '') + (d.attack_damage ? ': ' + d.attack_damage : ''));
    statLine.textContent = bits.join(' \u00b7 ');
    header.appendChild(statLine);
  }

  const controls = document.createElement('div');
  controls.className = 'encounter-adv-group-controls';
  const minus = document.createElement('button');
  minus.className = 'characters-remove-btn';
  minus.textContent = '\u2212';
  minus.title = 'Remove one (undamaged first)';
  minus.addEventListener('click', function () { removeGroupInstance(enc, g.entityId); });
  controls.appendChild(minus);
  const plus = document.createElement('button');
  plus.className = 'characters-add-btn';
  plus.textContent = '+';
  plus.title = 'Add another';
  plus.disabled = !g.entity;  // can't clone a deleted entry's stats
  plus.addEventListener('click', function () {
    if (g.entity) addInstance(enc, g.entity);
  });
  controls.appendChild(plus);
  header.appendChild(controls);
  wrap.appendChild(header);

  if (mode === 'run') {
    if (g.entity) {
      // Density pass (Gregg, session 38): the markdown Details section
      // costs ~10 mostly-empty lines on an iPad. Replace it with a
      // wrap-flow stat strip built here, and strip the Details section
      // (and the Features heading -- bold feature names carry the
      // structure) out of the markdown before rendering the rest
      // (features + leftover meta lore items).
      wrap.appendChild(buildAdvStatStrip(g.entity));
      let md = resolveEntityStatBlockMarkdown(g.entity, viewerContext(), null);
      md = md.replace(/### Details\n(?:- .*\n?)*/, '').replace('### Features\n', '').trim();
      if (md) {
        const statBlock = document.createElement('div');
        statBlock.className = 'encounter-adv-statblock';
        renderMarkdownInto(statBlock, md);
        wrap.appendChild(statBlock);
      }
    }
    const d = (g.entity && g.entity.details) || {};
    const hpMax = parseInt(d.hp, 10);
    const stressMax = parseInt(d.stress, 10);
    g.instances.forEach(function (inst) {
      wrap.appendChild(buildInstanceRow(enc, inst, hpMax, stressMax));
    });
  }

  return wrap;
}

function buildInstanceRow(enc, inst, hpMax, stressMax) {
  // Defeated is derived (E6): all HP marked. Unknown max (deleted or
  // detail-less entry) can never derive defeated.
  const defeated = !isNaN(hpMax) && hpMax > 0 && inst.hp >= hpMax;

  const row = document.createElement('div');
  row.className = 'encounter-instance-row' + (defeated ? ' defeated' : '');

  const label = document.createElement('span');
  label.className = 'encounter-instance-label';
  label.textContent = inst.label;
  row.appendChild(label);

  row.appendChild(buildInstanceTrack(enc, inst, 'HP', 'hp', hpMax));
  row.appendChild(buildInstanceTrack(enc, inst, 'Stress', 'stress', stressMax));

  row.appendChild(buildConditionSelects(enc, inst));

  return row;
}

// A2: 0-3 condition selects per instance -- one per applied condition
// (reselect swaps, the empty option clears) plus one empty "add" select
// while under the cap. Options from the character deck's condition
// source, core-three fallback if the campaign has no condition entries.
const CORE_CONDITIONS = ['Hidden', 'Restrained', 'Vulnerable'];
const MAX_INSTANCE_CONDITIONS = 3;

function conditionOptions() {
  const names = state.allEntities
    .filter(function (e) { return e.category === 'Game Mechanics' && e.subtype === 'conditions'; })
    .map(function (e) { return e.name; })
    .sort(function (a, b) { return a.localeCompare(b); });
  return names.length ? names : CORE_CONDITIONS.slice();
}

function buildConditionSelects(enc, inst) {
  const wrap = document.createElement('div');
  wrap.className = 'encounter-instance-conditions';
  const applied = (inst.conditions || []).slice(0, MAX_INSTANCE_CONDITIONS);
  const options = conditionOptions();

  function writeConditions(next) {
    patchInstance(enc, inst, { conditions: next.filter(Boolean) });
  }

  function makeSelect(currentValue, index) {
    const sel = document.createElement('select');
    sel.className = 'encounter-condition-select';
    const emptyOpt = document.createElement('option');
    emptyOpt.value = '';
    emptyOpt.textContent = currentValue ? '\u2014 clear' : '+ condition';
    sel.appendChild(emptyOpt);
    // A stored name missing from the current option list (renamed/
    // deleted condition entry) still renders selected rather than
    // silently blanking (absent = degraded display, not data loss).
    const optionNames = options.slice();
    if (currentValue && optionNames.indexOf(currentValue) === -1) optionNames.push(currentValue);
    optionNames.forEach(function (name) {
      // No duplicate conditions on one instance: hide names already
      // applied elsewhere on this instance.
      if (name !== currentValue && applied.indexOf(name) !== -1) return;
      const opt = document.createElement('option');
      opt.value = name;
      opt.textContent = name;
      if (name === currentValue) opt.selected = true;
      sel.appendChild(opt);
    });
    sel.addEventListener('change', function () {
      const next = applied.slice();
      if (index < next.length) {
        if (sel.value) { next[index] = sel.value; } else { next.splice(index, 1); }
      } else if (sel.value) {
        next.push(sel.value);
      }
      writeConditions(next);
    });
    return sel;
  }

  applied.forEach(function (name, i) { wrap.appendChild(makeSelect(name, i)); });
  if (applied.length < MAX_INSTANCE_CONDITIONS) wrap.appendChild(makeSelect('', applied.length));
  return wrap;
}

function buildInstanceTrack(enc, inst, labelText, key, max) {
  const wrap = document.createElement('div');
  // Per-key class: HP's column is fixed-width (sized for the DB-max 12
  // boxes) so Stress starts at the same x on every row and group.
  wrap.className = 'encounter-instance-track encounter-instance-track-' + key;
  const label = document.createElement('span');
  label.className = 'encounter-instance-track-label';
  label.textContent = labelText;
  wrap.appendChild(label);

  const boxes = document.createElement('div');
  boxes.className = 'character-sheet-track-boxes encounter-track-boxes';
  if (isNaN(max) || max <= 0) {
    // §3 missing-entity degradation: no known ceiling — render only the
    // marks already made (uncheckable-down still works via those), plus
    // a "?" so the state is visibly unknown rather than an empty track.
    const marked = Math.max(0, inst[key] || 0);
    for (let i = 0; i < marked; i++) boxes.appendChild(makeTrackBox(enc, inst, key, i, true));
    const unknown = document.createElement('span');
    unknown.className = 'encounter-track-unknown';
    unknown.textContent = '?';
    boxes.appendChild(unknown);
  } else {
    // Clamping (§3): render clamps to live max; stored marks rewrite
    // only on next interaction.
    const marked = Math.max(0, Math.min(max, inst[key] || 0));
    for (let i = 0; i < max; i++) boxes.appendChild(makeTrackBox(enc, inst, key, i, i < marked));
  }
  wrap.appendChild(boxes);
  return wrap;
}

// No locked state and no double-tap semantics here (unlike the Sheet
// tab): click a checked box to unmark down to it, an unchecked box to
// mark up through it.
function makeTrackBox(enc, inst, key, i, checked) {
  const box = document.createElement('button');
  box.type = 'button';
  box.className = 'character-sheet-track-box' + (checked ? ' marked' : '');
  box.addEventListener('click', function () {
    patchInstance(enc, inst, { [key]: checked ? i : i + 1 });
  });
  return box;
}



// Compact one-strip details render for the Run view: label-value
// segments in a wrap flow, schema-ordered, attack fields composed into
// one segment. iPad-density replacement for the markdown bullet list.
function buildAdvStatStrip(entity) {
  const d = entity.details || {};
  const stripEl = document.createElement('div');
  stripEl.className = 'encounter-statline-strip';
  function seg(label, value) {
    if (value === undefined || value === null || value === '') return;
    const span = document.createElement('span');
    span.className = 'encounter-statline-seg';
    if (label) {
      const lab = document.createElement('span');
      lab.className = 'encounter-statline-seg-label';
      lab.textContent = label + ' ';
      span.appendChild(lab);
    }
    span.appendChild(document.createTextNode(String(value)));
    stripEl.appendChild(span);
  }
  seg('Tier', d.tier);
  seg(null, d.type);
  seg('Difficulty', d.difficulty);
  seg('HP', d.hp);
  seg('Stress', d.stress);
  seg('Thresholds', d.thresholds);
  if (d.attack_name || d.attack_modifier || d.attack_damage) {
    const atk = [d.attack_modifier, d.attack_name ? d.attack_name + ':' : null,
      d.attack_range, d.attack_damage].filter(Boolean).join(' ');
    seg('ATK', atk);
  }
  return stripEl;
}

// --- Environment block (§5.2 item 5) ----------------------------------

function buildEnvironmentBlock(enc) {
  if (!enc.environmentId) return null;
  const env = entityById(enc.environmentId);
  const wrap = document.createElement('div');
  wrap.className = 'encounter-environment-block';
  if (!env) {
    const p = document.createElement('p');
    p.className = 'lore-empty';
    p.textContent = 'Selected environment entry is missing.';
    wrap.appendChild(p);
    return wrap;
  }
  const header = document.createElement('div');
  header.className = 'encounter-adv-group-header';
  const link = document.createElement('a');
  link.href = '#';
  link.className = 'entity-map-link encounter-env-title';
  link.textContent = env.name;
  link.addEventListener('click', function (ev) {
    ev.preventDefault();
    switchToCodexTabForEntity(env.id);
  });
  header.appendChild(link);
  wrap.appendChild(header);
  const bodyDiv = document.createElement('div');
  bodyDiv.className = 'encounter-env-body';
  // Same stat-block renderer the Entry Card uses (details + features
  // markdown incl. the Phase 15 feature-type captions).
  renderMarkdownInto(bodyDiv, resolveEntityStatBlockMarkdown(env, viewerContext(), null));
  wrap.appendChild(bodyDiv);
  return wrap;
}

// --- Tab wiring --------------------------------------------------------


// --- Adversary picker (§5.3, floating panel) --------------------------
// Lives on document.body (not detailEl) so the snapshot re-render each
// Add triggers doesn't destroy the open panel mid-multi-add. Add reads
// the encounter fresh from state at click time — a stale closure would
// clobber the instances the previous Add just wrote.

function openAdversaryPicker(enc) {
  if (document.querySelector('.encounter-picker-panel')) return;
  const encId = enc.id;

  const panel = document.createElement('div');
  panel.className = 'gallery-picker-panel encounter-picker-panel';
  const header = document.createElement('div');
  header.className = 'gallery-picker-header';
  header.textContent = 'Add adversary';
  panel.appendChild(header);
  const body = document.createElement('div');
  body.className = 'gallery-picker-body';
  panel.appendChild(body);
  document.body.appendChild(panel);

  // Drag-to-move via the header (gallery-picker pattern).
  let panelDrag = null;
  header.addEventListener('pointerdown', function (ev) {
    const rect = panel.getBoundingClientRect();
    panel.style.left = rect.left + 'px';
    panel.style.top = rect.top + 'px';
    panel.style.right = 'auto';
    header.setPointerCapture(ev.pointerId);
    panelDrag = { startX: ev.clientX, startY: ev.clientY, origLeft: rect.left, origTop: rect.top };
  });
  header.addEventListener('pointermove', function (ev) {
    if (!panelDrag) return;
    panel.style.left = (panelDrag.origLeft + (ev.clientX - panelDrag.startX)) + 'px';
    panel.style.top = (panelDrag.origTop + (ev.clientY - panelDrag.startY)) + 'px';
  });
  function endPanelDrag() { panelDrag = null; }
  header.addEventListener('pointerup', endPanelDrag);
  header.addEventListener('pointercancel', endPanelDrag);

  const searchInput = document.createElement('input');
  searchInput.type = 'text';
  searchInput.placeholder = 'Search\u2026';
  searchInput.className = 'encounter-picker-search';
  body.appendChild(searchInput);

  const filterRow = document.createElement('div');
  filterRow.className = 'encounter-picker-filters';
  const adversaries = state.allEntities.filter(function (e) { return e.category === 'Adversary'; });

  const tierSelect = document.createElement('select');
  const tierAny = document.createElement('option');
  tierAny.value = ''; tierAny.textContent = 'Any tier';
  tierSelect.appendChild(tierAny);
  Array.from(new Set(adversaries.map(function (e) { return (e.details && e.details.tier) || ''; })))
    .filter(Boolean)
    .sort(function (a, b) { return parseInt(a, 10) - parseInt(b, 10); })
    .forEach(function (t) {
      const opt = document.createElement('option');
      opt.value = t; opt.textContent = 'Tier ' + t;
      tierSelect.appendChild(opt);
    });
  filterRow.appendChild(tierSelect);

  // Type options collapse the compound Horde variants via the same
  // first-word normalization the calculator uses (§5.3).
  const typeSelect = document.createElement('select');
  const typeAny = document.createElement('option');
  typeAny.value = ''; typeAny.textContent = 'Any type';
  typeSelect.appendChild(typeAny);
  Array.from(new Set(adversaries.map(function (e) { return normalizeAdvType(e.details && e.details.type); })))
    .filter(Boolean)
    .sort()
    .forEach(function (t) {
      const opt = document.createElement('option');
      opt.value = t; opt.textContent = t;
      typeSelect.appendChild(opt);
    });
  filterRow.appendChild(typeSelect);
  body.appendChild(filterRow);

  const results = document.createElement('div');
  results.className = 'encounter-picker-results';
  body.appendChild(results);

  const actions = document.createElement('div');
  actions.className = 'modal-actions';
  const closeBtn = document.createElement('button');
  closeBtn.textContent = 'Close';
  closeBtn.addEventListener('click', closePanel);
  actions.appendChild(closeBtn);
  body.appendChild(actions);

  function closePanel() {
    document.removeEventListener('keydown', onKey);
    panel.remove();
  }
  function onKey(ev) {
    if (ev.key === 'Escape') closePanel();
  }
  document.addEventListener('keydown', onKey);

  // OI1: the shared matcher misses feature body text (resistances) and
  // difficulty (searchable:false), so extend it per comma-term with
  // substring checks over both — same AND-of-terms semantics.
  function pickerMatches(entity, rawQuery) {
    const raw = (rawQuery || '').trim().toLowerCase();
    if (!raw) return true;
    const terms = raw.split(',').map(function (t) { return t.trim(); }).filter(Boolean);
    return terms.every(function (q) {
      if (entityMatchesQuery(entity, q)) return true;
      const d = entity.details || {};
      if (d.difficulty && String(d.difficulty).toLowerCase().indexOf(q) !== -1) return true;
      return (entity.features || []).some(function (f) {
        return f && f.text && f.text.toLowerCase().indexOf(q) !== -1;
      });
    });
  }

  function renderResults() {
    results.innerHTML = '';
    const q = searchInput.value;
    const tier = tierSelect.value;
    const type = typeSelect.value;
    const matches = state.allEntities
      .filter(function (e) {
        if (e.category !== 'Adversary') return false;
        const d = e.details || {};
        if (tier && String(d.tier) !== tier) return false;
        if (type && normalizeAdvType(d.type) !== type) return false;
        return pickerMatches(e, q);
      })
      .sort(function (a, b) { return (a.name || '').localeCompare(b.name || ''); });
    if (!matches.length) {
      const p = document.createElement('p');
      p.className = 'lore-empty';
      p.textContent = 'No adversaries match.';
      results.appendChild(p);
      return;
    }
    matches.forEach(function (e) {
      const row = document.createElement('div');
      row.className = 'encounter-picker-row';
      const info = document.createElement('div');
      info.className = 'encounter-picker-row-info';
      const name = document.createElement('div');
      name.className = 'entity-name';
      name.textContent = e.name;
      info.appendChild(name);
      const d = e.details || {};
      const sub = document.createElement('div');
      sub.className = 'encounter-picker-row-sub';
      sub.textContent = ['Tier ' + (d.tier || '?'), d.type || '?', d.difficulty ? 'Difficulty ' + d.difficulty : null]
        .filter(Boolean).join(' \u00b7 ');
      info.appendChild(sub);
      row.appendChild(info);
      const addBtn = document.createElement('button');
      addBtn.textContent = 'Add';
      addBtn.addEventListener('click', function () {
        const live = state.allEncounters.find(function (x) { return x.id === encId; });
        if (live) addInstance(live, e);
      });
      row.appendChild(addBtn);
      results.appendChild(row);
    });
  }

  searchInput.addEventListener('input', renderResults);
  tierSelect.addEventListener('change', renderResults);
  typeSelect.addEventListener('change', renderResults);
  renderResults();
  searchInput.focus();
}

newBtn.addEventListener('click', createEncounter);

function ensureEncountersTabReady() {
  renderEncountersTab();
}

export { attachEncountersListener, detachEncountersListener, ensureEncountersTabReady, renderEncountersTab, updateEncounter, getSelectedEncounter };
