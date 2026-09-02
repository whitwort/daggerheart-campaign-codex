#!/usr/bin/env node
// Copy-editing pass, step 4/4: turn approved changes from
// copyedit-review.html into a minimal patch file, importable with the
// EXISTING firestore-backup.js import path -- no new Firestore write
// code, no new batching/timestamp logic, same tool that's already
// proven against prod restores.
//
// Usage:
//   node scripts/copyedit-apply.js --in backup.json --approved copyedit-approved.json --out copyedit-patch.json
//
// Then apply it (dev first, always):
//   GOOGLE_APPLICATION_CREDENTIALS=... node scripts/firestore-backup.js \
//     import --project daggerheart-campaign-codex-dev --in copyedit-patch.json
//
// copyedit-patch.json only contains the collections/docs that actually
// changed -- firestore-backup.js's import skips any collection not
// present in the file (`dump.collections[name] || []`), so this is safe
// to run without --wipe and never touches anything outside the approved
// set. Each patched doc is the FULL original doc (from --in backup.json)
// with only the approved field(s) replaced and updatedAt bumped -- a
// set() of the whole doc, same as every other import, so no partial-
// write surprises.

const fs = require('fs');

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) { args[argv[i].slice(2)] = argv[i + 1]; i++; }
  }
  return args;
}

// Set a dotted field path ('details.tier') on a plain object, in place.
function setPath(obj, path, value) {
  const parts = path.split('.');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (typeof cur[parts[i]] !== 'object' || cur[parts[i]] === null) cur[parts[i]] = {};
    cur = cur[parts[i]];
  }
  cur[parts[parts.length - 1]] = value;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.in || !args.approved || !args.out) {
    console.error('Usage: node scripts/copyedit-apply.js --in backup.json --approved copyedit-approved.json --out copyedit-patch.json');
    process.exit(1);
  }

  const dump = JSON.parse(fs.readFileSync(args.in, 'utf8'));
  const approvedFile = JSON.parse(fs.readFileSync(args.approved, 'utf8'));
  const approved = approvedFile.approved || approvedFile;

  const byCollection = { entities: {}, loreItems: {} };

  approved.forEach(function (change) {
    // id shape: '<collection>:<docId>:<field>' -- matches copyedit-extract.js.
    const firstColon = change.id.indexOf(':');
    const lastColon = change.id.lastIndexOf(':');
    const collection = change.id.slice(0, firstColon);
    const docId = change.id.slice(firstColon + 1, lastColon);
    const field = change.id.slice(lastColon + 1);

    if (!byCollection[collection]) {
      console.error('Unknown collection in approved id: ' + change.id);
      process.exit(1);
    }

    const source = (dump.collections[collection] || []).find(function (d) { return d.id === docId; });
    if (!source) {
      console.error('Doc not found in --in backup: ' + collection + '/' + docId + ' (id ' + change.id + ')');
      process.exit(1);
    }

    if (!byCollection[collection][docId]) {
      byCollection[collection][docId] = { id: docId, data: JSON.parse(JSON.stringify(source.data)) };
    }
    setPath(byCollection[collection][docId].data, field, change.suggested);
    byCollection[collection][docId].data.updatedAt = { __type: 'timestamp', value: new Date().toISOString() };
  });

  const patch = { collections: {} };
  let total = 0;
  Object.keys(byCollection).forEach(function (collection) {
    const docs = Object.values(byCollection[collection]);
    if (docs.length) {
      patch.collections[collection] = docs;
      total += docs.length;
    }
  });

  fs.writeFileSync(args.out, JSON.stringify(patch, null, 2));
  console.log('Patched ' + total + ' docs across ' + Object.keys(patch.collections).length + ' collections -> ' + args.out);
  console.log('Apply with: node scripts/firestore-backup.js import --project <id> --in ' + args.out + '  (no --wipe)');
}

main();
