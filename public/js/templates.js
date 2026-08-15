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
      { key: 'burden', standalone: true, searchable: true },
      { key: 'physical_or_magical', standalone: true, searchable: true },
      { key: 'primary_or_secondary', standalone: true, searchable: true },
      { key: 'range', standalone: true, searchable: true },
      { key: 'tier', standalone: false, searchable: true },
      { key: 'trait', standalone: true, searchable: true }
    ],
    hasFeatures: true
  },
  'Equipment/armor': {
    // tier is search-whitelisted; base_score/base_thresholds are tracked
    // structurally (useful for Phase 14 features -- e.g. auto-computed
    // armor math) but flagged searchable:false since "3" or "11" alone
    // are meaningless search terms out of context. Search feature isn't
    // built yet -- this is forward-looking metadata for when it is.
    detailKeys: [
      { key: 'tier', standalone: false, searchable: true },
      { key: 'base_score', standalone: false, searchable: false },
      { key: 'base_thresholds', standalone: false, searchable: false }
    ],
    hasFeatures: true
  },
  'Game Mechanics/abilities': {
    detailKeys: [
      { key: 'domain', standalone: true, searchable: true },
      { key: 'level', standalone: false, searchable: true },
      { key: 'type', standalone: true, searchable: true }
    ],
    hasFeatures: false
  },
  'Ancestry/': {
    detailKeys: [],
    hasFeatures: true
  },
  'Community/': {
    detailKeys: [],
    hasFeatures: true
  },
  'Game Mechanics/beastforms': {
    detailKeys: [
      { key: 'tier', standalone: false, searchable: true },
      { key: 'trait_bonus', standalone: false, searchable: true },
      { key: 'evasion_bonus', standalone: false, searchable: true },
      { key: 'attack', standalone: false, searchable: true },
      { key: 'advantages', standalone: true, searchable: true }
    ],
    hasFeatures: true
  },
  'Game Mechanics/classes': {
    // hope_feature_name/hope_feature_text isn't a detail key -- it's
    // special-cased in buildTemplateData (srd-import.js) as an extra
    // entry appended to the structured `features` list, not a separate
    // mechanism. background/connection (question arrays), items, and
    // suggested_traits are left as detailsLeftoverMd (existing generic
    // leftover handling, no schema entry needed).
    detailKeys: [
      { key: 'domain_1', standalone: true, searchable: true },
      { key: 'domain_2', standalone: true, searchable: true },
      { key: 'subclass_1', standalone: true, searchable: true },
      { key: 'subclass_2', standalone: true, searchable: true },
      { key: 'suggested_armor', standalone: true, searchable: true },
      { key: 'suggested_primary', standalone: true, searchable: true },
      { key: 'suggested_secondary', standalone: true, searchable: true },
      { key: 'evasion', standalone: false, searchable: true },
      { key: 'hp', standalone: false, searchable: true }
    ],
    hasFeatures: true
  },
  'Game Mechanics/subclasses': {
    // Three tiers players advance through (Foundation -> Mastery ->
    // Specialization), each with its own feature(s) -- unlike every
    // other templated type, `features` isn't one flat list. Each
    // feature item carries a `group` (matching a featureGroups[].key)
    // so storage stays a single flat {name,text,group}[] array (no
    // rules/schema change needed for nested structure) while display
    // and the edit UI render three separate sections. Phase 14's
    // character "card" tracking will read `group` to present each
    // tier as its own card -- this is why grouping is modeled at all
    // rather than flattened with prefixed names.
    detailKeys: [
      { key: 'spellcast_trait', standalone: true, searchable: true }
    ],
    hasFeatures: true,
    featureGroups: [
      { key: 'foundation', label: 'Foundation' },
      { key: 'mastery', label: 'Mastery' },
      { key: 'specialization', label: 'Specialization' }
    ]
  }
};

function templateSchemaKey(category, subtype) {
  return category + '/' + (subtype || '');
}

// Kept in sync with the copies in codex.js and srd-import.js (small,
// not worth a shared-utils module split -- same convention as slugify
// elsewhere in this project).
function humanizeKey(key) {
  return key.replace(/_/g, ' ').replace(/\b\w/g, function (c) { return c.toUpperCase(); });
}

function getTemplateSchema(category, subtype) {
  return TEMPLATE_SCHEMAS[templateSchemaKey(category, subtype)] || null;
}

function hasTemplateSchema(category, subtype) {
  return !!getTemplateSchema(category, subtype);
}

// --- Search index (display-time-adjacent, but this one IS stored: recomputed
// on every entity save/import, not derived at render time like the Details/
// Features markdown merge in codex.js) ---------------------------------

// Punctuation-forgiving normalization so "Tier: 1", "Tier 1" match
// identically -- colons become spaces, whitespace collapses, lowercase.
// Deliberately NOT fuzzy/stemmed beyond this; see design discussion in
// session history for why (predictable > clever).
function normalizeSearchTerm(s) {
  return String(s).toLowerCase().replace(/:/g, ' ').replace(/\s+/g, ' ').trim();
}

// Builds an entity's hidden search index from its structured details/
// features, per the schema's whitelist:
//  - detailKeys with searchable:true index the qualified "key value" pair
//    always, and the bare value too when standalone:true (categorical
//    values like Trait/Range/Domain are safe alone; Tier/Level/Base Score
//    are not -- "2" collides with every tiered/leveled stat in the game).
//  - Every structured feature name indexes standalone (feature names are
//    already specific, curated data -- e.g. "Flexible" -- no key needed).
// Returns [] when there's no schema (non-template-eligible types) or the
// entity hasn't opted into useTemplate.
function computeSearchIndex(details, features, schema) {
  const idx = [];
  if (!schema) return idx;
  schema.detailKeys.forEach(function (d) {
    if (!d.searchable) return;
    const val = details && details[d.key];
    if (val === undefined || val === null || val === '') return;
    const normVal = normalizeSearchTerm(val);
    idx.push(normalizeSearchTerm(humanizeKey(d.key)) + ' ' + normVal);
    if (d.standalone) idx.push(normVal);
  });
  (features || []).forEach(function (f) {
    if (f && f.name) idx.push(normalizeSearchTerm(f.name));
  });
  return idx;
}

export { TEMPLATE_SCHEMAS, getTemplateSchema, hasTemplateSchema, normalizeSearchTerm, computeSearchIndex };
