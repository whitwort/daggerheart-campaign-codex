import {
  getFirestore, doc, setDoc, collection, writeBatch, serverTimestamp,
  query, where, getDocs
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import { firebaseApp } from './firebase.js';
import { state } from './state.js';
import { nextSourceOrder } from './sources.js';
import { getTemplateSchema, computeSearchIndex } from './templates.js';

const db = getFirestore(firebaseApp);

// All SRD-imported content is attributed to this fixed-id source doc
// (found-or-created by ID, not text — durable against Gregg editing the
// display text later via Admin > Sources, which a text-match lookup
// would break). [text](url) link syntax, not <url> autolink syntax —
// <...> requires a scheme (http://) to parse as a link; a bare
// www.-prefixed autolink without one renders with stray literal
// "<"/">" around it.
const SRD_SOURCE_ID = 'srd-daggerheart';
const SRD_SOURCE_TEXT = 'Daggerheart SRD/Darrington Press: [www.darringtonpress.com/license](https://www.darringtonpress.com/license)';

// --- SRD import (Phase 12b; local-source pivot Phase 16) -----------------
// GM-only, driven by the Admin tab's "Import from SRD" tab (conditional on
// campaignType === 'daggerheart'). Originally pulled pre-parsed JSON from
// the seansbox/daggerheart-srd GitHub repo (which parses the official SRD
// PDF via its own Go/Marker-LLM pipeline). As of the SRD 2.0 revision
// (Aug 2026), that upstream project had not updated for the new PDF and
// showed no active maintenance signal, so extraction moved in-house: the
// SAME per-type record shape (one JSON array per SRD_TYPES key, snake_case
// field names) is now produced by hand/LLM-assisted extraction from the
// official PDF and committed to public/data/srd/*.json in THIS repo, rather
// than fetched from an external GitHub repo at runtime. See
// docs/srd-update-process.md for the full extraction process, field-shape
// reference per type, and how to apply future SRD revisions (minor or
// major) without repeating this from scratch.
//
// The repo-fetch path is kept (see fetchSrdType below) since re-pointing at
// an upstream repo if one ever resumes maintenance is a one-field change,
// not a design change — but 'local' (the default) is the maintained path
// going forward.
//
// Mapping (per Gregg's design, Phase 12b handoff): ancestries -> Ancestry,
// communities -> Community (own categories, no subtype). abilities,
// beastforms, classes, domains, subclasses -> Game Mechanics, subtype =
// the source type name. armor, consumables, items, weapons -> Equipment,
// subtype = the source type name.
//
// Idempotent by (category, subtype, slug): re-running "Update entries"
// updates existing entities in place (matched against state.allEntities,
// already live for the GM) rather than duplicating. Each entity gets
// exactly one lore item (kind 'imported') holding a markdown write-up
// built generically from the source record's fields; on update, that lore
// item is deleted and rewritten fresh (mirrors admin-db-import's "replace"
// lore semantics) rather than diffed. visibility 'all-players' throughout
// (public SRD rules text, not campaign secrets).

const SRD_TYPES = [
  { key: 'ancestries', category: 'Ancestry', subtype: null },
  { key: 'communities', category: 'Community', subtype: null },
  { key: 'abilities', category: 'Game Mechanics', subtype: 'abilities' },
  { key: 'beastforms', category: 'Game Mechanics', subtype: 'beastforms' },
  { key: 'classes', category: 'Game Mechanics', subtype: 'classes' },
  { key: 'domains', category: 'Game Mechanics', subtype: 'domains' },
  { key: 'subclasses', category: 'Game Mechanics', subtype: 'subclasses' },
  { key: 'armor', category: 'Equipment', subtype: 'armor' },
  { key: 'consumables', category: 'Equipment', subtype: 'consumables' },
  { key: 'items', category: 'Equipment', subtype: 'items' },
  { key: 'weapons', category: 'Equipment', subtype: 'weapons' },
  // Phase 16 (SRD 2.0 local-source pivot): upstream never parsed this type
  // even for SRD 1.0 (no conditions.json ever existed in their .build/
  // output) — encounters.js carried a 3-item hardcoded CORE_CONDITIONS
  // fallback (Hidden/Restrained/Vulnerable) as a result. No schema entry
  // in templates.js needed: 3 short records (name + description) pass
  // through the existing legacy formatSrdRecord path same as domains.
  { key: 'conditions', category: 'Game Mechanics', subtype: 'conditions' },
  // SRD 2.0 (Aug 2026): two new player-facing mechanics with no 1.0
  // analogue. Transformations (SRD 2.0 p.42-45) are a separate mechanic
  // from beastforms per Gregg's call (optional identity cards granted
  // by the GM: description + features + prompt questions, shaped like a
  // class record minus the stats). Stances (p.13, Brawler's Martial
  // Artist subclass) are tiered one-liners modeled like beastforms --
  // character-deck.js gives Brawlers a Stances sub-tab the way Druids
  // get Beastforms.
  { key: 'transformations', category: 'Game Mechanics', subtype: 'transformations' },
  { key: 'stances', category: 'Game Mechanics', subtype: 'stances' },
  // Phase 15 (phase-15-design.md §4.4/§4.5): the two types the sibling
  // encounter-builder project imported from this same source. Their
  // records use source-specific string encodings ("+3" atk, "8/15"
  // thresholds, "Name - Type" features) no other type shares, so each
  // carries a `normalize` pre-processor (applied in processType before
  // buildTemplateData); all other types pass records through unchanged.
  { key: 'adversaries', category: 'Adversary', subtype: null, normalize: normalizeAdversaryRecord },
  { key: 'environments', category: 'Environment', subtype: null, normalize: normalizeEnvironmentRecord }
];

// --- Phase 15 record normalizers (ported from encounter-builder's
// mapAdversaryFromSRD/mapEnvironmentFromSRD/mapFeatureFromSRD, amended
// per design §3.1 A1-A3) ------------------------------------------------

// A2: buildTemplateData routes only description/note into the flavor
// lore item, so all long-tail prose (motives, experience, impulses,
// potential adversaries) is composed into `description` as markdown
// here rather than passed through as keys (which would land as
// meta-details leftover bullets instead).
function normalizeAdversaryRecord(raw) {
  const flavor = [raw.description || ''];
  if (raw.motives_and_tactics) flavor.push('**Motives & Tactics:** ' + raw.motives_and_tactics);
  if (raw.experience) flavor.push('**Experience:** ' + raw.experience);
  return {
    name: raw.name,
    description: flavor.filter(Boolean).join('\n\n'),
    type: raw.type || 'Standard',
    tier: raw.tier,
    difficulty: raw.difficulty,
    hp: raw.hp,
    stress: raw.stress,
    thresholds: raw.thresholds || '0/0',  // "8/15" passthrough (D3)
    attack_modifier: raw.atk,             // "+3" passthrough — display formats, not import
    attack_name: raw.attack || 'Basic Attack',
    attack_range: raw.range || 'Melee',
    attack_damage: raw.damage || '',
    feature: (raw.feature || []).map(normalizeFeatureRecord)
  };
}

function normalizeEnvironmentRecord(raw) {
  const flavor = [raw.description || ''];
  if (raw.impulses) flavor.push('**Impulses:** ' + raw.impulses);
  if (raw.potential_adversaries) flavor.push('**Potential Adversaries:** ' + raw.potential_adversaries);
  return {
    name: raw.name,
    description: flavor.filter(Boolean).join('\n\n'),
    type: raw.type || 'Exploration',
    tier: raw.tier,
    difficulty: raw.difficulty,
    feature: (raw.feature || []).map(normalizeFeatureRecord)
  };
}

// "Spit Acid - Action" -> {name: "Spit Acid", text: ..., type: "Action"}.
// Greedy regex splits at the LAST "- " (A3): survives the one malformed
// source name ("Take Off- Action", no space before the hyphen), which a
// plain split(' - ') misses; hyphenated names ("Long-Term ...") have no
// space after their hyphen so can't misparse, and 0 source features
// contain a second " - " (verified against live source, design §3.1).
// Environment features' separate `question` field is deliberately
// IGNORED: it's a redundant (sometimes truncated) extraction of the
// italic GM prompt already embedded at the end of `text` in 78/78
// source features -- appending it duplicated the prompt (A1 as
// amended; caught in dev spot-check, Raging River / Dangerous
// Crossing).
function normalizeFeatureRecord(feature) {
  const rawName = String(feature.name || '');
  const m = rawName.match(/^(.*\S)\s*-\s+(\S.*)$/);
  const name = m ? m[1] : rawName;
  const type = m ? m[2] : 'Passive';
  return { name: name || 'Feature', text: feature.text || '', type: type };
}

// Kept in sync with the copies in codex.js/import.js (small, not worth a
// shared-utils module split).
function slugify(name) {
  return name.toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function humanizeKey(key) {
  return key.replace(/_/g, ' ').replace(/\b\w/g, function (c) { return c.toUpperCase(); });
}

// Generic markdown formatter: every SRD record type has a different field
// set, but they all decompose into the same handful of shapes (a
// description/note string, scalar stat fields, arrays of {name,text}
// features, arrays of {question} prompts, or domains' array-of-arrays card
// list) — so one formatter covers all 11 types instead of 11 bespoke ones.
function formatSrdRecord(rec) {
  const lines = [];
  if (rec.description) { lines.push(rec.description, ''); }
  if (rec.note) { lines.push('*' + rec.note + '*', ''); }

  const scalarKeys = [];
  const featureArrayKeys = [];
  const questionArrayKeys = [];

  Object.keys(rec).forEach(function (key) {
    if (key === 'name' || key === 'description' || key === 'note') return;
    const val = rec[key];
    if (Array.isArray(val)) {
      if (val.length === 0) return;
      if (Array.isArray(val[0])) {
        lines.push('### ' + humanizeKey(key));
        val.forEach(function (group, i) {
          lines.push('- Level ' + (i + 1) + ': ' + group.join(', '));
        });
        lines.push('');
      } else if (val[0] && typeof val[0] === 'object' && 'question' in val[0]) {
        questionArrayKeys.push(key);
      } else if (val[0] && typeof val[0] === 'object' && 'name' in val[0] && 'text' in val[0]) {
        featureArrayKeys.push(key);
      }
    } else if (val !== null && val !== undefined && val !== '') {
      scalarKeys.push(key);
    }
  });

  if (scalarKeys.length) {
    lines.push('### Details');
    scalarKeys.forEach(function (key) {
      lines.push('- **' + humanizeKey(key) + ':** ' + rec[key]);
    });
    lines.push('');
  }

  questionArrayKeys.forEach(function (key) {
    lines.push('### ' + humanizeKey(key));
    rec[key].forEach(function (item) { lines.push('- ' + item.question); });
    lines.push('');
  });

  featureArrayKeys.forEach(function (key) {
    lines.push('### ' + humanizeKey(key));
    rec[key].forEach(function (item) {
      lines.push('**' + item.name + '.** ' + item.text, '');
    });
  });

  return lines.join('\n').trim();
}

// Structured-template pilot (Weapons/Armor/Abilities): splits a record
// into { details, features, flavorMd, detailsLeftoverMd, featuresLeftoverMd }
// instead of one markdown blob. Whitelisted scalar keys (schema.detailKeys)
// become the entity's structured `details`; the feature array (if
// schema.hasFeatures) becomes structured `features`. Everything else
// long-tail (non-whitelisted scalars, question arrays, other feature-
// shaped arrays) becomes markdown -- scalars/questions bucketed as
// "details leftover", other {name,text} arrays as "features leftover" --
// each destined for its matching 'meta-details'/'meta-features' lore item,
// where codex.js's display-time merge prepends the structured data as a
// matching "### Details"/"### Feature" block (see codex.js
// resolveLoreItemMarkdown). description/note (none of the 3 pilot types
// currently have either) become the "flavor" lore item.
function buildTemplateData(rec, schema) {
  const details = {};
  const usedKeys = { name: true, description: true, note: true };

  schema.detailKeys.forEach(function (d) {
    const val = rec[d.key];
    if (val !== null && val !== undefined && val !== '') details[d.key] = String(val);
    usedKeys[d.key] = true;
  });

  let features = [];
  if (schema.hasFeatures) {
    if (schema.featureGroups && schema.featureGroupsFromArray) {
      // Ancestry (Phase 14 S7, §11.1): source has one flat rec.feature
      // array, group assigned by position -- NOT per-key arrays like
      // subclasses use in the branch below. Every current SRD ancestry
      // carries exactly 2 (verified), but guard defensively: extra
      // entries beyond featureGroups.length are still imported, just
      // left ungrouped (no false badge/pick-slot), rather than dropped.
      usedKeys.feature = true;
      if (Array.isArray(rec.feature)) {
        rec.feature.forEach(function (f, i) {
          const g = schema.featureGroups[i];
          features.push({ name: f.name, text: f.text, group: g ? g.key : null });
        });
      }
    } else if (schema.featureGroups) {
      schema.featureGroups.forEach(function (g) {
        usedKeys[g.key] = true;
        if (Array.isArray(rec[g.key])) {
          rec[g.key].forEach(function (f) { features.push({ name: f.name, text: f.text, group: g.key }); });
        }
      });
    } else {
      usedKeys.feature = true;
      if (Array.isArray(rec.feature)) {
        features = rec.feature.map(function (f) {
          const out = { name: f.name, text: f.text };
          // Phase 15 (D5): schemas with hasFeatureType carry the
          // normalizer-split Action/Passive/Reaction on each feature.
          // Gated so other types' features never gain the key, and
          // conditional on presence so Firestore never sees undefined.
          if (schema.hasFeatureType && f.type) out.type = f.type;
          return out;
        });
      }
      // Classes: hope_feature_name/hope_feature_text is a single extra
      // feature, not a separate mechanism -- appended to the same
      // structured features list rather than modeled as its own field.
      usedKeys.hope_feature_name = true;
      usedKeys.hope_feature_text = true;
      if (rec.hope_feature_name && rec.hope_feature_text) {
        features.push({ name: rec.hope_feature_name, text: rec.hope_feature_text });
      }
    }
  }

  const flavorLines = [];
  if (rec.description) flavorLines.push(rec.description, '');
  if (rec.note) flavorLines.push('*' + rec.note + '*', '');

  const detailLeftoverLines = [];
  const featureLeftoverLines = [];
  Object.keys(rec).forEach(function (key) {
    if (usedKeys[key]) return;
    const val = rec[key];
    if (val === null || val === undefined || val === '') return;
    if (Array.isArray(val)) {
      if (!val.length) return;
      if (val[0] && typeof val[0] === 'object' && 'name' in val[0] && 'text' in val[0]) {
        val.forEach(function (item) { featureLeftoverLines.push('**' + item.name + '.** ' + item.text, ''); });
      } else if (val[0] && typeof val[0] === 'object' && 'question' in val[0]) {
        detailLeftoverLines.push('### ' + humanizeKey(key));
        val.forEach(function (item) { detailLeftoverLines.push('- ' + item.question); });
        detailLeftoverLines.push('');
      }
      // array-of-arrays (domains' "card") not used by any pilot type; skip.
    } else if (key === 'text') {
      // Freeform prose field (e.g. an ability's effect text) -- its own
      // paragraph, not a "- **Text:** ..." bullet.
      detailLeftoverLines.push(val, '');
    } else {
      detailLeftoverLines.push('- **' + humanizeKey(key) + ':** ' + val);
    }
  });

  return {
    details: details,
    features: features,
    flavorMd: flavorLines.join('\n').trim(),
    detailsLeftoverMd: detailLeftoverLines.join('\n').trim(),
    featuresLeftoverMd: featureLeftoverLines.join('\n').trim()
  };
}

function stripBom(text) {
  return text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text;
}

// repo === 'local' (the default, see admin.js) reads our own committed
// JSON, same shape as the old upstream .build/03_json output. Any other
// value is treated as a GitHub 'owner/repo' and fetched the original way,
// in case an upstream project (this one or a future replacement) is ever
// worth pointing at again — see docs/srd-update-process.md.
function fetchSrdType(repo, key) {
  const url = (!repo || repo === 'local')
    ? '/data/srd/' + key + '.json'
    : 'https://raw.githubusercontent.com/' + repo + '/main/.build/03_json/' + key + '.json';
  return fetch(url).then(function (res) {
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return res.text();
  }).then(function (text) {
    return JSON.parse(stripBom(text));
  });
}

function fetchImportedLoreFor(entityId) {
  const q = query(collection(db, 'loreItems'), where('entityId', '==', entityId), where('kind', '==', 'imported'));
  return getDocs(q).then(function (snap) {
    const out = [];
    snap.forEach(function (d) { out.push(d.id); });
    return out;
  });
}

// Firestore writeBatch cap is 500 ops.
function commitOpsChunked(ops, progressCb) {
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
        else batch.set(op.ref, op.data);
      });
      return batch.commit().then(function () {
        committed += chunk.length;
        progressCb('Writing... ' + committed + '/' + ops.length);
      });
    });
  });
  return p;
}

// Finds the SRD source by its fixed doc id (state.allSources is already
// live for the GM — same in-memory-filter-over-fresh-query pattern used
// for entity idempotency elsewhere in this file), creating it with the
// default text on first run only. If Gregg has since edited the text via
// Admin > Sources, that edit is left alone — we never overwrite it.
function ensureSrdSourceId() {
  const existing = state.allSources.find(function (s) { return s.id === SRD_SOURCE_ID; });
  if (existing) return Promise.resolve(existing.id);
  return setDoc(doc(db, 'sources', SRD_SOURCE_ID), {
    text: SRD_SOURCE_TEXT, order: nextSourceOrder(), createdAt: serverTimestamp(), updatedAt: serverTimestamp()
  }).then(function () { return SRD_SOURCE_ID; });
}

function runSrdImport(repo, progressCb) {
  const results = { created: 0, updated: 0, skipped: 0, errors: [] };

  return ensureSrdSourceId().then(function (srdSourceId) {
    let chain = Promise.resolve();
    SRD_TYPES.forEach(function (typeDef) {
      chain = chain.then(function () {
        progressCb('Fetching ' + typeDef.key + '...');
        return fetchSrdType(repo, typeDef.key).then(function (records) {
          return processType(typeDef, records, progressCb, results, srdSourceId);
        }).catch(function (err) {
          results.errors.push(typeDef.key + ': ' + err.message);
          progressCb(typeDef.key + ' FAILED: ' + err.message);
        });
      });
    });
    return chain.then(function () { return results; });
  });
}

// Builds the 1-3 lore item payloads (entityId filled in by the caller)
// for one record. Template-schema types: 'flavor' (meta: null) if
// description/note present, 'meta-details' if the entity has structured
// details or detail-shaped leftover text, 'meta-features' if it has
// structured features or feature-shaped leftover text -- the anchor items
// are created even with empty content so codex.js's display-time merge
// always has somewhere to attach the synthesized block. Legacy types get
// exactly one (meta: null, full formatSrdRecord blob) -- unchanged.
function buildLoreDocs(rec, schema, templ) {
  if (!schema) {
    return [{ meta: null, content: formatSrdRecord(rec) }];
  }
  const docsOut = [];
  if (templ.flavorMd) docsOut.push({ meta: null, content: templ.flavorMd });
  if (Object.keys(templ.details).length || templ.detailsLeftoverMd) {
    docsOut.push({ meta: 'meta-details', content: templ.detailsLeftoverMd });
  }
  if (schema.hasFeatures && (templ.features.length || templ.featuresLeftoverMd)) {
    docsOut.push({ meta: 'meta-features', content: templ.featuresLeftoverMd });
  }
  return docsOut;
}

function processType(typeDef, records, progressCb, results, srdSourceId) {
  const ops = [];
  const schema = getTemplateSchema(typeDef.category, typeDef.subtype);
  // entityId -> lore docs to (re)write, for entities that already exist
  // (need their old 'imported' lore looked up and deleted before the
  // fresh one is added).
  const updateTargets = [];

  records.forEach(function (rec) {
    // Phase 15: type-specific pre-processor (adversaries/environments
    // only) reshapes the raw record into what buildTemplateData +
    // the schema whitelist expect; every other type passes through.
    if (typeDef.normalize) rec = typeDef.normalize(rec);
    if (!rec.name) { results.skipped += 1; return; }
    const slug = slugify(rec.name);
    const existing = state.allEntities.find(function (e) {
      return e.category === typeDef.category
        && (typeDef.subtype ? e.subtype === typeDef.subtype : !e.subtype)
        && e.slug === slug;
    });
    const templ = schema ? buildTemplateData(rec, schema) : null;
    const templateFields = schema
      ? { useTemplate: true, details: templ.details, features: templ.features, searchIndex: computeSearchIndex(templ.details, templ.features, schema) }
      : { useTemplate: false, details: {}, features: [], searchIndex: [] };
    const loreDocs = buildLoreDocs(rec, schema, templ);

    if (existing) {
      ops.push({
        type: 'set',
        ref: doc(db, 'entities', existing.id),
        data: {
          slug: slug,
          name: rec.name,
          category: typeDef.category,
          subtype: typeDef.subtype || null,
          parentId: existing.parentId || null,
          relatedIds: existing.relatedIds || [],
          tags: existing.tags || [],
          ancestry: null,
          aliases: [],
          date: null,
          ownerId: null,
          hasMapImage: existing.hasMapImage || false,
          visibility: existing.visibility || 'all-players',
          sourceId: srdSourceId,
          useTemplate: templateFields.useTemplate,
          details: templateFields.details,
          features: templateFields.features,
          searchIndex: templateFields.searchIndex,
          createdAt: existing.createdAt || serverTimestamp(),
          updatedAt: serverTimestamp()
        }
      });
      updateTargets.push({ entityId: existing.id, loreDocs: loreDocs });
      results.updated += 1;
    } else {
      const entityRef = doc(collection(db, 'entities'));
      ops.push({
        type: 'set',
        ref: entityRef,
        data: {
          slug: slug,
          name: rec.name,
          category: typeDef.category,
          subtype: typeDef.subtype || null,
          parentId: null,
          relatedIds: [],
          tags: [],
          ancestry: null,
          aliases: [],
          date: null,
          ownerId: null,
          hasMapImage: false,
          visibility: 'all-players',
          sourceId: srdSourceId,
          useTemplate: templateFields.useTemplate,
          details: templateFields.details,
          features: templateFields.features,
          searchIndex: templateFields.searchIndex,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp()
        }
      });
      loreDocs.forEach(function (ld, i) {
        ops.push({
          type: 'set',
          ref: doc(collection(db, 'loreItems')),
          data: {
            entityId: entityRef.id,
            kind: 'imported',
            authorId: null,
            authorType: 'gm',
            visibility: 'all-players',
            content: ld.content,
            meta: ld.meta,
            sourceId: srdSourceId,
            order: i,
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp()
          }
        });
      });
      results.created += 1;
    }
  });

  progressCb(typeDef.key + ': resolving lore for ' + updateTargets.length + ' existing entries...');

  // Sequentially look up + delete old 'imported' lore for updated
  // entities, then add the fresh write-up(s). Sequential (not parallel)
  // to stay predictable under Firestore's per-second query limits at
  // this batch size (up to ~190 entities for one type).
  let lorePromise = Promise.resolve();
  updateTargets.forEach(function (t) {
    lorePromise = lorePromise.then(function () {
      return fetchImportedLoreFor(t.entityId).then(function (loreIds) {
        loreIds.forEach(function (id) {
          ops.push({ type: 'delete', ref: doc(db, 'loreItems', id) });
        });
        t.loreDocs.forEach(function (ld, i) {
          ops.push({
            type: 'set',
            ref: doc(collection(db, 'loreItems')),
            data: {
              entityId: t.entityId,
              kind: 'imported',
              authorId: null,
              authorType: 'gm',
              visibility: 'all-players',
              content: ld.content,
              meta: ld.meta,
              sourceId: srdSourceId,
              order: i,
              createdAt: serverTimestamp(),
              updatedAt: serverTimestamp()
            }
          });
        });
      });
    });
  });

  return lorePromise.then(function () {
    progressCb(typeDef.key + ': writing ' + ops.length + ' operations...');
    return commitOpsChunked(ops, progressCb);
  });
}

export { runSrdImport };
