// Admin > Data > Export Lore. Three export modes (Selected Entries /
// Character / All Party Visible) x four formats (JSON / Markdown /
// Word / PDF). Built for GM use here, but the mode+format+resolution
// logic is deliberately viewer-ctx-driven (not "GM sees everything"
// hardcoded) so a future player-facing reuse only needs a different
// entry point into resolveExportContext(), not a rewrite.
//
// Visibility is never re-implemented here -- every mode resolves down
// to a viewerContext()-shaped ctx object fed straight into visibility.js's
// own canSee()/isSecretFor()/resolveEntityStatBlockMarkdown() (the same
// functions the Codex tab and Character Deck cards already use), so this
// module can't drift out of sync with the app's one visibility model.
//
// JSON entity/lore shape matches import.js's validateImport() (a
// round-trip authoring format, same as the old single-entry exporter
// this replaces); Markdown/Word/PDF are human-readable dumps built from
// resolveEntityStatBlockMarkdown's rendered content instead.
import { state } from './state.js';
import { CONFIG } from './firebase.js';
import {
  entityMatchesQuery, categoryGroupLabel, registerVisibilityChangeHandler,
  resolveEntityStatBlockMarkdown, categoryPinClassLocal, isCategoryCollapsed,
  isSubtypeCollapsed, subtypeCollapseKey, subtypeLabel
} from './codex.js';
import { canSee, viewerContext, entityHasSecretsFor, belongsOnLoreSurface, isSecretFor } from './visibility.js';
import {
  fetchImagesForEntities, buildSourcesWarning, buildMarkdownDocument,
  buildDocxBlob, buildPdfBlob
} from './export-render.js';
import { loadMarkdownModules } from './markdown.js';

const modeSelect = document.getElementById('export-mode-select');
const formatSelect = document.getElementById('export-format-select');
const selectedPanel = document.getElementById('export-mode-selected-panel');
const characterInline = document.getElementById('export-character-inline');
const characterSelect = document.getElementById('export-character-select');
const secretsCheck = document.getElementById('export-character-secrets-check');
const jsonOptionsRow = document.getElementById('export-json-options');
const includeImagesCheck = document.getElementById('export-include-images-check');
const searchEl = document.getElementById('export-lore-search');
const listEl = document.getElementById('export-lore-list');
const previewEl = document.getElementById('export-lore-preview');
const warningEl = document.getElementById('export-lore-warning');
const statusEl = document.getElementById('export-lore-status');
const exportBtn = document.getElementById('export-lore-btn');

let selectedIds = new Set();

// Keep in sync with slugify() in codex.js/import.js (private in both;
// 4 lines, not worth an export/cycle risk).
function slugify(name) {
  return name.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}
function entitySlug(e) {
  return e.slug || slugify(e.name || '');
}

// --- Mode/format panel visibility -----------------------------------

function updateModeUI() {
  const mode = modeSelect.value;
  selectedPanel.style.display = mode === 'selected' ? '' : 'none';
  characterInline.style.display = mode === 'character' ? '' : 'none';
  if (mode === 'character' && !characterSelect.options.length) renderCharacterSelect();
}
function updateFormatUI() {
  jsonOptionsRow.style.display = formatSelect.value === 'json' ? '' : 'none';
}
modeSelect.addEventListener('change', function () { updateModeUI(); updatePreview(); });
formatSelect.addEventListener('change', function () { updateFormatUI(); updatePreview(); });
secretsCheck.addEventListener('change', updatePreview);
characterSelect.addEventListener('change', updatePreview);
includeImagesCheck.addEventListener('change', updatePreview);

// PCs only (ownerId set) -- per Gregg's call, NPCs aren't meaningful
// "export as this character's known lore" targets the way a player's
// own PC is.
function renderCharacterSelect() {
  const chars = state.allEntities
    .filter(function (e) { return e.category === 'Character' && e.ownerId; })
    .sort(function (a, b) { return (a.name || '').localeCompare(b.name || ''); });
  const prevValue = characterSelect.value;
  characterSelect.innerHTML = '';
  chars.forEach(function (c) {
    const opt = document.createElement('option');
    opt.value = c.id;
    opt.textContent = c.name;
    characterSelect.appendChild(opt);
  });
  if (chars.some(function (c) { return c.id === prevValue; })) characterSelect.value = prevValue;
}

// --- Selected Entries browser -----------------------------------------
// Deliberately mirrors codex.js's own renderList DOM shape exactly
// (entity-group-header/-dot/-title/-count/-caret, subtype sub-groups,
// same collapse state) per Gregg's call -- "the same entry browser UI"
// means visually identical, not a re-skinned picker. The only behavior
// difference from the Codex tab's list: clicking a row (de)selects it
// (toggles .active) instead of navigating to it -- no checkboxes, no
// state.selectedId involvement, so this can't fight the real Codex
// tab's own renderList over the same DOM.

function renderExportLoreList() {
  const query = searchEl.value;
  const ctx = viewerContext();
  const pool = state.allEntities
    .filter(function (e) { return ctx.gmView || canSee(e, ctx); })
    .filter(function (e) { return entityMatchesQuery(e, query); });

  // Drop selections that no longer exist / no longer match the
  // current viewer's visibility (stale selection would export data the
  // current viewer can no longer see).
  const poolIds = new Set(pool.map(function (e) { return e.id; }));
  Array.from(selectedIds).forEach(function (id) { if (!poolIds.has(id)) selectedIds.delete(id); });

  listEl.innerHTML = '';
  if (!pool.length) {
    const p = document.createElement('p');
    p.className = 'lore-empty';
    p.textContent = 'No matches.';
    listEl.appendChild(p);
    updatePreview();
    return;
  }

  const byCategory = {};
  pool.forEach(function (e) {
    const cat = e.category || '(uncategorized)';
    (byCategory[cat] = byCategory[cat] || []).push(e);
  });
  const orderedCats = CONFIG.categories.filter(function (c) { return byCategory[c]; });
  Object.keys(byCategory).forEach(function (c) { if (orderedCats.indexOf(c) === -1) orderedCats.push(c); });

  // Same "force-expand while searching" override as the Codex tab.
  const searchActive = searchEl.value.trim().length > 0;

  function buildEntityLi(entity) {
    const li = document.createElement('li');
    li.dataset.id = entity.id;
    if (selectedIds.has(entity.id)) li.classList.add('active');
    const nameDiv = document.createElement('div');
    nameDiv.className = 'entity-name';
    nameDiv.textContent = entity.name;
    li.appendChild(nameDiv);
    li.addEventListener('click', function () { toggleEntity(entity.id); });
    return li;
  }

  orderedCats.forEach(function (cat) {
    const entities = byCategory[cat];
    const collapsed = searchActive ? false : isCategoryCollapsed(cat);

    const header = document.createElement('div');
    header.className = 'entity-group-header' + (collapsed ? ' collapsed' : '');
    const dotSpan = document.createElement('span');
    dotSpan.className = 'entity-group-dot ' + categoryPinClassLocal(cat);
    const titleSpan = document.createElement('span');
    titleSpan.className = 'entity-group-title';
    titleSpan.textContent = categoryGroupLabel(cat);
    const countSpan = document.createElement('span');
    countSpan.className = 'entity-group-count';
    countSpan.textContent = '(' + entities.length + ')';
    const caretSpan = document.createElement('span');
    caretSpan.className = 'entity-group-caret';
    caretSpan.textContent = '\u25be';
    header.appendChild(dotSpan);
    header.appendChild(titleSpan);
    header.appendChild(countSpan);
    header.appendChild(caretSpan);
    header.addEventListener('click', function () {
      state.categoryCollapse[cat] = collapsed ? false : true;
      renderExportLoreList();
    });
    listEl.appendChild(header);

    const ul = document.createElement('ul');
    ul.className = 'entity-group-list' + (collapsed ? ' collapsed' : '');

    const plainEntities = [];
    const bySubtype = {};
    entities.forEach(function (entity) {
      if (entity.subtype) {
        (bySubtype[entity.subtype] = bySubtype[entity.subtype] || []).push(entity);
      } else {
        plainEntities.push(entity);
      }
    });

    plainEntities
      .sort(function (a, b) { return (a.name || '').localeCompare(b.name || ''); })
      .forEach(function (entity) { ul.appendChild(buildEntityLi(entity)); });

    Object.keys(bySubtype).sort(function (a, b) { return subtypeLabel(a).localeCompare(subtypeLabel(b)); })
      .forEach(function (subtype) {
        const subEntities = bySubtype[subtype].sort(function (a, b) { return (a.name || '').localeCompare(b.name || ''); });
        const subCollapsed = searchActive ? false : isSubtypeCollapsed(cat, subtype);

        const subLi = document.createElement('li');
        subLi.className = 'entity-subgroup-li';
        const subHeader = document.createElement('div');
        subHeader.className = 'entity-subgroup-header' + (subCollapsed ? ' collapsed' : '');
        const subTitleSpan = document.createElement('span');
        subTitleSpan.className = 'entity-group-title';
        subTitleSpan.textContent = subtypeLabel(subtype);
        const subCountSpan = document.createElement('span');
        subCountSpan.className = 'entity-group-count';
        subCountSpan.textContent = '(' + subEntities.length + ')';
        const subCaretSpan = document.createElement('span');
        subCaretSpan.className = 'entity-subgroup-caret';
        subCaretSpan.textContent = '\u25be';
        subHeader.appendChild(subTitleSpan);
        subHeader.appendChild(subCountSpan);
        subHeader.appendChild(subCaretSpan);
        subHeader.addEventListener('click', function (ev) {
          ev.stopPropagation();
          state.subtypeCollapse[subtypeCollapseKey(cat, subtype)] = subCollapsed ? false : true;
          renderExportLoreList();
        });
        subLi.appendChild(subHeader);

        const subUl = document.createElement('ul');
        subUl.className = 'entity-subgroup-list' + (subCollapsed ? ' collapsed' : '');
        subEntities.forEach(function (entity) { subUl.appendChild(buildEntityLi(entity)); });
        subLi.appendChild(subUl);

        ul.appendChild(subLi);
      });

    listEl.appendChild(ul);
  });

  updatePreview();
}
function toggleEntity(id) {
  if (selectedIds.has(id)) selectedIds.delete(id); else selectedIds.add(id);
  renderExportLoreList();
}
searchEl.addEventListener('input', renderExportLoreList);

// --- Ctx + entity pool resolution, per mode ---------------------------

// Character/party modes fabricate a viewerContext()-shaped ctx for a
// character who may not be the real signed-in viewer -- exactly the
// "GM previewing as a specific player" idea, just without an actual
// preview session. Excluding secrets = activeCharacterId left null
// (canSee's 'character' branch then only passes characterShared:true
// items, i.e. things already shared with the whole party) while
// ownedCharacterIds still contains the character so their own
// character-sheet gm-only content stays included -- see isSecretFor's
// definition in visibility.js, which this mirrors exactly.
//
// Character mode's pool is deliberately narrow (per Gregg's call): NOT
// "everything this character can see" -- just their own character
// entity, plus (when secrets are included) any OTHER entity that IS a
// secret for them or CONTAINS one (entityHasSecretsFor, the same check
// that drives the Codex tab's own "secret" badge/Show-secrets filter).
// All-players content the character merely has ordinary access to
// (like any party member) is out of scope for this export.
function resolveExportContext() {
  const mode = modeSelect.value;
  if (mode === 'party') {
    const ctx = { gmView: false, activeCharacterId: null, ownedCharacterIds: [] };
    return { ctx: ctx, pool: partyVisiblePool(ctx) };
  }
  if (mode === 'character') {
    const charId = characterSelect.value;
    const includeSecrets = secretsCheck.checked;
    const ctx = includeSecrets
      ? { gmView: false, activeCharacterId: charId, ownedCharacterIds: charId ? [charId] : [] }
      : { gmView: false, activeCharacterId: null, ownedCharacterIds: charId ? [charId] : [] };
    return { ctx: ctx, pool: charId ? characterPool(charId, ctx, includeSecrets) : [] };
  }
  const ctx = viewerContext();
  const pool = state.allEntities.filter(function (e) { return selectedIds.has(e.id); });
  return { ctx: ctx, pool: pool };
}
function partyVisiblePool(ctx) {
  return state.allEntities.filter(function (e) { return canSee(e, ctx); });
}
function characterPool(charId, ctx, includeSecrets) {
  const charEntity = state.allEntities.find(function (e) { return e.id === charId; });
  if (!charEntity) return [];
  if (!includeSecrets) return [charEntity];
  const others = state.allEntities.filter(function (e) {
    return e.id !== charId && entityHasSecretsFor(e, ctx);
  });
  return [charEntity].concat(others);
}

// --- Per-entity content/lore/notes resolution ---------------------------

function resolveExportLoreItems(entity, ctx) {
  return state.allLoreItems
    .filter(function (item) {
      return item.entityId === entity.id && item.kind !== 'note'
        && item.meta !== 'meta-details' && item.meta !== 'meta-features';
    })
    .filter(function (item) { return ctx.gmView || canSee(item, ctx); })
    .sort(function (a, b) { return (a.order || 0) - (b.order || 0); });
}

// Canonized (all-players) notes only -- same belongsOnLoreSurface rule
// the Codex tab's own Lore-tab-style surfaces use, so a still-private
// note never leaks into an export. Still-private notes are simply
// omitted, same as the app's own Lore tab omits them.
function resolveExportNotes(entity, ctx) {
  return state.allLoreItems
    .filter(function (item) { return item.entityId === entity.id && item.kind === 'note'; })
    .filter(belongsOnLoreSurface)
    .filter(function (item) { return ctx.gmView || canSee(item, ctx); })
    .sort(function (a, b) { return (a.order || 0) - (b.order || 0); });
}

function buildPerEntityRecord(entity, ctx) {
  const loreItems = resolveExportLoreItems(entity, ctx);
  const notes = resolveExportNotes(entity, ctx);
  const sourceIds = loreItems.concat(notes).map(function (it) { return it.sourceId; }).filter(Boolean);
  if (entity.sourceId) sourceIds.push(entity.sourceId);
  function toItem(it) { return { content: it.content, secret: isSecretFor(it, ctx) }; }
  return {
    entity: entity,
    // isSecretFor only ever returns true when ctx.activeCharacterId is
    // set (Character mode with secrets included) -- other modes' ctx
    // never sets it, so this is a no-op there.
    entitySecret: isSecretFor(entity, ctx),
    loreContent: loreItems.map(toItem).filter(function (it) { return it.content && it.content.trim(); }),
    noteContent: notes.map(toItem).filter(function (it) { return it.content && it.content.trim(); }),
    // Template entities only (Adversary/Ancestry/Equipment/etc stat
    // blocks) -- resolveEntityStatBlockMarkdown's non-template branch
    // just re-returns every lore item's content, which would duplicate
    // the Lore section above for ordinary narrative entities.
    statBlockMd: entity.useTemplate ? resolveEntityStatBlockMarkdown(entity, ctx, null) : '',
    sourceIds: sourceIds
  };
}

// The character name to print in a "[Secret - Name only]" tag, or null
// when this export's ctx has no active character (nothing can be
// flagged secret in that case, so nothing needs a name).
function activeCharacterName(ctx) {
  if (!ctx.activeCharacterId) return null;
  const c = state.allEntities.find(function (e) { return e.id === ctx.activeCharacterId; });
  return c ? c.name : null;
}

function groupImagesByOwner(images) {
  const out = {};
  images.forEach(function (img) { (out[img.ownerId] = out[img.ownerId] || []).push(img); });
  return out;
}

// --- JSON builder (import.js round-trip shape) -------------------------

function buildJsonEntityRecord(pe, imagesByEntity, includeImages) {
  const entity = pe.entity;
  const parent = entity.parentId
    ? state.allEntities.find(function (e) { return e.id === entity.parentId; })
    : null;
  const related = (entity.relatedIds || [])
    .map(function (id) { return state.allEntities.find(function (e) { return e.id === id; }); })
    .filter(Boolean);
  const out = {
    name: entity.name,
    category: entity.category,
    parentSlug: parent ? entitySlug(parent) : null
  };
  if (related.length) out.relatedSlugs = related.map(entitySlug);
  if (entity.tags && entity.tags.length) out.tags = entity.tags.slice();
  if (pe.loreContent.length) out.lore = pe.loreContent.map(function (it) { return it.content; });
  if (entity.ancestry) out.ancestry = entity.ancestry;
  if (entity.aliases && entity.aliases.length) out.aliases = entity.aliases.slice();
  if (entity.date) out.date = entity.date;
  if (entity.subtype) out.subtype = entity.subtype;
  if (entity.useTemplate && entity.details && Object.keys(entity.details).length) {
    out.details = Object.assign({}, entity.details);
  }
  if (entity.useTemplate && entity.features && entity.features.length) {
    out.features = entity.features.map(function (f) {
      const o = { name: f.name, text: f.text };
      if (f.type) o.type = f.type;
      return o;
    });
  }
  if (includeImages) {
    const imgs = imagesByEntity[entity.id] || [];
    if (imgs.length) {
      out.images = imgs.map(function (img) {
        return { data: img.data, contentType: img.contentType, width: img.width, height: img.height, isPortrait: !!img.isPortrait };
      });
    }
  }
  return out;
}

// --- Status / warning preview -------------------------------------------

function updatePreview() {
  const mode = modeSelect.value;
  if (mode === 'character' && !characterSelect.value) {
    previewEl.textContent = 'Pick a character.';
    warningEl.innerHTML = '';
    exportBtn.disabled = true;
    return;
  }
  const resolved = resolveExportContext();
  if (!resolved.pool.length) {
    previewEl.textContent = mode === 'selected' ? 'No entries selected.' : 'Nothing visible to export.';
    warningEl.innerHTML = '';
    exportBtn.disabled = true;
    return;
  }
  const perEntity = resolved.pool.map(function (e) { return buildPerEntityRecord(e, resolved.ctx); });
  const loreCount = perEntity.reduce(function (n, pe) { return n + pe.loreContent.length + pe.noteContent.length; }, 0);
  previewEl.textContent = resolved.pool.length + ' entr' + (resolved.pool.length === 1 ? 'y' : 'ies')
    + ', ' + loreCount + ' lore/note item' + (loreCount === 1 ? '' : 's') + ' selected for export.';
  let sourceIds = [];
  perEntity.forEach(function (pe) { sourceIds = sourceIds.concat(pe.sourceIds); });
  renderMarkdownWarning(buildSourcesWarning(sourceIds, state.allSources));
  exportBtn.disabled = false;
}

// warningEl holds markdown (source entries are themselves markdown
// text, see sources.js) -- rendered rich via the app's one markdown
// pipeline, same as every other lore surface, rather than shown raw.
let warningRenderModules = null;
function renderMarkdownWarning(mdText) {
  if (warningRenderModules) {
    warningEl.innerHTML = warningRenderModules.DOMPurify.sanitize(warningRenderModules.marked.parse(mdText, { breaks: true }));
    return;
  }
  warningEl.textContent = mdText;
  loadMarkdownModules().then(function (mods) {
    warningRenderModules = mods;
    if (warningEl.isConnected) {
      warningEl.innerHTML = mods.DOMPurify.sanitize(mods.marked.parse(mdText, { breaks: true }));
    }
  }).catch(function () { /* plain text already shown */ });
}

// --- Download ------------------------------------------------------------

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function exportFilename(mode, ext) {
  if (mode === 'selected' && selectedIds.size === 1) {
    const e = state.allEntities.find(function (en) { return selectedIds.has(en.id); });
    return (e ? entitySlug(e) : 'entry') + '.' + ext;
  }
  if (mode === 'character') {
    const c = state.allEntities.find(function (en) { return en.id === characterSelect.value; });
    return (c ? entitySlug(c) : 'character') + '-export.' + ext;
  }
  if (mode === 'party') return 'party-visible-lore.' + ext;
  return 'lore-export.' + ext;
}

async function runExport() {
  const mode = modeSelect.value;
  const format = formatSelect.value;
  const resolved = resolveExportContext();
  if (!resolved.pool.length) return;
  const secretCharacterName = activeCharacterName(resolved.ctx);
  const perEntity = resolved.pool.map(function (e) { return buildPerEntityRecord(e, resolved.ctx); });
  let sourceIds = [];
  perEntity.forEach(function (pe) { sourceIds = sourceIds.concat(pe.sourceIds); });

  // Markdown/Word/PDF all show a Gallery section per entity (count-only
  // for Markdown, embedded for Word/PDF), so all three need the fetch;
  // JSON keeps its own opt-in checkbox (raw image bytes bloat the file).
  const needsImages = format !== 'json' || includeImagesCheck.checked;
  let imagesByEntity = {};
  if (needsImages) {
    const images = await fetchImagesForEntities(resolved.pool.map(function (e) { return e.id; }));
    const visible = images.filter(function (img) { return resolved.ctx.gmView || canSee(img, resolved.ctx); });
    visible.forEach(function (img) {
      if (img.sourceId) sourceIds.push(img.sourceId);
      img.secret = isSecretFor(img, resolved.ctx);
    });
    imagesByEntity = groupImagesByOwner(visible);
  }
  const warningText = buildSourcesWarning(sourceIds, state.allSources);

  if (format === 'json') {
    const payload = { entities: perEntity.map(function (pe) { return buildJsonEntityRecord(pe, imagesByEntity, includeImagesCheck.checked); }) };
    downloadBlob(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }), exportFilename(mode, 'json'));
    return;
  }
  if (format === 'markdown') {
    downloadBlob(new Blob([buildMarkdownDocument(perEntity, imagesByEntity, warningText, secretCharacterName)], { type: 'text/markdown' }), exportFilename(mode, 'md'));
    return;
  }
  if (format === 'docx') {
    const blob = await buildDocxBlob(perEntity, imagesByEntity, warningText, secretCharacterName);
    downloadBlob(blob, exportFilename(mode, 'docx'));
    return;
  }
  if (format === 'pdf') {
    const blob = await buildPdfBlob(perEntity, imagesByEntity, warningText, secretCharacterName);
    downloadBlob(blob, exportFilename(mode, 'pdf'));
  }
}

exportBtn.addEventListener('click', function () {
  exportBtn.disabled = true;
  statusEl.textContent = 'Preparing export\u2026';
  runExport()
    .then(function () { statusEl.textContent = 'Downloaded.'; })
    .catch(function (err) {
      console.error('Export failed:', err);
      statusEl.textContent = 'Export failed: ' + err.message;
    })
    .finally(function () { updatePreview(); });
});

registerVisibilityChangeHandler(function () { renderExportLoreList(); renderCharacterSelect(); updatePreview(); });
updateModeUI();
updateFormatUI();
renderExportLoreList();
