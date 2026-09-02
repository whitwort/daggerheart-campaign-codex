import {
  getFirestore, collection, doc, writeBatch, serverTimestamp,
  query, where, getDocs
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import { firebaseApp, CONFIG } from './firebase.js';
import { state } from './state.js';
import { parseDateSpec } from './dates.js';
import { getTemplateSchema, computeSearchIndex } from './templates.js';
import { beginOp, updateOp, endOp } from './op-status.js';

const db = getFirestore(firebaseApp);

// --- Admin: bulk import (Phase 8 import pilot) --------------------------
// GM-only (lives in the Admin tab). Paste JSON -> Validate -> Import.
// Input shape:
//   { "entities": [ { "name", "category", "parentSlug": string|null,
//       "relatedSlugs": [..]?, "tags": [..]?, "lore": ["md", ..]?,
//       "ancestry": string?, "aliases": [..]?, "date": string?,
//       "subtype": string?, "details": {..}?, "features": [..]? }, .. ] }
// ancestry/aliases are meant for Characters, date for Scenes/Events,
// subtype for Game Mechanics/Equipment (see CONFIG.subtypesByCategory) —
// the importer doesn't enforce category pairing — the form does.
// details/features (added for structured-template categories, e.g.
// Adversary/Environment): optional. Only meaningful when
// getTemplateSchema(category, subtype) resolves a schema (templates.js).
// - "details": object keyed by schema.detailKeys[].key (e.g. "tier",
//   "hp", "attack_range" for Adversary). Unknown keys are dropped
//   (whitelisted the same way srd-import.js's buildTemplateData works).
//   Values are coerced to strings, same as the manual-entry form.
// - "features": [{ "name", "text", "type"? }, ..]. "type" (Action/
//   Passive/Reaction — free string) is kept only when
//   schema.hasFeatureType is true for this category.
// - If either is present and a schema resolves, the created/replaced
//   entity gets useTemplate: true, details, features, and a computed
//   searchIndex, matching what the SRD importer and the manual "Use
//   template" toggle produce. "lore" entries stay flavor-only (meta:
//   null) exactly as before; the importer additionally writes the
//   'meta-details'/'meta-features' anchor lore items (empty leftover
//   content) so codex.js's display-time synthesis (resolveLoreItemMarkdown)
//   has somewhere to attach the structured Details/Features block — the
//   same anchor pattern srd-import.js's buildLoreDocs uses.
// - Categories without a template schema silently ignore details/features
//   (useTemplate stays false) — no error, since the importer doesn't
//   enforce category/schema pairing any more than it enforces
//   category/subtype pairing.
// - "update" (merge) conflict choice: details/features/useTemplate are
//   only touched when the corresponding key is present in the JSON
//   (same "hasX" convention as tags/ancestry/etc.) — omit them to leave
//   an existing entity's template data untouched.
// Semantics:
// - Dedup by slug (slugified name) against existing entities: each match
//   is listed as a conflict with a per-entity choice:
//     skip (default) - entity AND its lore ignored; its existing doc id
//       still resolves parentSlug/relatedSlugs references from other
//       batch items.
//     replace - existing doc id kept (pins/relations/images stay valid);
//       the entity doc is fully rewritten from the import. hasMapImage
//       and mapId are preserved from the existing doc (the import JSON
//       cannot express map images; overwriting would orphan an uploaded
//       map). ALL existing lore items are deleted and imported lore is
//       written fresh.
//     update - merge: name/category/parentId always replaced (parentSlug
//       is required in the shape, so null counts as provided);
//       relatedIds/tags replaced only if the key is present in the JSON;
//       visibility untouched. Imported lore appends after existing lore
//       (order continues), skipping items whose content exactly matches
//       an existing item, so re-runs don't duplicate.
// - parentSlug/relatedSlugs resolve against existing entities first, then
//   other batch items. Unresolvable -> validation error.
// - All new entity doc ids are pre-generated at validation time, so batch
//   items can reference each other in any order.
// - Created entities: visibility 'gm-only', hasMapImage false.
// - Lore items: kind 'imported', authorId null, authorType 'gm',
//   visibility 'gm-only', order = source array index.
// - authorId/authorType convention (all writers): authorType 'gm' means
//   authorId null; authorType 'character' means authorId is the authoring
//   Player Character's entities/ doc id (never a uid/email — a player may
//   own several PCs, and authorship must survive a PC's death). No writer
//   sets 'character' yet (Phase 14, player contribution).

const importJsonEl = document.getElementById('admin-import-json');
const importRunBtn = document.getElementById('admin-import-run-btn');
const importReportEl = document.getElementById('admin-import-report');
const importConflictsEl = document.getElementById('admin-import-conflicts');
const importBulkRowEl = document.getElementById('admin-import-bulk-row');
const importConflictsOverlayEl = document.getElementById('admin-import-conflicts-overlay');
const importConflictsConfirmBtn = document.getElementById('admin-import-conflicts-confirm');
const importConflictsCancelBtn = document.getElementById('admin-import-conflicts-cancel');
const importSummaryEl = document.getElementById('admin-import-summary');
const importLogToggleEl = document.getElementById('admin-import-log-toggle');
const importLogBodyEl = document.getElementById('admin-import-log-body');
const importUploadBtn = document.getElementById('admin-import-upload-btn');
const importFileInputEl = document.getElementById('admin-import-file-input');

importLogToggleEl.addEventListener('click', function () {
  const open = importLogBodyEl.style.display !== 'none';
  importLogBodyEl.style.display = open ? 'none' : 'block';
  importLogToggleEl.innerHTML = 'Log ' + (open ? '&#9656;' : '&#9662;');
});

// --- CodeMirror (lazy-loaded, JSON syntax highlighting in the import
// textarea). Loaded on first visit to the Admin tab, not at page load.
let cmInstance = null;
let cmLoadPromise = null;

function loadCodeMirrorAssets() {
  if (cmLoadPromise) return cmLoadPromise;
  cmLoadPromise = new Promise(function (resolve, reject) {
    const cssLink = document.createElement('link');
    cssLink.rel = 'stylesheet';
    cssLink.href = 'https://unpkg.com/codemirror@5.65.16/lib/codemirror.css';
    document.head.appendChild(cssLink);

    const coreScript = document.createElement('script');
    coreScript.src = 'https://unpkg.com/codemirror@5.65.16/lib/codemirror.js';
    coreScript.onload = function () {
      const modeScript = document.createElement('script');
      modeScript.src = 'https://unpkg.com/codemirror@5.65.16/mode/javascript/javascript.js';
      modeScript.onload = function () { resolve(window.CodeMirror); };
      modeScript.onerror = function () { reject(new Error('Failed to load CodeMirror JSON mode')); };
      document.head.appendChild(modeScript);
    };
    coreScript.onerror = function () { reject(new Error('Failed to load CodeMirror')); };
    document.head.appendChild(coreScript);
  });
  return cmLoadPromise;
}

function ensureImportEditorReady() {
  if (cmInstance) return;
  loadCodeMirrorAssets().then(function (CodeMirror) {
    if (cmInstance) return;
    cmInstance = CodeMirror.fromTextArea(importJsonEl, {
      mode: { name: 'javascript', json: true },
      lineNumbers: true,
      lineWrapping: true
    });
    cmInstance.on('change', scheduleValidate);
  }).catch(function (err) {
    console.error('CodeMirror load failed, falling back to plain textarea:', err.message);
  });
}

function getImportText() {
  return cmInstance ? cmInstance.getValue() : importJsonEl.value;
}

function setImportText(text) {
  if (cmInstance) cmInstance.setValue(text);
  else importJsonEl.value = text;
}

// Fallback for the (brief, pre-CodeMirror-load) window and in case the
// CDN load fails.
importJsonEl.addEventListener('input', function () {
  if (!cmInstance) scheduleValidate();
});

importUploadBtn.addEventListener('click', function () {
  importFileInputEl.click();
});

importFileInputEl.addEventListener('change', function () {
  const file = importFileInputEl.files && importFileInputEl.files[0];
  importFileInputEl.value = '';
  if (!file) return;
  if (getImportText().trim() !== '') {
    const confirmed = window.confirm('Replace current textarea content with this file?');
    if (!confirmed) return;
  }
  const reader = new FileReader();
  reader.onload = function () {
    setImportText(String(reader.result));
    validateImport();
  };
  reader.onerror = function () {
    window.alert('File read failed: ' + reader.error.message);
  };
  reader.readAsText(file);
});

// Keep in sync with slugify() in codex.js (private there; 4 lines, not
// worth an export/cycle risk).
function slugify(name) {
  return name.toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// Result of the last successful validation; consumed by runImport().
// Invalidated on any textarea edit.
let validatedPlan = null;

function clearConflictRows() {
  Array.from(importConflictsEl.children).forEach(function (el) {
    if (!el.classList.contains('import-conflicts-grid-header')) importConflictsEl.removeChild(el);
  });
  importBulkRowEl.innerHTML = '';
}

function invalidatePlan() {
  validatedPlan = null;
  importRunBtn.disabled = true;
  clearConflictRows();
}

let validateDebounceHandle = null;
function scheduleValidate() {
  invalidatePlan();
  if (validateDebounceHandle) clearTimeout(validateDebounceHandle);
  validateDebounceHandle = setTimeout(validateImport, 650);
}

function renderSummaryBadges(counts) {
  importSummaryEl.innerHTML = '';
  function badge(text, cls) {
    const span = document.createElement('span');
    span.className = 'import-badge ' + cls;
    span.textContent = text;
    importSummaryEl.appendChild(span);
  }
  if (counts.errors > 0) {
    badge(counts.errors + ' error' + (counts.errors === 1 ? '' : 's'), 'import-badge-error');
    return;
  }
  badge(counts.additions + ' addition' + (counts.additions === 1 ? '' : 's'), 'import-badge-add');
  if (counts.conflicts > 0) {
    badge(counts.conflicts + ' conflict' + (counts.conflicts === 1 ? '' : 's'), 'import-badge-conflict');
  }
}

function validateImport() {
  invalidatePlan();
  importSummaryEl.innerHTML = '';
  const errors = [];
  const lines = [];

  const text = getImportText().trim();
  if (text === '') {
    importReportEl.textContent = '';
    return;
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    importReportEl.textContent = 'JSON parse failed: ' + err.message;
    renderSummaryBadges({ errors: 1, additions: 0, conflicts: 0 });
    return;
  }
  if (!parsed || !Array.isArray(parsed.entities)) {
    importReportEl.textContent = 'Expected an object with an "entities" array.';
    renderSummaryBadges({ errors: 1, additions: 0, conflicts: 0 });
    return;
  }

  // Existing slug -> doc id (first wins; existing duplicate slugs are a
  // pre-existing condition, just noted). Fall back to slugified name for
  // docs missing a slug field (early test docs).
  const existingBySlug = {};
  state.allEntities.forEach(function (e) {
    const s = e.slug || (e.name ? slugify(e.name) : '');
    if (s && !(s in existingBySlug)) existingBySlug[s] = e.id;
  });

  // First pass: shape checks, slug assignment, in-batch duplicate check,
  // pre-generate ids for new entities.
  const batchBySlug = {};   // slug -> resolved doc id (new or existing)
  const items = [];
  parsed.entities.forEach(function (raw, i) {
    const label = 'entities[' + i + ']';
    if (!raw || typeof raw !== 'object') { errors.push(label + ': not an object'); return; }
    if (typeof raw.name !== 'string' || raw.name.trim() === '') {
      errors.push(label + ': missing/empty name'); return;
    }
    const name = raw.name.trim();
    if (CONFIG.categories.indexOf(raw.category) === -1) {
      errors.push(label + ' (' + name + '): bad category "' + raw.category + '"'); return;
    }
    if (raw.parentSlug !== null && typeof raw.parentSlug !== 'string') {
      errors.push(label + ' (' + name + '): parentSlug must be a string or null'); return;
    }
    const relatedSlugs = raw.relatedSlugs || [];
    const tags = raw.tags || [];
    const lore = raw.lore || [];
    if (!Array.isArray(relatedSlugs) || !Array.isArray(tags) || !Array.isArray(lore)) {
      errors.push(label + ' (' + name + '): relatedSlugs/tags/lore must be arrays'); return;
    }
    if (lore.some(function (c) { return typeof c !== 'string' || c.trim() === ''; })) {
      errors.push(label + ' (' + name + '): lore entries must be non-empty strings'); return;
    }
    if ('ancestry' in raw && typeof raw.ancestry !== 'string') {
      errors.push(label + ' (' + name + '): ancestry must be a string'); return;
    }
    if ('subtype' in raw && typeof raw.subtype !== 'string') {
      errors.push(label + ' (' + name + '): subtype must be a string'); return;
    }
    if ('date' in raw && typeof raw.date !== 'string') {
      errors.push(label + ' (' + name + '): date must be a string'); return;
    }
    let dateSort = null;
    if ('date' in raw && raw.date) {
      const parsedDate = parseDateSpec(raw.date);
      if (!parsedDate.ok) {
        errors.push(label + ' (' + name + '): date "' + raw.date + '" — ' + parsedDate.error); return;
      }
      dateSort = parsedDate.offsetSeconds;
    }
    const aliases = raw.aliases || [];
    if (!Array.isArray(aliases) || aliases.some(function (a) { return typeof a !== 'string'; })) {
      errors.push(label + ' (' + name + '): aliases must be an array of strings'); return;
    }
    if ('details' in raw && (typeof raw.details !== 'object' || raw.details === null || Array.isArray(raw.details))) {
      errors.push(label + ' (' + name + '): details must be an object'); return;
    }
    if ('features' in raw) {
      if (!Array.isArray(raw.features)) {
        errors.push(label + ' (' + name + '): features must be an array'); return;
      }
      const badFeature = raw.features.some(function (f) {
        return !f || typeof f !== 'object'
          || typeof f.name !== 'string' || f.name.trim() === ''
          || typeof f.text !== 'string';
      });
      if (badFeature) {
        errors.push(label + ' (' + name + '): each feature needs a non-empty "name" and a "text" string'); return;
      }
    }
    const schema = getTemplateSchema(raw.category, raw.subtype || null);
    const hasDetails = ('details' in raw);
    const hasFeatures = ('features' in raw);
    let details = {};
    let features = [];
    if (schema && (hasDetails || hasFeatures)) {
      schema.detailKeys.forEach(function (d) {
        const val = raw.details && raw.details[d.key];
        if (val !== null && val !== undefined && val !== '') details[d.key] = String(val);
      });
      features = (raw.features || []).map(function (f) {
        const out = { name: f.name, text: f.text };
        if (schema.hasFeatureType && f.type) out.type = f.type;
        return out;
      });
    }
    const searchIndex = (schema && (hasDetails || hasFeatures))
      ? computeSearchIndex(details, features, schema) : [];
    const useTemplate = !!(schema && (hasDetails || hasFeatures));
    const slug = slugify(name);
    if (slug === '') { errors.push(label + ' (' + name + '): name slugifies to empty'); return; }
    if (slug in batchBySlug) {
      errors.push(label + ' (' + name + '): duplicate slug "' + slug + '" within batch'); return;
    }
    const isDuplicate = slug in existingBySlug;
    const id = isDuplicate ? existingBySlug[slug] : doc(collection(db, 'entities')).id;
    batchBySlug[slug] = id;
    items.push({
      id: id, slug: slug, name: name, category: raw.category,
      parentSlug: raw.parentSlug, relatedSlugs: relatedSlugs,
      tags: tags, lore: lore, isDuplicate: isDuplicate,
      ancestry: raw.ancestry || null, aliases: aliases, date: raw.date || null,
      dateSort: dateSort,
      subtype: raw.subtype || null,
      useTemplate: useTemplate, details: details, features: features, searchIndex: searchIndex,
      hasRelated: ('relatedSlugs' in raw), hasTags: ('tags' in raw),
      hasAncestry: ('ancestry' in raw), hasAliases: ('aliases' in raw),
      hasDate: ('date' in raw), hasSubtype: ('subtype' in raw),
      hasDetails: hasDetails, hasFeatures: hasFeatures
    });
  });

  // Second pass: resolve references. Incoming refs are slugified too, so
  // "Genesis" or "The Hub" resolve the same as "genesis"/"the-hub".
  function resolveSlug(raw) {
    const s = slugify(raw);
    if (s in existingBySlug) return existingBySlug[s];
    if (s in batchBySlug) return batchBySlug[s];
    return null;
  }
  // Resolve refs for duplicates too: replace/update need parentId and
  // relatedIds just like creates do.
  items.forEach(function (item) {
    if (item.parentSlug === null) {
      item.parentId = null;
    } else {
      item.parentId = resolveSlug(item.parentSlug);
      if (item.parentId === null) {
        errors.push(item.name + ': unresolvable parentSlug "' + item.parentSlug + '"');
      }
    }
    item.relatedIds = [];
    item.relatedSlugs.forEach(function (s) {
      const rid = resolveSlug(s);
      if (rid === null) {
        errors.push(item.name + ': unresolvable relatedSlug "' + s + '"');
      } else {
        item.relatedIds.push(rid);
      }
    });
  });

  const creates = items.filter(function (it) { return !it.isDuplicate; });
  const duplicates = items.filter(function (it) { return it.isDuplicate; });
  const loreCount = creates.reduce(function (n, it) { return n + it.lore.length; }, 0);

  lines.push('Creates: ' + creates.length + ' entities, ' + loreCount + ' lore items');
  creates.forEach(function (it) {
    lines.push('  + [' + it.category + '] ' + it.name
      + (it.parentSlug ? ' (parent: ' + it.parentSlug + ')' : '')
      + (it.lore.length ? ' [' + it.lore.length + ' lore]' : ''));
  });
  if (duplicates.length) {
    lines.push('Conflicts (slug already exists) — choose per entity below: '
      + duplicates.length);
  }
  if (errors.length) {
    lines.push('ERRORS (' + errors.length + ') — fix before importing:');
    errors.forEach(function (e) { lines.push('  ! ' + e); });
  }
  importReportEl.textContent = lines.join('\n');
  renderSummaryBadges({ errors: errors.length, additions: creates.length, conflicts: duplicates.length });

  if (errors.length === 0) {
    duplicates.forEach(function (it) {
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      it.selectEl = checkbox;

      const nameSpan = document.createElement('span');
      nameSpan.textContent = '[' + it.category + '] ' + it.name;

      const loreSpan = document.createElement('span');
      loreSpan.className = 'import-lore-count';
      loreSpan.textContent = it.lore.length ? (it.lore.length + ' lore') : '\u2014';

      const sel = document.createElement('select');
      ['skip', 'replace', 'update'].forEach(function (v) {
        const opt = document.createElement('option');
        opt.value = v;
        opt.textContent = v;
        sel.appendChild(opt);
      });
      it.choiceEl = sel;

      importConflictsEl.appendChild(checkbox);
      importConflictsEl.appendChild(nameSpan);
      importConflictsEl.appendChild(loreSpan);
      importConflictsEl.appendChild(sel);
    });

    if (duplicates.length > 0) {
      const bulkRow = document.createElement('div');
      bulkRow.className = 'import-bulk-row';
      const selectAllLabel = document.createElement('label');
      const selectAllCb = document.createElement('input');
      selectAllCb.type = 'checkbox';
      selectAllCb.addEventListener('change', function () {
        duplicates.forEach(function (it) { it.selectEl.checked = selectAllCb.checked; });
      });
      selectAllLabel.appendChild(selectAllCb);
      selectAllLabel.appendChild(document.createTextNode(' Select all'));
      const bulkMethodSel = document.createElement('select');
      ['skip', 'replace', 'update'].forEach(function (v) {
        const opt = document.createElement('option');
        opt.value = v;
        opt.textContent = v;
        bulkMethodSel.appendChild(opt);
      });
      const applyBtn = document.createElement('button');
      applyBtn.type = 'button';
      applyBtn.textContent = 'Apply to selected';
      applyBtn.addEventListener('click', function () {
        duplicates.forEach(function (it) {
          if (it.selectEl.checked) it.choiceEl.value = bulkMethodSel.value;
        });
      });
      bulkRow.appendChild(selectAllLabel);
      bulkRow.appendChild(bulkMethodSel);
      bulkRow.appendChild(applyBtn);
      importBulkRowEl.appendChild(bulkRow);
    }
  }

  if (errors.length === 0 && (creates.length > 0 || duplicates.length > 0)) {
    validatedPlan = { creates: creates, duplicates: duplicates };
    importRunBtn.disabled = false;
  }
}

// Fetch all existing lore items for one entity id (replace: to delete
// them; update: for order continuation + exact-content dedupe).
function fetchLoreFor(entityId) {
  const q = query(collection(db, 'loreItems'), where('entityId', '==', entityId));
  return getDocs(q).then(function (snap) {
    const out = [];
    snap.forEach(function (d) { out.push({ id: d.id, data: d.data() }); });
    return out;
  });
}

function runImport() {
  if (!validatedPlan) return;
  const creates = validatedPlan.creates;
  // Read choices before invalidation tears the selects down.
  const replaces = [];
  const updates = [];
  let skipped = 0;
  validatedPlan.duplicates.forEach(function (it) {
    const choice = it.choiceEl ? it.choiceEl.value : 'skip';
    if (choice === 'replace') replaces.push(it);
    else if (choice === 'update') updates.push(it);
    else skipped += 1;
  });
  invalidatePlan();
  importRunBtn.disabled = true;
  importReportEl.textContent = 'Preparing import...';
  beginOp('import', 'Importing entries\u2026');

  // Existing entity docs by id (for hasMapImage/mapId preservation on
  // replace).
  const existingById = {};
  state.allEntities.forEach(function (e) { existingById[e.id] = e; });

  // Fetch existing lore for every replace/update target, sequentially.
  const loreByEntity = {};
  let fetches = Promise.resolve();
  replaces.concat(updates).forEach(function (it) {
    fetches = fetches.then(function () {
      return fetchLoreFor(it.id).then(function (loreDocs) {
        loreByEntity[it.id] = loreDocs;
      });
    });
  });

  fetches.then(function () {
    const ops = [];
    // meta defaults to null (plain lore item, same doc shape as before
    // details/features existed) — pass 'meta-details'/'meta-features' for
    // the anchor items a templated entity needs so codex.js's
    // resolveLoreItemMarkdown has somewhere to attach the synthesized
    // Details/Features block (see srd-import.js's buildLoreDocs, same
    // pattern).
    function newLoreOp(entityId, content, order, meta) {
      ops.push({
        type: 'set',
        ref: doc(collection(db, 'loreItems')),
        data: {
          entityId: entityId,
          kind: 'imported',
          authorId: null,
          authorType: 'gm',
          visibility: 'gm-only',
          content: content,
          meta: meta || null,
          order: order,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp()
        }
      });
    }
    // Anchor lore items are empty leftover content (details/features are
    // fully structured on the entity doc, nothing unwhitelisted to carry
    // as markdown) — content: ''. Appended after the flavor "lore" items
    // so flavor always displays first.
    function pushTemplateAnchors(it, startOrder) {
      let next = startOrder;
      if (it.useTemplate && Object.keys(it.details).length) {
        newLoreOp(it.id, '', next, 'meta-details');
        next += 1;
      }
      if (it.useTemplate && it.features.length) {
        newLoreOp(it.id, '', next, 'meta-features');
        next += 1;
      }
      return next;
    }

    creates.forEach(function (it) {
      ops.push({
        type: 'set',
        ref: doc(db, 'entities', it.id),
        data: {
          slug: it.slug,
          name: it.name,
          category: it.category,
          parentId: it.parentId,
          relatedIds: it.relatedIds,
          ancestry: it.ancestry,
          aliases: it.aliases,
          date: it.date,
          dateSort: it.dateSort,
          subtype: it.subtype,
          visibility: 'gm-only',
          hasMapImage: false,
          tags: it.tags,
          useTemplate: it.useTemplate,
          details: it.details,
          features: it.features,
          searchIndex: it.searchIndex,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp()
        }
      });
      it.lore.forEach(function (content, order) { newLoreOp(it.id, content, order); });
      pushTemplateAnchors(it, it.lore.length);
    });

    replaces.forEach(function (it) {
      const existing = existingById[it.id] || {};
      const data = {
        slug: it.slug,
        name: it.name,
        category: it.category,
        parentId: it.parentId,
        relatedIds: it.relatedIds,
        ancestry: it.ancestry,
        aliases: it.aliases,
        date: it.date,
        dateSort: it.dateSort,
        subtype: it.subtype,
        visibility: 'gm-only',
        hasMapImage: existing.hasMapImage || false,
        tags: it.tags,
        useTemplate: it.useTemplate,
        details: it.details,
        features: it.features,
        searchIndex: it.searchIndex,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp()
      };
      if (existing.mapId !== undefined) data.mapId = existing.mapId;
      ops.push({ type: 'set', ref: doc(db, 'entities', it.id), data: data });
      (loreByEntity[it.id] || []).forEach(function (ld) {
        ops.push({ type: 'delete', ref: doc(db, 'loreItems', ld.id) });
      });
      it.lore.forEach(function (content, order) { newLoreOp(it.id, content, order); });
      pushTemplateAnchors(it, it.lore.length);
    });

    updates.forEach(function (it) {
      const data = {
        slug: it.slug,
        name: it.name,
        category: it.category,
        parentId: it.parentId,
        updatedAt: serverTimestamp()
      };
      if (it.hasRelated) data.relatedIds = it.relatedIds;
      if (it.hasTags) data.tags = it.tags;
      if (it.hasAncestry) data.ancestry = it.ancestry;
      if (it.hasAliases) data.aliases = it.aliases;
      if (it.hasDate) { data.date = it.date; data.dateSort = it.dateSort; }
      if (it.hasSubtype) data.subtype = it.subtype;
      const touchesTemplate = it.hasDetails || it.hasFeatures;
      if (touchesTemplate) {
        data.useTemplate = it.useTemplate;
        data.details = it.details;
        data.features = it.features;
        data.searchIndex = it.searchIndex;
      }
      ops.push({ type: 'update', ref: doc(db, 'entities', it.id), data: data });
      const existingLore = loreByEntity[it.id] || [];
      const existingContent = {};
      let maxOrder = -1;
      existingLore.forEach(function (ld) {
        existingContent[(ld.data.content || '').trim()] = true;
        if (typeof ld.data.order === 'number' && ld.data.order > maxOrder) {
          maxOrder = ld.data.order;
        }
        // Merge replaces the anchors wholesale below (details/features are
        // fully re-supplied, never partially) — the old anchor's stale
        // synthesized content would otherwise linger next to fresh data.
        if (touchesTemplate && (ld.data.meta === 'meta-details' || ld.data.meta === 'meta-features')) {
          ops.push({ type: 'delete', ref: doc(db, 'loreItems', ld.id) });
        }
      });
      let next = maxOrder + 1;
      it.lore.forEach(function (content) {
        if (existingContent[content.trim()]) return;
        newLoreOp(it.id, content, next);
        next += 1;
      });
      if (touchesTemplate) next = pushTemplateAnchors(it, next);
    });

    // Firestore writeBatch cap is 500 ops; chunk and commit sequentially.
    const CHUNK = 450;
    const chunks = [];
    for (let i = 0; i < ops.length; i += CHUNK) chunks.push(ops.slice(i, i + CHUNK));

    let committed = 0;
    let p = Promise.resolve();
    chunks.forEach(function (chunk) {
      p = p.then(function () {
        const batch = writeBatch(db);
        chunk.forEach(function (op) {
          if (op.type === 'delete') batch.delete(op.ref);
          else if (op.type === 'update') batch.update(op.ref, op.data);
          else batch.set(op.ref, op.data);
        });
        return batch.commit().then(function () {
          committed += chunk.length;
          const line = 'Importing... ' + committed + '/' + ops.length + ' writes';
          importReportEl.textContent = line;
          updateOp(line, ops.length ? Math.round(100 * committed / ops.length) : 100);
        });
      });
    });
    return p.then(function () {
      const line = 'Import complete: '
        + creates.length + ' created, '
        + replaces.length + ' replaced, '
        + updates.length + ' updated, '
        + skipped + ' skipped ('
        + committed + ' writes). Entities list updates live.';
      importReportEl.textContent = line;
      endOp(line);
    });
  }).catch(function (err) {
    // Batches are atomic individually but not across chunks: a failure
    // mid-run leaves earlier chunks committed. Re-validates automatically:
    // entities already committed will now show as conflicts; choose skip
    // (or update, which dedupes lore by exact content) rather than
    // replaying the whole batch blindly.
    const line = 'Import FAILED: ' + err.message
      + '\nRevalidating; already-committed entities will show as conflicts (default skip).';
    importReportEl.textContent = line;
    endOp(line);
    scheduleValidate();
  });
}

importRunBtn.addEventListener('click', function () {
  if (!validatedPlan) return;
  if (validatedPlan.duplicates.length > 0) {
    importConflictsOverlayEl.classList.add('open');
  } else {
    runImport();
  }
});

importConflictsConfirmBtn.addEventListener('click', function () {
  importConflictsOverlayEl.classList.remove('open');
  runImport();
});

importConflictsCancelBtn.addEventListener('click', function () {
  importConflictsOverlayEl.classList.remove('open');
});

export { ensureImportEditorReady };

