// Playwright global setup for the player-role e2e smoke suite.
//
// Run only via `npm run test:e2e` (scripts/e2e-run.sh), which wraps
// `firebase emulators:exec --only firestore,auth,hosting` — that sets
// FIRESTORE_EMULATOR_HOST / FIREBASE_AUTH_EMULATOR_HOST, which the Admin
// SDK auto-detects. Never talks to a real project: initializeApp below
// takes no credentials, which the Admin SDK only permits against an
// emulator host.
//
// Writes tests/e2e/.seed.json (gitignored) with the data the spec files
// need to reference (custom token, seeded entity name, player email) —
// keeps the seed's IDs/values in one place instead of duplicated magic
// strings in each spec.
import admin from 'firebase-admin';
import { writeFileSync } from 'node:fs';

const PROJECT_ID = 'demo-dcc-e2e';
const PLAYER_EMAIL = 'e2e-player@example.com';
const PLAYER_UID = 'e2e-player-uid';
const ENTITY_NAME = 'E2E Test Location';
const OTHER_ENTITY_NAME = 'E2E GM-Only Faction';

export default async function globalSetup() {
  admin.initializeApp({ projectId: PROJECT_ID });
  const auth = admin.auth();
  const db = admin.firestore();

  // email must be a real profile field on the emulator user (not a custom
  // claim) -- firestore.rules' isPlayer()/isGM() key off request.auth.
  // token.email, which the ID token only populates from the user's own
  // Auth profile.
  await auth.createUser({ uid: PLAYER_UID, email: PLAYER_EMAIL, emailVerified: true });
  const token = await auth.createCustomToken(PLAYER_UID);

  // players/{email} doc existence == role 'player' (see firestore.rules
  // isPlayer(), auth.js's playerDocUnsub). Admin SDK writes bypass rules
  // entirely, so this only needs to satisfy the app's READ path, not
  // isValidEntity()-style write schemas.
  await db.doc(`players/${PLAYER_EMAIL}`).set({
    email: PLAYER_EMAIL,
    displayName: 'E2E Player',
    addedAt: admin.firestore.FieldValue.serverTimestamp()
  });

  // One player-visible entity (for the detail-view flow) and one that
  // would only be full-authority-editable by the GM (to assert Edit/
  // Delete stay absent for a non-owning player -- codex.js's
  // hasFullAuthority gate).
  await db.doc('entities/e2e-visible-entity').set({
    name: ENTITY_NAME,
    category: 'Location',
    visibility: 'all-players',
    description: 'Seeded by tests/e2e/global-setup.mjs.'
  });
  await db.doc('entities/e2e-gm-only-entity').set({
    name: OTHER_ENTITY_NAME,
    category: 'Faction',
    visibility: 'all-players',
    description: 'Seeded by tests/e2e/global-setup.mjs.'
  });

  writeFileSync(
    new URL('./.seed.json', import.meta.url),
    JSON.stringify({ token, playerEmail: PLAYER_EMAIL, entityName: ENTITY_NAME, otherEntityName: OTHER_ENTITY_NAME }, null, 2)
  );
}
