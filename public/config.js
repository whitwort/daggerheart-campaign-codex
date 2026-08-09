/**
 * config.js
 *
 * Campaign/deployment-specific values for the Hosting-served UI. Mirrors
 * config.gs (which still holds the same values for Apps Script's
 * admin/import-only use) — keep the two in sync by hand for now; there's
 * no build step tying them together.
 *
 * Firebase config below is not a secret — it identifies which project to
 * talk to, grants no access by itself. Real access control is Firestore
 * security rules (firestore.rules) and Firebase Auth provider identity,
 * not this file.
 */

window.APP_CONFIG = {
  campaignName: "Aether's Children",

  tabs: {
    map: 'Map',
    codex: 'Codex'
  },

  categories: ['NPC', 'Faction', 'Location', 'Item', 'History', 'Organization', 'Event'],

  // Path to the base map image, relative to public/. Drop the file in
  // public/maps/ and update this path, then redeploy (push to main) —
  // see README for the full "add your own map" steps. Note: as of Phase
  // 6a this is only used as a one-time seed value when the `maps`
  // Firestore collection is empty (bootstraps the root map doc). Once
  // that doc exists, editing this value does nothing — update the doc's
  // `image` field directly (e.g. via the Firebase console) instead.
  mapImage: 'maps/genesis-map.webp',

  firebase: {
    apiKey: 'AIzaSyBbmp4gRn7fRIzFcK2nEgCy126Db0RhjB0',
    authDomain: 'daggerheart-campaign-codex.firebaseapp.com',
    projectId: 'daggerheart-campaign-codex',
    storageBucket: 'daggerheart-campaign-codex.firebasestorage.app',
    messagingSenderId: '621018661606',
    appId: '1:621018661606:web:3a4ac8abef07bae50bf127'
  },

  // GM identity — the one account allowed to write. Must match this value
  // in firestore.rules too (isGM() check) and config.gs (rules can't read
  // either file). GM is expected to sign in with Google, since that's the
  // provider whose email this matches.
  gmEmail: 'whitwort@gmail.com'
};
