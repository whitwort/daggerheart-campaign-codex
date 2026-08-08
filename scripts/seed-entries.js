// One-off script: bulk-seed data/seed-entries.json into the entries
// collection. Not part of the deployed app — run manually from a
// Codespace/local machine with Node + firebase-admin installed.
//
// Setup:
//   1. Firebase console > Project settings > Service accounts >
//      Generate new private key. Save the downloaded file as
//      scripts/service-account.json (gitignored, never commit it).
//   2. npm install firebase-admin (in scripts/, or repo root — no
//      package.json is committed, so this is a local-only install).
//   3. node scripts/seed-entries.js
//
// Safe to re-run: uses entry.id as the doc ID, so re-running overwrites
// the same docs rather than duplicating them.

const admin = require('firebase-admin');
const path = require('path');
const fs = require('fs');

const serviceAccountPath = path.join(__dirname, 'service-account.json');
if (!fs.existsSync(serviceAccountPath)) {
  console.error('Missing scripts/service-account.json — see setup notes at the top of this file.');
  process.exit(1);
}

const serviceAccount = require(serviceAccountPath);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();

const seedPath = path.join(__dirname, '..', 'data', 'seed-entries.json');
const entries = JSON.parse(fs.readFileSync(seedPath, 'utf8'));

async function run() {
  const batch = db.batch();

  entries.forEach(function (entry) {
    const id = entry.id;
    const data = Object.assign({}, entry);
    delete data.id; // id is the doc ID, not a field

    const ref = db.collection('entries').doc(id);
    batch.set(ref, data);
  });

  await batch.commit();
  console.log('Seeded ' + entries.length + ' entries into Firestore.');
}

run().catch(function (err) {
  console.error('Seed failed:', err);
  process.exit(1);
});
