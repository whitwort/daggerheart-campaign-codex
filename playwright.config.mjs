// Playwright config for the player-role smoke suite (tests/e2e/).
// Run only via `npm run test:e2e` (scripts/e2e-run.sh) -- expects the
// Firebase Hosting emulator already serving public/ (with
// firebase-env.emulator.js swapped in) at baseURL below, and the
// Firestore/Auth emulators up for globalSetup + the specs themselves.
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  globalSetup: './tests/e2e/global-setup.mjs',
  timeout: 30000,
  retries: 0,
  reporter: 'list',
  use: {
    baseURL: 'http://127.0.0.1:5000',
    headless: true,
    // Sandbox-only: this container's outbound HTTPS is intercepted by a
    // proxy whose cert Chromium doesn't trust, which would otherwise
    // block the gstatic.com Firebase SDK imports. Harmless/inert on
    // GitHub Actions runners (no such proxy there) but kept rather than
    // stripped before commit, since CI environments can have the same
    // class of intercepting proxy and this suite has no need to assert
    // TLS trust chains -- that's not what it's testing.
    ignoreHTTPSErrors: true
  }
});
