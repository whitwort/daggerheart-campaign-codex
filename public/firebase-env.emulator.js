/**
 * firebase-env.emulator.js — EMULATOR Firebase project identity, for the
 * Playwright e2e smoke suite only (tests/e2e/). Never used by dev or prod
 * CI jobs; see .github/workflows/e2e.yml.
 *
 * `demo-` prefixed projectId is a Firebase emulator convention: the SDKs
 * accept it with no real credentials and no risk of accidentally talking
 * to a live project if `useEmulator` below were ever ignored. apiKey/
 * appId are throwaway values — the emulator doesn't validate them.
 *
 * useEmulator (not part of real firebase-env.*.js files) is read by
 * firebase.js to decide whether to call connectFirestoreEmulator/
 * connectAuthEmulator, and by auth.js to decide whether to expose the
 * test-only __e2eSignIn hook. Absent (undefined) in dev/prod envs, so
 * both stay inert there by construction, not by an extra flag to forget.
 */
window.FIREBASE_ENV = {
  apiKey: 'demo-e2e-key',
  authDomain: 'localhost',
  projectId: 'demo-dcc-e2e',
  storageBucket: 'demo-dcc-e2e.appspot.com',
  messagingSenderId: '0',
  appId: '1:0:web:0',
  useEmulator: true
};
