// Related-entity resolution, shared by codex.js (Related chips, edit
// draft), export-lore.js (JSON round-trip) and anything else that needs
// "what is this entity related to".
//
// Two sources of relatedness per entity:
//   - relatedIds: real doc ids (the original, canonical field).
//   - pendingRelatedSlugs: slugs from a lore import that pointed at
//     entities that didn't exist yet (Sep 2026 -- import.js no longer
//     rejects those). Stored slugified. Resolved at READ time against
//     the live entity list, so a pending link lights up the moment an
//     entity with that slug exists -- by a later import, a manual
//     create, or a rename -- with no write needed. Unresolved slugs are
//     simply skipped: no chip, no link, nothing to leak.
//
// Relatedness stays symmetric at display time (see codex.js Related
// chips): a pending slug on A naming B's slug also makes A show up on B.
import { state } from './state.js';

// Keep in sync with slugify() in codex.js / import.js (private there).
function slugify(name) {
  return name.toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function entitySlugKey(e) {
  return e.slug || (e.name ? slugify(e.name) : '');
}

// slug -> entity id, first wins (same rule as import.js existingBySlug).
// Cached per state.allEntities array: the entities listener replaces
// the array on every snapshot, so identity is a safe invalidation key,
// and the Related-chips reverse scan calls this once per entity.
let slugIndexFor = null;
let slugIndex = {};
function slugToId() {
  if (slugIndexFor !== state.allEntities) {
    slugIndex = {};
    state.allEntities.forEach(function (e) {
      const s = entitySlugKey(e);
      if (s && !(s in slugIndex)) slugIndex[s] = e.id;
    });
    slugIndexFor = state.allEntities;
  }
  return slugIndex;
}

// relatedIds plus every pending slug that now resolves, deduped, self
// excluded. Dangling relatedIds (deleted targets) pass through as
// before -- callers already skip ids with no entity.
function resolvedRelatedIds(entity) {
  const index = slugToId();
  const out = [];
  (entity.relatedIds || []).forEach(function (id) {
    if (out.indexOf(id) === -1) out.push(id);
  });
  (entity.pendingRelatedSlugs || []).forEach(function (s) {
    const id = index[s];
    if (id && id !== entity.id && out.indexOf(id) === -1) out.push(id);
  });
  return out;
}

// Pending slugs that still don't resolve to any entity.
function unresolvedPendingSlugs(entity) {
  const index = slugToId();
  return (entity.pendingRelatedSlugs || []).filter(function (s) { return !(s in index); });
}

// Does `e` point at `target` (by id or by a now-resolving pending slug)?
function relatesTo(e, target) {
  if ((e.relatedIds || []).indexOf(target.id) !== -1) return true;
  const pending = e.pendingRelatedSlugs || [];
  if (!pending.length) return false;
  const slug = entitySlugKey(target);
  return !!slug && pending.indexOf(slug) !== -1 && slugToId()[slug] === target.id;
}

export { entitySlugKey, resolvedRelatedIds, unresolvedPendingSlugs, relatesTo };
