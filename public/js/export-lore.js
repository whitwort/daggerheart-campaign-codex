// Admin > Data > Export Lore sub-tab. Inline entry browser (search +
// category-grouped list, same shape as backup.js's "Restore a single
// entry" list and codex.js's own entity-picker popup) with single-
// entity selection; Export writes one JSON file in the exact shape
// import.js's validateImport() expects ({ "entities": [ {...} ] }),
// so a round-trip through Import Lore recreates an equivalent entry.
//
// Deliberately NOT exported (no equivalent import.js field): images,
// pins, dateEnd/dateEndSort, visibility, ownerId, cards, badgeColor,
// metaAncestryTargetIds, sourceId. A full-fidelity single-entry backup
// already exists (Admin > Backup > "Restore a single entry" round-
// trips a raw backup.js dump) -- this tool is for the *authoring*
// format instead, e.g. to hand-edit an entry outside the app or share
// a class/ancestry writeup as portable JSON.
import { state } from './state.js';
import { entityMatchesQuery, categoryGroupLabel, registerVisibilityChangeHandler } from './codex.js';

const exportSearchEl = document.getElementById('export-lore-search');
const exportListEl = document.getElementById('export-lore-list');
const exportPreviewEl = document.getElementById('export-lore-preview');
const exportBtn = document.getElementById('export-lore-btn');

let exportSelected = null;

// Keep in sync with slugify() in codex.js/import.js (private in both;
// 4 lines, not worth an export/cycle risk).
function slugify(name) {
  return name.toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
function entitySlug(e) {
  return e.slug || slugify(e.name || '');
}

// Non-note, non-anchor lore items only: notes are per-author private
// and must never leave in an export; meta-details/meta-features
// anchors are import.js's own synthesized re-creation of the
// details/features already carried on the entity fields below, so
// including their (empty) content would just double up on re-import.
function exportableLoreContent(entity) {
  return state.allLoreItems
    .filter(function (item) {
      return item.entityId === entity.id && item.kind !== 'note'
        && item.meta !== 'meta-details' && item.meta !== 'meta-features';
    })
    .sort(function (a, b) { return (a.order || 0) - (b.order || 0); })
    .map(function (item) { return item.content; })
    .filter(function (c) { return c && c.trim(); });
}

function buildExportRecord(entity) {
  const parent = entity.parentId
    ? state.allEntities.find(function (e) { return e.id === entity.parentId; })
    : null;
  const related = (entity.relatedIds || [])
    .map(function (id) { return state.allEntities.find(function (e) { return e.id === id; }); })
    .filter(Boolean);
  const lore = exportableLoreContent(entity);

  const out = {
    name: entity.name,
    category: entity.category,
    parentSlug: parent ? entitySlug(parent) : null
  };
  if (related.length) out.relatedSlugs = related.map(entitySlug);
  if (entity.tags && entity.tags.length) out.tags = entity.tags.slice();
  if (lore.length) out.lore = lore;
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
  return out;
}

function renderExportLoreList() {
  const query = exportSearchEl.value;
  exportListEl.innerHTML = '';
  const pool = state.allEntities
    .filter(function (e) { return entityMatchesQuery(e, query); })
    .sort(function (a, b) { return (a.name || '').localeCompare(b.name || ''); });

  if (!pool.length) {
    const p = document.createElement('p');
    p.className = 'lore-empty';
    p.textContent = 'No matches.';
    exportListEl.appendChild(p);
    return;
  }

  // Selection can go stale if the selected entity was deleted or no
  // longer matches the search -- clear it rather than export stale data.
  if (exportSelected && !pool.some(function (e) { return e.id === exportSelected.id; })) {
    exportSelected = null;
  }

  const byCategory = {};
  pool.forEach(function (e) {
    const cat = e.category || '(uncategorized)';
    (byCategory[cat] = byCategory[cat] || []).push(e);
  });

  Object.keys(byCategory).sort().forEach(function (cat) {
    const header = document.createElement('div');
    header.className = 'entity-group-header';
    const titleSpan = document.createElement('span');
    titleSpan.className = 'entity-group-title';
    titleSpan.textContent = categoryGroupLabel(cat);
    const countSpan = document.createElement('span');
    countSpan.className = 'entity-group-count';
    countSpan.textContent = '(' + byCategory[cat].length + ')';
    header.appendChild(titleSpan);
    header.appendChild(countSpan);
    exportListEl.appendChild(header);

    const ul = document.createElement('ul');
    ul.className = 'entity-group-list';
    byCategory[cat]
      .sort(function (a, b) { return (a.name || '').localeCompare(b.name || ''); })
      .forEach(function (e) {
        const li = document.createElement('li');
        li.className = 'export-lore-row';
        if (exportSelected && exportSelected.id === e.id) li.classList.add('active');
        const nameDiv = document.createElement('div');
        nameDiv.className = 'entity-name';
        nameDiv.textContent = e.name;
        li.appendChild(nameDiv);
        li.addEventListener('click', function () { selectExportEntity(e); });
        ul.appendChild(li);
      });
    exportListEl.appendChild(ul);
  });

  updateExportPreview();
}

function updateExportPreview() {
  if (!exportSelected) {
    exportPreviewEl.textContent = '';
    exportBtn.disabled = true;
    return;
  }
  const loreCount = exportableLoreContent(exportSelected).length;
  exportPreviewEl.textContent = exportSelected.name + ' ('
    + categoryGroupLabel(exportSelected.category || '(uncategorized)') + ') \u2014 '
    + loreCount + ' lore item' + (loreCount === 1 ? '' : 's') + '.';
  exportBtn.disabled = false;
}

function selectExportEntity(entity) {
  exportSelected = entity;
  renderExportLoreList();
}

exportSearchEl.addEventListener('input', renderExportLoreList);

exportBtn.addEventListener('click', function () {
  if (!exportSelected) return;
  const payload = { entities: [buildExportRecord(exportSelected)] };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = (entitySlug(exportSelected) || 'entry') + '.json';
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
});

registerVisibilityChangeHandler(renderExportLoreList);
renderExportLoreList();
