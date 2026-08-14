/**
 * templates.js
 *
 * Structured "stat block" schema for entry types that benefit from it
 * (Phase 12b+ pilot: Weapons, Armor, Abilities). Drives THREE things from
 * one definition, per Gregg's design:
 *   1. Which scalar fields get pulled out of SRD records into the
 *      entity's structured `details` object (vs. left as long-tail
 *      markdown in the "mechanics" lore item).
 *   2. Whether the entity carries a structured `features` list
 *      ({name, text}[]) vs. none.
 *   3. What's search-indexable later (Phase: search whitelist) — a
 *      detail key's `standalone` flag says whether the bare VALUE (not
 *      just "key value") is safe to index on its own. E.g. `trait:
 *      Agility` -> "agility" alone is fine (categorical), but
 *      `tier: 2` -> bare "2" is not (collides with every tiered/leveled
 *      stat in the game) so tier is standalone:false, only indexed as
 *      the qualified pair "tier 2".
 *
 * Deliberately NOT auto-derived from SRD record shape — this is a
 * curated whitelist Gregg controls, same "GM decides what's structured"
 * philosophy as the Sources/tags features. Extending to more types
 * (Classes, Subclasses, Beastforms, Ancestries, Communities) is a
 * follow-up; those have messier per-record shapes (multiple feature
 * arrays, cross-references) and aren't in this pilot.
 *
 * Keyed by 'Category/subtype' (subtype '' for categories that don't
 * carry one, e.g. a future 'Ancestry/').
 */

const TEMPLATE_SCHEMAS = {
  'Equipment/weapons': {
    detailKeys: [
      { key: 'burden', standalone: true },
      { key: 'physical_or_magical', standalone: true },
      { key: 'primary_or_secondary', standalone: true },
      { key: 'range', standalone: true },
      { key: 'tier', standalone: false },
      { key: 'trait', standalone: true }
    ],
    hasFeatures: true
  },
  'Equipment/armor': {
    // Only tier is tracked/searchable. base_score and base_thresholds
    // don't make sense as search facets (Gregg's call) -- they stay as
    // long-tail markdown in the mechanics lore item, not structured
    // `details`.
    detailKeys: [
      { key: 'tier', standalone: false }
    ],
    hasFeatures: true
  },
  'Game Mechanics/abilities': {
    detailKeys: [
      { key: 'domain', standalone: true },
      { key: 'level', standalone: false },
      { key: 'type', standalone: true }
    ],
    hasFeatures: false
  }
};

function templateSchemaKey(category, subtype) {
  return category + '/' + (subtype || '');
}

function getTemplateSchema(category, subtype) {
  return TEMPLATE_SCHEMAS[templateSchemaKey(category, subtype)] || null;
}

function hasTemplateSchema(category, subtype) {
  return !!getTemplateSchema(category, subtype);
}

export { TEMPLATE_SCHEMAS, getTemplateSchema, hasTemplateSchema };
