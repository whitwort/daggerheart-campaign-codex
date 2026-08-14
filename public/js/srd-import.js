import {
  getFirestore, doc, collection, writeBatch, serverTimestamp,
  query, where, getDocs
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import { firebaseApp } from './firebase.js';
import { state } from './state.js';
import { addSource } from './sources.js';

const db = getFirestore(firebaseApp);

// All SRD-imported content is attributed to this fixed source, resolved
// (or created, on first ever import) at the start of every run — see
// ensureSrdSourceId() below. Self-configuring: doesn't depend on Gregg
// having created it first via the Admin > Sources UI.
const SRD_SOURCE_TEXT = 'Daggerheart SRD/Darrington Press: <www.darringtonpress.com/license>';

// --- SRD import (Phase 12b) ----------------------------------------------
// GM-only, driven by the Admin tab's "Import from SRD" tab (conditional on
// campaignType === 'daggerheart'). Pulls pre-parsed JSON from a GitHub repo
// (default seansbox/daggerheart-srd) that itself parses the official SRD
// PDF — much easier than us writing a PDF parser, and the upstream repo
// tracks SRD updates (e.g. the Hope & Fear expansion) automatically.
// Source shape/URL convention taken from the sibling daggerheart-encounter-
// builder project, which already imports `adversaries`/`environments` the
// same way from the same kind of repo.
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
  { key: 'weapons', category: 'Equipment', subtype: 'weapons' }
];

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

function stripBom(text) {
  return text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text;
}

function fetchSrdType(repo, key) {
  const url = 'https://raw.githubusercontent.com/' + repo + '/main/.build/03_json/' + key + '.json';
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

// Finds the SRD source by exact text match (state.allSources is already
// live for the GM — same in-memory-filter-over-fresh-query pattern used
// for entity idempotency elsewhere in this file), creating it on first
// run if it doesn't exist yet.
function ensureSrdSourceId() {
  const existing = state.allSources.find(function (s) { return s.text === SRD_SOURCE_TEXT; });
  if (existing) return Promise.resolve(existing.id);
  return addSource(SRD_SOURCE_TEXT).then(function (ref) { return ref.id; });
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

function processType(typeDef, records, progressCb, results, srdSourceId) {
  const ops = [];
  // entityId -> markdown, for entities that already exist (need their old
  // 'imported' lore looked up and deleted before the fresh one is added).
  const updateTargets = [];

  records.forEach(function (rec) {
    if (!rec.name) { results.skipped += 1; return; }
    const slug = slugify(rec.name);
    const existing = state.allEntities.find(function (e) {
      return e.category === typeDef.category
        && (typeDef.subtype ? e.subtype === typeDef.subtype : !e.subtype)
        && e.slug === slug;
    });
    const markdown = formatSrdRecord(rec);

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
          createdAt: existing.createdAt || serverTimestamp(),
          updatedAt: serverTimestamp()
        }
      });
      updateTargets.push({ entityId: existing.id, markdown: markdown });
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
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp()
        }
      });
      ops.push({
        type: 'set',
        ref: doc(collection(db, 'loreItems')),
        data: {
          entityId: entityRef.id,
          kind: 'imported',
          authorId: null,
          authorType: 'gm',
          visibility: 'all-players',
          content: markdown,
          sourceId: srdSourceId,
          order: 0,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp()
        }
      });
      results.created += 1;
    }
  });

  progressCb(typeDef.key + ': resolving lore for ' + updateTargets.length + ' existing entries...');

  // Sequentially look up + delete old 'imported' lore for updated
  // entities, then add the fresh write-up. Sequential (not parallel) to
  // stay predictable under Firestore's per-second query limits at this
  // batch size (up to ~190 entities for one type).
  let lorePromise = Promise.resolve();
  updateTargets.forEach(function (t) {
    lorePromise = lorePromise.then(function () {
      return fetchImportedLoreFor(t.entityId).then(function (loreIds) {
        loreIds.forEach(function (id) {
          ops.push({ type: 'delete', ref: doc(db, 'loreItems', id) });
        });
        ops.push({
          type: 'set',
          ref: doc(collection(db, 'loreItems')),
          data: {
            entityId: t.entityId,
            kind: 'imported',
            authorId: null,
            authorType: 'gm',
            visibility: 'all-players',
            content: t.markdown,
            sourceId: srdSourceId,
            order: 0,
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp()
          }
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
