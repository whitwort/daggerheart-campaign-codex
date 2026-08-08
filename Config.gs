/**
 * Config.gs
 *
 * All campaign/deployment-specific values live here. Source logic elsewhere
 * in this project should never hardcode a campaign name, GM email, or
 * Firebase project — read from CONFIG instead, so this repo stays reusable
 * for other GMs standing up their own instance.
 *
 * To deploy your own campaign: fill in the values below, or (once built)
 * use the in-app GM setup flow instead of editing this file directly.
 */

const CONFIG = {
  // App identity — shown in UI, not used for auth/security.
  campaignName: '__CAMPAIGN_NAME__',

  // Tab labels — override if "Codex" / "Map" don't fit your setting.
  tabs: {
    map: 'Map',
    codex: 'Codex'
  },

  // Firebase project config (client-side; safe to be public — see note below).
  // Get this from Firebase console > Project Settings > General > Your apps > Web app.
  firebase: {
    apiKey: 'AIzaSyBbmp4gRn7fRIzFcK2nEgCy126Db0RhjB0',
    authDomain: 'daggerheart-campaign-codex.firebaseapp.com',
    projectId: 'daggerheart-campaign-codex',
    storageBucket: 'daggerheart-campaign-codex.firebasestorage.app',
    messagingSenderId: '621018661606',
    appId: '1:621018661606:web:3a4ac8abef07bae50bf127'
  },

  // GM identity — the one account allowed to write. Must match this value
  // in firestore.rules too (isGM() check) since rules can't read this file.
  gmEmail: 'whitwort@gmail.com'
};

/**
 * NOTE on the Firebase config object above: it is not a secret. Firebase's
 * client SDK config identifies which project to talk to; it grants no
 * access by itself. All real access control is enforced server-side by
 * Firestore security rules (see firestore.rules), not by hiding this object.
 */
