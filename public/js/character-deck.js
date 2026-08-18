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
import { firebaseApp } from './firebase.js';
import { state } from './state.js';
import { canSee, hasFullAuthority } from './visibility.js';
import { renderMarkdownInto } from './markdown.js';
import { trackWrite } from './connectivity.js';
import { generateDefaultBadgeColor } from './badge-color.js';
import { resolveEntityStatBlockMarkdown, switchToCodexTabForEntity, enterEntityEditMode } from './codex.js';
import {
  DEFAULT_CARDS, TIER_OPTIONS, normalizeAncestryIds, resolveFunctionalIds,
  cumulativeTierKeys, buildFloatingPickerPanel, openAbilityPickerPopup
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

// The mini parchment card itself -- opts: title, titleSuffix (qty/note,
// shown muted after the name), badge (Tier/Level, normalized to the
// card's own bottom-right corner across every type that has one),
// metaLines (array of strings, one per line, right under the name),
// bodyMd (markdown, rendered via the same renderer everything else in
// the app uses), controls (array of {icon,title,cls,onClick}, top-right
// corner), wide (spans the tray's full width -- used for Subclass).
function buildMiniCard(opts) {
  const card = document.createElement('div');
  card.className = 'character-deck-card' + (opts.wide ? ' wide' : '');
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
    card.appendChild(controls);
  }
  const h3 = document.createElement('h3');
  h3.appendChild(document.createTextNode(opts.title));
  if (opts.titleSuffix) {
    const span = document.createElement('span');
    span.className = 'character-deck-card-suffix';
    span.textContent = ' ' + opts.titleSuffix;
    h3.appendChild(span);
  }
  card.appendChild(h3);
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

// Experience add popup: no candidates, no search, no linking -- an
// Experience is always freeform (Name + Text), never Codex-backed, so
// this is a much simpler form than openCardPickerPopup's linked-or-
// custom flow, not a variant of it.
function openExperiencePickerPopup(onAdd) {
  if (document.querySelector('.entity-picker-panel')) return;
  const built = buildFloatingPickerPanel();
  built.header.textContent = 'Add experience';

  const nameInput = document.createElement('input');
  nameInput.type = 'text';
  nameInput.placeholder = 'Experience name';
  built.body.appendChild(nameInput);

  const textInput = document.createElement('textarea');
  textInput.placeholder = 'Experience text';
  textInput.rows = 3;
  built.body.appendChild(textInput);

  const confirmBtn = document.createElement('button');
  confirmBtn.type = 'button';
  confirmBtn.textContent = 'Add';
  confirmBtn.addEventListener('click', function () {
    const name = nameInput.value.trim();
    if (!name) return;
    onAdd(name, textInput.value.trim());
    close();
  });
  built.body.appendChild(confirmBtn);

  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.textContent = 'Cancel';
  cancelBtn.addEventListener('click', close);
  built.body.appendChild(cancelBtn);

  nameInput.focus();
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
          bodyMd: resolveEntityStatBlockMarkdown(anc, ctx, pair[0])
        }));
      });
    }
  } else if (functionalIds.length === 2) {
    functionalIds.forEach(function (fid, i) {
      const anc = state.allEntities.find(function (e) { return e.id === fid; });
      if (!anc) return;
      const group = picks[fid] || (i === 0 ? 'first' : 'second');
      tray.appendChild(buildMiniCard({ title: anc.name, bodyMd: resolveEntityStatBlockMarkdown(anc, ctx, group) }));
    });
  }

  const community = state.allEntities.find(function (e) { return e.id === cards.communityId; });
  if (community) {
    tray.appendChild(buildMiniCard({ title: community.name, bodyMd: resolveEntityStatBlockMarkdown(community, ctx, null) }));
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
  const tray = buildTray();

  if (cls) {
    const d = cls.details || {};
    const metaLines = (d.evasion || d.hp) ? ['Evasion ' + (d.evasion || '\u2014') + ' \u00b7 HP ' + (d.hp || '\u2014')] : [];
    tray.appendChild(buildMiniCard({ title: cls.name, metaLines: metaLines, bodyMd: resolveEntityStatBlockMarkdown(cls, ctx, null) }));
  }
  if (subclass) {
    const tierKey = cards.subclassTier || 'foundation';
    const tierLabel = TIER_OPTIONS.find(function (t) { return t.key === tierKey; });
    tray.appendChild(buildMiniCard({
      title: subclass.name,
      wide: true,
      metaLines: ['Through ' + (tierLabel ? tierLabel.label : '')],
      bodyMd: resolveEntityStatBlockMarkdown(subclass, ctx, cumulativeTierKeys(tierKey))
    }));
  }

  if (!tray.children.length) buildEmptyNote(tray, 'No class set.');
  section.appendChild(tray);
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
      bodyMd: resolveEntityStatBlockMarkdown(a, ctx, null),
      controls: controls
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
        const candidates = abilitiesVisible.filter(function (a) {
          if (abilityIds.indexOf(a.id) !== -1) return false;
          if (!selectedClass) return true;
          const dom = a.details && a.details.domain;
          return !dom || dom === d.domain_1 || dom === d.domain_2 || (a.visibility === 'character' && a.characterId === entity.id);
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
      tray.appendChild(buildMiniCard({ title: exp.name, bodyMd: exp.text, controls: controls }));
    });
    if (editable) {
      tray.appendChild(buildAddSlot('+ Add experience', function () {
        openExperiencePickerPopup(function (name, text) {
          patchCards(entity, { experiences: experiences.concat([{ id: newLocalId(), name: name, text: text }]) });
        });
      }));
    }
    if (!tray.children.length && !editable) buildEmptyNote(tray, 'No experiences.');
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
          bodyMd: resolveEntityStatBlockMarkdown(bf, ctx, null)
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
      bodyMd: linked ? resolveEntityStatBlockMarkdown(linked, ctx, null) : '',
      controls: controls
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
    return { badge: details.tier ? ('T' + details.tier) : null, metaLines: weaponMetaLines(details), bodyMd: resolveEntityStatBlockMarkdown(e, ctx, null) };
  }
  if (e.subtype === 'armor') {
    return { badge: details.tier ? ('T' + details.tier) : null, metaLines: armorMetaLines(details), bodyMd: resolveEntityStatBlockMarkdown(e, ctx, null) };
  }
  // Items/Consumables: no templates.js schema at all -- text only.
  return { metaLines: [], bodyMd: stripLoneRollDetails(resolveEntityStatBlockMarkdown(e, ctx, null)) };
}
function buildEquipmentSection(entity, cards, ctx, editable) {
  const section = buildSection('Equipment');
  const tray = buildTray();
  const equipment = cards.equipment || [];

  equipment.forEach(function (it) {
    const linked = it.entityId ? state.allEntities.find(function (e) { return e.id === it.entityId && canSee(e, ctx); }) : null;
    const typeOpts = linked ? equipmentCardOptsForLinked(linked, ctx) : { metaLines: [], bodyMd: 'Custom item, no Codex entry.' };
    const controls = editable ? [{
      icon: '&times;', title: 'Remove', cls: 'ctl-remove',
      onClick: function () { patchCards(entity, { equipment: equipment.filter(function (x) { return x.id !== it.id; }) }); }
    }] : [];
    tray.appendChild(buildMiniCard(Object.assign({
      title: it.label,
      titleSuffix: it.qty && it.qty !== 1 ? ('\u00d7' + it.qty) : null,
      controls: controls
    }, typeOpts)));
  });

  if (editable) {
    tray.appendChild(buildAddSlot('+ Add item', function () {
      const candidates = state.allEntities.filter(function (e) { return e.category === 'Equipment' && (ctx.gmView || canSee(e, ctx)); });
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
  section.appendChild(tray);
  return section;
}

// --- Top-level assembly ------------------------------------------------
function buildDeckHeader(entity, ctx, editable) {
  const header = document.createElement('div');
  header.className = 'character-deck-header';
  const dot = document.createElement('span');
  dot.className = 'character-badge-dot';
  dot.style.background = entity.badgeColor || generateDefaultBadgeColor(entity.name);
  header.appendChild(dot);
  const h2 = document.createElement('h2');
  h2.textContent = entity.name;
  header.appendChild(h2);
  // Player view only (Gregg's explicit ask) -- GM already works out of
  // the Codex tab directly, this is for a player's own owned character
  // so they don't have to hunt for it in the Table of Contents. Same
  // button/behavior as Map tab's GM-only "Edit in Codex" (map.js) --
  // jumps to the Codex tab AND opens edit mode there, doesn't unlock
  // any inline editing on this card itself.
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
  }
  return header;
}

export function buildCharacterDeck(entity, ctx) {
  const editable = hasFullAuthority(entity, ctx);
  const cards = Object.assign({}, DEFAULT_CARDS, entity.cards || {});

  const wrap = document.createElement('div');
  wrap.className = 'character-deck';
  wrap.appendChild(buildDeckHeader(entity, ctx, editable));
  wrap.appendChild(buildHeritageSection(cards, ctx));
  wrap.appendChild(buildClassSection(entity, cards, ctx, editable));
  wrap.appendChild(buildAbilitiesSection(entity, cards, ctx, editable));
  wrap.appendChild(buildConditionsSection(entity, cards, ctx, editable));
  wrap.appendChild(buildEquipmentSection(entity, cards, ctx, editable));
  return wrap;
}
