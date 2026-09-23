// encounter-status.js -- live HP/Stress panel on an encounter's linked
// Meta-Encounter lore item (Sep 2026). Two per-encounter toggles (Build
// tab, both off by default): showAdversaryStatus, showPlayerStatus.
//
// Shown only while the run is Started (Gregg's call): Start adds it,
// Complete/Reset remove it. Data paths differ because of who can read
// what:
//   - Adversaries: `encounters` is GM-only in firestore.rules, so the
//     GM's client writes a snapshot onto each linked lore item
//     (loreItems.encounterStatus) -- encounters.js syncEncounterStatuses
//     keeps it in step from the encounters listener. Names are the real
//     instance labels only when adversaries are revealed at Start
//     (revealAdversariesTiming === 'start'); otherwise "Adversary n", so
//     the panel doesn't leak what the party is fighting.
//   - Party: every player-owned Character's cards.sheet hp/stress, read
//     live at render time (entities are readable by players, and the
//     entities listener already re-renders the Codex on sheet edits) --
//     so no writes for this half, just the showParty flag.
//
// encounterStatus shape: { adversaries: [{name, hp, hpMax, stress,
// stressMax}], showAdversaries: bool, showParty: bool } or null.
import { state } from './state.js';
import { canSee } from './visibility.js';

// --- GM side: the snapshot to write --------------------------------------

function computeEncounterStatus(enc) {
  if ((enc.runStatus || 'pristine') !== 'started') return null;
  const showAdversaries = !!enc.showAdversaryStatus;
  const showParty = !!enc.showPlayerStatus;
  if (!showAdversaries && !showParty) return null;
  const named = (enc.revealAdversariesTiming || 'off') === 'start';
  const adversaries = !showAdversaries ? [] : (enc.instances || []).map(function (inst, i) {
    const entity = state.allEntities.find(function (e) { return e.id === inst.entityId; });
    const d = (entity && entity.details) || {};
    return {
      name: named ? (inst.label || inst.fallbackName || 'Adversary ' + (i + 1)) : 'Adversary ' + (i + 1),
      hp: inst.hp || 0, hpMax: parseInt(d.hp, 10) || 0,
      stress: inst.stress || 0, stressMax: parseInt(d.stress, 10) || 0
    };
  });
  return { adversaries: adversaries, showAdversaries: showAdversaries, showParty: showParty };
}

// --- Render side (codex.js lore item) ------------------------------------

function partyRows(ctx) {
  return state.allEntities
    .filter(function (e) { return e.category === 'Character' && e.ownerId && canSee(e, ctx); })
    .sort(function (a, b) { return (a.name || '').localeCompare(b.name || ''); })
    .map(function (e) {
      const sheet = (e.cards && e.cards.sheet) || {};
      const hp = sheet.hp || {};
      const stress = sheet.stress || {};
      return {
        name: e.name || '(unnamed)',
        hp: hp.marked || 0, hpMax: hp.max || 0,
        stress: stress.marked || 0, stressMax: stress.max || 0
      };
    });
}

function track(marked, max, cls) {
  const cell = document.createElement('td');
  const boxes = document.createElement('span');
  boxes.className = 'es-track';
  for (let i = 0; i < max; i++) {
    const b = document.createElement('i');
    b.className = cls + (i < marked ? ' on' : '');
    boxes.appendChild(b);
  }
  cell.appendChild(boxes);
  const num = document.createElement('span');
  num.className = 'es-num';
  num.textContent = max ? (Math.min(marked, max) + '/' + max) : '—';
  cell.appendChild(num);
  return cell;
}

function table(title, rows, defeatable) {
  const frag = document.createDocumentFragment();
  const h = document.createElement('h4');
  h.textContent = title;
  frag.appendChild(h);
  const t = document.createElement('table');
  const head = document.createElement('tr');
  ['', 'HP', 'Stress'].forEach(function (label) {
    const th = document.createElement('th');
    th.textContent = label;
    head.appendChild(th);
  });
  t.appendChild(head);
  rows.forEach(function (r) {
    const tr = document.createElement('tr');
    const down = defeatable && r.hpMax > 0 && r.hp >= r.hpMax;
    if (down) tr.className = 'es-down';
    const name = document.createElement('td');
    name.className = 'es-name';
    name.textContent = r.name;
    if (down) {
      const tag = document.createElement('span');
      tag.className = 'es-tag';
      tag.textContent = 'defeated';
      name.appendChild(tag);
    }
    tr.appendChild(name);
    tr.appendChild(track(r.hp, r.hpMax, 'hp'));
    tr.appendChild(track(r.stress, r.stressMax, 'st'));
    t.appendChild(tr);
  });
  frag.appendChild(t);
  return frag;
}

// null when there's nothing to show (no status, or both halves empty).
function buildEncounterStatusPanel(status, ctx) {
  if (!status) return null;
  const adversaries = status.showAdversaries ? (status.adversaries || []) : [];
  const party = status.showParty ? partyRows(ctx) : [];
  if (!adversaries.length && !party.length) return null;
  const panel = document.createElement('div');
  panel.className = 'encounter-status';
  const live = document.createElement('span');
  live.className = 'es-live';
  live.textContent = '● live';
  panel.appendChild(live);
  if (adversaries.length) panel.appendChild(table('Adversaries', adversaries, true));
  if (party.length) panel.appendChild(table('Party', party, false));
  return panel;
}

export { computeEncounterStatus, buildEncounterStatusPanel };
