/**
 * config.js
 *
 * Campaign/deployment-specific values for the Hosting-served UI.
 * (The old config.gs mirror is gone with the Apps Script removal.)
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

  categories: ['Character', 'Faction', 'Location', 'Item', 'History', 'Organization', 'Event'],

  // Project identity comes from firebase-env.js (prod by default; the dev
  // CI job swaps in firebase-env.dev.js). Loaded by index.html before
  // this file.
  firebase: window.FIREBASE_ENV,

  // GM identity — the one account allowed to write. Must match this value
  // in firestore.rules too (isGM() check — rules can't read this file).
  // GM is expected to sign in with Google, since that's the provider
  // whose email this matches.
  gmEmail: 'whitwort@gmail.com'
};
