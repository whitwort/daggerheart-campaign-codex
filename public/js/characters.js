// characters.js — Phase 14 S5. The Characters tab: GM left-rail PC
// flipper + ownerId assignment management, player own-character list/
// create/delete + card-slot editor (ancestry/community/class/subclass+
// tier/abilities), badgeColor picker, and the player-side "Request
// transfer" flow on unowned-but-visible PCs (transferRequests writes).
//
// The GM's FULL transferRequests collection listener (unfiltered --
// needed for the unified Requests queue) lives in admin.js beside
// joinRequests, per Gregg's placement call: extend the existing Admin
// tab section + its nav badge, not a separate nav element. This module
// only owns the player-scoped "my own pending requests" listener
// (state.myTransferRequests, `where toEmail==self` -- an unfiltered
// collection listener would be rules-denied for a non-GM, same reason
// joinRequests/players are GM-only collection reads elsewhere in this
// app) -- used here to gray out an already-requested "Request transfer"
// button.
//
// "GM view" shows that character's player-perspective card view (§6.4):
// deliberately NOT built by re-invoking the Codex tab's own stateful
// renderEntityViewCard with a synthesized ctx -- that component owns
// several genuinely singular pieces of global state (state.selectedId,
// state.detailActiveTab, state.loreEdit/noteEdit, and critically
// state.entityImagesTargetId/currentEntityImages, which is a single live
// Firestore query pointed at ONE entity's images at a time). Two
// simultaneously-mounted instances -- the real Codex tab selection and
// this flipper's preview -- would fight over that single per-entity
// image listener the moment both are on screen, which they can be (tab
// panels hide via CSS, not by unmounting). Instead this module builds
// its own smaller, fully self-contained read-only preview (lore list
// only, no Gallery/Notes/edit chrome, own local canSee filtering against
// a synthesized ctx) -- see renderCharacterPlayerEyeView. Flagged as a
// deliberate simplification, not an oversight -- see handoff.

import {
  getFirestore, doc, collection, addDoc, deleteDoc, updateDoc, setDoc,
  onSnapshot, query, where, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import { firebaseApp } from './firebase.js';
import { state } from './state.js';
import { attachListener, detachListener, safeSnapshotHandler } from './listeners.js';
import { trackWrite } from './connectivity.js';
import { canSee, viewerContext, hasFullAuthority, belongsOnLoreSurface } from './visibility.js';
import { switchToCodexTabForEntity, applyWikiLinks } from './codex.js';
import { getTemplateSchema, humanizeKey } from './templates.js';
import { renderMarkdownInto } from './markdown.js';

const db = getFirestore(firebaseApp);

// Kept in sync with the copy in codex.js/srd-import.js -- small, not
// worth a shared-utils module split, same convention as humanizeKey.
function slugify(name) {
  return name.toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function byName(a, b) { return (a.name || '').localeCompare(b.name || ''); }

const charactersGmViewEl = document.getElementById('characters-gm-view');
const charactersPlayerViewEl = document.getElementById('characters-player-view');
const charactersFlipperListEl = document.getElementById('characters-flipper-list');
const charactersDetailPaneEl = document.getElementById('characters-detail-pane');
const charactersPlayerOwnListEl = document.getElementById('characters-player-own-list');
const charactersNewBtnEl = document.getElementById('characters-new-btn');
const charactersNewFormEl = document.getElementById('characters-new-form');
const charactersNewNameEl = document.getElementById('characters-new-name');
const charactersNewSaveBtnEl = document.getElementById('characters-new-save-btn');
const charactersNewCancelBtnEl = document.getElementById('characters-new-cancel-btn');
const charactersNewErrorEl = document.getElementById('characters-new-error');
const charactersPlayerSelectedEl = document.getElementById('characters-player-selected');
const charactersPlayerAvailableListEl = document.getElementById('characters-player-available-list');

// --- transferRequests: player-scoped listener (own requests only) --------
function attachCharacterTransferListeners() {
  const email = state.currentUser && state.currentUser.email;
  if (!email) return;
  attachListener('myTransferRequestsUnsub', function () {
    return onSnapshot(
      query(collection(db, 'transferRequests'), where('toEmail', '==', email)),
      safeSnapshotHandler('myTransferRequests', function (snapshot) {
        state.myTransferRequests = [];
        snapshot.forEach(function (docSnap) {
          state.myTransferRequests.push(Object.assign({ id: docSnap.id }, docSnap.data()));
        });
        renderCharactersTab();
      }),
      function (err) { console.error('myTransferRequests listener failed:', err.message); }
    );
  });
}
function detachCharacterTransferListeners() {
  detachListener('myTransferRequestsUnsub');
}

// --- Card-slot stat display (§6.4: "linked entity's existing template
// display, tier-scoped for subclass via featureGroups") -- own compact
// Details+Features markdown builder, NOT a reuse of buildEntityPreviewCard
// (that shows only the entity's first raw loreItem verbatim, never the
// resolveLoreItemMarkdown-synthesized Details/Features view -- it would
// silently show nothing for a templated Ancestry/Class/Subclass with no
// free-text lore item of its own). tierFilter, when given, restricts
// features to that featureGroups key (subclass tier-scoping, D7) --
// otherwise every feature renders (ancestry/community/class, none of
// which are tiered).
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
    ? feats.filter(function (f) { return f.group === tierFilter; })
    : feats;
  const featLines = relevantFeats.map(function (f) { return '**' + f.name + '.** ' + f.text; });
  const blocks = [];
  if (lines.length) blocks.push(lines.join('\n'));
  if (featLines.length) blocks.push(featLines.join('\n\n'));
  return blocks.join('\n\n');
}

function buildCardSlot(entity, opts) {
  const wrap = document.createElement('div');
  wrap.className = 'character-card-slot';
  if (!entity) {
    const none = document.createElement('p');
    none.className = 'lore-empty';
    none.textContent = '\u2014 none selected \u2014';
    wrap.appendChild(none);
    return wrap;
  }
  const nameBtn = document.createElement('button');
  nameBtn.type = 'button';
  nameBtn.className = 'character-name-chip';
  nameBtn.textContent = entity.name;
  nameBtn.title = 'Open in Codex';
  nameBtn.addEventListener('click', function () { switchToCodexTabForEntity(entity.id); });
  wrap.appendChild(nameBtn);
  const md = slotStatMarkdown(entity, opts && opts.tier);
  if (md) {
    const body = document.createElement('div');
    body.className = 'character-card-slot-body';
    renderMarkdownInto(body, md);
    wrap.appendChild(body);
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

// Abilities: multi-select, add-one-at-a-time list+picker, same UX pattern
// as codex.js's buildRelatedEditor (Related entries) -- the add-select is
// additionally grouped into <optgroup>s by the ability's `domain` detail
// key (Game Mechanics/abilities schema, templates.js) since that's how
// players actually browse Daggerheart's ability list at the table.
function buildAbilitiesPicker(cards, abilityEntities, onChange) {
  const wrap = document.createElement('div');
  wrap.className = 'entity-edit-field';
  const label = document.createElement('label');
  label.textContent = 'Abilities (aim for at least 2)';
  wrap.appendChild(label);

  const abilityIds = cards.abilityIds || [];
  const list = document.createElement('ul');
  list.className = 'related-edit-list';
  abilityIds.forEach(function (id) {
    const a = abilityEntities.find(function (e) { return e.id === id; });
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
  addRow.className = 'related-edit-add';
  const select = document.createElement('select');
  const available = abilityEntities.filter(function (e) { return abilityIds.indexOf(e.id) === -1; });
  if (!available.length) {
    const opt = document.createElement('option');
    opt.textContent = '(no more abilities to add)';
    opt.disabled = true;
    select.appendChild(opt);
  } else {
    const byDomain = {};
    available.forEach(function (e) {
      const dom = (e.details && e.details.domain) || 'Other';
      (byDomain[dom] = byDomain[dom] || []).push(e);
    });
    Object.keys(byDomain).sort().forEach(function (dom) {
      const group = document.createElement('optgroup');
      group.label = dom;
      byDomain[dom].sort(byName).forEach(function (e) {
        const opt = document.createElement('option');
        opt.value = e.id;
        opt.textContent = e.name;
        group.appendChild(opt);
      });
      select.appendChild(group);
    });
  }
  const addBtn = document.createElement('button');
  addBtn.type = 'button';
  addBtn.textContent = 'Add';
  addBtn.addEventListener('click', function () {
    const id = select.value;
    if (!id || abilityIds.indexOf(id) !== -1) return;
    onChange(abilityIds.concat([id]));
  });
  addRow.appendChild(select);
  addRow.appendChild(addBtn);
  wrap.appendChild(addRow);
  return wrap;
}

const DEFAULT_CARDS = {
  ancestryId: null, communityId: null, classId: null, subclassId: null,
  subclassTier: 'foundation', abilityIds: []
};
// Single source of truth for tier keys/labels: the same featureGroups
// the subclass template schema already defines (templates.js) -- falls
// back to the same three if that schema is ever removed/renamed.
const TIER_OPTIONS = (function () {
  const schema = getTemplateSchema('Game Mechanics', 'subclasses');
  return (schema && schema.featureGroups) || [
    { key: 'foundation', label: 'Foundation' },
    { key: 'mastery', label: 'Mastery' },
    { key: 'specialization', label: 'Specialization' }
  ];
})();

function saveCardsPatch(entity, patch) {
  const cards = Object.assign({}, DEFAULT_CARDS, entity.cards || {}, patch);
  trackWrite(
    updateDoc(doc(db, 'entities', entity.id), { cards: cards, updatedAt: serverTimestamp() }),
    'Saving character card'
  ).catch(function (err) { window.alert('Save failed: ' + err.message); });
}

// Editable card-slot editor. ctx must be the REAL viewer's ctx (never a
// synthesized one) -- edit authority is always the actual person at the
// keyboard, never a preview identity. Callers (GM flipper's own detail
// pane; a player's own-character selection) already only reach this when
// hasFullAuthority is true; the check here is a defensive backstop, not
// the primary gate.
function buildCardSlotEditor(entity, ctx) {
  const wrap = document.createElement('div');
  wrap.className = 'character-card-editor';
  if (!hasFullAuthority(entity, ctx)) return wrap;

  const cards = Object.assign({}, DEFAULT_CARDS, entity.cards || {});
  const visible = function (e) { return ctx.gmView || canSee(e, ctx); };
  const ancestries = state.allEntities.filter(function (e) { return e.category === 'Ancestry' && visible(e); }).sort(byName);
  const communities = state.allEntities.filter(function (e) { return e.category === 'Community' && visible(e); }).sort(byName);
  const classes = state.allEntities.filter(function (e) { return e.category === 'Game Mechanics' && e.subtype === 'classes' && visible(e); }).sort(byName);
  const subclasses = state.allEntities.filter(function (e) { return e.category === 'Game Mechanics' && e.subtype === 'subclasses' && visible(e); }).sort(byName);
  const abilities = state.allEntities.filter(function (e) { return e.category === 'Game Mechanics' && e.subtype === 'abilities' && visible(e); });

  wrap.appendChild(buildSingleEntityPicker('Ancestry', ancestries, cards.ancestryId,
    function (v) { saveCardsPatch(entity, { ancestryId: v }); }));
  wrap.appendChild(buildCardSlot(ancestries.find(function (e) { return e.id === cards.ancestryId; })));

  wrap.appendChild(buildSingleEntityPicker('Community', communities, cards.communityId,
    function (v) { saveCardsPatch(entity, { communityId: v }); }));
  wrap.appendChild(buildCardSlot(communities.find(function (e) { return e.id === cards.communityId; })));

  wrap.appendChild(buildSingleEntityPicker('Class', classes, cards.classId,
    function (v) { saveCardsPatch(entity, { classId: v }); }));
  wrap.appendChild(buildCardSlot(classes.find(function (e) { return e.id === cards.classId; })));

  wrap.appendChild(buildSingleEntityPicker('Subclass', subclasses, cards.subclassId,
    function (v) { saveCardsPatch(entity, { subclassId: v }); }));
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
  tierSelect.addEventListener('change', function () { saveCardsPatch(entity, { subclassTier: tierSelect.value }); });
  tierWrap.appendChild(tierSelect);
  wrap.appendChild(tierWrap);
  wrap.appendChild(buildCardSlot(subclasses.find(function (e) { return e.id === cards.subclassId; }), { tier: cards.subclassTier }));

  wrap.appendChild(buildAbilitiesPicker(cards, abilities, function (ids) { saveCardsPatch(entity, { abilityIds: ids }); }));
  const abilityCardsWrap = document.createElement('div');
  cards.abilityIds.forEach(function (id) {
    const a = abilities.find(function (e) { return e.id === id; });
    if (a) abilityCardsWrap.appendChild(buildCardSlot(a));
  });
  wrap.appendChild(abilityCardsWrap);

  return wrap;
}

// Owner-picked badge color (D3/S4's badge mechanism gains its picker
// here -- every badge rendered seafoam-fallback until this session).
// Palette is the app's own existing --cat-* category accent family
// (styles.css) -- already a curated, visually distinct 12-hue set that
// matches the established aesthetic, not a new ad-hoc palette.
const BADGE_COLORS = [
  '#6E8E7A', '#B0785A', '#C2A24D', '#7A6C9E', '#9A5F6B', '#5E8296',
  '#8C8072', '#7C7A45', '#5A7690', '#8E6A4F', '#5C5A66', '#4F7A6E'
];

function buildBadgeColorPicker(entity) {
  const wrap = document.createElement('div');
  wrap.className = 'entity-edit-field';
  const label = document.createElement('label');
  label.textContent = 'Badge color';
  wrap.appendChild(label);
  const row = document.createElement('div');
  row.className = 'character-badge-swatch-row';
  BADGE_COLORS.forEach(function (color) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'character-badge-swatch';
    if ((entity.badgeColor || '') === color) btn.classList.add('selected');
    btn.style.background = color;
    btn.title = color;
    btn.addEventListener('click', function () {
      trackWrite(
        updateDoc(doc(db, 'entities', entity.id), { badgeColor: color, updatedAt: serverTimestamp() }),
        'Saving badge color'
      ).catch(function (err) { window.alert('Save failed: ' + err.message); });
    });
    row.appendChild(btn);
  });
  wrap.appendChild(row);
  return wrap;
}

// GM-only: reassign/unassign ownerId on an already-owned PC. This is the
// "assignment management" half of §6.4's GM view -- ownerId was already
// settable via the general Codex-tab inline entity-edit form (unchanged,
// still works); this is a Characters-tab-local convenience so the GM
// doesn't have to leave the flipper to do it, per the design's explicit
// "absorbing the Admin party-table's character column" language (the
// Admin table's old read-only Characters column is removed this session
// -- see admin.js -- since this view now both shows and manages it).
function buildOwnerReassignSelect(entity) {
  const wrap = document.createElement('div');
  wrap.className = 'entity-edit-field';
  const label = document.createElement('label');
  label.textContent = 'Owned by party member';
  wrap.appendChild(label);
  const select = document.createElement('select');
  const noneOpt = document.createElement('option');
  noneOpt.value = '';
  noneOpt.textContent = '-- unassign --';
  select.appendChild(noneOpt);
  state.allPlayers.slice().sort(function (a, b) { return a.id.localeCompare(b.id); }).forEach(function (p) {
    const opt = document.createElement('option');
    opt.value = p.id;
    opt.textContent = p.displayName ? (p.displayName + ' (' + p.id + ')') : p.id;
    select.appendChild(opt);
  });
  select.value = entity.ownerId || '';
  select.addEventListener('change', function () {
    const newOwner = select.value || null;
    trackWrite(
      updateDoc(doc(db, 'entities', entity.id), { ownerId: newOwner, updatedAt: serverTimestamp() }),
      'Reassigning character'
    ).catch(function (err) { window.alert('Save failed: ' + err.message); });
    if (!newOwner) state.charactersSelectedId = null; // drops out of the PC flipper once the entities snapshot lands
  });
  wrap.appendChild(select);
  return wrap;
}

// Read-only "as the owner currently sees it" preview (§6.4) -- see the
// module header comment for why this is a small self-contained renderer
// rather than a second mount of the Codex tab's stateful detail card.
// Lore only (D5: notes are private by construction, nothing to preview
// there; Gallery is a possible follow-up, not built this session).
function renderCharacterPlayerEyeView(container, entity) {
  const syntheticCtx = {
    role: 'player', gmView: false, email: entity.ownerId,
    activeCharacterId: entity.id, ownedCharacterIds: [entity.id]
  };
  const heading = document.createElement('h4');
  heading.textContent = 'As ' + (entity.ownerId || 'the owner') + ' currently sees it';
  container.appendChild(heading);
  const items = state.allLoreItems
    .filter(function (it) { return it.entityId === entity.id && belongsOnLoreSurface(it) && canSee(it, syntheticCtx); })
    .sort(function (a, b) { return (a.order || 0) - (b.order || 0); });
  if (!items.length) {
    const p = document.createElement('p');
    p.className = 'lore-empty';
    p.textContent = 'No lore visible to this character yet.';
    container.appendChild(p);
    return;
  }
  items.forEach(function (item) {
    const div = document.createElement('div');
    div.className = 'lore-item';
    const bodyDiv = document.createElement('div');
    bodyDiv.className = 'lore-item-body';
    renderMarkdownInto(bodyDiv, item.content).then(function () {
      applyWikiLinks(bodyDiv, entity.id, syntheticCtx);
    });
    div.appendChild(bodyDiv);
    container.appendChild(div);
  });
}

// --- GM view ---------------------------------------------------------
function renderCharactersGmView(ctx) {
  charactersFlipperListEl.innerHTML = '';
  const owned = state.allEntities.filter(function (e) { return e.category === 'Character' && e.ownerId; });

  if (!owned.length) {
    const p = document.createElement('p');
    p.className = 'lore-empty';
    p.textContent = 'No characters assigned to party members yet.';
    charactersFlipperListEl.appendChild(p);
  } else {
    const byPlayer = {};
    owned.forEach(function (e) { (byPlayer[e.ownerId] = byPlayer[e.ownerId] || []).push(e); });
    Object.keys(byPlayer).sort(function (a, b) {
      const pa = state.allPlayers.find(function (p) { return p.id === a; });
      const pb = state.allPlayers.find(function (p) { return p.id === b; });
      return ((pa && pa.displayName) || a).localeCompare((pb && pb.displayName) || b);
    }).forEach(function (email) {
      const player = state.allPlayers.find(function (p) { return p.id === email; });
      const groupLabel = document.createElement('div');
      groupLabel.className = 'characters-flipper-group-label';
      groupLabel.textContent = (player && player.displayName) || email;
      charactersFlipperListEl.appendChild(groupLabel);
      byPlayer[email].sort(byName).forEach(function (e) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'characters-flipper-item';
        if (e.id === state.charactersSelectedId) btn.classList.add('selected');
        btn.textContent = e.name;
        btn.addEventListener('click', function () {
          state.charactersSelectedId = e.id;
          renderCharactersTab();
        });
        charactersFlipperListEl.appendChild(btn);
      });
    });
  }

  charactersDetailPaneEl.innerHTML = '';
  const selected = owned.find(function (e) { return e.id === state.charactersSelectedId; });
  if (!selected) {
    const p = document.createElement('p');
    p.className = 'lore-empty';
    p.textContent = "Select a party member's character.";
    charactersDetailPaneEl.appendChild(p);
    return;
  }
  const heading = document.createElement('h3');
  heading.textContent = selected.name;
  charactersDetailPaneEl.appendChild(heading);
  charactersDetailPaneEl.appendChild(buildOwnerReassignSelect(selected));
  charactersDetailPaneEl.appendChild(buildBadgeColorPicker(selected));
  charactersDetailPaneEl.appendChild(buildCardSlotEditor(selected, ctx));
  const eyeView = document.createElement('div');
  eyeView.className = 'character-player-eye-view';
  renderCharacterPlayerEyeView(eyeView, selected);
  charactersDetailPaneEl.appendChild(eyeView);
}

// --- Player view -------------------------------------------------------
function renderCharactersPlayerView(ctx) {
  const own = state.allEntities
    .filter(function (e) { return e.category === 'Character' && e.ownerId === ctx.email; })
    .sort(byName);

  charactersPlayerOwnListEl.innerHTML = '';
  if (!own.length) {
    const p = document.createElement('p');
    p.className = 'lore-empty';
    p.textContent = 'No characters yet -- create one below.';
    charactersPlayerOwnListEl.appendChild(p);
  } else {
    own.forEach(function (e) {
      const row = document.createElement('div');
      row.className = 'characters-flipper-item characters-own-row';
      if (e.id === state.charactersSelectedId) row.classList.add('selected');
      const nameBtn = document.createElement('button');
      nameBtn.type = 'button';
      nameBtn.className = 'character-name-chip';
      nameBtn.textContent = e.name;
      nameBtn.addEventListener('click', function () { state.charactersSelectedId = e.id; renderCharactersTab(); });
      row.appendChild(nameBtn);
      if (e.id === state.activeCharacterId) {
        const activeLabel = document.createElement('span');
        activeLabel.className = 'characters-active-label';
        activeLabel.textContent = 'Active';
        row.appendChild(activeLabel);
      } else {
        const setActiveBtn = document.createElement('button');
        setActiveBtn.type = 'button';
        setActiveBtn.className = 'action-btn-compact';
        setActiveBtn.textContent = 'Set active';
        setActiveBtn.addEventListener('click', function () {
          trackWrite(updateDoc(doc(db, 'players', ctx.email), { activeCharacterId: e.id }), 'Setting active character')
            .catch(function (err) { window.alert('Save failed: ' + err.message); });
        });
        row.appendChild(setActiveBtn);
      }
      charactersPlayerOwnListEl.appendChild(row);
    });
  }

  charactersPlayerSelectedEl.innerHTML = '';
  const selected = own.find(function (e) { return e.id === state.charactersSelectedId; });
  if (selected) {
    const heading = document.createElement('h3');
    heading.textContent = selected.name;
    charactersPlayerSelectedEl.appendChild(heading);
    charactersPlayerSelectedEl.appendChild(buildBadgeColorPicker(selected));
    charactersPlayerSelectedEl.appendChild(buildCardSlotEditor(selected, ctx));
    const deleteBtn = document.createElement('button');
    deleteBtn.type = 'button';
    deleteBtn.className = 'action-btn-compact';
    deleteBtn.textContent = 'Delete character';
    deleteBtn.addEventListener('click', function () {
      const confirmed = window.confirm('Delete ' + selected.name + '? This cannot be undone.');
      if (!confirmed) return;
      deleteDoc(doc(db, 'entities', selected.id)).catch(function (err) { window.alert('Delete failed: ' + err.message); });
      state.charactersSelectedId = null;
    });
    charactersPlayerSelectedEl.appendChild(deleteBtn);
  }

  // "Available characters" (§6.4): unowned Character entities the GM has
  // made visible (canSee) -- ownerId==null alone doesn't distinguish an
  // NPC from an adoptable PC in this schema (no separate flag), so
  // visibility is the de facto gate: a GM who wants a PC discoverable for
  // transfer request simply shares it, same as any other lore element;
  // an NPC left gm-only (the default) never surfaces here. Documented
  // interpretation -- see handoff.
  const available = state.allEntities
    .filter(function (e) { return e.category === 'Character' && !e.ownerId && canSee(e, ctx); })
    .sort(byName);
  charactersPlayerAvailableListEl.innerHTML = '';
  if (!available.length) {
    const p = document.createElement('p');
    p.className = 'lore-empty';
    p.textContent = 'None right now.';
    charactersPlayerAvailableListEl.appendChild(p);
  } else {
    available.forEach(function (e) {
      const row = document.createElement('div');
      row.className = 'characters-flipper-item';
      const nameBtn = document.createElement('button');
      nameBtn.type = 'button';
      nameBtn.className = 'character-name-chip';
      nameBtn.textContent = e.name;
      nameBtn.addEventListener('click', function () { switchToCodexTabForEntity(e.id); });
      row.appendChild(nameBtn);
      const pendingReq = state.myTransferRequests.find(function (r) { return r.characterId === e.id; });
      const reqBtn = document.createElement('button');
      reqBtn.type = 'button';
      reqBtn.className = 'action-btn-compact';
      reqBtn.textContent = pendingReq ? 'Cancel request' : 'Request transfer';
      reqBtn.addEventListener('click', function () {
        if (pendingReq) {
          deleteDoc(doc(db, 'transferRequests', pendingReq.id)).catch(function (err) { window.alert('Cancel failed: ' + err.message); });
        } else {
          addDoc(collection(db, 'transferRequests'), { characterId: e.id, toEmail: ctx.email, requestedAt: serverTimestamp() })
            .catch(function (err) { window.alert('Request failed: ' + err.message); });
        }
      });
      row.appendChild(reqBtn);
      charactersPlayerAvailableListEl.appendChild(row);
    });
  }
}

// --- Dispatch + "+ New character" --------------------------------------
function renderCharactersTab() {
  const ctx = viewerContext();
  charactersGmViewEl.style.display = ctx.gmView ? '' : 'none';
  charactersPlayerViewEl.style.display = ctx.gmView ? 'none' : '';
  if (ctx.gmView) {
    renderCharactersGmView(ctx);
    return;
  }
  if (state.charactersSelectedId) {
    const stillOwn = state.allEntities.some(function (e) {
      return e.id === state.charactersSelectedId && e.category === 'Character' && e.ownerId === ctx.email;
    });
    if (!stillOwn) state.charactersSelectedId = null;
  }
  renderCharactersPlayerView(ctx);
}

function ensureCharactersTabReady() {
  renderCharactersTab();
}

if (charactersNewBtnEl) {
  charactersNewBtnEl.addEventListener('click', function () {
    charactersNewFormEl.style.display = 'block';
    charactersNewErrorEl.textContent = '';
    charactersNewNameEl.value = '';
    charactersNewNameEl.focus();
  });
  charactersNewCancelBtnEl.addEventListener('click', function () {
    charactersNewFormEl.style.display = 'none';
  });
  charactersNewSaveBtnEl.addEventListener('click', function () {
    const ctx = viewerContext();
    const name = charactersNewNameEl.value.trim();
    charactersNewErrorEl.textContent = '';
    if (!name) { charactersNewErrorEl.textContent = 'Name is required.'; return; }
    if (!ctx.email) return;
    charactersNewSaveBtnEl.disabled = true;
    const newId = doc(collection(db, 'entities')).id;
    // Mirrors codex.js's saveNewEntity default shape, plus the Phase 14
    // Character-only fields (ownerId/badgeColor/cards) and the
    // characterId/characterShared/mapImageVisibleToPlayers triple every
    // entity now carries (§3.1). visibility defaults gm-only, same
    // literal-default convention as every other new-entity write in this
    // app (sharing.js's header comment) -- the owner still sees their own
    // brand-new PC regardless, via canSee's own-Character grant.
    const entityData = {
      slug: slugify(name), name: name, category: 'Character',
      ancestry: null, subtype: '', aliases: [], date: null, dateSort: null,
      dateEnd: null, dateEndSort: null, parentId: null, relatedIds: [],
      visibility: 'gm-only', characterId: null, characterShared: false,
      hasMapImage: false, mapImageVisibleToPlayers: false, tags: [], sourceId: null,
      useTemplate: false, details: {}, features: [], searchIndex: [],
      ownerId: ctx.email, badgeColor: null,
      cards: Object.assign({}, DEFAULT_CARDS),
      createdAt: serverTimestamp(), updatedAt: serverTimestamp()
    };
    trackWrite(setDoc(doc(db, 'entities', newId), entityData), 'Creating character').catch(function (err) {
      window.alert('Create failed: ' + err.message);
    });
    charactersNewSaveBtnEl.disabled = false;
    charactersNewFormEl.style.display = 'none';
    state.charactersSelectedId = newId;
    // Convenience default: a player's very first character becomes their
    // active one automatically. Never overrides an already-set active
    // character (no silent mid-session switch away from what they're
    // currently playing).
    if (!state.activeCharacterId) {
      updateDoc(doc(db, 'players', ctx.email), { activeCharacterId: newId }).catch(function () {});
    }
  });
}

// NOTE: this module deliberately does NOT call
// registerVisibilityChangeHandler(renderCharactersTab) at its own top
// level, unlike map.js/timeline.js's equivalent registrations. codex.js
// -> admin.js -> characters.js -> codex.js is a real import cycle (this
// module imports switchToCodexTabForEntity/applyWikiLinks from codex.js;
// admin.js now imports renderCharactersTab from this module to feed the
// unified Requests queue re-render). A top-level call back into codex.js
// here would run WHILE codex.js's own module body is still mid-
// evaluation further up that same cycle (codex.js hasn't reached its
// `const visibilityChangeHandlers = []` yet) -- a live ReferenceError
// (TDZ), not a hypothetical. main.js sits outside the cycle and only
// runs its own top-level code after every static import has FULLY
// resolved, so it's the safe place for this registration -- see main.js.
export { ensureCharactersTabReady, renderCharactersTab, attachCharacterTransferListeners, detachCharacterTransferListeners };
