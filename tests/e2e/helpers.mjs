// Shared helpers for the player-role e2e smoke suite.
import { readFileSync } from 'node:fs';

export function loadSeed() {
  return JSON.parse(readFileSync(new URL('./.seed.json', import.meta.url), 'utf8'));
}

// Drives the app's test-only sign-in hook (auth.js's window.__e2eSignIn,
// gated on firebase-env.emulator.js's useEmulator flag) with the custom
// token global-setup.mjs minted for the seeded player. Waits for
// #main-app to actually be visible -- role resolution is async
// (players/{email} onSnapshot round-trip), not synchronous with the
// sign-in call.
export async function signInAsPlayer(page, seed) {
  await page.goto('/');
  await page.waitForFunction(() => typeof window.__e2eSignIn === 'function');
  await page.evaluate((token) => window.__e2eSignIn(token), seed.token);
  await page.locator('#main-app').waitFor({ state: 'visible' });
}
