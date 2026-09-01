// Firestore Security Rules unit tests, run against the local emulator
// (never a live project — @firebase/rules-unit-testing's testEnv talks
// only to FIRESTORE_EMULATOR_HOST). Invoke via `npm run test:rules`
// (wraps `firebase emulators:exec`, which starts/stops the emulator and
// sets that env var). Do not run this file directly with `node --test`
// outside that wrapper — there will be no emulator to connect to.
//
// Coverage is deliberately narrow: the invariants firestore.rules'
// comments call load-bearing (ownsCharacter gating, presence isolation,
// character-edited's split-recipient update clause, self-release,
// default-deny) — not exhaustive per-field fuzzing. Add a case here
// whenever a rules bug reaches prod; that's the trigger, not "test
// everything up front."
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  initializeTestEnvironment, assertSucceeds, assertFails
} from '@firebase/rules-unit-testing';

const GM_EMAIL = 'whitwort@gmail.com'; // must match firestore.rules' isGM()

let testEnv;

before(async () => {
  testEnv = await initializeTestEnvironment({
    projectId: 'rules-test',
    firestore: {
      rules: readFileSync('firestore.rules', 'utf8'),
      host: '127.0.0.1',
      port: 8080
    }
  });
});

after(async () => {
  await testEnv.cleanup();
});

function gmCtx() {
  return testEnv.authenticatedContext('gm-uid', { email: GM_EMAIL });
}
function playerCtx(email) {
  return testEnv.authenticatedContext(email.replace(/[^a-z0-9]/gi, '-'), { email });
}

// Seed data as the GM/admin (rules bypassed) between tests.
async function withSecurityRulesDisabled(fn) {
  await testEnv.withSecurityRulesDisabled(async (ctx) => { await fn(ctx.firestore()); });
}

test.beforeEach(async () => { await testEnv.clearFirestore(); });

test('presence: player can create own doc with lastOnline only', async () => {
  const db = playerCtx('alice@example.com').firestore();
  await assertSucceeds(
    db.doc('presence/alice@example.com').set({ lastOnline: new Date() })
  );
});

test('presence: player cannot create another player\'s doc', async () => {
  const db = playerCtx('alice@example.com').firestore();
  await assertFails(
    db.doc('presence/bob@example.com').set({ lastOnline: new Date() })
  );
});

test('presence: player cannot smuggle extra fields into their own doc', async () => {
  const db = playerCtx('alice@example.com').firestore();
  await assertFails(
    db.doc('presence/alice@example.com').set({ lastOnline: new Date(), activeCharacterId: 'x' })
  );
});

test('presence: player cannot read presence (GM-only read, incl. own doc)', async () => {
  await withSecurityRulesDisabled(async (db) => {
    await db.doc('presence/alice@example.com').set({ lastOnline: new Date() });
  });
  const db = playerCtx('alice@example.com').firestore();
  await assertFails(db.doc('presence/alice@example.com').get());
});

test('entities: player may create their own Character', async () => {
  await withSecurityRulesDisabled(async (db) => {
    await db.doc('players/alice@example.com').set({ activeCharacterId: null });
  });
  const db = playerCtx('alice@example.com').firestore();
  await assertSucceeds(db.collection('entities').add({
    slug: 'alices-pc', name: 'Alice\'s PC', category: 'Character', subtype: '',
    parentId: null, relatedIds: [], visibility: 'gm-only', ownerId: 'alice@example.com'
  }));
});

test('entities: player cannot create a Character owned by someone else', async () => {
  await withSecurityRulesDisabled(async (db) => {
    await db.doc('players/alice@example.com').set({ activeCharacterId: null });
  });
  const db = playerCtx('alice@example.com').firestore();
  await assertFails(db.collection('entities').add({
    slug: 'bobs-pc', name: 'Bob\'s PC', category: 'Character', subtype: '',
    parentId: null, relatedIds: [], visibility: 'gm-only', ownerId: 'bob@example.com'
  }));
});

test('entities: player cannot create a non-Character entity', async () => {
  await withSecurityRulesDisabled(async (db) => {
    await db.doc('players/alice@example.com').set({ activeCharacterId: null });
  });
  const db = playerCtx('alice@example.com').firestore();
  await assertFails(db.collection('entities').add({
    slug: 'a-location', name: 'A Location', category: 'Location', subtype: '',
    parentId: null, relatedIds: [], visibility: 'gm-only'
  }));
});

test('entities: owning player can edit their Character but not reassign ownerId/category', async () => {
  let charId;
  await withSecurityRulesDisabled(async (db) => {
    await db.doc('players/alice@example.com').set({ activeCharacterId: null });
    const ref = await db.collection('entities').add({
      slug: 'alices-pc', name: 'Alice\'s PC', category: 'Character', subtype: '',
      parentId: null, relatedIds: [], visibility: 'gm-only', ownerId: 'alice@example.com'
    });
    charId = ref.id;
  });
  const db = playerCtx('alice@example.com').firestore();
  await assertSucceeds(db.doc(`entities/${charId}`).update({ name: 'Renamed PC' }));
  await assertFails(db.doc(`entities/${charId}`).update({ ownerId: 'bob@example.com' }));
  await assertFails(db.doc(`entities/${charId}`).update({ category: 'Location' }));
});

test('entities: self-release (ownerId -> null, nothing else) is allowed', async () => {
  let charId;
  await withSecurityRulesDisabled(async (db) => {
    await db.doc('players/alice@example.com').set({ activeCharacterId: null });
    const ref = await db.collection('entities').add({
      slug: 'alices-pc', name: 'Alice\'s PC', category: 'Character', subtype: '',
      parentId: null, relatedIds: [], visibility: 'gm-only', ownerId: 'alice@example.com'
    });
    charId = ref.id;
  });
  const db = playerCtx('alice@example.com').firestore();
  await assertSucceeds(db.doc(`entities/${charId}`).update({ ownerId: null, updatedAt: new Date() }));
});

test('entities: self-release cannot piggyback another field change', async () => {
  let charId;
  await withSecurityRulesDisabled(async (db) => {
    await db.doc('players/alice@example.com').set({ activeCharacterId: null });
    const ref = await db.collection('entities').add({
      slug: 'alices-pc', name: 'Alice\'s PC', category: 'Character', subtype: '',
      parentId: null, relatedIds: [], visibility: 'gm-only', ownerId: 'alice@example.com'
    });
    charId = ref.id;
  });
  const db = playerCtx('alice@example.com').firestore();
  await assertFails(db.doc(`entities/${charId}`).update({ ownerId: null, name: 'Sneaky rename' }));
});

test('notifications: owning player may refresh a character-edited doc (createdAt/seenAt only)', async () => {
  let charId;
  await withSecurityRulesDisabled(async (db) => {
    await db.doc('players/alice@example.com').set({ activeCharacterId: null });
    const ref = await db.collection('entities').add({
      slug: 'alices-pc', name: 'Alice\'s PC', category: 'Character', subtype: '',
      parentId: null, relatedIds: [], visibility: 'gm-only', ownerId: 'alice@example.com'
    });
    charId = ref.id;
    await db.doc(`notifications/charedit-${charId}`).set({
      recipientEmail: GM_EMAIL, kind: 'character-edited', entityId: charId,
      createdAt: new Date(), seenAt: null
    });
  });
  const db = playerCtx('alice@example.com').firestore();
  await assertSucceeds(
    db.doc(`notifications/charedit-${charId}`).update({ createdAt: new Date() })
  );
});

test('notifications: owning player cannot touch recipientEmail on a character-edited doc', async () => {
  let charId;
  await withSecurityRulesDisabled(async (db) => {
    await db.doc('players/alice@example.com').set({ activeCharacterId: null });
    const ref = await db.collection('entities').add({
      slug: 'alices-pc', name: 'Alice\'s PC', category: 'Character', subtype: '',
      parentId: null, relatedIds: [], visibility: 'gm-only', ownerId: 'alice@example.com'
    });
    charId = ref.id;
    await db.doc(`notifications/charedit-${charId}`).set({
      recipientEmail: GM_EMAIL, kind: 'character-edited', entityId: charId,
      createdAt: new Date(), seenAt: null
    });
  });
  const db = playerCtx('alice@example.com').firestore();
  await assertFails(
    db.doc(`notifications/charedit-${charId}`).update({ recipientEmail: 'alice@example.com' })
  );
});

test('notifications: a stranger cannot flip seenAt on someone else\'s notification', async () => {
  await withSecurityRulesDisabled(async (db) => {
    await db.doc('players/alice@example.com').set({ activeCharacterId: null });
    await db.doc('players/bob@example.com').set({ activeCharacterId: null });
    await db.doc('notifications/n1').set({
      recipientEmail: 'alice@example.com', kind: 'discovered', entityId: 'e1',
      createdAt: new Date(), seenAt: null
    });
  });
  const db = playerCtx('bob@example.com').firestore();
  await assertFails(db.doc('notifications/n1').update({ seenAt: new Date() }));
});

test('joinRequests: a user can only create their own request doc', async () => {
  const db = playerCtx('alice@example.com').firestore();
  await assertSucceeds(db.doc('joinRequests/alice@example.com').set({ requestedAt: new Date() }));
  await assertFails(db.doc('joinRequests/bob@example.com').set({ requestedAt: new Date() }));
});

test('default deny: unmatched collection is unreadable and unwritable, even for GM', async () => {
  const gm = gmCtx().firestore();
  await assertFails(gm.doc('somethingUnmatched/doc1').set({ x: 1 }));
  await assertFails(gm.doc('somethingUnmatched/doc1').get());
});
