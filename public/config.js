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

  categories: ['Character', 'Faction', 'Location', 'World Facts', 'Organization', 'Event', 'Scene', 'Ancestry', 'Community', 'Game Mechanics', 'Equipment', 'Adversary', 'Environment'],

  // "Meta" entry types: categories that describe rules/lore-as-fact
  // rather than something with a physical presence in the world, so they
  // never get a map pin. Excluded from the Map tab's pin-target picker
  // and legend. Adjust freely — this is the one place that list lives.
  metaCategories: ['World Facts', 'Game Mechanics', 'Ancestry', 'Community', 'Equipment'],

  // Subtype options for the two categories that carry one (Phase 12b, SRD
  // import). Matches the source SRD JSON type names verbatim (see
  // srd-import.js) so imported and manually-created entries use the same
  // vocabulary. Categories not listed here don't offer a subtype field.
  // 'conditions' is the one exception -- not an SRD-import type (the
  // upstream repo has no structured Conditions JSON, see chat), hand-
  // added for manually-entered Condition entries (Hidden, Restrained,
  // Poisoned, etc.).
  subtypesByCategory: {
    'Game Mechanics': ['abilities', 'beastforms', 'campaign-mechanics', 'classes', 'conditions', 'domains', 'stances', 'subclasses', 'transformations', "Aether's Children"],
    'Equipment': ['armor', 'consumables', 'items', 'weapons']
  },

  // Icons used for entry links across the app (Entry Browser map links,
  // Entry Card map link, map breadcrumb, gallery portrait/map badges).
  // One place to swap the glyphs. These are Lucide (lucide.dev, ISC
  // license) SVG markup, assigned via .innerHTML (not .textContent) at
  // each call site. Icons use stroke="currentColor" so they pick up
  // color from the containing element's `color` CSS property.
  icons: {
    // "book-marked" -- chosen over map/compass/pin variants (Gregg's
    // call: reads as the campaign's own map icon).
    map: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.106 5.553a2 2 0 0 0 1.788 0l3.659-1.83A1 1 0 0 1 21 4.619v12.764a1 1 0 0 1-.553.894l-4.553 2.277a2 2 0 0 1-1.788 0l-4.212-2.106a2 2 0 0 0-1.788 0l-3.659 1.83A1 1 0 0 1 3 19.381V6.618a1 1 0 0 1 .553-.894l4.553-2.277a2 2 0 0 1 1.788 0z"/><path d="M15 5.764v15"/><path d="M9 3.236v15"/></svg>',
    // "scroll-text"
    codex: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 12h-5"/><path d="M15 8h-5"/><path d="M19 17V5a2 2 0 0 0-2-2H4"/><path d="M8 21h12a2 2 0 0 0 2-2v-1a1 1 0 0 0-1-1H11a1 1 0 0 0-1 1v1a2 2 0 1 1-4 0V5a2 2 0 1 0-4 0v2a1 1 0 0 0 1 1h3"/></svg>',
    // "image" -- replaces the hardcoded star (\u2605) used as the
    // gallery "current portrait" indicator.
    portrait: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="18" x="3" y="3" rx="2" ry="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/></svg>',
    // "external-link" -- the web-standard "pop out" glyph (a box with an
    // arrow escaping its top-right corner). Phase 14 S8: long lore
    // item's "open in window" affordance.
    popout: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/></svg>'
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
