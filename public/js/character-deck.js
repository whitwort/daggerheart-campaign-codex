// character-deck.js — Phase 14 S15. The "character deck" viewer:
// Characters tab, GM and player detail panes, when a character is
// selected. Renders Heritage / Class / Abilities / Conditions /
// Equipment as parchment "cards" (matching .codex-entity-card's own
// visual identity, scaled down) laid out in dark "trays" per section --
// the physical Daggerheart-cards-on-the-table metaphor, per Gregg's
// design pass.
//
// DELIBERATELY a second, separate editing surface from character-
// cards.js's draft/Save-Cancel build-time editor (Codex tab -> Edit).
// That module owns character BUILD state (ancestry/community/class/
// subclass/abilityIds/badgeColor) via a draft object Save/Cancel
// governs. This module owns PLAY-TIME state (current subclass tier,
// which abilities are Active vs Vaulted, active Conditions, carried
// Equipment) and writes each change straight to Firestore on
// interaction -- there's no "cancel out of" a condition you just
// suffered mid-scene. Flagged explicitly to Gregg before building
// (see session notes) given the S9/S10 history of two editing
// surfaces causing more confusion than they solved; the split here is
// build-time vs. play-time, not a duplicate of the same thing.
//
// Ability ownership: vaultAbilityIds is a SUBSET of cards.abilityIds
// (the Codex tab's existing Abilities picker still owns the master
// list, untouched by this module) -- Active is derived as "abilityIds
// minus vaultAbilityIds", never stored as its own separate array, so
// the two can't drift out of sync. Conditions/Equipment are wholly new
// cards.* fields with no Codex-tab counterpart.
//
// Known limitation: writes are direct updateDoc calls against the
// closed-over `entity` snapshot at render time, not a diff against
// live state -- two rapid clicks before the entities listener's next
// snapshot echoes back could lose one (last-write-wins), same
// characteristic already accepted elsewhere in this app (see e.g.
// persistent_storage's own last-write-wins note). Not engineered
// around; a real conflict here needs a double-click within roughly a
// round-trip, which at-the-table use makes rare enough not to justify
// optimistic-merge complexity.

import {
  getFirestore, doc, updateDoc, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import { firebaseApp, CONFIG } from './firebase.js';
import { state } from './state.js';
import { canSee, hasFullAuthority } from './visibility.js';
import { renderMarkdownInto } from './markdown.js';
import { trackWrite } from './connectivity.js';
import { generateDefaultBadgeColor } from './badge-color.js';
import { attachPickerDismiss } from './picker-panel.js';
import { resolveEntityStatBlockMarkdown, switchToCodexTabForEntity, enterEntityEditMode } from './codex.js';
import { buildInfoPopup } from './info-popup.js';
import {
  DEFAULT_CARDS, TIER_OPTIONS, normalizeAncestryIds, resolveFunctionalIds,
  cumulativeTierKeys, buildFloatingPickerPanel, openAbilityPickerPopup, openExperiencePickerPopup,
  tierForCharacterLevel
} from './character-cards.js';

const db = getFirestore(firebaseApp);

function byName(a, b) { return (a.name || '').localeCompare(b.name || ''); }
function newLocalId() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }

function patchCards(entity, patch) {
  const cards = Object.assign({}, DEFAULT_CARDS, entity.cards || {}, patch);
  trackWrite(updateDoc(doc(db, 'entities', entity.id), { cards: cards, updatedAt: serverTimestamp() }), 'Saving character')
    .catch(function (err) { window.alert('Save failed: ' + err.message); });
}

// --- Shared card/tray/section builders ------------------------------------

function buildSection(titleText, extraHeaderEl) {
  const section = document.createElement('div');
  section.className = 'character-deck-section';
  const titleRow = document.createElement('div');
  titleRow.className = 'character-deck-section-title-row';
  const title = document.createElement('span');
  title.className = 'character-deck-section-title';
  title.textContent = titleText;
  titleRow.appendChild(title);
  if (extraHeaderEl) titleRow.appendChild(extraHeaderEl);
  section.appendChild(titleRow);
  return section;
}
function buildTray() {
  const tray = document.createElement('div');
  tray.className = 'character-deck-tray';
  return tray;
}
function buildEmptyNote(tray, text) {
  const p = document.createElement('p');
  p.className = 'lore-empty';
  p.textContent = text;
  tray.appendChild(p);
}
function buildAddSlot(label, onClick) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'character-deck-add-slot';
  btn.textContent = label;
  btn.addEventListener('click', onClick);
  return btn;
}

// Two elements side by side with a draggable vertical divider between
// them (S18: Heritage/Conditions share a row, and Class/Subclass share
// a row within the Class section). Percentage split communicated to
// CSS via a --split-fraction custom property on the row (inherited
// down to the pane rules) rather than inline flex-basis on the panes
// directly -- keeps specificity low enough for the narrow-container
// fallback (stacks to a column, hides the handle) to override it with
// a plain class rule, no !important needed. Pointer Events (not
// mouse/touch separately) so this works the same with a finger on
// iPad as a mouse on desktop -- setPointerCapture keeps the drag
// tracking even if the finger/cursor leaves the thin handle mid-drag.
// stateKey is OPTIONAL session-only state (state.js) the fraction is
// read from/written back to -- resets on reload, not persisted to
// Firestore; this is a personal viewing preference, not campaign data.
function buildSplitRow(leftEl, rightEl, opts) {
  opts = opts || {};
  const stateKey = opts.stateKey;
  const defaultFraction = opts.defaultFraction !== undefined ? opts.defaultFraction : 0.5;
  const minFraction = opts.minFraction !== undefined ? opts.minFraction : 0.2;
  const maxFraction = opts.maxFraction !== undefined ? opts.maxFraction : 0.8;

  const row = document.createElement('div');
  row.className = 'character-deck-split-row';

  const leftPane = document.createElement('div');
  leftPane.className = 'character-deck-split-pane';
  leftPane.appendChild(leftEl);

  const handle = document.createElement('div');
  handle.className = 'character-deck-split-handle';
  handle.setAttribute('role', 'separator');
  handle.setAttribute('aria-orientation', 'vertical');
  handle.tabIndex = 0;

  const rightPane = document.createElement('div');
  rightPane.className = 'character-deck-split-pane';
  rightPane.appendChild(rightEl);

  row.appendChild(leftPane);
  row.appendChild(handle);
  row.appendChild(rightPane);

  let fraction = (stateKey && typeof state[stateKey] === 'number') ? state[stateKey] : defaultFraction;
  row.style.setProperty('--split-fraction', (fraction * 100) + '%');

  let dragging = false, startX = 0, startFraction = fraction, containerWidth = 0;
  handle.addEventListener('pointerdown', function (ev) {
    dragging = true;
    startX = ev.clientX;
    startFraction = fraction;
    containerWidth = row.getBoundingClientRect().width || 1;
    try { handle.setPointerCapture(ev.pointerId); } catch (e) { /* unsupported, drag still works via document fallback below */ }
    handle.classList.add('dragging');
    ev.preventDefault();
  });
  handle.addEventListener('pointermove', function (ev) {
    if (!dragging) return;
    const dx = ev.clientX - startX;
    let next = startFraction + (dx / containerWidth);
    next = Math.max(minFraction, Math.min(maxFraction, next));
    fraction = next;
    row.style.setProperty('--split-fraction', (fraction * 100) + '%');
  });
  function endDrag(ev) {
    if (!dragging) return;
    dragging = false;
    handle.classList.remove('dragging');
    if (stateKey) state[stateKey] = fraction;
    if (ev && ev.pointerId !== undefined) {
      try { handle.releasePointerCapture(ev.pointerId); } catch (e) { /* already released */ }
    }
  }
  handle.addEventListener('pointerup', endDrag);
  handle.addEventListener('pointercancel', endDrag);

  return row;
}

// Lazy-loads SortableJS (same pattern as codex.js's Gallery/Lore
// reorder and admin.js's Sources reorder -- own local wrapper per
// module around the shared state.sortableModulePromise, not a shared
// function import, matching the established convention). iOS Safari
// has no native HTML5 drag-and-drop touch support, hence a real
// library instead of rolling this by hand.
function loadSortable() {
  if (!state.sortableModulePromise) {
    state.sortableModulePromise = import('https://esm.sh/sortablejs@1.15.2')
      .then(function (mod) { return mod.default || mod; });
  }
  return state.sortableModulePromise;
}

// Enables drag-reorder on a tray's cards (S22: Abilities' Active/Vault/
// Experience tabs, Equipment). container's card children must each
// carry a data-reorder-id (buildMiniCard's opts.reorderId) -- the "+
// Add" slot has none, and is excluded from dragging via `filter` so it
// stays put at the end of the tray rather than becoming reorderable
// itself. preventOnFilter:false (SortableJS defaults this to true) so
// the add-slot's own click handler keeps firing normally -- true would
// swallow the initiating event on that element, which risks breaking
// its click on touch. onReorder receives the new id order (add-slot
// excluded) for the caller to write back to Firestore -- this module
// never persists order itself, same "caller owns the Firestore write"
// shape every other control in this file already uses.
function enableCardReorder(container, onReorder) {
  const items = Array.prototype.slice.call(container.children).filter(function (el) { return el.dataset && el.dataset.reorderId; });
  if (items.length < 2) return;
  loadSortable().then(function (Sortable) {
    // eslint-disable-next-line no-new
    new Sortable(container, {
      filter: '.character-deck-add-slot',
      preventOnFilter: false,
      forceFallback: true,
      animation: 150,
      onEnd: function () {
        const orderedIds = Array.prototype.slice.call(container.children)
          .filter(function (el) { return el.dataset && el.dataset.reorderId; })
          .map(function (el) { return el.dataset.reorderId; });
        onReorder(orderedIds);
      }
    });
  }).catch(function () { /* drag-reorder unavailable; add/remove/swap still work */ });
}

// The mini parchment card itself -- opts: title, titleSuffix (qty/note,
// shown muted after the name), badge (Tier/Level, normalized to the
// card's own bottom-right corner across every type that has one),
// metaLines (array of strings, one per line, right under the name),
// bodyMd (markdown, rendered via the same renderer everything else in
// the app uses), controls (array of {icon,title,cls,onClick}, top-right
// corner), wide (spans the tray's full width -- no current caller
// since Subclass moved to its own split-row pane (S18), kept as a
// general option), reorderId (drag-reorder key, see enableCardReorder).
function buildMiniCard(opts) {
  const card = document.createElement('div');
  card.className = 'character-deck-card' + (opts.wide ? ' wide' : '');
  // reorderId (S22): drag-reorder target key, read back by
  // enableCardReorder's onEnd handler after a drop -- set whenever a
  // caller passes one, harmless/unused otherwise.
  if (opts.reorderId) card.dataset.reorderId = opts.reorderId;

  const headerRow = document.createElement('div');
  headerRow.className = 'character-deck-card-header-row';

  // Title group: Codex link (S20 -- moved from a bottom-left corner
  // icon to inline, left of the name) + the name itself, sharing one
  // sub-row so the pair can be the single flex-start item opposite
  // .character-deck-card-controls in the outer header row.
  const titleGroup = document.createElement('div');
  titleGroup.className = 'character-deck-card-title-group';
  const h3 = document.createElement('h3');
  h3.appendChild(document.createTextNode(opts.title));
  if (opts.titleSuffix) {
    const span = document.createElement('span');
    span.className = 'character-deck-card-suffix';
    span.textContent = ' ' + opts.titleSuffix;
    h3.appendChild(span);
  }
  titleGroup.appendChild(h3);
  // Every card type EXCEPT Experience (never Codex-backed, no entity
  // to open). Conditions/Equipment only get one when linked to an
  // actual entity (entityId set); a custom/free-text entry has
  // nothing to open, so opts.codexEntityId is simply omitted for
  // those and no icon renders. Right of the name (S21 -- was left of
  // it, S20).
  if (opts.codexEntityId) {
    const codexLink = document.createElement('button');
    codexLink.type = 'button';
    codexLink.className = 'character-deck-card-codex-link';
    codexLink.title = 'Open in Codex';
    codexLink.innerHTML = CONFIG.icons.codex;
    codexLink.addEventListener('click', function () { switchToCodexTabForEntity(opts.codexEntityId); });
    titleGroup.appendChild(codexLink);
  }
  headerRow.appendChild(titleGroup);
  if (opts.controls && opts.controls.length) {
    const controls = document.createElement('div');
    controls.className = 'character-deck-card-controls';
    opts.controls.forEach(function (c) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'character-deck-ctl ' + (c.cls || '');
      btn.title = c.title;
      btn.innerHTML = c.icon;
      btn.addEventListener('click', c.onClick);
      controls.appendChild(btn);
    });
    headerRow.appendChild(controls);
  }
  card.appendChild(headerRow);
  (opts.metaLines || []).forEach(function (line) {
    if (!line) return;
    const m = document.createElement('div');
    m.className = 'character-deck-card-meta';
    m.textContent = line;
    card.appendChild(m);
  });
  if (opts.bodyMd) {
    const body = document.createElement('div');
    body.className = 'character-deck-card-body';
    renderMarkdownInto(body, opts.bodyMd);
    card.appendChild(body);
  }
  if (opts.badge) {
    const badge = document.createElement('div');
    badge.className = 'character-deck-card-badge';
    badge.textContent = opts.badge;
    card.appendChild(badge);
  }
  return card;
}

// --- Generic linked-entity-or-custom-text add popup (Conditions/
// Equipment) -- same floating-panel chrome as character-cards.js's own
// openAbilityPickerPopup (shares buildFloatingPickerPanel), generalized
// with optional grouping and a free-text custom-entry fallback for
// anything that isn't in the Codex. ---------------------------------------
function openCardPickerPopup(opts) {
  if (document.querySelector('.entity-picker-panel')) return;
  const built = buildFloatingPickerPanel();
  built.header.textContent = opts.title;
  const close = attachPickerDismiss(built.panel);

  const searchInput = document.createElement('input');
  searchInput.type = 'text';
  searchInput.placeholder = 'Search\u2026';
  searchInput.className = 'entity-picker-search';
  built.body.appendChild(searchInput);

  const listEl = document.createElement('div');
  listEl.className = 'entity-picker-list';
  built.body.appendChild(listEl);

  const customToggle = document.createElement('button');
  customToggle.type = 'button';
  customToggle.className = 'add-link';
  customToggle.textContent = '+ ' + opts.customLabel;
  built.body.appendChild(customToggle);

  const customForm = document.createElement('div');
  customForm.className = 'character-deck-custom-form';
  customForm.style.display = 'none';
  const nameInput = document.createElement('input');
  nameInput.type = 'text';
  nameInput.placeholder = 'Name';
  customForm.appendChild(nameInput);
  let qtyInput = null, noteInput = null;
  if (opts.customExtraField === 'qty') {
    qtyInput = document.createElement('input');
    qtyInput.type = 'number';
    qtyInput.min = '1';
    qtyInput.value = '1';
    customForm.appendChild(qtyInput);
  } else if (opts.customExtraField === 'note') {
    noteInput = document.createElement('input');
    noteInput.type = 'text';
    noteInput.placeholder = 'Note (optional)';
    customForm.appendChild(noteInput);
  }
  const confirmBtn = document.createElement('button');
  confirmBtn.type = 'button';
  confirmBtn.textContent = 'Add';
  confirmBtn.addEventListener('click', function () {
    const name = nameInput.value.trim();
    if (!name) return;
    opts.onCustom(name, qtyInput ? (parseInt(qtyInput.value, 10) || 1) : undefined, noteInput ? noteInput.value.trim() : undefined);
    close();
  });
  customForm.appendChild(confirmBtn);
  built.body.appendChild(customForm);
  customToggle.addEventListener('click', function () {
    const open = customForm.style.display === 'none';
    customForm.style.display = open ? 'flex' : 'none';
  });

  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.textContent = 'Cancel';
  cancelBtn.addEventListener('click', close);
  built.body.appendChild(cancelBtn);

  function renderRow(ul, e) {
    const li = document.createElement('li');
    const nameDiv = document.createElement('div');
    nameDiv.className = 'entity-name';
    nameDiv.textContent = e.name;
    li.appendChild(nameDiv);
    li.addEventListener('click', function () { opts.onSelect(e); close(); });
    ul.appendChild(li);
  }
  function renderResults() {
    listEl.innerHTML = '';
    const q = searchInput.value.trim().toLowerCase();
    const pool = opts.candidates.filter(function (e) { return !q || (e.name || '').toLowerCase().indexOf(q) !== -1; });
    if (!pool.length) {
      const p = document.createElement('p');
      p.className = 'lore-empty';
      p.textContent = 'No matches.';
      listEl.appendChild(p);
      return;
    }
    if (!opts.groupFn) {
      const ul = document.createElement('ul');
      ul.className = 'entity-group-list';
      pool.sort(byName).forEach(function (e) { renderRow(ul, e); });
      listEl.appendChild(ul);
      return;
    }
    const byGroup = {};
    pool.forEach(function (e) {
      const g = opts.groupFn(e) || 'Other';
      (byGroup[g] = byGroup[g] || []).push(e);
    });
    Object.keys(byGroup).sort().forEach(function (g) {
      const header = document.createElement('div');
      header.className = 'entity-group-header';
      const titleSpan = document.createElement('span');
      titleSpan.className = 'entity-group-title';
      titleSpan.textContent = g;
      const countSpan = document.createElement('span');
      countSpan.className = 'entity-group-count';
      countSpan.textContent = '(' + byGroup[g].length + ')';
      header.appendChild(titleSpan);
      header.appendChild(countSpan);
      listEl.appendChild(header);
      const ul = document.createElement('ul');
      ul.className = 'entity-group-list';
      byGroup[g].sort(byName).forEach(function (e) { renderRow(ul, e); });
      listEl.appendChild(ul);
    });
  }
  searchInput.addEventListener('input', renderResults);
  renderResults();
  searchInput.focus();
}

// Experience add popup moved to character-cards.js (openExperiencePickerPopup)
// so it can be reused by both this module's Experience tab AND the Codex
// tab's edit-form Experiences editor -- see that module for the
// implementation.

// Items/Consumables carry no templates.js schema at all -- their card
// text is just the entity's own lore content, unlike every other
// equipment subtype. Some hand-authored entries (pre-dating this
// feature) include a "### Details" heading whose only content is a
// bare "- **Roll:** N" bullet -- meaningless out of context on a
// compact card, so it's stripped here specifically (not touched
// anywhere else the same lore content renders, e.g. the Lore tab).
// Only drops the section when Roll is its ONLY bullet; a Details
// section with other content is left alone.
function stripLoneRollDetails(md) {
  if (!md) return md;
  return md.replace(/(^|\n)### Details\n((?:- .+\n?)*)/, function (match, pre, bulletsBlock) {
    const bullets = bulletsBlock.split('\n').filter(Boolean);
    if (bullets.length === 1 && /^- \*\*Roll:\*\*/.test(bullets[0])) return pre;
    return match;
  }).trim();
}

// --- Deck-card markdown cleanup (S17): Gregg's ask is specifically
// scoped to the compact deck cards, NOT the Codex tab's own Lore tab
// (resolveEntityStatBlockMarkdown's output is otherwise unchanged --
// these are post-processing steps applied only where a card's bodyMd
// is actually assembled below). Two different operations:
//  - stripHeadingLines: removes ONLY the heading line itself, keeping
//    whatever content sits under it -- used for the generic "###
//    Details"/"### Features" labels (redundant clutter on a card
//    that's obviously details/features already) and, on Ancestry
//    cards only, "### First"/"### Second" (redundant with the card's
//    own titleSuffix, which already says "-- First"/"-- Second").
//  - stripSections: removes the heading AND everything under it up to
//    the next heading -- used for Class cards' Background/Connection
//    roleplay-prompt question lists, which don't belong on a compact
//    reference card at all.
function stripHeadingLines(md, headings) {
  if (!md) return md;
  const targets = headings.map(function (h) { return '### ' + h; });
  return md.split('\n').filter(function (line) { return targets.indexOf(line.trim()) === -1; })
    .join('\n').replace(/\n{3,}/g, '\n\n').trim();
}
function stripSections(md, headings) {
  if (!md) return md;
  const targets = headings.map(function (h) { return '### ' + h; });
  let skipping = false;
  const out = md.split('\n').filter(function (line) {
    const trimmed = line.trim();
    if (/^### /.test(trimmed)) {
      skipping = targets.indexOf(trimmed) !== -1;
      if (skipping) return false;
    }
    return !skipping;
  });
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}
// opts.extraHeadingLines: additional bare heading LINES to drop (kept
// content), beyond the always-dropped Details/Features.
// opts.stripSections: whole sections to drop entirely (heading + body).
// stripBulletLabels: drops "- **Label:** value" bullet lines whose
// data already appears elsewhere on the card (a meta line, a badge)
// -- listing it again in the Details bullets is pure duplication on a
// card this compact. A trailing space on an entry (e.g. 'Domain ')
// matches by PREFIX, not exact label -- covers numbered/suffixed
// variants (Domain 1/Domain 2, Suggested Armor/Primary/Secondary)
// without listing every one out.
function stripBulletLines(md, labels) {
  if (!md) return md;
  return md.split('\n').filter(function (line) {
    const m = /^- \*\*([^:]+):\*\*/.exec(line.trim());
    if (!m) return true;
    const label = m[1];
    return !labels.some(function (pat) {
      return pat.charAt(pat.length - 1) === ' ' ? label.indexOf(pat) === 0 : label === pat;
    });
  }).join('\n').replace(/\n{3,}/g, '\n\n').trim();
}
function cleanCardMd(md, opts) {
  opts = opts || {};
  let out = stripHeadingLines(md, ['Details', 'Features'].concat(opts.extraHeadingLines || []));
  if (opts.stripSections) out = stripSections(out, opts.stripSections);
  if (opts.stripBulletLabels) out = stripBulletLines(out, opts.stripBulletLabels);
  return out;
}

// --- Per-type meta-line builders (the "attributes at top" Gregg asked
// for, one convention per entry type) -------------------------------------
function abilityMetaLines(details) {
  const d = details || {};
  const parts = [d.domain, d.type].filter(Boolean);
  if (d.recall !== undefined && d.recall !== null && d.recall !== '') parts.push('Recall ' + d.recall);
  return parts.length ? [parts.join(' \u00b7 ')] : [];
}
function weaponMetaLines(details) {
  const d = details || {};
  const parts = [d.burden, d.physical_or_magical, d.primary_or_secondary, d.range, d.trait, d.damage].filter(Boolean);
  return parts.length ? [parts.join(' \u00b7 ')] : [];
}
function armorMetaLines(details) {
  const d = details || {};
  const parts = [];
  if (d.base_score) parts.push('Base Score ' + d.base_score);
  if (d.base_thresholds) parts.push('Thresholds ' + d.base_thresholds);
  return parts.length ? [parts.join(' \u00b7 ')] : [];
}
function beastformMetaLines(details) {
  const d = details || {};
  const lines = [];
  const l1 = [d.trait_bonus, d.evasion_bonus].filter(Boolean).join(' \u00b7 ');
  if (l1) lines.push(l1);
  if (d.attack) lines.push('Attack: ' + d.attack);
  if (d.advantages) lines.push('Advantages: ' + d.advantages);
  if (d.examples) lines.push('Examples: ' + d.examples);
  return lines;
}

// --- Heritage (Ancestry x2 + Community) -----------------------------------
// Always exactly two Ancestry cards, one per feature group (First/
// Second) -- even with a single ancestry providing both, per Gregg's
// spec: same ancestry name on both cards, First on one, Second on the
// other. A mixed pair (two functional ancestries via a meta ancestry
// pick) shows each ancestry's own picked group instead.
function buildHeritageSection(cards, ctx) {
  const section = buildSection('Heritage');
  const tray = buildTray();

  const flavorIds = normalizeAncestryIds(cards);
  const functionalIds = resolveFunctionalIds(flavorIds);
  const picks = cards.ancestryFeaturePicks || {};

  if (functionalIds.length === 1) {
    const anc = state.allEntities.find(function (e) { return e.id === functionalIds[0]; });
    if (anc) {
      [['first', 'First'], ['second', 'Second']].forEach(function (pair) {
        tray.appendChild(buildMiniCard({
          title: anc.name,
          titleSuffix: '\u2014 ' + pair[1],
          bodyMd: cleanCardMd(resolveEntityStatBlockMarkdown(anc, ctx, pair[0]), { extraHeadingLines: ['First', 'Second'] }),
          codexEntityId: anc.id
        }));
      });
    }
  } else if (functionalIds.length === 2) {
    functionalIds.forEach(function (fid, i) {
      const anc = state.allEntities.find(function (e) { return e.id === fid; });
      if (!anc) return;
      const group = picks[fid] || (i === 0 ? 'first' : 'second');
      tray.appendChild(buildMiniCard({
        title: anc.name,
        bodyMd: cleanCardMd(resolveEntityStatBlockMarkdown(anc, ctx, group), { extraHeadingLines: ['First', 'Second'] }),
        codexEntityId: anc.id
      }));
    });
  }

  const community = state.allEntities.find(function (e) { return e.id === cards.communityId; });
  if (community) {
    tray.appendChild(buildMiniCard({
      title: community.name,
      bodyMd: cleanCardMd(resolveEntityStatBlockMarkdown(community, ctx, null)),
      codexEntityId: community.id
    }));
  }

  if (!tray.children.length) buildEmptyNote(tray, 'No heritage set.');
  section.appendChild(tray);
  return section;
}

// --- Class + Subclass ------------------------------------------------------
function buildClassSection(entity, cards, ctx, editable) {
  const cls = state.allEntities.find(function (e) { return e.id === cards.classId; });
  const subclass = state.allEntities.find(function (e) { return e.id === cards.subclassId; });

  let tierPicker = null;
  if (subclass) {
    tierPicker = document.createElement('label');
    tierPicker.className = 'character-deck-tier-picker';
    tierPicker.appendChild(document.createTextNode('Tier '));
    const select = document.createElement('select');
    TIER_OPTIONS.forEach(function (t) {
      const opt = document.createElement('option');
      opt.value = t.key;
      opt.textContent = t.label;
      select.appendChild(opt);
    });
    select.value = cards.subclassTier || 'foundation';
    select.disabled = !editable;
    select.addEventListener('change', function () { patchCards(entity, { subclassTier: select.value }); });
    tierPicker.appendChild(select);
  }

  const section = buildSection('Class', tierPicker);

  let classPane = null, subclassPane = null;
  if (cls) {
    const d = cls.details || {};
    const metaLines = (d.evasion || d.hp) ? ['Evasion ' + (d.evasion || '\u2014') + ' \u00b7 HP ' + (d.hp || '\u2014')] : [];
    classPane = buildTray();
    classPane.classList.add('single');
    classPane.appendChild(buildMiniCard({
      title: cls.name,
      metaLines: metaLines,
      bodyMd: cleanCardMd(resolveEntityStatBlockMarkdown(cls, ctx, null), {
        stripSections: ['Background', 'Connection'],
        stripBulletLabels: ['Evasion', 'Hp', 'Domain ', 'Subclass ', 'Suggested ']
      }),
      codexEntityId: cls.id
    }));
  }
  if (subclass) {
    const tierKey = cards.subclassTier || 'foundation';
    const tierLabel = TIER_OPTIONS.find(function (t) { return t.key === tierKey; });
    subclassPane = buildTray();
    subclassPane.classList.add('single');
    subclassPane.appendChild(buildMiniCard({
      title: subclass.name,
      metaLines: ['Through ' + (tierLabel ? tierLabel.label : '')],
      bodyMd: cleanCardMd(resolveEntityStatBlockMarkdown(subclass, ctx, cumulativeTierKeys(tierKey))),
      codexEntityId: subclass.id
    }));
  }

  // Class + Subclass share a row (S18), 40/60 to start -- only when
  // both exist; a lone card (no subclass picked yet, or somehow no
  // class) just fills the section normally, same as before.
  if (classPane && subclassPane) {
    section.appendChild(buildSplitRow(classPane, subclassPane, { stateKey: 'characterDeckClassSplit', defaultFraction: 0.4 }));
  } else if (classPane || subclassPane) {
    section.appendChild(classPane || subclassPane);
  } else {
    const tray = buildTray();
    buildEmptyNote(tray, 'No class set.');
    section.appendChild(tray);
  }
  return section;
}

// --- Abilities (Active / Vault / Beastforms-if-Druid tabs) ----------------
function buildAbilitiesSection(entity, cards, ctx, editable) {
  const section = buildSection('Abilities');
  const abilityIds = cards.abilityIds || [];
  const vaultIds = cards.vaultAbilityIds || [];
  const activeIds = abilityIds.filter(function (id) { return vaultIds.indexOf(id) === -1; });

  const selectedClass = state.allEntities.find(function (e) { return e.id === cards.classId; });
  const isDruid = !!selectedClass && (selectedClass.name || '').trim() === 'Druid';

  const tabs = [['active', 'Active'], ['vault', 'Vault'], ['experience', 'Experience']];
  if (isDruid) tabs.push(['beastforms', 'Beastforms']);
  if (!tabs.some(function (t) { return t[0] === state.characterDeckAbilityTab; })) {
    state.characterDeckAbilityTab = 'active';
  }

  const subtabs = document.createElement('div');
  subtabs.className = 'character-deck-subtabs';
  const panels = {};
  tabs.forEach(function (t) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = t[1];
    if (state.characterDeckAbilityTab === t[0]) btn.classList.add('active');
    btn.addEventListener('click', function () {
      state.characterDeckAbilityTab = t[0];
      subtabs.querySelectorAll('button').forEach(function (b) { b.classList.remove('active'); });
      btn.classList.add('active');
      Object.keys(panels).forEach(function (k) { panels[k].classList.toggle('active', k === t[0]); });
    });
    subtabs.appendChild(btn);
  });
  section.appendChild(subtabs);

  const abilitiesVisible = state.allEntities.filter(function (e) {
    return e.category === 'Game Mechanics' && e.subtype === 'abilities' && (ctx.gmView || canSee(e, ctx));
  });

  function buildAbilityCard(a, inVault) {
    const controls = editable ? [
      {
        icon: inVault ? '&#8593;' : '&#8595;', title: inVault ? 'Move to Active' : 'Move to Vault', cls: 'ctl-swap',
        onClick: function () {
          const newVault = inVault
            ? vaultIds.filter(function (id) { return id !== a.id; })
            : vaultIds.concat([a.id]);
          patchCards(entity, { vaultAbilityIds: newVault });
        }
      },
      {
        icon: '&times;', title: 'Remove', cls: 'ctl-remove',
        onClick: function () {
          patchCards(entity, {
            abilityIds: abilityIds.filter(function (id) { return id !== a.id; }),
            vaultAbilityIds: vaultIds.filter(function (id) { return id !== a.id; })
          });
        }
      }
    ] : [];
    const d = a.details || {};
    return buildMiniCard({
      title: a.name,
      badge: d.level ? ('Lv ' + d.level) : null,
      metaLines: abilityMetaLines(d),
      bodyMd: cleanCardMd(resolveEntityStatBlockMarkdown(a, ctx, null), { stripBulletLabels: ['Domain', 'Level', 'Type', 'Recall'] }),
      controls: controls,
      codexEntityId: a.id,
      reorderId: editable ? a.id : null
    });
  }

  ['active', 'vault'].forEach(function (key) {
    const panel = document.createElement('div');
    panel.className = 'character-deck-tab-panel' + (state.characterDeckAbilityTab === key ? ' active' : '');
    const tray = buildTray();
    const ids = key === 'active' ? activeIds : vaultIds;
    ids.forEach(function (id) {
      const a = abilitiesVisible.find(function (e) { return e.id === id; })
        || state.allEntities.find(function (e) { return e.id === id; });
      if (a) tray.appendChild(buildAbilityCard(a, key === 'vault'));
    });
    if (editable) {
      tray.appendChild(buildAddSlot('+ Add ability', function () {
        const d = selectedClass ? (selectedClass.details || {}) : {};
        const characterLevel = parseInt(cards.level, 10) || 1;
        const candidates = abilitiesVisible.filter(function (a) {
          if (abilityIds.indexOf(a.id) !== -1) return false;
          if (!selectedClass) return true;
          const dom = a.details && a.details.domain;
          const domainMatch = !dom || dom === d.domain_1 || dom === d.domain_2 || (a.visibility === 'character' && a.characterId === entity.id);
          if (!domainMatch) return false;
          // Phase 14 S17: level-gate on ability.details.level (numeric
          // string, e.g. "1".."10") -- no level on the ability at all
          // is always available (unfiltered), same "absent = unfiltered"
          // convention as the domain check above.
          const abilityLevel = parseInt(a.details && a.details.level, 10);
          return !abilityLevel || abilityLevel <= characterLevel;
        });
        openAbilityPickerPopup('Add ability', candidates, function (a) {
          patchCards(entity, {
            abilityIds: abilityIds.concat([a.id]),
            vaultAbilityIds: key === 'vault' ? vaultIds.concat([a.id]) : vaultIds
          });
        });
      }));
    }
    if (!tray.children.length && !editable) {
      buildEmptyNote(tray, key === 'active' ? 'No active abilities.' : 'Vault is empty.');
    }
    if (editable) {
      enableCardReorder(tray, function (orderedIds) {
        if (key === 'active') {
          patchCards(entity, { abilityIds: orderedIds.concat(vaultIds) });
        } else {
          patchCards(entity, { vaultAbilityIds: orderedIds });
        }
      });
    }
    panel.appendChild(tray);
    panels[key] = panel;
    section.appendChild(panel);
  });

  // Experience tab: always-freeform name+text, never Codex-backed --
  // no picker/search popup, just a small "Name" + "Text" form.
  {
    const panel = document.createElement('div');
    panel.className = 'character-deck-tab-panel' + (state.characterDeckAbilityTab === 'experience' ? ' active' : '');
    const tray = buildTray();
    const experiences = cards.experiences || [];
    experiences.forEach(function (exp) {
      const controls = editable ? [{
        icon: '&times;', title: 'Remove', cls: 'ctl-remove',
        onClick: function () { patchCards(entity, { experiences: experiences.filter(function (x) { return x.id !== exp.id; }) }); }
      }] : [];
      tray.appendChild(buildMiniCard({ title: exp.name, bodyMd: exp.text, controls: controls, reorderId: editable ? exp.id : null }));
    });
    if (editable) {
      tray.appendChild(buildAddSlot('+ Add experience', function () {
        openExperiencePickerPopup(function (name, text) {
          patchCards(entity, { experiences: experiences.concat([{ id: newLocalId(), name: name, text: text }]) });
        });
      }));
    }
    if (!tray.children.length && !editable) buildEmptyNote(tray, 'No experiences.');
    if (editable) {
      enableCardReorder(tray, function (orderedIds) {
        const byId = {};
        experiences.forEach(function (e) { byId[e.id] = e; });
        patchCards(entity, { experiences: orderedIds.map(function (id) { return byId[id]; }).filter(Boolean) });
      });
    }
    panel.appendChild(tray);
    panels.experience = panel;
    section.appendChild(panel);
  }

  if (isDruid) {
    const panel = document.createElement('div');
    panel.className = 'character-deck-tab-panel' + (state.characterDeckAbilityTab === 'beastforms' ? ' active' : '');
    const beastforms = state.allEntities.filter(function (e) {
      return e.category === 'Game Mechanics' && e.subtype === 'beastforms' && (ctx.gmView || canSee(e, ctx));
    });
    const byTier = {};
    beastforms.forEach(function (e) {
      const t = (e.details && e.details.tier) || 'Other';
      (byTier[t] = byTier[t] || []).push(e);
    });
    const tray = buildTray();
    Object.keys(byTier).sort(function (a, b) { return (parseInt(a, 10) || 99) - (parseInt(b, 10) || 99); }).forEach(function (t) {
      const label = document.createElement('div');
      label.className = 'character-deck-tier-group-label';
      label.textContent = /^\d+$/.test(t) ? ('Tier ' + t) : t;
      tray.appendChild(label);
      byTier[t].sort(byName).forEach(function (bf) {
        const d = bf.details || {};
        tray.appendChild(buildMiniCard({
          title: bf.name,
          badge: d.tier ? ('T' + d.tier) : null,
          metaLines: beastformMetaLines(d),
          bodyMd: cleanCardMd(resolveEntityStatBlockMarkdown(bf, ctx, null), {
            stripBulletLabels: ['Tier', 'Trait Bonus', 'Evasion Bonus', 'Attack', 'Advantages', 'Examples']
          }),
          codexEntityId: bf.id
        }));
      });
    });
    if (!tray.children.length) buildEmptyNote(tray, 'No beastforms available.');
    panel.appendChild(tray);
    panels.beastforms = panel;
    section.appendChild(panel);
  }

  return section;
}

// --- Conditions --------------------------------------------------------
function buildConditionsSection(entity, cards, ctx, editable) {
  const section = buildSection('Conditions');
  const tray = buildTray();
  const conditions = cards.conditions || [];

  conditions.forEach(function (c) {
    const linked = c.entityId ? state.allEntities.find(function (e) { return e.id === c.entityId && canSee(e, ctx); }) : null;
    const controls = editable ? [{
      icon: '&times;', title: 'Remove', cls: 'ctl-remove',
      onClick: function () { patchCards(entity, { conditions: conditions.filter(function (x) { return x.id !== c.id; }) }); }
    }] : [];
    tray.appendChild(buildMiniCard({
      title: c.label,
      titleSuffix: c.note ? ('\u00d7' + c.note) : null,
      bodyMd: linked ? cleanCardMd(resolveEntityStatBlockMarkdown(linked, ctx, null)) : '',
      controls: controls,
      codexEntityId: linked ? linked.id : null
    }));
  });

  if (editable) {
    tray.appendChild(buildAddSlot('+ Add condition', function () {
      const candidates = state.allEntities.filter(function (e) {
        return e.category === 'Game Mechanics' && e.subtype === 'conditions' && (ctx.gmView || canSee(e, ctx));
      });
      openCardPickerPopup({
        title: 'Add condition',
        candidates: candidates,
        groupFn: null,
        customLabel: 'Custom condition',
        customExtraField: 'note',
        onSelect: function (e) {
          patchCards(entity, { conditions: conditions.concat([{ id: newLocalId(), entityId: e.id, label: e.name, note: '' }]) });
        },
        onCustom: function (name, qty, note) {
          patchCards(entity, { conditions: conditions.concat([{ id: newLocalId(), entityId: null, label: name, note: note || '' }]) });
        }
      });
    }));
  }
  if (!tray.children.length && !editable) buildEmptyNote(tray, 'No conditions.');
  section.appendChild(tray);
  return section;
}

// --- Equipment (formerly "Inventory") --------------------------------------
function equipmentCardOptsForLinked(e, ctx) {
  const details = e.details || {};
  if (e.subtype === 'weapons') {
    return {
      badge: details.tier ? ('T' + details.tier) : null, metaLines: weaponMetaLines(details),
      bodyMd: cleanCardMd(resolveEntityStatBlockMarkdown(e, ctx, null), {
        stripBulletLabels: ['Burden', 'Physical Or Magical', 'Primary Or Secondary', 'Range', 'Tier', 'Trait', 'Damage']
      })
    };
  }
  if (e.subtype === 'armor') {
    return {
      badge: details.tier ? ('T' + details.tier) : null, metaLines: armorMetaLines(details),
      bodyMd: cleanCardMd(resolveEntityStatBlockMarkdown(e, ctx, null), { stripBulletLabels: ['Tier', 'Base Score', 'Base Thresholds'] })
    };
  }
  // Items/Consumables: no templates.js schema at all -- text only.
  return { metaLines: [], bodyMd: cleanCardMd(stripLoneRollDetails(resolveEntityStatBlockMarkdown(e, ctx, null))) };
}
// Weapon/Armor slot ASSIGNMENT lives on the Sheet tab now (S17 follow-
// up) -- character-sheet.js's Equipped panel, to the right of the
// stats block. The per-card <select> that used to live here (commit 5)
// didn't have room on these cramped mini-cards and was confusing in
// practice; cards.equipment[i].slot itself is unchanged, just the
// control that sets it moved. This section stays read-only display of
// what's carried, same as Conditions/Experience.
function buildEquipmentSection(entity, cards, ctx, editable) {
  const cls = state.allEntities.find(function (e) { return e.id === cards.classId; });
  const d = cls ? (cls.details || {}) : {};
  const infoIcon = buildInfoPopup([
    d.suggested_armor ? ('Suggested Armor: ' + d.suggested_armor) : null,
    d.suggested_primary ? ('Suggested Primary: ' + d.suggested_primary) : null,
    d.suggested_secondary ? ('Suggested Secondary: ' + d.suggested_secondary) : null
  ], { title: 'Suggested equipment (from Class)' });
  const section = buildSection('Equipment', infoIcon);
  const tray = buildTray();
  const equipment = cards.equipment || [];

  equipment.forEach(function (it) {
    const linked = it.entityId ? state.allEntities.find(function (e) { return e.id === it.entityId && canSee(e, ctx); }) : null;
    const typeOpts = linked ? equipmentCardOptsForLinked(linked, ctx) : { metaLines: [], bodyMd: 'Custom item, no Codex entry.' };
    const controls = editable ? [{
      icon: '&times;', title: 'Remove', cls: 'ctl-remove',
      onClick: function () { patchCards(entity, { equipment: equipment.filter(function (x) { return x.id !== it.id; }) }); }
    }] : [];
    const miniCard = buildMiniCard(Object.assign({
      title: it.label,
      titleSuffix: it.qty && it.qty !== 1 ? ('\u00d7' + it.qty) : null,
      controls: controls,
      codexEntityId: linked ? linked.id : null,
      reorderId: editable ? it.id : null
    }, typeOpts));
    tray.appendChild(miniCard);
  });

  if (editable) {
    tray.appendChild(buildAddSlot('+ Add item', function () {
      const characterTier = tierForCharacterLevel(cards.level);
      const candidates = state.allEntities.filter(function (e) {
        if (e.category !== 'Equipment' || !(ctx.gmView || canSee(e, ctx))) return false;
        // Phase 14 S17: tier-gate on item.details.tier (Weapons/Armor
        // only -- other Equipment subtypes carry no tier at all and
        // stay unfiltered, same "absent = unfiltered" convention as
        // the ability level-gate above).
        const itemTier = parseInt(e.details && e.details.tier, 10);
        return !itemTier || itemTier <= characterTier;
      });
      openCardPickerPopup({
        title: 'Add item',
        candidates: candidates,
        groupFn: function (e) { return e.subtype ? (e.subtype.charAt(0).toUpperCase() + e.subtype.slice(1)) : 'Other'; },
        customLabel: 'Custom item',
        customExtraField: 'qty',
        onSelect: function (e) {
          patchCards(entity, { equipment: equipment.concat([{ id: newLocalId(), entityId: e.id, label: e.name, qty: 1 }]) });
        },
        onCustom: function (name, qty) {
          patchCards(entity, { equipment: equipment.concat([{ id: newLocalId(), entityId: null, label: name, qty: qty || 1 }]) });
        }
      });
    }));
  }
  if (!tray.children.length && !editable) buildEmptyNote(tray, 'No equipment.');
  if (editable) {
    enableCardReorder(tray, function (orderedIds) {
      const byId = {};
      equipment.forEach(function (e) { byId[e.id] = e; });
      patchCards(entity, { equipment: orderedIds.map(function (id) { return byId[id]; }).filter(Boolean) });
    });
  }
  section.appendChild(tray);
  return section;
}

// --- Top-level assembly ------------------------------------------------
export function buildDeckHeader(entity, ctx, editable) {
  const header = document.createElement('div');
  header.className = 'character-deck-header';
  const dot = document.createElement('span');
  dot.className = 'character-badge-dot';
  dot.style.background = entity.badgeColor || generateDefaultBadgeColor(entity.name);
  header.appendChild(dot);
  const h2 = document.createElement('h2');
  h2.textContent = entity.name;
  header.appendChild(h2);
  // Player view: "Edit in Codex" (Gregg's explicit ask) -- GM already
  // works out of the Codex tab directly, this is for a player's own
  // owned character so they don't have to hunt for it in the Table of
  // Contents. Same button/behavior as Map tab's GM-only "Edit in
  // Codex" (map.js) -- jumps to the Codex tab AND opens edit mode
  // there, doesn't unlock any inline editing on this card itself.
  // GM view: "View in Codex" in the same spot (S19) -- opens the
  // character's entry in VIEW mode, no edit mode entered (GM already
  // has the Codex tab's own Edit affordance once there if they want
  // it; this is a quick jump, not a shortcut into editing).
  if (!ctx.gmView && editable) {
    const editLink = document.createElement('button');
    editLink.type = 'button';
    editLink.className = 'entity-map-link timeline-edit-in-codex-link character-deck-edit-link';
    editLink.title = 'Edit in Codex';
    editLink.textContent = 'Edit in Codex';
    editLink.addEventListener('click', function () {
      switchToCodexTabForEntity(entity.id);
      enterEntityEditMode(entity);
    });
    header.appendChild(editLink);
  } else if (ctx.gmView) {
    const viewLink = document.createElement('button');
    viewLink.type = 'button';
    viewLink.className = 'entity-map-link timeline-edit-in-codex-link character-deck-edit-link';
    viewLink.title = 'View in Codex';
    viewLink.textContent = 'View in Codex';
    viewLink.addEventListener('click', function () { switchToCodexTabForEntity(entity.id); });
    header.appendChild(viewLink);
  }
  return header;
}

export function buildCharacterDeck(entity, ctx) {
  const editable = hasFullAuthority(entity, ctx);
  const cards = Object.assign({}, DEFAULT_CARDS, entity.cards || {});

  const wrap = document.createElement('div');
  wrap.className = 'character-deck';
  wrap.appendChild(buildSplitRow(
    buildHeritageSection(cards, ctx),
    buildConditionsSection(entity, cards, ctx, editable),
    { stateKey: 'characterDeckHeritageConditionsSplit', defaultFraction: 0.6 }
  ));
  wrap.appendChild(buildClassSection(entity, cards, ctx, editable));
  wrap.appendChild(buildAbilitiesSection(entity, cards, ctx, editable));
  wrap.appendChild(buildEquipmentSection(entity, cards, ctx, editable));
  return wrap;
}
