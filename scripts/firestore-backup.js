#!/usr/bin/env node
// Firestore export/import for the Codex.
//
// Usage:
//   GOOGLE_APPLICATION_CREDENTIALS=/path/key.json \
//     node scripts/firestore-backup.js export --project daggerheart-campaign-codex-dev --out backup.json
//
//   GOOGLE_APPLICATION_CREDENTIALS=/path/key.json \
//     node scripts/firestore-backup.js import --project daggerheart-campaign-codex --in backup.json [--wipe]
//
// Requires: npm install --no-save firebase-admin@12  (matches CI's deploy.yml pattern)
//
// Notes:
// - Collections covered: entities, images, joinRequests, loreItems, pins,
//   players. `_meta` is deliberately excluded — it's CI-managed deploy
//   version state, not campaign data, and importing it would clobber the
//   destination's live deployed-version doc.
// - Document IDs are preserved on import (entityId/ownerId/authorId fields
//   elsewhere in the app reference these ids directly, not Firestore refs).
// - createdAt/updatedAt/addedAt/requestedAt/uploadedAt Timestamp fields are
//   round-tripped losslessly via a {__type:'timestamp', value: isoString}
//   marker. No GeoPoint or DocumentReference fields exist in this schema
//   (verified against public/js/*.js) — this script does not handle them.
// - --wipe deletes every doc in the covered collections in the destination
//   project before writing. There is no confirmation prompt beyond the
//   flag itself — this is meant to be run deliberately, not by accident.

const fs = require('fs');
const admin = require('firebase-admin');

const COLLECTIONS = ['config', 'encounters', 'entities', 'images', 'joinRequests', 'loreItems', 'notifications', 'pins', 'players', 'sources', 'threads', 'transferRequests'];
// threads is this app's only collection with a subcollection (messages,
// Phase 14 S6). Handled explicitly below on export/import/wipe -- a flat
// top-level get() never sees subcollection docs, and deleting a thread
// doc ORPHANS its messages rather than deleting them.
const SUBCOLLECTIONS = { threads: ['messages'] };
const BATCH_LIMIT = 500;

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) { args[key] = next; i++; }
      else { args[key] = true; }
    } else {
      args._.push(a);
    }
  }
  return args;
}

function serializeValue(v) {
  if (v instanceof admin.firestore.Timestamp) {
    return { __type: 'timestamp', value: v.toDate().toISOString() };
  }
  if (Array.isArray(v)) return v.map(serializeValue);
  if (v && typeof v === 'object') {
    const out = {};
    Object.keys(v).forEach(function (k) { out[k] = serializeValue(v[k]); });
    return out;
  }
  return v;
}

function deserializeValue(v) {
  if (v && typeof v === 'object' && v.__type === 'timestamp') {
    return admin.firestore.Timestamp.fromDate(new Date(v.value));
  }
  if (Array.isArray(v)) return v.map(deserializeValue);
  if (v && typeof v === 'object') {
    const out = {};
    Object.keys(v).forEach(function (k) { out[k] = deserializeValue(v[k]); });
    return out;
  }
  return v;
}

async function runExport(db, outPath) {
  const dump = { exportedAt: new Date().toISOString(), collections: {} };
  for (const name of COLLECTIONS) {
    const snap = await db.collection(name).get();
    const entries = [];
    for (const d of snap.docs) {
      const entry = { id: d.id, data: serializeValue(d.data()) };
      for (const sub of (SUBCOLLECTIONS[name] || [])) {
        const subSnap = await d.ref.collection(sub).get();
        entry[sub] = subSnap.docs.map(function (sd) {
          return { id: sd.id, data: serializeValue(sd.data()) };
        });
      }
      entries.push(entry);
    }
    dump.collections[name] = entries;
    console.log(name + ': ' + snap.size + ' docs');
  }
  fs.writeFileSync(outPath, JSON.stringify(dump, null, 2));
  console.log('Wrote ' + outPath);
}

async function wipeCollection(db, name) {
  const snap = await db.collection(name).get();
  const refs = [];
  for (const d of snap.docs) {
    for (const sub of (SUBCOLLECTIONS[name] || [])) {
      const subSnap = await d.ref.collection(sub).get();
      subSnap.docs.forEach(function (sd) { refs.push(sd.ref); });
    }
    refs.push(d.ref);
  }
  for (let i = 0; i < refs.length; i += BATCH_LIMIT) {
    const batch = db.batch();
    refs.slice(i, i + BATCH_LIMIT).forEach(function (ref) { batch.delete(ref); });
    await batch.commit();
  }
  console.log(name + ': wiped ' + refs.length + ' docs');
}

async function runImport(db, inPath, wipe) {
  const dump = JSON.parse(fs.readFileSync(inPath, 'utf8'));
  if (wipe) {
    for (const name of COLLECTIONS) await wipeCollection(db, name);
  }
  for (const name of COLLECTIONS) {
    const docs = dump.collections[name] || [];
    let subCount = 0;
    const writes = [];
    docs.forEach(function (entry) {
      writes.push({ ref: db.collection(name).doc(entry.id), data: deserializeValue(entry.data) });
      (SUBCOLLECTIONS[name] || []).forEach(function (sub) {
        (entry[sub] || []).forEach(function (sd) {
          writes.push({ ref: db.collection(name).doc(entry.id).collection(sub).doc(sd.id), data: deserializeValue(sd.data) });
          subCount++;
        });
      });
    });
    for (let i = 0; i < writes.length; i += BATCH_LIMIT) {
      const batch = db.batch();
      writes.slice(i, i + BATCH_LIMIT).forEach(function (w) { batch.set(w.ref, w.data); });
      await batch.commit();
    }
    console.log(name + ': wrote ' + docs.length + ' docs' + (subCount ? ' (+' + subCount + ' subcollection docs)' : ''));
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const mode = args._[0];
  if (!args.project) { console.error('Missing --project'); process.exit(1); }
  if (mode !== 'export' && mode !== 'import') {
    console.error('Usage: node scripts/firestore-backup.js <export|import> --project <id> [--out file] [--in file] [--wipe]');
    process.exit(1);
  }

  admin.initializeApp({ projectId: args.project });
  const db = admin.firestore();

  if (mode === 'export') {
    if (!args.out) { console.error('Missing --out'); process.exit(1); }
    await runExport(db, args.out);
  } else {
    if (!args.in) { console.error('Missing --in'); process.exit(1); }
    await runImport(db, args.in, !!args.wipe);
  }
}

main().catch(function (err) { console.error(err); process.exit(1); });
