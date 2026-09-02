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
import {
  entityMatchesQuery, categoryGroupLabel, registerVisibilityChangeHandler,
  resolveEntityStatBlockMarkdown
} from './codex.js';
import { canSee, viewerContext } from './visibility.js';
import {
  fetchImagesForEntities, buildSourcesWarning, buildMarkdownDocument,
  buildDocxBlob, buildPdfBlob
} from './export-render.js';

const modeSelect = document.getElementById('export-mode-select');
const formatSelect = document.getElementById('export-format-select');
const selectedPanel = document.getElementById('export-mode-selected-panel');
const characterPanel = document.getElementById('export-mode-character-panel');
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
  characterPanel.style.display = mode === 'character' ? '' : 'none';
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

function renderCharacterSelect() {
  const chars = state.allEntities
    .filter(function (e) { return e.category === 'Character'; })
    .sort(function (a, b) { return (a.name || '').localeCompare(b.name || ''); });
  const prevValue = characterSelect.value;
  characterSelect.innerHTML = '';
  chars.forEach(function (c) {
    const opt = document.createElement('option');
    opt.value = c.id;
    opt.textContent = c.name + (c.ownerId ? '' : ' (NPC)');
    characterSelect.appendChild(opt);
  });
  if (chars.some(function (c) { return c.id === prevValue; })) characterSelect.value = prevValue;
}

// --- Selected Entries browser (multi-select, category select-all) ----

function renderExportLoreList() {
  const query = searchEl.value;
  listEl.innerHTML = '';
  const ctx = viewerContext();
  const pool = state.allEntities
    .filter(function (e) { return ctx.gmView || canSee(e, ctx); })
    .filter(function (e) { return entityMatchesQuery(e, query); })
    .sort(function (a, b) { return (a.name || '').localeCompare(b.name || ''); });

  // Drop selections that no longer exist / no longer match the
  // player's visibility (stale selection would export data the current
  // viewer can no longer see).
  const poolIds = new Set(pool.map(function (e) { return e.id; }));
  Array.from(selectedIds).forEach(function (id) { if (!poolIds.has(id)) selectedIds.delete(id); });

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

  Object.keys(byCategory).sort().forEach(function (cat) {
    const catEntities = byCategory[cat];
    const allSelected = catEntities.every(function (e) { return selectedIds.has(e.id); });

    const header = document.createElement('div');
    header.className = 'entity-group-header';
    const selectAllBox = document.createElement('input');
    selectAllBox.type = 'checkbox';
    selectAllBox.checked = allSelected;
    selectAllBox.title = 'Select/deselect all in this category';
    selectAllBox.addEventListener('click', function (e) {
      e.stopPropagation();
      catEntities.forEach(function (ent) {
        if (selectAllBox.checked) selectedIds.add(ent.id); else selectedIds.delete(ent.id);
      });
      renderExportLoreList();
    });
    header.appendChild(selectAllBox);
    const titleSpan = document.createElement('span');
    titleSpan.className = 'entity-group-title';
    titleSpan.textContent = categoryGroupLabel(cat);
    const countSpan = document.createElement('span');
    countSpan.className = 'entity-group-count';
    countSpan.textContent = '(' + catEntities.length + ')';
    header.appendChild(titleSpan);
    header.appendChild(countSpan);
    listEl.appendChild(header);

    const ul = document.createElement('ul');
    ul.className = 'entity-group-list';
    catEntities
      .sort(function (a, b) { return (a.name || '').localeCompare(b.name || ''); })
      .forEach(function (e) {
        const li = document.createElement('li');
        li.className = 'export-lore-row';
        if (selectedIds.has(e.id)) li.classList.add('active');
        const box = document.createElement('input');
        box.type = 'checkbox';
        box.checked = selectedIds.has(e.id);
        box.addEventListener('click', function (ev) { ev.stopPropagation(); toggleEntity(e.id); });
        li.appendChild(box);
        const nameDiv = document.createElement('div');
        nameDiv.className = 'entity-name';
        nameDiv.textContent = e.name;
        li.appendChild(nameDiv);
        li.addEventListener('click', function () { toggleEntity(e.id); });
        ul.appendChild(li);
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
function resolveExportContext() {
  const mode = modeSelect.value;
  if (mode === 'party') {
    return { ctx: { gmView: false, activeCharacterId: null, ownedCharacterIds: [] }, pool: partyOrCharacterPool({ gmView: false, activeCharacterId: null, ownedCharacterIds: [] }) };
  }
  if (mode === 'character') {
    const charId = characterSelect.value;
    const includeSecrets = secretsCheck.checked;
    const ctx = includeSecrets
      ? { gmView: false, activeCharacterId: charId, ownedCharacterIds: charId ? [charId] : [] }
      : { gmView: false, activeCharacterId: null, ownedCharacterIds: charId ? [charId] : [] };
    return { ctx: ctx, pool: charId ? partyOrCharacterPool(ctx) : [] };
  }
  const ctx = viewerContext();
  const pool = state.allEntities.filter(function (e) { return selectedIds.has(e.id); });
  return { ctx: ctx, pool: pool };
}
function partyOrCharacterPool(ctx) {
  return state.allEntities.filter(function (e) {
    return canSee(e, ctx) || !!resolveEntityStatBlockMarkdown(e, ctx, null).trim();
  });
}

// --- Per-entity content/lore resolution --------------------------------

function resolveExportLoreItems(entity, ctx) {
  return state.allLoreItems
    .filter(function (item) {
      return item.entityId === entity.id && item.kind !== 'note'
        && item.meta !== 'meta-details' && item.meta !== 'meta-features';
    })
    .filter(function (item) { return ctx.gmView || canSee(item, ctx); })
    .sort(function (a, b) { return (a.order || 0) - (b.order || 0); });
}

function buildPerEntityRecord(entity, ctx) {
  const loreItems = resolveExportLoreItems(entity, ctx);
  const sourceIds = loreItems.map(function (it) { return it.sourceId; }).filter(Boolean);
  if (entity.sourceId) sourceIds.push(entity.sourceId);
  return {
    entity: entity,
    loreContent: loreItems.map(function (it) { return it.content; }).filter(function (c) { return c && c.trim(); }),
    contentMd: resolveEntityStatBlockMarkdown(entity, ctx, null),
    sourceIds: sourceIds
  };
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
  if (pe.loreContent.length) out.lore = pe.loreContent;
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
    warningEl.textContent = '';
    exportBtn.disabled = true;
    return;
  }
  const resolved = resolveExportContext();
  if (!resolved.pool.length) {
    previewEl.textContent = mode === 'selected' ? 'No entries selected.' : 'Nothing visible to export.';
    warningEl.textContent = '';
    exportBtn.disabled = true;
    return;
  }
  const perEntity = resolved.pool.map(function (e) { return buildPerEntityRecord(e, resolved.ctx); });
  const loreCount = perEntity.reduce(function (n, pe) { return n + pe.loreContent.length; }, 0);
  previewEl.textContent = resolved.pool.length + ' entr' + (resolved.pool.length === 1 ? 'y' : 'ies')
    + ', ' + loreCount + ' lore item' + (loreCount === 1 ? '' : 's') + ' selected for export.';
  let sourceIds = [];
  perEntity.forEach(function (pe) { sourceIds = sourceIds.concat(pe.sourceIds); });
  warningEl.textContent = buildSourcesWarning(sourceIds, state.allSources);
  exportBtn.disabled = false;
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
  const perEntity = resolved.pool.map(function (e) { return buildPerEntityRecord(e, resolved.ctx); });
  let sourceIds = [];
  perEntity.forEach(function (pe) { sourceIds = sourceIds.concat(pe.sourceIds); });

  const needsImages = format === 'docx' || format === 'pdf' || (format === 'json' && includeImagesCheck.checked);
  let imagesByEntity = {};
  if (needsImages) {
    const images = await fetchImagesForEntities(resolved.pool.map(function (e) { return e.id; }));
    const visible = images.filter(function (img) { return resolved.ctx.gmView || canSee(img, resolved.ctx); });
    visible.forEach(function (img) { if (img.sourceId) sourceIds.push(img.sourceId); });
    imagesByEntity = groupImagesByOwner(visible);
  }
  const warningText = buildSourcesWarning(sourceIds, state.allSources);

  if (format === 'json') {
    const payload = { entities: perEntity.map(function (pe) { return buildJsonEntityRecord(pe, imagesByEntity, includeImagesCheck.checked); }) };
    downloadBlob(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }), exportFilename(mode, 'json'));
    return;
  }
  if (format === 'markdown') {
    downloadBlob(new Blob([buildMarkdownDocument(perEntity, warningText)], { type: 'text/markdown' }), exportFilename(mode, 'md'));
    return;
  }
  if (format === 'docx') {
    const blob = await buildDocxBlob(perEntity, warningText, imagesByEntity);
    downloadBlob(blob, exportFilename(mode, 'docx'));
    return;
  }
  if (format === 'pdf') {
    const blob = await buildPdfBlob(perEntity, warningText, imagesByEntity);
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
