// Player-role smoke suite. Floated at the Aug 28 2026 focus-loss retro,
// built Sep 2026 alongside the presence heartbeat redesign that removed
// one of the bug classes this suite guards (see HANDOFF.md). This is the
// only pre-deploy check that exercises the app as a signed-in PLAYER
// rather than GM -- test:rules checks permissions, not UI behavior.
//
// Run via `npm run test:e2e` only (needs the emulator-seeded custom
// token from global-setup.mjs / tests/e2e/.seed.json).
import { test, expect } from '@playwright/test';
import admin from 'firebase-admin';
import { loadSeed, signInAsPlayer } from './helpers.mjs';

let seed;

test.beforeAll(() => {
  seed = loadSeed();
  if (!admin.apps.length) admin.initializeApp({ projectId: 'demo-dcc-e2e' });
});

test('player sign-in resolves to player role, no GM-only UI', async ({ page }) => {
  await signInAsPlayer(page, seed);

  await expect(page.locator('#login-gate')).toBeHidden();
  // Role-gated nav -- updateAccessUI(role) in auth.js only shows these
  // for role === 'gm'.
  await expect(page.locator('#tab-btn-admin')).toBeHidden();
  await expect(page.locator('#tab-btn-encounters')).toBeHidden();
  await expect(page.locator('#tab-btn-stables')).toBeHidden();
  await expect(page.locator('#tab-btn-codex')).toBeVisible();
});

test('a players/{email} snapshot with no role/activeCharacterId change does not steal focus', async ({ page }) => {
  // Regression guard for the Aug 2026 bug: playerDocUnsub used to call
  // updateAccessUI() (full re-render) on every snapshot of this doc,
  // including unrelated-field writes (originally the presence
  // heartbeat, before it moved to its own collection). Fixed by gating
  // the re-render on roleChanged || activeCharacterChanged (auth.js).
  // This asserts an unrelated-field write to the SAME doc still doesn't
  // disturb an in-progress player interaction.
  await signInAsPlayer(page, seed);

  const search = page.locator('#codex-search');
  await search.click();
  await search.fill('abc');

  await admin.firestore().doc(`players/${seed.playerEmail}`).set(
    { displayName: 'E2E Player (touched)' },
    { merge: true }
  );
  await page.waitForTimeout(500); // let a spurious re-render happen, if the bug regressed

  await expect(search).toBeFocused();
  await expect(search).toHaveValue('abc');
});

test('player can open a visible entity, without GM-only edit/delete controls', async ({ page }) => {
  await signInAsPlayer(page, seed);

  // Category groups (e.g. "Locations (1)") are collapsed by default --
  // expand the seeded entity's category before it's clickable.
  await page.locator('#codex-entities').getByText('Locations', { exact: true }).click();
  await page.locator('#codex-entities').getByText(seed.entityName, { exact: true }).click();

  const detail = page.locator('#codex-detail');
  await expect(detail).toContainText(seed.entityName);
  // hasFullAuthority(entity, ctx) is false for a player who doesn't own
  // this entity -- codex.js only renders the Edit/Delete action row
  // when true.
  await expect(detail.getByRole('button', { name: 'Edit', exact: true })).toHaveCount(0);
  await expect(detail.getByRole('button', { name: 'Delete', exact: true })).toHaveCount(0);
});
