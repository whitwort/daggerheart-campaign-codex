// visibility-ui.js — Phase 14 S2. The GM-facing 3-state visibility control:
// existing toggle switch + a new "..." kebab that opens an anchored popover
// (radio list of current-party PCs + "None"). One shared builder used at
// all four toggle sites (entity, lore-item live toggle, lore-item edit box,
// gallery image) per phase-14-design.md §6.1 — replaces the near-identical
// hand-built toggle code that used to live at each call site.
//
// State machine (design doc §6.1 / D1):
//   characterId == null: toggle flips gm-only <-> all-players
//     ("Hidden from party" / "Visible to party")
//   characterId != null: toggle flips character <-> all-players
//     ("Specific player" / "Visible to party"); gm-only unreachable until
//     "None" is selected in the popover.
//   Selecting a character (from any state) -> visibility becomes
//     'character' with that characterId. If the character actually changed,
//     characterShared is cleared (it's that character's owner's own consent
//     flag from S3 -- stale once the GM re-targets a different PC).
//   Selecting "None" -> gm-only (D1), clears characterShared.
//
// Reveal-without-source confirmation (existing confirmRevealWithoutSource
// guard) fires whenever the element moves OUT of gm-only for the first
// time, regardless of whether it lands on all-players or a specific
// character -- both are new exposure to at least one player.
//
// Live-write sites (entity/lore-item-toggle/gallery) pass onApply = the
// sharing.js write function bound to that element's id; the eventual
// Firestore snapshot triggers the real re-render. The lore-item edit-box
// site (local unsaved draft, no live write) passes onApply = a mutator on
// editState. Either way this control also refreshes its own label/toggle/
// popover state immediately after a successful apply, so the UI doesn't
// wait on write round-trip latency.

import { state } from './state.js';

// --- popover singleton: only one open at a time, closed on outside
// click / Escape. Registered once at module load (not per-render) so
// repeated renders of lore/gallery lists never pile up duplicate
// document-level listeners. ------------------------------------------------
let activePopover = null;

function closeActivePopover() {
  if (!activePopover) return;
  activePopover.popover.hidden = true;
  activePopover.btn.classList.remove('open');
  activePopover = null;
}

document.addEventListener('click', function (e) {
  if (activePopover && !activePopover.wrap.contains(e.target)) closeActivePopover();
});
document.addEventListener('keydown', function (e) {
  if (e.key === 'Escape') closeActivePopover();
});

// --- current-party PCs: players' characters (ownerId set), ordered by
// player name then character name, per §6.1. A character whose owner has
// since been removed from players/{email} still gets listed (falls back
// to showing the raw ownerId) rather than silently disappearing from the
// picker. ------------------------------------------------------------------
function partyCharacterOptions() {
  return state.allEntities
    .filter(function (e) { return e.category === 'Character' && !!e.ownerId; })
    .map(function (e) {
      const player = (state.allPlayers || []).find(function (p) { return p.id === e.ownerId; });
      return {
        id: e.id,
        name: e.name || '(unnamed)',
        playerName: (player && player.displayName) || e.ownerId
      };
    })
    .sort(function (a, b) {
      return a.playerName.localeCompare(b.playerName) || a.name.localeCompare(b.name);
    });
}

// --- buildVisibilityControl ------------------------------------------------
// opts:
//   getVisibility(): () => 'gm-only'|'all-players'|'character' (current)
//   getCharacterId(): () => string|null (current)
//   sourceId: string|null — passed to confirmReveal on a gm-only exit
//   confirmReveal: (sourceId) => bool — inject confirmRevealWithoutSource
//     (avoids a circular import back into codex.js)
//   onApply: (patch) => void — patch is {visibility, characterId} and,
//     when clearing/reassigning a share, also {characterShared: false}
// Returns a DOM node (span.vis-control) to insert in place of the old
// hand-built label+switch markup.
function buildVisibilityControl(opts) {
  let currentV = opts.getVisibility();
  let currentCharId = opts.getCharacterId() || null;

  const wrap = document.createElement('span');
  wrap.className = 'vis-control';

  const label = document.createElement('span');
  wrap.appendChild(label);

  const switchLabel = document.createElement('label');
  const switchInput = document.createElement('input');
  switchInput.type = 'checkbox';
  const switchSlider = document.createElement('span');
  switchSlider.className = 'toggle-slider';
  switchLabel.appendChild(switchInput);
  switchLabel.appendChild(switchSlider);
  wrap.appendChild(switchLabel);

  const kebabWrap = document.createElement('span');
  kebabWrap.className = 'vis-kebab-wrap';
  const kebabBtn = document.createElement('button');
  kebabBtn.type = 'button';
  kebabBtn.className = 'vis-kebab-btn';
  kebabBtn.setAttribute('aria-label', 'Target a specific player');
  kebabBtn.textContent = '\u22EE';
  const popover = document.createElement('div');
  popover.className = 'vis-kebab-popover';
  popover.hidden = true;
  kebabWrap.appendChild(kebabBtn);
  kebabWrap.appendChild(popover);
  wrap.appendChild(kebabWrap);

  const radioName = 'vis-target-' + Math.random().toString(36).slice(2);
  let radios = [];

  function buildOptionRow(value, name, playerName) {
    const row = document.createElement('label');
    row.className = 'vis-kebab-option';
    const input = document.createElement('input');
    input.type = 'radio';
    input.name = radioName;
    input.value = value;
    input.addEventListener('change', function () { onSelect(value); });
    row.appendChild(input);
    const nameSpan = document.createElement('span');
    nameSpan.className = 'vis-kebab-char-name';
    nameSpan.textContent = name;
    row.appendChild(nameSpan);
    if (playerName) {
      const playerSpan = document.createElement('span');
      playerSpan.className = 'vis-kebab-player-name';
      playerSpan.textContent = playerName;
      row.appendChild(playerSpan);
    }
    return { row: row, input: input, value: value };
  }

  function buildPopoverContent() {
    popover.innerHTML = '';
    radios = [];
    const noneOpt = buildOptionRow('', 'None');
    popover.appendChild(noneOpt.row);
    radios.push(noneOpt);
    partyCharacterOptions().forEach(function (pc) {
      const opt = buildOptionRow(pc.id, pc.name, pc.playerName);
      popover.appendChild(opt.row);
      radios.push(opt);
    });
    syncRadios();
  }

  function syncRadios() {
    radios.forEach(function (r) { r.input.checked = (r.value === (currentCharId || '')); });
  }

  function refresh() {
    const characterMode = !!currentCharId;
    const visible = currentV === 'all-players';
    let text, cls;
    if (characterMode) {
      text = visible ? 'Visible to party' : 'Specific player';
      cls = visible ? 'state-visible' : 'state-character';
    } else {
      text = visible ? 'Visible to party' : 'Hidden from party';
      cls = visible ? 'state-visible' : 'state-hidden';
    }
    label.className = 'toggle-switch-label ' + cls;
    label.textContent = text;
    switchLabel.className = 'toggle-switch' + (characterMode ? ' mode-character' : '');
    switchInput.checked = visible;
    kebabBtn.classList.toggle('active', characterMode);
    syncRadios();
  }

  function applyChange(newV, newCharId, clearShared) {
    const wasHidden = currentV === 'gm-only';
    const becomesRevealed = newV !== 'gm-only';
    if (wasHidden && becomesRevealed && !opts.confirmReveal(opts.sourceId)) return false;
    const patch = { visibility: newV, characterId: newCharId };
    if (clearShared) patch.characterShared = false;
    currentV = newV;
    currentCharId = newCharId;
    opts.onApply(patch);
    refresh();
    return true;
  }

  switchInput.addEventListener('change', function () {
    const wantVisible = switchInput.checked;
    const newV = wantVisible ? 'all-players' : (currentCharId ? 'character' : 'gm-only');
    if (!applyChange(newV, currentCharId, false)) switchInput.checked = !wantVisible;
  });

  function onSelect(value) {
    const ok = value === ''
      ? applyChange('gm-only', null, true)
      : applyChange('character', value, value !== currentCharId);
    if (ok) closeActivePopover(); else syncRadios();
  }

  kebabBtn.addEventListener('click', function (e) {
    e.stopPropagation();
    if (activePopover && activePopover.popover === popover) { closeActivePopover(); return; }
    closeActivePopover();
    buildPopoverContent();
    popover.hidden = false;
    kebabBtn.classList.add('open');
    activePopover = { wrap: kebabWrap, popover: popover, btn: kebabBtn };
  });

  refresh();
  return wrap;
}

export { buildVisibilityControl };
