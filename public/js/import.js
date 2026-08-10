import {
  getFirestore, collection, doc, writeBatch, serverTimestamp,
  query, where, getDocs
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import { firebaseApp, CONFIG } from './firebase.js';
import { state } from './state.js';

const db = getFirestore(firebaseApp);

// --- Admin: bulk import (Phase 8 import pilot) --------------------------
// GM-only (lives in the Admin tab). Paste JSON -> Validate -> Import.
// Input shape:
//   { "entities": [ { "name", "category", "parentSlug": string|null,
//       "relatedSlugs": [..]?, "tags": [..]?, "lore": ["md", ..]?,
//       "ancestry": string?, "aliases": [..]?, "date": string? }, .. ] }
// ancestry/aliases are meant for Characters, date for Scenes/Events, but
// the importer doesn't enforce category pairing — the form does.
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

const importJsonEl = document.getElementById('admin-import-json');
const importValidateBtn = document.getElementById('admin-import-validate-btn');
const importRunBtn = document.getElementById('admin-import-run-btn');
const importReportEl = document.getElementById('admin-import-report');
const importConflictsEl = document.getElementById('admin-import-conflicts');

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

function invalidatePlan() {
  validatedPlan = null;
  importRunBtn.disabled = true;
  importConflictsEl.innerHTML = '';
}

importJsonEl.addEventListener('input', invalidatePlan);

function validateImport() {
  invalidatePlan();
  const errors = [];
  const lines = [];

  let parsed;
  try {
    parsed = JSON.parse(importJsonEl.value);
  } catch (err) {
    importReportEl.textContent = 'JSON parse failed: ' + err.message;
    return;
  }
  if (!parsed || !Array.isArray(parsed.entities)) {
    importReportEl.textContent = 'Expected an object with an "entities" array.';
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
    if ('date' in raw && typeof raw.date !== 'string') {
      errors.push(label + ' (' + name + '): date must be a string'); return;
    }
    const aliases = raw.aliases || [];
    if (!Array.isArray(aliases) || aliases.some(function (a) { return typeof a !== 'string'; })) {
      errors.push(label + ' (' + name + '): aliases must be an array of strings'); return;
    }
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
      hasRelated: ('relatedSlugs' in raw), hasTags: ('tags' in raw),
      hasAncestry: ('ancestry' in raw), hasAliases: ('aliases' in raw),
      hasDate: ('date' in raw)
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

  if (errors.length === 0) {
    duplicates.forEach(function (it) {
      const row = document.createElement('div');
      row.className = 'import-conflict-row';
      const sel = document.createElement('select');
      ['skip', 'replace', 'update'].forEach(function (v) {
        const opt = document.createElement('option');
        opt.value = v;
        opt.textContent = v;
        sel.appendChild(opt);
      });
      it.choiceEl = sel;
      const label = document.createElement('span');
      label.textContent = ' [' + it.category + '] ' + it.name
        + (it.lore.length ? ' (' + it.lore.length + ' lore)' : '');
      row.appendChild(sel);
      row.appendChild(label);
      importConflictsEl.appendChild(row);
    });
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
  importValidateBtn.disabled = true;
  importReportEl.textContent = 'Preparing import...';

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
    function newLoreOp(entityId, content, order) {
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
          order: order,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp()
        }
      });
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
          visibility: 'gm-only',
          hasMapImage: false,
          tags: it.tags,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp()
        }
      });
      it.lore.forEach(function (content, order) { newLoreOp(it.id, content, order); });
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
        visibility: 'gm-only',
        hasMapImage: existing.hasMapImage || false,
        tags: it.tags,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp()
      };
      if (existing.mapId !== undefined) data.mapId = existing.mapId;
      ops.push({ type: 'set', ref: doc(db, 'entities', it.id), data: data });
      (loreByEntity[it.id] || []).forEach(function (ld) {
        ops.push({ type: 'delete', ref: doc(db, 'loreItems', ld.id) });
      });
      it.lore.forEach(function (content, order) { newLoreOp(it.id, content, order); });
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
      if (it.hasDate) data.date = it.date;
      ops.push({ type: 'update', ref: doc(db, 'entities', it.id), data: data });
      const existingLore = loreByEntity[it.id] || [];
      const existingContent = {};
      let maxOrder = -1;
      existingLore.forEach(function (ld) {
        existingContent[(ld.data.content || '').trim()] = true;
        if (typeof ld.data.order === 'number' && ld.data.order > maxOrder) {
          maxOrder = ld.data.order;
        }
      });
      let next = maxOrder + 1;
      it.lore.forEach(function (content) {
        if (existingContent[content.trim()]) return;
        newLoreOp(it.id, content, next);
        next += 1;
      });
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
          importReportEl.textContent = 'Importing... ' + committed + '/' + ops.length + ' writes';
        });
      });
    });
    return p.then(function () {
      importReportEl.textContent = 'Import complete: '
        + creates.length + ' created, '
        + replaces.length + ' replaced, '
        + updates.length + ' updated, '
        + skipped + ' skipped ('
        + committed + ' writes). Entities list updates live.';
      importValidateBtn.disabled = false;
    });
  }).catch(function (err) {
    // Batches are atomic individually but not across chunks: a failure
    // mid-run leaves earlier chunks committed. Re-run Validate: entities
    // already committed will now show as conflicts; choose skip (or
    // update, which dedupes lore by exact content) rather than replaying
    // the whole batch blindly.
    importReportEl.textContent = 'Import FAILED: ' + err.message
      + '\nRe-run Validate; already-committed entities appear as conflicts (default skip).';
    importValidateBtn.disabled = false;
  });
}

importValidateBtn.addEventListener('click', validateImport);
importRunBtn.addEventListener('click', runImport);

// --- One-off data fix: category renames (Aug 2026) ----------------------
// NPC -> Character, History -> World Facts. Idempotent (no-ops once no
// docs carry the old names). Temporary: remove this block (and its
// Admin-tab markup) once run on both dev and prod data.
const fixNpcBtn = document.getElementById('admin-fix-npc-category-btn');
const fixNpcStatusEl = document.getElementById('admin-fix-npc-category-status');
const CATEGORY_RENAMES = { 'NPC': 'Character', 'History': 'World Facts' };
fixNpcBtn.addEventListener('click', function () {
  const targets = state.allEntities.filter(function (e) {
    return e.category in CATEGORY_RENAMES;
  });
  if (targets.length === 0) {
    fixNpcStatusEl.textContent = 'No entities with old category names.';
    return;
  }
  fixNpcBtn.disabled = true;
  const batch = writeBatch(db);
  targets.forEach(function (e) {
    batch.update(doc(db, 'entities', e.id), {
      category: CATEGORY_RENAMES[e.category], updatedAt: serverTimestamp()
    });
  });
  batch.commit().then(function () {
    fixNpcStatusEl.textContent = 'Renamed categories on ' + targets.length + ' entities.';
  }).catch(function (err) {
    fixNpcStatusEl.textContent = 'Failed: ' + err.message;
  }).finally(function () {
    fixNpcBtn.disabled = false;
  });
});
