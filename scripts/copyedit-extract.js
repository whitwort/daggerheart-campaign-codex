#!/usr/bin/env node
// Copy-editing pass, step 1/4: pull copyeditable text out of a
// firestore-backup.js export into a flat review list.
//
// Usage:
//   node scripts/copyedit-extract.js --in backup.json --out copyedit-items.json
//
// Scope (Gregg's call, Sep 2026): loreItems.content, and every string
// value inside entities.details. NOT entity names, NOT feature text
// (features[].text) -- explicitly excluded. loreItems.encounterRevealMd
// is system-generated (Run state machine) and also excluded -- it isn't
// prose to hand-edit, it's regenerated on every Start/Complete/Reset.
//
// Each item gets a stable id (collection:docId:field, field is 'content'
// for loreItems or 'details.<key>' for entities) so copyedit-apply.js can
// find its way back to the exact field without re-parsing anything.

const fs = require('fs');

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) { args[argv[i].slice(2)] = argv[i + 1]; i++; }
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.in || !args.out) {
    console.error('Usage: node scripts/copyedit-extract.js --in backup.json --out copyedit-items.json');
    process.exit(1);
  }

  const dump = JSON.parse(fs.readFileSync(args.in, 'utf8'));
  const entities = dump.collections.entities || [];
  const loreItems = dump.collections.loreItems || [];

  const entityById = {};
  entities.forEach(function (e) { entityById[e.id] = e.data; });

  const items = [];

  entities.forEach(function (e) {
    const details = e.data.details;
    if (!details || typeof details !== 'object') return;
    Object.keys(details).forEach(function (key) {
      const val = details[key];
      if (typeof val !== 'string' || val.trim() === '') return;
      items.push({
        id: 'entities:' + e.id + ':details.' + key,
        collection: 'entities',
        docId: e.id,
        field: 'details.' + key,
        context: (e.data.category || '?') + (e.data.subtype ? '/' + e.data.subtype : '') +
          ' — "' + (e.data.name || e.id) + '" — ' + key,
        original: val
      });
    });
  });

  loreItems.forEach(function (li) {
    const val = li.data.content;
    if (typeof val !== 'string' || val.trim() === '') return;
    const parent = entityById[li.data.entityId];
    const parentName = parent ? parent.name : (li.data.entityId || '?');
    items.push({
      id: 'loreItems:' + li.id + ':content',
      collection: 'loreItems',
      docId: li.id,
      field: 'content',
      context: parentName + ' — ' + (li.data.kind || 'lore') + (li.data.meta ? ' (' + li.data.meta + ')' : ''),
      original: val
    });
  });

  fs.writeFileSync(args.out, JSON.stringify({ items: items }, null, 2));
  console.log('Extracted ' + items.length + ' items (' +
    items.filter(function (i) { return i.collection === 'entities'; }).length + ' details, ' +
    items.filter(function (i) { return i.collection === 'loreItems'; }).length + ' lore) -> ' + args.out);
}

main();
