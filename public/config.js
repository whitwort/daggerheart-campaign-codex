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

  categories: ['NPC', 'Faction', 'Location', 'Item', 'History', 'Organization', 'Event'],

  firebase: {
    apiKey: 'AIzaSyBbmp4gRn7fRIzFcK2nEgCy126Db0RhjB0',
    authDomain: 'daggerheart-campaign-codex.firebaseapp.com',
    projectId: 'daggerheart-campaign-codex',
    storageBucket: 'daggerheart-campaign-codex.firebasestorage.app',
    messagingSenderId: '621018661606',
    appId: '1:621018661606:web:3a4ac8abef07bae50bf127'
  },

  // GM identity — the one account allowed to write. Must match this value
  // in firestore.rules too (isGM() check — rules can't read this file).
  // GM is expected to sign in with Google, since that's the provider
  // whose email this matches.
  gmEmail: 'whitwort@gmail.com'
};
