/**
 * Config.gs
 *
 * Values for future Apps Script admin/import scripts (not the live UI —
 * that's public/config.js, served by Firebase Hosting; see code.gs).
 * Keep in sync with public/config.js by hand.
 */

const CONFIG = {
  campaignName: "Aether's Children",

  firebase: {
    apiKey: 'AIzaSyBbmp4gRn7fRIzFcK2nEgCy126Db0RhjB0',
    authDomain: 'daggerheart-campaign-codex.firebaseapp.com',
    projectId: 'daggerheart-campaign-codex',
    storageBucket: 'daggerheart-campaign-codex.firebasestorage.app',
    messagingSenderId: '621018661606',
    appId: '1:621018661606:web:3a4ac8abef07bae50bf127'
  },

  // GM identity — the one account allowed to write. Must match this value
  // in firestore.rules too (isGM() check) and public/config.js.
  gmEmail: 'whitwort@gmail.com'
};

/**
 * NOTE on the Firebase config object above: it is not a secret. Firebase's
 * client SDK config identifies which project to talk to; it grants no
 * access by itself. All real access control is enforced server-side by
 * Firestore security rules (see firestore.rules), not by hiding this object.
 */
