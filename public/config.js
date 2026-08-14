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

  categories: ['Character', 'Faction', 'Location', 'Item', 'World Facts', 'Organization', 'Event', 'Scene', 'Ancestry', 'Community', 'Game Mechanics', 'Equipment'],

  // "Meta" entry types: categories that describe rules/lore-as-fact
  // rather than something with a physical presence in the world, so they
  // never get a map pin. Excluded from the Map tab's pin-target picker
  // and legend. Adjust freely — this is the one place that list lives.
  metaCategories: ['World Facts', 'Game Mechanics', 'Ancestry', 'Community', 'Equipment'],

  // Subtype options for the two categories that carry one (Phase 12b, SRD
  // import). Matches the source SRD JSON type names verbatim (see
  // srd-import.js) so imported and manually-created entries use the same
  // vocabulary. Categories not listed here don't offer a subtype field.
  subtypesByCategory: {
    'Game Mechanics': ['abilities', 'beastforms', 'classes', 'domains', 'subclasses', "Aether's Children"],
    'Equipment': ['armor', 'consumables', 'items', 'weapons']
  },

  // Icons used for entry links across the app (Entry Browser map links,
  // Entry Card map link, map breadcrumb). One place to swap the glyphs.
  icons: {
    map: '\u{1F5FA}\u{FE0F}',   // \u{1F5FA}\u{FE0F} = 🗺️
    codex: '\u{1F4D6}'          // \u{1F4D6} = 📖
  },

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
