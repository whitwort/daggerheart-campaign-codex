import {
  getFirestore, collection, doc, writeBatch, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import { firebaseApp, CONFIG } from './firebase.js';
import { state } from './state.js';

const db = getFirestore(firebaseApp);

// --- Admin: bulk import (Phase 8 import pilot) --------------------------
// GM-only (lives in the Admin tab). Paste JSON -> Validate -> Import.
// Input shape:
//   { "entities": [ { "name", "category", "parentSlug": string|null,
//       "relatedSlugs": [..]?, "tags": [..]?, "lore": ["md", ..]? }, .. ] }
// Semantics:
// - Dedup by slug (slugified name) against existing entities: a match is
//   reported and skipped entirely (entity AND its lore) but its existing
//   doc id still resolves parentSlug/relatedSlugs references from other
//   batch items.
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
      tags: tags, lore: lore, isDuplicate: isDuplicate
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
  items.forEach(function (item) {
    if (item.isDuplicate) return;
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
    lines.push('Skipped as duplicates (slug already exists):');
    duplicates.forEach(function (it) { lines.push('  = ' + it.name + ' (' + it.slug + ')'); });
  }
  if (errors.length) {
    lines.push('ERRORS (' + errors.length + ') — fix before importing:');
    errors.forEach(function (e) { lines.push('  ! ' + e); });
  }
  importReportEl.textContent = lines.join('\n');

  if (errors.length === 0 && creates.length > 0) {
    validatedPlan = creates;
    importRunBtn.disabled = false;
  }
}

function runImport() {
  if (!validatedPlan) return;
  const plan = validatedPlan;
  invalidatePlan();
  importValidateBtn.disabled = true;
  importReportEl.textContent = 'Importing...';

  // Build the flat op list: one entity set + N loreItem sets per item.
  const ops = [];
  plan.forEach(function (it) {
    ops.push({
      ref: doc(db, 'entities', it.id),
      data: {
        slug: it.slug,
        name: it.name,
        category: it.category,
        parentId: it.parentId,
        relatedIds: it.relatedIds,
        visibility: 'gm-only',
        hasMapImage: false,
        tags: it.tags,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp()
      }
    });
    it.lore.forEach(function (content, order) {
      ops.push({
        ref: doc(collection(db, 'loreItems')),
        data: {
          entityId: it.id,
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
      chunk.forEach(function (op) { batch.set(op.ref, op.data); });
      return batch.commit().then(function () {
        committed += chunk.length;
        importReportEl.textContent = 'Importing... ' + committed + '/' + ops.length + ' writes';
      });
    });
  });
  p.then(function () {
    importReportEl.textContent = 'Import complete: ' + plan.length + ' entities, '
      + (ops.length - plan.length) + ' lore items ('
      + committed + ' writes). Entities list updates live.';
    importValidateBtn.disabled = false;
  }).catch(function (err) {
    // Batches are atomic individually but not across chunks: a failure
    // mid-run leaves earlier chunks committed. Re-running Validate +
    // Import is safe for entities (setDoc, fixed ids) but would duplicate
    // loreItems of already-committed entities — hence the explicit
    // instruction to re-Validate, which will now see those entities as
    // existing duplicates and skip them.
    importReportEl.textContent = 'Import FAILED after ' + committed + '/' + ops.length
      + ' writes: ' + err.message
      + '\nRe-run Validate: already-committed entities will now be skipped as duplicates.';
    importValidateBtn.disabled = false;
  });
}

importValidateBtn.addEventListener('click', validateImport);
importRunBtn.addEventListener('click', runImport);

// --- One-off data fix: NPC -> Character rename (Aug 2026) ---------------
// Temporary: remove this block (and its Admin-tab markup) once run.
const fixNpcBtn = document.getElementById('admin-fix-npc-category-btn');
const fixNpcStatusEl = document.getElementById('admin-fix-npc-category-status');
fixNpcBtn.addEventListener('click', function () {
  const targets = state.allEntities.filter(function (e) { return e.category === 'NPC'; });
  if (targets.length === 0) {
    fixNpcStatusEl.textContent = 'No entities with category NPC.';
    return;
  }
  fixNpcBtn.disabled = true;
  const batch = writeBatch(db);
  targets.forEach(function (e) {
    batch.update(doc(db, 'entities', e.id), {
      category: 'Character', updatedAt: serverTimestamp()
    });
  });
  batch.commit().then(function () {
    fixNpcStatusEl.textContent = 'Updated ' + targets.length + ' entities to Character.';
  }).catch(function (err) {
    fixNpcStatusEl.textContent = 'Failed: ' + err.message;
  }).finally(function () {
    fixNpcBtn.disabled = false;
  });
});
