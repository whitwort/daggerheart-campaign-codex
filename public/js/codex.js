import {
  getFirestore, collection, onSnapshot, doc, setDoc, addDoc, updateDoc, deleteDoc,
  query, where, writeBatch, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import { firebaseApp, CONFIG } from './firebase.js';
import { state } from './state.js';
import { attachListener, detachListener, safeSnapshotHandler } from './listeners.js';
import { trackWrite } from './connectivity.js';
import { renderMarkdownInto } from './markdown.js';
import { renderAdminRootEntitySelect, renderAdminPlayersList } from './admin.js';
import { parseDateSpec, formatDateSegments } from './dates.js';
import { buildSourceSelect, renderSourceLabel, registerSourcesChangeHandler, confirmRevealWithoutSource, sortedSources } from './sources.js';
import {
  uploadEntityGalleryImage, deleteEntityGalleryImage, setGalleryImageVisibility, setGalleryImageSource,
  setEntityPortrait, setEntityMap, clearEntityMap, migrateLegacyMapImageIfNeeded
} from './images.js';
import { getTemplateSchema, normalizeSearchTerm, computeSearchIndex } from './templates.js';

const db = getFirestore(firebaseApp);

// --- Codex tab: entities + loreItems (Phase 8 schema) -----------------------
// `entities` unifies lore entries and locations; per-entity content lives
// in `loreItems` docs with individual visibility. The old `entries`
// collection (content_gm/content_player fields) is dead — wipe decision,
// no migration. UI labels: the list pane is the "Table of Contents", the
// detail pane is "My Knowledge" (both internal-facing terms only, the
// underlying data model is still `entities`/`entities` collection).
const searchEl = document.getElementById('codex-search');
const listEl = document.getElementById('codex-entities');
const detailEl = document.getElementById('codex-detail');
const detailPaneEl = document.getElementById('codex-detail-pane');
const newEntityBtn = document.getElementById('codex-new-btn');
const codexTabEl = document.getElementById('codex-tab');
const buildVersionEl = document.getElementById('build-version');

// Reserve room for the version-label footer (#build-version, a normal
// in-flow element after #main-app) in every JS-measured viewport-fit
// height -- without this, sizing a tab to fill exactly to
// window.innerHeight pushes the footer just past the visible viewport,
// needing an extra scroll the whole point of this fit was to avoid.
// Shared by Codex/Map/Timeline's fit functions (each imports this).
function footerReserve() {
  if (!buildVersionEl) return 0;
  const cs = window.getComputedStyle(buildVersionEl);
  return buildVersionEl.offsetHeight + parseFloat(cs.marginTop || '0');
}

// Phase 13 layout fix: same pattern as Timeline's fitLayoutHeight
// (timeline.js) -- CSS alone can't know how much vertical space
// header/nav/filters above this row consume without duplicating that
// measurement here, so it's measured live instead. Without this,
// #codex-entities' own overflow-y:auto only bounded ITS height; the
// pane as a whole still grew past the viewport on short screens
// (subtype-nested groups, several filter rows), pushing +New Entry
// off the bottom and forcing a page scroll the internal scrollbar
// was supposed to make unnecessary. Recomputed on load, on switching
// to this tab, and on resize.
function fitCodexTabHeight() {
  if (!codexTabEl) return;
  const panel = document.getElementById('codex-panel');
  if (!panel || !panel.classList.contains('active')) return;
  const rect = codexTabEl.getBoundingClientRect();
  // #codex-detail-pane carries a negative margin-top (flush-align fix,
  // see styles.css) so its own box pokes above #codex-tab's own top
  // edge by that amount. That poke isn't clipped by anything and
  // wasn't accounted for here, so it silently added its full height
  // to the page's total scrollable content beyond what this function
  // already budgets for -- exactly enough overflow (a few px) to
  // trigger an otherwise-pointless page-level vertical scrollbar on
  // every load. Read the actual live value (matches the "keep in
  // sync via getComputedStyle" pattern map.js already uses for
  // #map-well's padding) rather than hardcoding it, so this keeps
  // working if that CSS value ever changes.
  const detailPane = document.getElementById('codex-detail-pane');
  const poke = detailPane ? Math.abs(Math.min(0, parseFloat(window.getComputedStyle(detailPane).marginTop) || 0)) : 0;
  // +2px safety margin: 0.45rem doesn't convert to a whole px, and
  // Chrome/Firefox can round that math slightly differently -- without
  // this, Chrome was still showing a stray 1-2px vertical scrollbar
  // (Firefox happened to round the other way and didn't). A couple
  // extra px of unused space at the bottom is imperceptible; a
  // pointless scrollbar isn't.
  const h = window.innerHeight - rect.top - 16 - footerReserve() - poke - 2;
  codexTabEl.style.height = Math.max(320, h) + 'px';
}
window.addEventListener('resize', fitCodexTabHeight);
// iOS Safari's dynamic toolbar (address bar) hasn't necessarily
// settled to its final collapsed/expanded height at initial page
// load -- window.innerHeight read right away can be off, which is why
// this was sizing wrong on first load and only correcting itself once
// something (e.g. a scroll, which forces the toolbar to settle) fired
// a plain 'resize'. window.visualViewport's own 'resize' event fires
// specifically on toolbar collapse/expand, which plain window resize
// doesn't reliably catch; the one-shot delayed re-check covers browsers
// without visualViewport support as a fallback.
if (window.visualViewport) {
  window.visualViewport.addEventListener('resize', fitCodexTabHeight);
}
setTimeout(fitCodexTabHeight, 300);
// Second, later one-shot: 300ms wasn't always enough margin for iOS
// Safari's toolbar to finish settling on a fresh cold load (reported
// as "still needs a manual nudge" even with the 300ms check in
// place) -- cheap insurance, not a fix in itself.
setTimeout(fitCodexTabHeight, 1000);
// Distinct failure mode from toolbar-settling: web font swap
// (Comfortaa/Inter loading in) reflows the header/nav this pane's
// height is measured against (rect.top in fitCodexTabHeight), AFTER
// the timeouts above may have already fired and measured the
// pre-swap layout -- neither a window resize nor a visualViewport
// resize fires for a font-driven reflow, so it was invisible to both
// existing listeners. document.fonts.ready catches this directly.
if (window.document && document.fonts && document.fonts.ready) {
  document.fonts.ready.then(fitCodexTabHeight);
}

// slug: human-readable debugging/import aid, NOT the canonical key (auto
// doc ID is). Regenerated from name on every save; uniqueness is only
// softly enforced at import time. Kept in sync with import.js's copy.
function slugify(name) {
  return name.toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// Kept in sync with the copy in srd-import.js (small, not worth a
// shared-utils module split -- same convention as slugify above).
function humanizeKey(key) {
  return key.replace(/_/g, ' ').replace(/\b\w/g, function (c) { return c.toUpperCase(); });
}

// Resolves the subtype a draft's category/subtype pair should be saved
// and looked up under -- categories without a subtypesByCategory list
// never carry one, matching saveEntityEdit's own resolution.
function draftSubtype(draft) {
  return ((CONFIG.subtypesByCategory[draft.category] || []).length && draft.subtype) ? draft.subtype : null;
}

// Lore item 'meta' field: enum ('', 'meta', 'meta-details', 'meta-features'),
// null/absent on the doc means none. Legacy docs from before this enum
// (boolean true) still normalize to 'meta' for editing/badge purposes.
function normalizeMetaForEdit(v) {
  if (v === 'meta-details' || v === 'meta-features' || v === 'meta') return v;
  return v ? 'meta' : '';
}
function metaBadgeLabel(v) {
  if (v === 'meta-details') return 'Meta \u00b7 Details';
  if (v === 'meta-features') return 'Meta \u00b7 Features';
  if (v) return 'Meta';
  return null;
}

// CSS class carrying the entry-type dot/pin color (see styles.css "Pin
// color legend" block — single place to edit colors). Mirrors
// categoryPinClass() in map.js; kept local since codex.js and map.js
// don't share a small-utils module.
function categoryPinClassLocal(category) {
  const slug = (category || 'default').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return 'pin-cat-' + (slug || 'default');
}


// Listener-attachment invariant (Phase 7a): only attach once hasAccess
// is true — Firestore permanently kills a listener on permission-denied
// and never retries. Callers (auth.js) own that gating.
function attachCodexListeners() {
  attachListener('entitiesUnsub', function () {
    return onSnapshot(collection(db, 'entities'), safeSnapshotHandler('entities', function (snapshot) {
      state.allEntities = [];
      snapshot.forEach(function (docSnap) {
        state.allEntities.push(Object.assign({ id: docSnap.id }, docSnap.data()));
      });
      renderList();
      renderDetailForSelected();
      renderAdminRootEntitySelect();
      renderAdminPlayersList();
      notifyVisibilityChange();
    }), function (err) {
      listEl.innerHTML = '<p>Error loading entities: ' + err.message + '</p>';
    });
  });

  attachListener('loreItemsUnsub', function () {
    return onSnapshot(collection(db, 'loreItems'), safeSnapshotHandler('loreItems', function (snapshot) {
      state.allLoreItems = [];
      snapshot.forEach(function (docSnap) {
        state.allLoreItems.push(Object.assign({ id: docSnap.id }, docSnap.data()));
      });
      // Lore visibility affects which entities appear in the player
      // list and which pins render, not just the open detail.
      renderList();
      renderDetailForSelected();
      notifyVisibilityChange();
    }), function (err) {
      detailEl.innerHTML = '<p>Error loading lore: ' + err.message + '</p>';
    });
  });
}

function detachCodexListeners() {
  detachListener('entitiesUnsub');
  detachListener('loreItemsUnsub');
  setEntityImagesTarget(null);
}

// --- Per-entity images listener -----------------------------------------
// Image docs carry base64 payloads (up to ~750KB each), so a whole-
// collection listener is off the table — we live-listen only to the one
// entity currently selected. Manual lifecycle, same deliberate-exception
// stance as mapImageUnsub.
function setEntityImagesTarget(entityId) {
  if (state.entityImagesTargetId === entityId && state.entityImagesUnsub) return;
  if (state.entityImagesUnsub) {
    state.entityImagesUnsub();
    state.entityImagesUnsub = null;
  }
  state.entityImagesTargetId = entityId;
  state.currentEntityImages = [];
  if (!entityId) return;
  state.entityImagesUnsub = onSnapshot(
    query(collection(db, 'images'), where('ownerId', '==', entityId)),
    safeSnapshotHandler('entityImages', function (snapshot) {
      if (state.entityImagesTargetId !== entityId) return; // stale snapshot after retarget
      state.currentEntityImages = [];
      snapshot.forEach(function (docSnap) {
        state.currentEntityImages.push(Object.assign({ id: docSnap.id }, docSnap.data()));
      });
      // One-time, idempotent: an entity's old standalone map image
      // (pre-Gallery-tab-Set-map) becomes a normal gallery image with
      // isMap:true. GM-only (write access), no-op once already migrated
      // — see migrateLegacyMapImageIfNeeded's own comment (images.js).
      if (state.currentRole === 'gm') {
        migrateLegacyMapImageIfNeeded(entityId, state.currentEntityImages);
      }
      renderDetailForSelected();
    }),
    function (err) {
      console.error('entity images listener error:', err.message);
    });
}

function galleryImagesFor(entityId, gmView) {
  return state.currentEntityImages
    .filter(function (img) {
      return img.ownerId === entityId && img.role === 'gallery'
        && (gmView || img.visibility === 'all-players');
    })
    .sort(function (a, b) {
      const oa = typeof a.sortOrder === 'number' ? a.sortOrder : null;
      const ob = typeof b.sortOrder === 'number' ? b.sortOrder : null;
      if (oa !== null && ob !== null) return oa - ob;
      if (oa !== null) return -1;
      if (ob !== null) return 1;
      const ta = (a.uploadedAt && a.uploadedAt.toMillis) ? a.uploadedAt.toMillis() : 0;
      const tb = (b.uploadedAt && b.uploadedAt.toMillis) ? b.uploadedAt.toMillis() : 0;
      return ta - tb;
    });
}

// Entity card gallery hero header. Locked design from
// portrait-picker-dialog-mockup-v6 (see codex-handoff_6.md): card-level
// diagonal mask on a wrapper div (not the <img>), manual cover-fit +
// px transform (object-fit/object-position can't give arbitrary pan
// range for aspect-mismatched sources), stepped zoom, two-axis edge
// fade on the image itself. Scoped to #codex-detail only for now.
const PORTRAIT_ZOOM_STEP_FACTOR = 0.12; // ~12% per step, per mockup
const PORTRAIT_MAX_ZOOM_STEPS = 8;
const PORTRAIT_MIN_ZOOM_STEPS = -8;
const PORTRAIT_MIN_ZOOM_MULT = 0.2; // floor for the zoom multiplier at deep negative steps
const PORTRAIT_MIN_OVERLAP_FRAC = 0.28; // mid-point of mockup's tunable 22-35% range
// GROWING BAND MODEL (replaced the fixed 2.2:1 aspect band): the hero
// band's height follows the image — its bottom edge IS the image's
// bottom edge (the band's min-height is set from y+scaledH each
// render; the in-flow heading still provides a floor). The image is an
// object floating on the card: at V-fade 0 the whole image is visible
// down to its real bottom edge, with no window clipping it mid-image.
// Scale derives from the band WIDTH only (base = bandWidth/imgWidth,
// i.e. 100% zoom = image width fills the card), so there is no circular
// dependency between band height and image size. Vertical drag crops
// the image's TOP only (y <= 0); the bottom is always fully shown.

// While the Set portrait dialog's edit stage is open, the card should
// show the in-progress (unsaved) crop rather than the committed one —
// this lets the drag/zoom/fade controls preview live on the actual card,
// per the locked redesign. Cleared on Save/Cancel.
let portraitPreviewOverride = null; // { entityId, img } | null

// Returns the entity's current portrait image doc (isPortrait flag), or
// falls back to the first gallery image in sort order if none is flagged
// yet (covers pre-portrait-feature galleries without a separate migration
// step). Respects gmView the same way galleryImagesFor does, so a
// gm-only portrait never shows to players.
function portraitImageFor(entity, gmView) {
  if (portraitPreviewOverride && portraitPreviewOverride.entityId === entity.id) {
    return portraitPreviewOverride.img;
  }
  const images = galleryImagesFor(entity.id, gmView);
  if (!images.length) return null;
  return images.find(function (img) { return img.isPortrait; }) || images[0];
}

// Scale from band width only — see GROWING BAND MODEL note above.
function portraitCurrentScale(img, cw) {
  const base = cw / img.width;
  const step = typeof img.portraitZoomStep === 'number' ? img.portraitZoomStep : 0;
  return base * Math.max(PORTRAIT_MIN_ZOOM_MULT, 1 + step * PORTRAIT_ZOOM_STEP_FACTOR);
}

// ox/oy here are the *scaled* px offsets being tested (not yet clamped or
// converted to/from the stored fractions).
// X: relaxed clamp per the original spec — under-coverage allowed on
//    either side (card background shows through; the H fade softens the
//    image's own left edge), with a MIN_OVERLAP floor so the image can't
//    be dragged fully out of view horizontally.
// Y: the band grows to the image's bottom edge, so y > 0 would just be
//    a pointless gap above the image — clamp to y <= 0 (drag up crops
//    the top), keeping at least MIN_OVERLAP of the image's own height
//    visible.
function portraitClampOffset(img, cw, ch, ox, oy) {
  const scale = portraitCurrentScale(img, cw);
  const scaledW = img.width * scale, scaledH = img.height * scale;
  const minOverlapX = cw * PORTRAIT_MIN_OVERLAP_FRAC;
  const minX = Math.min(0, cw - scaledW) - (cw - minOverlapX);
  const maxX = 0 + (cw - minOverlapX);
  const minY = -scaledH * (1 - PORTRAIT_MIN_OVERLAP_FRAC);
  return { x: Math.max(minX, Math.min(maxX, ox)), y: Math.max(minY, Math.min(0, oy)) };
}

// Stored offsets are fractions of the *scaled* image size at the current
// zoom step, so the crop reproduces the same relative framing regardless
// of the rendering container's actual pixel size (card vs. dialog
// preview, different screen widths, etc).
function portraitOffsetFracToPx(img, cw, ch) {
  const scale = portraitCurrentScale(img, cw);
  const scaledW = img.width * scale, scaledH = img.height * scale;
  const fx = typeof img.portraitOffsetXFrac === 'number' ? img.portraitOffsetXFrac : 0;
  const fy = typeof img.portraitOffsetYFrac === 'number' ? img.portraitOffsetYFrac : 0;
  return portraitClampOffset(img, cw, ch, fx * scaledW, fy * scaledH);
}

function portraitOffsetPxToFrac(img, cw, ch, px, py) {
  const scale = portraitCurrentScale(img, cw);
  const scaledW = img.width * scale, scaledH = img.height * scale;
  return { xFrac: scaledW ? px / scaledW : 0, yFrac: scaledH ? py / scaledH : 0 };
}

// Two independently-masked nested wrappers (nested single-mask elements
// multiply naturally; no mask-composite anywhere — iOS Safari support
// for it is unverified).
//
// ANCHORING (the fix for the long-running "hard line" bug): gradients
// are anchored in px to the IMAGE'S OWN visible edges, not the
// container's. The image is an object floating on the card — it may
// legally under-cover the band (relaxed clamp, original spec), so a
// container-anchored gradient can reach full opacity before the image
// actually ends, leaving the raw element edge exposed as a hard line.
// Anchored to the edge itself, the fade always begins exactly where the
// image ends, at any drag position or zoom:
// - H fades the image's left edge: transparent at the edge's x, opaque
//   over a run of (pct/45 · container width).
// - V fades the image's bottom edge the same way.
// - At 0% the mask is removed entirely: the hard line IS the image's
//   real edge, which is the intended meaning of "no fade".
// - An edge that sits outside the view (image continues past the band)
//   anchors at the container edge (max(0, …)), which degenerates to the
//   old container-anchored behavior for covering crops.
function portraitApplyEdgeFade(hWrapEl, vWrapEl, img, geom) {
  const hPct = typeof img.portraitFadeH === 'number' ? img.portraitFadeH : 12;
  const vPct = typeof img.portraitFadeV === 'number' ? img.portraitFadeV : 12;
  if (hPct <= 0) {
    hWrapEl.style.webkitMaskImage = '';
    hWrapEl.style.maskImage = '';
  } else {
    const leftEdge = Math.max(0, geom.x);
    const hRun = (hPct / 45) * geom.cw;
    const hGrad = 'linear-gradient(to right, transparent ' + leftEdge.toFixed(1) + 'px, black ' + (leftEdge + hRun).toFixed(1) + 'px)';
    hWrapEl.style.webkitMaskImage = hGrad;
    hWrapEl.style.maskImage = hGrad;
  }
  if (vPct <= 0) {
    vWrapEl.style.webkitMaskImage = '';
    vWrapEl.style.maskImage = '';
  } else {
    const bottomGap = Math.max(0, geom.ch - (geom.y + geom.ih));
    const vRun = (vPct / 45) * geom.ch;
    const vGrad = 'linear-gradient(to top, transparent ' + bottomGap.toFixed(1) + 'px, black ' + (bottomGap + vRun).toFixed(1) + 'px)';
    vWrapEl.style.webkitMaskImage = vGrad;
    vWrapEl.style.maskImage = vGrad;
  }
}

// Renders img (a portrait-flagged image doc, using its saved crop state)
// into imgEl, sized to containerEl's current dimensions, with the edge
// fade applied to hWrapEl/vWrapEl (see portraitApplyEdgeFade — the fade
// needs the computed geometry, so it's applied here, after layout math).
function portraitRenderInto(imgEl, hWrapEl, vWrapEl, containerEl, img) {
  const cw = containerEl.clientWidth;
  if (!img.width || !img.height || !cw) return;
  const scale = portraitCurrentScale(img, cw);
  const clamped = portraitOffsetFracToPx(img, cw, 0);
  const iw = img.width * scale, ih = img.height * scale;
  imgEl.style.width = iw + 'px';
  imgEl.style.height = ih + 'px';
  imgEl.style.transform = 'translate(' + clamped.x + 'px, ' + clamped.y + 'px)';
  // Background layer: the band's bottom edge is the image's bottom edge
  // (y <= 0, so visible image height is y+ih). Absolute layer — height
  // is explicit, nothing in flow depends on it.
  const band = containerEl.parentElement;
  if (band && band.classList.contains('codex-card-hero-band')) {
    // Band takes no layout space (absolute, z-index 0) — its height is
    // purely decorative and must never exceed the card's own height
    // (set entirely by the normal-flow content next to it), or the
    // image visibly pokes out past the bottom of the card well. This
    // only bites on very wide screens: scale is cw-driven (see
    // portraitCurrentScale), so a wide card produces a tall band with
    // no natural ceiling otherwise.
    const card = band.parentElement;
    const cardHeight = card ? card.clientHeight : Infinity;
    band.style.height = Math.min(cardHeight, Math.max(0, clamped.y + ih)) + 'px';
  }
  const ch = containerEl.clientHeight;
  portraitApplyEdgeFade(hWrapEl, vWrapEl, img, { cw: cw, ch: ch, x: clamped.x, y: clamped.y, iw: iw, ih: ih });
}

// Builds the #codex-card-hero wrapper (card-level 45deg mask + hero img)
// to prepend to #codex-detail. Card-level mask, per the locked design, is
// CSS-only (styles.css) on .codex-card-hero — this only sizes/positions
// the <img> inside it.
let cardHeroState = null; // { imgEl, hWrapEl, vWrapEl, containerEl, portrait } | null
// live=false (used by read-only cards rendered outside the Codex tab, e.g.
// Timeline/Map entry-card panels) skips the shared cardHeroState/
// ResizeObserver singleton entirely -- that machinery assumes exactly one
// hero exists at a time (portraitObserveContainer unobserves whichever
// element it last tracked), so a second simultaneously-rendered hero would
// steal live resize-tracking away from the real Codex tab card. Read-only
// cards don't need it (no portrait-editing entry point in read-only mode)
// -- they still get one correctly-sized initial layout via the
// requestAnimationFrame call below, just no ongoing resize tracking.
function buildCardHero(entity, portrait, live) {
  if (live === undefined) live = true;
  const heroWrap = document.createElement('div');
  heroWrap.className = 'codex-card-hero';
  const hWrap = document.createElement('div');
  hWrap.className = 'codex-hero-fade';
  const vWrap = document.createElement('div');
  vWrap.className = 'codex-hero-fade';
  const imgEl = document.createElement('img');
  imgEl.className = 'codex-hero-img';
  imgEl.src = portrait.data;
  imgEl.alt = '';
  vWrap.appendChild(imgEl);
  hWrap.appendChild(vWrap);
  heroWrap.appendChild(hWrap);
  if (live) {
    cardHeroState = { imgEl: imgEl, hWrapEl: hWrap, vWrapEl: vWrap, containerEl: heroWrap, portrait: portrait };
    portraitObserveContainer(heroWrap);
  }
  requestAnimationFrame(function () { portraitRenderInto(imgEl, hWrap, vWrap, heroWrap, portrait); });
  return heroWrap;
}
let portraitResizeObserver = null;
let portraitObservedEl = null;
function portraitObserveContainer(el) {
  if (portraitObservedEl === el) return;
  if (!portraitResizeObserver) {
    portraitResizeObserver = new ResizeObserver(function () {
      // Deferred to next frame: the callback below mutates band.style.height,
      // and heroWrap (the observed element) sizes against band via CSS — a
      // synchronous mutation here resizes the observed element from inside
      // its own callback, which is exactly the pattern that trips browsers'
      // "ResizeObserver loop completed with undelivered notifications"
      // warning. Deferring breaks the same-frame self-trigger.
      requestAnimationFrame(function () {
        if (cardHeroState && cardHeroState.containerEl.isConnected) {
          portraitRenderInto(cardHeroState.imgEl, cardHeroState.hWrapEl, cardHeroState.vWrapEl, cardHeroState.containerEl, cardHeroState.portrait);
        }
      });
    });
  }
  if (portraitObservedEl) portraitResizeObserver.unobserve(portraitObservedEl);
  portraitResizeObserver.observe(el);
  portraitObservedEl = el;
}

// Modules whose rendering depends on lore visibility (map.js: pin
// filtering) register here — codex.js can't import map.js back without a
// module cycle, so the dependency is inverted.
const visibilityChangeHandlers = [];
function registerVisibilityChangeHandler(fn) {
  visibilityChangeHandlers.push(fn);
}
function notifyVisibilityChange() {
  visibilityChangeHandlers.forEach(function (fn) { fn(); });
}

// Live-refresh the currently-rendered card (source labels/dropdowns)
// whenever a GM edit to the Sources list comes in.
registerSourcesChangeHandler(function () { renderDetailForSelected(); });

// map.js registers its "switch to Map tab and load this Location's map"
// function here (same inverted-dependency pattern as above).
let mapNavigationHandler = null;
function registerMapNavigationHandler(fn) {
  mapNavigationHandler = fn;
}

// --- Visibility model ---------------------------------------------------
// Entities carry an explicit visibility flag ('gm-only' | 'all-players')
// controlling whether players see the entity at all (list, pins, related
// chips). Within a visible entity, loreItems keep their own per-item
// visibility. All client-side render logic per the locked security model.
// Docs missing the field (pre-flag test data) are treated as gm-only.

function isGmView() {
  return state.currentRole === 'gm' && !state.gmPreviewAsPlayer;
}

// --- Nav-strip role switcher (global, not per-card) -----------------------
// GM: "View" dropdown (GM/Player) drives the existing gmPreviewAsPlayer
// simulation. True player: "Character" dropdown is a placeholder for now
// (values to be populated in a future phase) — shown but inert.
const navViewSwitcherEl = document.getElementById('nav-view-switcher');
const navCharacterSwitcherEl = document.getElementById('nav-character-switcher');
const gmViewSelect = document.getElementById('gm-view-select');
function updateGmToolbar() {
  navViewSwitcherEl.style.display = (state.currentRole === 'gm') ? '' : 'none';
  navCharacterSwitcherEl.style.display = (state.currentRole === 'player') ? '' : 'none';
  if (state.currentRole === 'gm') {
    gmViewSelect.value = state.gmPreviewAsPlayer ? 'player' : 'gm';
  }
}
gmViewSelect.addEventListener('change', function () {
  state.gmPreviewAsPlayer = (gmViewSelect.value === 'player');
  updateGmToolbar();
  renderList();
  renderDetailForSelected();
  notifyVisibilityChange();
});

// Authorship model: authorType is 'gm' (authorId null) or 'character'
// (authorId = the authoring Player Character's entities/ doc id — never a
// player's uid/email). "Written by" tracks in-fiction knowledge, not who's
// at the table: a player owns one or more PCs (admin.js players/ +
// entities.ownerId=email), and a PC's authorship survives the PC's death.
// So "can this player see an author-only item" resolves through the
// authoring character's owner, not the item itself.
function loreItemVisibleToPlayer(item) {
  if (item.visibility === 'all-players') return true;
  if (item.visibility !== 'author-only') return false;
  if (item.authorType !== 'character' || !item.authorId || !state.currentUser) return false;
  const authorEntity = state.allEntities.find(function (e) { return e.id === item.authorId; });
  return !!authorEntity && authorEntity.ownerId === state.currentUser.email;
}

function loreItemsForEntity(entityId, gmView) {
  return state.allLoreItems
    .filter(function (item) { return item.entityId === entityId; })
    .filter(function (item) { return gmView || loreItemVisibleToPlayer(item); })
    .sort(function (a, b) { return (a.order || 0) - (b.order || 0); });
}

// Display-time merge (structured template pilot, refined per Gregg):
// entity.details/features are NEVER rendered as a standalone block --
// instead the FIRST 'meta-details'/'meta-features' lore item (in this
// viewer's visible, order-sorted list) gets the structured data
// synthesized into a "### Details"/"### Feature" block matching the
// original SRD markdown's own formatting, prepended to whatever the item
// already holds (SRD leftover bullets like weapon Damage, or anything
// Gregg hand-adds). Later items sharing the same meta value render
// exactly as authored. Stored content is never rewritten -- this runs
// fresh on every render, so editing details/features or re-running SRD
// import is reflected immediately with no lore item migration needed.
function buildDetailsMarkdown(entity) {
  const schema = getTemplateSchema(entity.category, entity.subtype);
  const details = entity.details || {};
  // Iterate the schema's fixed detailKeys order (same order the edit form
  // uses), not Object.keys(details) -- Firestore/JSON key order isn't
  // guaranteed consistent across entities, which was producing different
  // Details orderings entry to entry.
  const orderedKeys = schema ? schema.detailKeys.map(function (d) { return d.key; }) : Object.keys(details);
  const lines = [];
  orderedKeys.forEach(function (k) {
    if (details[k] === undefined || details[k] === null || details[k] === '') return;
    lines.push('- **' + humanizeKey(k) + ':** ' + details[k]);
  });
  if (!lines.length) return '';
  return ['### Details'].concat(lines).join('\n');
}
function buildFeaturesMarkdown(entity) {
  const feats = entity.features || [];
  if (!feats.length) return '';
  const schema = getTemplateSchema(entity.category, entity.subtype);
  if (schema && schema.featureGroups) {
    const lines = [];
    schema.featureGroups.forEach(function (g) {
      const groupFeats = feats.filter(function (f) { return f.group === g.key; });
      if (!groupFeats.length) return;
      lines.push('### ' + g.label);
      groupFeats.forEach(function (f) { lines.push('**' + f.name + '.** ' + f.text, ''); });
    });
    return lines.join('\n').trim();
  }
  const lines = ['### Features'];
  feats.forEach(function (f) { lines.push('**' + f.name + '.** ' + f.text, ''); });
  return lines.join('\n').trim();
}
function resolveLoreItemMarkdown(entity, item, items) {
  if (!entity.useTemplate || !item.meta) return item.content;
  if (item.meta === 'meta-details' || item.meta === 'meta-features') {
    const first = items.find(function (it) { return it.meta === item.meta; });
    if (first && first.id === item.id) {
      const synthesized = item.meta === 'meta-details' ? buildDetailsMarkdown(entity) : buildFeaturesMarkdown(entity);
      if (!synthesized) return item.content;
      if (!item.content) return synthesized;
      // 'meta-details' leftover content is itself more bullets (e.g.
      // weapon Damage, armor Base Score) -- join with a single newline so
      // it reads as one continuous list, matching the original single-blob
      // markdown's formatting, not two visually separated lists.
      const joiner = item.meta === 'meta-details' ? '\n' : '\n\n';
      return synthesized + joiner + item.content;
    }
  }
  return item.content;
}

// Exported for map.js: pins pointing at player-invisible entities are
// themselves hidden from players.
function isEntityPlayerVisible(entityId) {
  const entity = state.allEntities.find(function (e) { return e.id === entityId; });
  return !!entity && entity.visibility === 'all-players';
}

// --- List pane (Table of Contents) ---------------------------------------

// Shared by the main Entry Browser search box and the map pin panel's
// entity picker search (map.js) -- comma-separated terms AND together;
// each term OR-matches name/tags/aliases substring plus the hidden
// searchIndex (template Details/Features whitelist, see templates.js).
function entityMatchesQuery(entity, rawQuery) {
  const raw = (rawQuery || '').trim().toLowerCase();
  if (!raw) return true;
  const terms = raw.split(',').map(function (t) { return t.trim(); }).filter(Boolean);
  if (!terms.length) return true;
  return terms.every(function (q) {
    const nameMatch = (entity.name || '').toLowerCase().indexOf(q) !== -1;
    const tagMatch = (entity.tags || []).some(function (t) {
      return t.toLowerCase().indexOf(q) !== -1;
    });
    const aliasMatch = (entity.aliases || []).some(function (a) {
      return a.toLowerCase().indexOf(q) !== -1;
    });
    const qNorm = normalizeSearchTerm(q);
    const indexMatch = (entity.searchIndex || []).some(function (t) {
      return t.indexOf(qNorm) !== -1;
    });
    return nameMatch || tagMatch || aliasMatch || indexMatch;
  });
}
function matchesFilters(entity) {
  return entityMatchesQuery(entity, searchEl.value);
}

// Selecting a new entity always lands back on the Lore tab, out of edit
// mode, with no in-progress lore edit carried over. clearSearch is opt-in:
// true for navigation that jumps AWAY from the currently selected entity
// (wiki link, related-entry chip) where a stale search query would hide
// the destination from the Entry Browser; false for clicking the entity
// directly in the (possibly search-filtered) Entry Browser list itself,
// where clearing the box the user just used to find it would be jarring.
function selectEntity(entityId, clearSearch) {
  state.selectedId = entityId;
  state.detailActiveTab = 'lore';
  state.detailEditMode = false;
  state.detailEditDraft = null;
  state.loreEdit = null;
  if (clearSearch) searchEl.value = '';
  renderList();
  renderDetailForSelected();
}

// Exported for map.js's switchToCodexEntity (a separate pin-click entity
// switch, not routed through selectEntity above) so a pin click also
// clears a stale search query.
function clearCodexSearchInput() {
  searchEl.value = '';
  updateSearchClearBtnVisibility();
}

function isCategoryCollapsed(cat) {
  // Default COLLAPSED — only an explicit `false` (the user expanded it)
  // opens a group.
  return state.categoryCollapse[cat] !== false;
}

// Subtype sub-groups (Phase 12b, SRD import): a second, nested collapse
// level under categories that use `entity.subtype` (Game Mechanics,
// Equipment). Keyed by 'category|subtype' so the same subtype string
// under two different categories collapses independently. Same
// default-collapsed convention as isCategoryCollapsed.
function subtypeCollapseKey(cat, subtype) {
  return cat + '|' + subtype;
}
function isSubtypeCollapsed(cat, subtype) {
  return state.subtypeCollapse[subtypeCollapseKey(cat, subtype)] !== false;
}
function subtypeLabel(subtype) {
  return subtype.charAt(0).toUpperCase() + subtype.slice(1);
}

// TOC group headers show the category as a group label ("Characters (41)")
// so plural reads more naturally than the singular per-entity type name
// used everywhere else (entity type line, category dropdown, etc).
// Already-plural compound categories (ending in 's') pass through unchanged.
const CATEGORY_GROUP_LABELS = {
  'Character': 'Characters', 'Faction': 'Factions', 'Location': 'Locations',
  'Item': 'Items', 'World Facts': 'World Facts', 'Organization': 'Organizations',
  'Event': 'Events', 'Scene': 'Scenes', 'Ancestry': 'Ancestries', 'Community': 'Communities',
  'Game Mechanics': 'Game Mechanics', 'Equipment': 'Equipment'
};
function categoryGroupLabel(cat) {
  return CATEGORY_GROUP_LABELS[cat] || cat;
}

// Table of Contents: accordion grouped by category (CONFIG.categories
// order), each group a collapsible horizontal bar, collapsed by default.
function renderList() {
  updateGmToolbar();
  const gmView = isGmView();
  const filtered = state.allEntities
    .filter(matchesFilters)
    .filter(function (e) { return gmView || isEntityPlayerVisible(e.id); })
    .sort(function (a, b) { return (a.name || '').localeCompare(b.name || ''); });

  listEl.innerHTML = '';
  if (filtered.length === 0) {
    const emptyP = document.createElement('p');
    emptyP.textContent = 'No entities match.';
    emptyP.style.padding = '0.5rem 0.75rem';
    listEl.appendChild(emptyP);
    return;
  }

  const byCategory = {};
  filtered.forEach(function (entity) {
    const cat = entity.category || '(uncategorized)';
    if (!byCategory[cat]) byCategory[cat] = [];
    byCategory[cat].push(entity);
  });

  const orderedCats = CONFIG.categories.filter(function (c) { return byCategory[c]; });
  Object.keys(byCategory).forEach(function (c) {
    if (orderedCats.indexOf(c) === -1) orderedCats.push(c);
  });

  // While a search query is active, force every category with a match
  // open — overrides the user's stored collapse preference for the
  // duration of the search only; clearing the box restores it.
  const searchActive = searchEl.value.trim().length > 0;

  orderedCats.forEach(function (cat) {
    const entities = byCategory[cat];
    const collapsed = searchActive ? false : isCategoryCollapsed(cat);

    const header = document.createElement('div');
    header.className = 'entity-group-header' + (collapsed ? ' collapsed' : '');
    const dotSpan = document.createElement('span');
    dotSpan.className = 'entity-group-dot ' + categoryPinClassLocal(cat);
    const titleSpan = document.createElement('span');
    titleSpan.className = 'entity-group-title';
    titleSpan.textContent = categoryGroupLabel(cat);
    const countSpan = document.createElement('span');
    countSpan.className = 'entity-group-count';
    countSpan.textContent = '(' + entities.length + ')';
    const caretSpan = document.createElement('span');
    caretSpan.className = 'entity-group-caret';
    caretSpan.textContent = '\u25be';
    header.appendChild(dotSpan);
    header.appendChild(titleSpan);
    header.appendChild(countSpan);
    header.appendChild(caretSpan);
    header.addEventListener('click', function () {
      state.categoryCollapse[cat] = collapsed ? false : true;
      renderList();
    });
    listEl.appendChild(header);

    const ul = document.createElement('ul');
    ul.className = 'entity-group-list' + (collapsed ? ' collapsed' : '');

    function buildEntityLi(entity) {
      const li = document.createElement('li');
      li.dataset.id = entity.id;
      if (entity.id === state.selectedId) li.classList.add('active');

      const nameDiv = document.createElement('div');
      nameDiv.className = 'entity-name';
      nameDiv.textContent = entity.name;
      li.appendChild(nameDiv);

      const rightCol = document.createElement('div');
      rightCol.className = 'entity-right-col';
      if (entity.category === 'Location' && entity.hasMapImage) {
        const mapLink = document.createElement('button');
        mapLink.type = 'button';
        mapLink.className = 'entity-map-link';
        mapLink.title = 'Open map';
        mapLink.innerHTML = CONFIG.icons.map;
        mapLink.addEventListener('click', function (ev) {
          ev.stopPropagation();
          if (mapNavigationHandler) mapNavigationHandler(entity.id);
        });
        rightCol.appendChild(mapLink);
      }
      if (gmView && entity.visibility !== 'all-players') {
        const hiddenSpan = document.createElement('span');
        hiddenSpan.className = 'entity-hidden-badge';
        hiddenSpan.textContent = 'hidden';
        rightCol.appendChild(hiddenSpan);
      }
      if (rightCol.children.length) li.appendChild(rightCol);

      li.addEventListener('click', function () { selectEntity(entity.id); });
      return li;
    }

    // Entities without a subtype render directly in this category's list,
    // same as before subtypes existed. Entities WITH a subtype (Game
    // Mechanics/Equipment, from SRD import) are grouped into their own
    // nested collapsible sub-list, appended as a single <li> so it's
    // naturally hidden when the parent category collapses (no extra
    // collapse-propagation logic needed).
    const plainEntities = [];
    const bySubtype = {};
    entities.forEach(function (entity) {
      if (entity.subtype) {
        if (!bySubtype[entity.subtype]) bySubtype[entity.subtype] = [];
        bySubtype[entity.subtype].push(entity);
      } else {
        plainEntities.push(entity);
      }
    });

    plainEntities.forEach(function (entity) { ul.appendChild(buildEntityLi(entity)); });

    Object.keys(bySubtype).sort(function (a, b) { return subtypeLabel(a).localeCompare(subtypeLabel(b)); })
      .forEach(function (subtype) {
        const subEntities = bySubtype[subtype];
        const subCollapsed = searchActive ? false : isSubtypeCollapsed(cat, subtype);

        const subLi = document.createElement('li');
        subLi.className = 'entity-subgroup-li';

        const subHeader = document.createElement('div');
        subHeader.className = 'entity-subgroup-header' + (subCollapsed ? ' collapsed' : '');
        const subTitleSpan = document.createElement('span');
        subTitleSpan.className = 'entity-group-title';
        subTitleSpan.textContent = subtypeLabel(subtype);
        const subCountSpan = document.createElement('span');
        subCountSpan.className = 'entity-group-count';
        subCountSpan.textContent = '(' + subEntities.length + ')';
        const subCaretSpan = document.createElement('span');
        subCaretSpan.className = 'entity-subgroup-caret';
        subCaretSpan.textContent = '\u25be';
        subHeader.appendChild(subTitleSpan);
        subHeader.appendChild(subCountSpan);
        subHeader.appendChild(subCaretSpan);
        subHeader.addEventListener('click', function (ev) {
          ev.stopPropagation();
          state.subtypeCollapse[subtypeCollapseKey(cat, subtype)] = subCollapsed ? false : true;
          renderList();
        });
        subLi.appendChild(subHeader);

        const subUl = document.createElement('ul');
        subUl.className = 'entity-subgroup-list' + (subCollapsed ? ' collapsed' : '');
        subEntities.forEach(function (entity) { subUl.appendChild(buildEntityLi(entity)); });
        subLi.appendChild(subUl);

        ul.appendChild(subLi);
      });

    listEl.appendChild(ul);
  });
}

// --- Wiki links ----------------------------------------------------------
// Auto-link entity names appearing in rendered lore text: any exact
// entity-name match (word-boundary-ish: not embedded in a longer
// alphanumeric run, so "Baker" doesn't match inside "Bakerians") becomes
// a click-to-navigate link. Longest names win over prefixes ("Trixie's
// Trading Post" over "Trixie"). In player view only player-visible
// entities are linkable — hidden names stay plain text (linking them
// would leak their existence). The current entity's own name isn't
// linked (self-link is noise). Runs on the rendered DOM, walking text
// nodes and skipping real <a> links from the markdown.
function applyWikiLinks(rootEl, currentEntityId, gmView) {
  const candidates = [];
  state.allEntities.forEach(function (e) {
    if (e.id === currentEntityId || !e.name) return;
    if (!gmView && !isEntityPlayerVisible(e.id)) return;
    candidates.push({ name: e.name, id: e.id });
    // Aliases link to the same entity ("Janine Cody" -> Merv).
    (e.aliases || []).forEach(function (a) {
      if (a) candidates.push({ name: a, id: e.id });
    });
  });
  if (!candidates.length) return;
  candidates.sort(function (a, b) { return b.name.length - a.name.length; });
  const byName = {};
  candidates.forEach(function (e) { if (!(e.name in byName)) byName[e.name] = e.id; });
  const pattern = new RegExp(candidates.map(function (e) {
    return e.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }).join('|'), 'g');

  function isWordChar(ch) { return /[A-Za-z0-9]/.test(ch); }

  const walker = document.createTreeWalker(rootEl, NodeFilter.SHOW_TEXT, {
    acceptNode: function (node) {
      for (let p = node.parentNode; p && p !== rootEl; p = p.parentNode) {
        if (p.nodeName === 'A') return NodeFilter.FILTER_REJECT;
      }
      return NodeFilter.FILTER_ACCEPT;
    }
  });
  const textNodes = [];
  while (walker.nextNode()) textNodes.push(walker.currentNode);

  textNodes.forEach(function (node) {
    const text = node.nodeValue;
    pattern.lastIndex = 0;
    let m;
    let last = 0;
    let frag = null;
    while ((m = pattern.exec(text)) !== null) {
      const before = m.index > 0 ? text.charAt(m.index - 1) : '';
      const after = text.charAt(m.index + m[0].length);
      if ((before && isWordChar(before)) || (after && isWordChar(after))) continue;
      if (!frag) frag = document.createDocumentFragment();
      if (m.index > last) frag.appendChild(document.createTextNode(text.slice(last, m.index)));
      const a = document.createElement('a');
      a.href = '#';
      a.className = 'wiki-link';
      a.textContent = m[0];
      a.dataset.entityId = byName[m[0]];
      frag.appendChild(a);
      last = m.index + m[0].length;
    }
    if (frag) {
      if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
      node.parentNode.replaceChild(frag, node);
    }
  });
}

// Delegated: one handler for every wiki link in the detail pane.
detailEl.addEventListener('click', function (ev) {
  const a = ev.target.closest ? ev.target.closest('a.wiki-link') : null;
  if (!a) return;
  ev.preventDefault();
  selectEntity(a.dataset.entityId, true);
});

// --- Entity-level GM visibility toggle (always upper-right, live-writes
// immediately regardless of edit mode) -------------------------------------
function buildEntityVisibilityToggle(entity) {
  const row = document.createElement('div');
  row.className = 'entity-visibility-toggle-row';
  const label = document.createElement('span');
  const hidden = entity.visibility !== 'all-players';
  label.className = 'toggle-switch-label ' + (hidden ? 'state-hidden' : 'state-visible');
  label.textContent = hidden ? 'Hidden from party' : 'Visible to party';
  row.appendChild(label);
  const switchLabel = document.createElement('label');
  switchLabel.className = 'toggle-switch';
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.checked = !hidden;
  input.addEventListener('change', function () {
    if (input.checked && !confirmRevealWithoutSource(entity.sourceId)) {
      input.checked = false;
      return;
    }
    updateDoc(doc(db, 'entities', entity.id), {
      visibility: input.checked ? 'all-players' : 'gm-only',
      updatedAt: serverTimestamp()
    }).catch(function (err) {
      window.alert('Visibility change failed: ' + err.message);
    });
  });
  const slider = document.createElement('span');
  slider.className = 'toggle-slider';
  switchLabel.appendChild(input);
  switchLabel.appendChild(slider);
  row.appendChild(switchLabel);
  return row;
}

// --- Inline entity edit fields (replaces the old entity-form modal) -------

function buildEntityDraft(entity) {
  return {
    name: entity.name || '',
    category: entity.category || CONFIG.categories[0],
    ancestry: entity.ancestry || '',
    subtype: entity.subtype || '',
    aliases: (entity.aliases || []).join(', '),
    date: entity.date || '',
    dateEnd: entity.dateEnd || '',
    parentId: entity.parentId || '',
    tags: (entity.tags || []).join(', '),
    relatedIds: (entity.relatedIds || []).slice(),
    ownerId: entity.ownerId || '',
    sourceId: entity.sourceId || null,
    useTemplate: !!entity.useTemplate,
    details: Object.assign({}, entity.details || {}),
    features: (entity.features || []).map(function (f) { return { name: f.name || '', text: f.text || '' }; })
  };
}

// Phase 13: entity.updatedAt is a Firestore Timestamp once the write has
// round-tripped through the server (null on our own still-pending local
// write, but by the time editing starts we're reading server-confirmed
// data, so this is safe here).
function updatedAtMs(entity) {
  const t = entity && entity.updatedAt;
  return (t && typeof t.toMillis === 'function') ? t.toMillis() : null;
}

function enterEntityEditMode(entity) {
  state.detailEditMode = true;
  state.detailEditDraft = buildEntityDraft(entity);
  state.detailEditBaseUpdatedAtMs = updatedAtMs(entity);
  state.detailEditConflictDismissedAtMs = null;
  renderDetailForSelected();
}

function cancelEntityEdit() {
  state.detailEditMode = false;
  state.detailEditDraft = null;
  state.detailEditBaseUpdatedAtMs = null;
  state.detailEditConflictDismissedAtMs = null;
  renderDetailForSelected();
}

function saveEntityEdit(entity) {
  const draft = state.detailEditDraft;
  const name = draft.name.trim();
  if (!name) {
    window.alert('Name is required.');
    return;
  }
  const cat = draft.category;
  const tags = draft.tags.split(',').map(function (t) { return t.trim(); }).filter(Boolean);
  const aliases = draft.aliases.split(',').map(function (t) { return t.trim(); }).filter(Boolean);
  const dateStr = ((cat === 'Scene' || cat === 'Event') && draft.date.trim()) ? draft.date.trim() : '';
  let dateSort = null;
  if (dateStr) {
    const parsed = parseDateSpec(dateStr);
    if (!parsed.ok) {
      window.alert('Date: ' + parsed.error);
      return;
    }
    dateSort = parsed.offsetSeconds;
    // Warn (don't block -- an exact tie is legal data, the Timeline
    // well's cluster-picker exists precisely to handle it) if another
    // Scene/Event already resolves to this exact instant, so an
    // accidental typo/copy-paste date gets caught at save time instead
    // of only showing up as an unexpected cluster on the Timeline later.
    const dup = state.allEntities.find(function (e) {
      return e.id !== entity.id && (e.category === 'Scene' || e.category === 'Event') && e.dateSort === dateSort;
    });
    if (dup) {
      const proceed = window.confirm(
        'Another ' + dup.category + ' ("' + dup.name + '") already has this exact date/time (' + dateStr + '). Save anyway?'
      );
      if (!proceed) return;
    }
  }
  // Optional end date -- turns a single point in time into a span (e.g.
  // a Scene covering several in-fiction days). Only meaningful once a
  // start date is set; silently ignored otherwise rather than erroring,
  // since clearing the start date is a reasonable way to "undo" a dated
  // entity and shouldn't be blocked by a leftover end date the GM
  // forgot to also clear.
  const dateEndStr = (dateStr && draft.dateEnd.trim()) ? draft.dateEnd.trim() : '';
  let dateEndSort = null;
  if (dateEndStr) {
    const parsedEnd = parseDateSpec(dateEndStr);
    if (!parsedEnd.ok) {
      window.alert('End date: ' + parsedEnd.error);
      return;
    }
    dateEndSort = parsedEnd.offsetSeconds;
    if (dateEndSort < dateSort) {
      window.alert('End date must be at or after the start date.');
      return;
    }
  }
  const subtype = draftSubtype(draft);
  // useTemplate only sticks if a template schema still applies to the
  // saved category/subtype (guards against a stale true left over from
  // before the category was changed) -- details/features data itself is
  // never wiped, so flipping back is non-destructive.
  const templateSchema = getTemplateSchema(cat, subtype);
  const entityData = {
    slug: slugify(name),
    name: name,
    category: cat,
    ancestry: (cat === 'Character' && draft.ancestry.trim()) ? draft.ancestry.trim() : null,
    subtype: subtype,
    aliases: (cat === 'Character') ? aliases : [],
    date: dateStr || null,
    dateSort: dateSort,
    dateEnd: dateEndStr || null,
    dateEndSort: dateEndSort,
    ownerId: (cat === 'Character' && draft.ownerId) ? draft.ownerId : null,
    parentId: draft.parentId || null,
    relatedIds: draft.relatedIds.slice(),
    tags: tags,
    sourceId: draft.sourceId || null,
    useTemplate: !!draft.useTemplate && !!templateSchema,
    details: draft.details || {},
    features: draft.features || [],
    searchIndex: (draft.useTemplate && templateSchema) ? computeSearchIndex(draft.details, draft.features, templateSchema) : [],
    updatedAt: serverTimestamp()
  };
  // Phase 13: close the edit form optimistically, not gated on the
  // write Promise -- see saveNewEntity's comment above for why (offline,
  // this Promise doesn't resolve until reconnect, but the entities
  // listener's own optimistic local update re-renders almost
  // immediately, which was leaving the edit form open with a duplicate-
  // submission risk on every field, not just new entities).
  trackWrite(updateDoc(doc(db, 'entities', entity.id), entityData), 'Saving entity').catch(function (err) {
    window.alert('Save failed: ' + err.message);
  });
  state.detailEditMode = false;
  state.detailEditDraft = null;
  state.detailEditBaseUpdatedAtMs = null;
  state.detailEditConflictDismissedAtMs = null;
  renderDetailForSelected();
}

function makeEditField(labelText, value, onInput, opts) {
  const wrap = document.createElement('div');
  wrap.className = 'entity-edit-field';
  const label = document.createElement('label');
  label.textContent = labelText;
  wrap.appendChild(label);
  const input = document.createElement('input');
  input.type = 'text';
  input.value = value;
  if (opts && opts.placeholder) input.placeholder = opts.placeholder;
  input.addEventListener('input', function () { onInput(input.value); });
  wrap.appendChild(input);
  return wrap;
}

function buildParentSelect(entityId, currentParentId, onChange) {
  const wrap = document.createElement('div');
  wrap.className = 'entity-edit-field';
  const label = document.createElement('label');
  label.textContent = 'Parent entity';
  wrap.appendChild(label);
  const select = document.createElement('select');
  const noneOpt = document.createElement('option');
  noneOpt.value = '';
  noneOpt.textContent = '-- none --';
  select.appendChild(noneOpt);
  state.allEntities
    .filter(function (e) { return e.id !== entityId; })
    .sort(function (a, b) { return (a.name || '').localeCompare(b.name || ''); })
    .forEach(function (e) {
      const opt = document.createElement('option');
      opt.value = e.id;
      opt.textContent = e.name;
      select.appendChild(opt);
    });
  select.value = currentParentId || '';
  select.addEventListener('change', function () { onChange(select.value); });
  wrap.appendChild(select);
  return wrap;
}

function buildRelatedEditor(entityId, draft) {
  const wrap = document.createElement('div');
  wrap.className = 'entity-edit-field';
  const label = document.createElement('label');
  label.textContent = 'Related entries';
  wrap.appendChild(label);

  const list = document.createElement('ul');
  list.className = 'related-edit-list';
  draft.relatedIds.forEach(function (id) {
    const target = state.allEntities.find(function (e) { return e.id === id; });
    const li = document.createElement('li');
    const span = document.createElement('span');
    span.textContent = target ? target.name : '(deleted entity)';
    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.textContent = 'Remove';
    removeBtn.addEventListener('click', function () {
      draft.relatedIds = draft.relatedIds.filter(function (rid) { return rid !== id; });
      renderDetailForSelected();
    });
    li.appendChild(span);
    li.appendChild(removeBtn);
    list.appendChild(li);
  });
  wrap.appendChild(list);

  const addRow = document.createElement('div');
  addRow.className = 'related-edit-add';
  const select = document.createElement('select');
  const available = state.allEntities
    .filter(function (e) { return e.id !== entityId && draft.relatedIds.indexOf(e.id) === -1; })
    .sort(function (a, b) { return (a.name || '').localeCompare(b.name || ''); });
  if (available.length === 0) {
    const opt = document.createElement('option');
    opt.textContent = '(no more entities to link)';
    opt.disabled = true;
    select.appendChild(opt);
  } else {
    available.forEach(function (e) {
      const opt = document.createElement('option');
      opt.value = e.id;
      opt.textContent = e.name;
      select.appendChild(opt);
    });
  }
  const addBtn = document.createElement('button');
  addBtn.type = 'button';
  addBtn.textContent = 'Add';
  addBtn.addEventListener('click', function () {
    const id = select.value;
    if (!id || draft.relatedIds.indexOf(id) !== -1) return;
    draft.relatedIds.push(id);
    renderDetailForSelected();
  });
  addRow.appendChild(select);
  addRow.appendChild(addBtn);
  wrap.appendChild(addRow);
  return wrap;
}

// Structured stat-block editor (Weapons/Armor/Abilities pilot): only
// rendered when a template schema applies to the draft's current
// category/subtype (see templates.js). The "Use structured template"
// toggle is per-entity opt-in per Gregg's design -- unchecked leaves
// details/features data in place but unused, so re-checking later is
// non-destructive. Detail keys are the schema's fixed whitelist (not a
// freeform key list -- that's the point, keeps search indexing sane);
// Features is a freely add/removable {name,text} list.
function buildTemplateEditor(draft) {
  const schema = getTemplateSchema(draft.category, draftSubtype(draft));
  if (!schema) return null;

  const wrap = document.createElement('div');
  wrap.className = 'entity-edit-field entity-edit-template-block';

  const toggleWrap = document.createElement('div');
  toggleWrap.className = 'entity-edit-meta-row';
  const toggleLabel = document.createElement('label');
  toggleLabel.className = 'toggle-switch';
  const toggleInput = document.createElement('input');
  toggleInput.type = 'checkbox';
  toggleInput.checked = !!draft.useTemplate;
  toggleInput.addEventListener('change', function () {
    draft.useTemplate = toggleInput.checked;
    renderDetailForSelected();
  });
  const toggleSlider = document.createElement('span');
  toggleSlider.className = 'toggle-slider';
  toggleLabel.appendChild(toggleInput);
  toggleLabel.appendChild(toggleSlider);
  toggleWrap.appendChild(toggleLabel);
  const toggleText = document.createElement('span');
  toggleText.className = 'toggle-switch-label';
  toggleText.textContent = 'Use structured template (Details/Features)';
  toggleWrap.appendChild(toggleText);
  wrap.appendChild(toggleWrap);

  if (!draft.useTemplate) return wrap;

  schema.detailKeys.forEach(function (d) {
    const fieldWrap = document.createElement('div');
    fieldWrap.className = 'entity-edit-field';
    const label = document.createElement('label');
    label.textContent = humanizeKey(d.key);
    fieldWrap.appendChild(label);
    const input = document.createElement('input');
    input.type = 'text';
    input.value = draft.details[d.key] || '';
    input.addEventListener('input', function () { draft.details[d.key] = input.value; });
    fieldWrap.appendChild(input);
    wrap.appendChild(fieldWrap);
  });

  if (schema.hasFeatures) {
    if (schema.featureGroups) {
      schema.featureGroups.forEach(function (g) {
        const featLabel = document.createElement('label');
        featLabel.textContent = g.label + ' features';
        wrap.appendChild(featLabel);
        const featList = document.createElement('div');
        featList.className = 'template-feature-edit-list';
        draft.features.forEach(function (f, i) {
          if (f.group !== g.key) return;
          const row = document.createElement('div');
          row.className = 'template-feature-edit-row';
          const nameInput = document.createElement('input');
          nameInput.type = 'text';
          nameInput.placeholder = 'Name';
          nameInput.value = f.name;
          nameInput.addEventListener('input', function () { f.name = nameInput.value; });
          row.appendChild(nameInput);
          const textInput = document.createElement('input');
          textInput.type = 'text';
          textInput.placeholder = 'Effect text';
          textInput.value = f.text;
          textInput.addEventListener('input', function () { f.text = textInput.value; });
          row.appendChild(textInput);
          const removeBtn = document.createElement('button');
          removeBtn.type = 'button';
          removeBtn.className = 'action-btn-compact';
          removeBtn.textContent = 'Remove';
          removeBtn.addEventListener('click', function () {
            draft.features.splice(i, 1);
            renderDetailForSelected();
          });
          row.appendChild(removeBtn);
          featList.appendChild(row);
        });
        wrap.appendChild(featList);
        const addBtn = document.createElement('button');
        addBtn.type = 'button';
        addBtn.className = 'action-btn-compact';
        addBtn.textContent = '+ Add ' + g.label.toLowerCase() + ' feature';
        addBtn.addEventListener('click', function () {
          draft.features.push({ name: '', text: '', group: g.key });
          renderDetailForSelected();
        });
        wrap.appendChild(addBtn);
      });
    } else {
      const featLabel = document.createElement('label');
      featLabel.textContent = 'Features';
      wrap.appendChild(featLabel);
      const featList = document.createElement('div');
      featList.className = 'template-feature-edit-list';
      draft.features.forEach(function (f, i) {
        const row = document.createElement('div');
        row.className = 'template-feature-edit-row';
        const nameInput = document.createElement('input');
        nameInput.type = 'text';
        nameInput.placeholder = 'Name';
        nameInput.value = f.name;
        nameInput.addEventListener('input', function () { f.name = nameInput.value; });
        row.appendChild(nameInput);
        const textInput = document.createElement('input');
        textInput.type = 'text';
        textInput.placeholder = 'Effect text';
        textInput.value = f.text;
        textInput.addEventListener('input', function () { f.text = textInput.value; });
        row.appendChild(textInput);
        const removeBtn = document.createElement('button');
        removeBtn.type = 'button';
        removeBtn.className = 'action-btn-compact';
        removeBtn.textContent = 'Remove';
        removeBtn.addEventListener('click', function () {
          draft.features.splice(i, 1);
          renderDetailForSelected();
        });
        row.appendChild(removeBtn);
        featList.appendChild(row);
      });
      wrap.appendChild(featList);
      const addBtn = document.createElement('button');
      addBtn.type = 'button';
      addBtn.className = 'action-btn-compact';
      addBtn.textContent = '+ Add feature';
      addBtn.addEventListener('click', function () {
        draft.features.push({ name: '', text: '' });
        renderDetailForSelected();
      });
      wrap.appendChild(addBtn);
    }
  }

  return wrap;
}

function renderEntityEditBlock(container, entity, draft) {
  container.appendChild(buildParentSelect(entity.id, draft.parentId, function (v) { draft.parentId = v; }));
  container.appendChild(makeEditField('Tags (comma-separated)', draft.tags, function (v) { draft.tags = v; }));

  const templateEditor = buildTemplateEditor(draft);
  if (templateEditor) container.appendChild(templateEditor);

  container.appendChild(buildRelatedEditor(entity.id, draft));
  const sourceWrap = document.createElement('div');
  sourceWrap.className = 'entity-edit-field';
  const sourceLabel = document.createElement('label');
  sourceLabel.textContent = 'Source';
  sourceWrap.appendChild(sourceLabel);
  sourceWrap.appendChild(buildSourceSelect(draft.sourceId, function (v) { draft.sourceId = v; }));
  container.appendChild(sourceWrap);

  const actions = document.createElement('div');
  actions.className = 'actions-row';
  const right = document.createElement('div');
  right.className = 'actions-row-right';
  const saveBtn = document.createElement('button');
  saveBtn.textContent = 'Save';
  saveBtn.addEventListener('click', function () { saveEntityEdit(entity); });
  right.appendChild(saveBtn);
  const cancelBtn = document.createElement('button');
  cancelBtn.textContent = 'Cancel';
  cancelBtn.addEventListener('click', cancelEntityEdit);
  right.appendChild(cancelBtn);
  actions.appendChild(right);
  container.appendChild(actions);
}

// --- New-entity mini dialog: Name + Entry type only. Save creates the
// entity doc immediately, then opens its My Knowledge card straight into
// edit mode so every other field (parent, tags, related, images, etc.)
// is filled in inline. ------------------------------------------------------
const entityNewOverlayEl = document.getElementById('entity-new-overlay');
const entityNewNameEl = document.getElementById('entity-new-name');
const entityNewCategoryEl = document.getElementById('entity-new-category');
const entityNewErrorEl = document.getElementById('entity-new-error');
const entityNewSaveBtn = document.getElementById('entity-new-save');
const entityNewCancelBtn = document.getElementById('entity-new-cancel');

CONFIG.categories.forEach(function (cat) {
  const opt = document.createElement('option');
  opt.value = cat;
  opt.textContent = cat;
  entityNewCategoryEl.appendChild(opt);
});

function openNewEntityDialog() {
  entityNewNameEl.value = '';
  entityNewCategoryEl.value = CONFIG.categories[0];
  entityNewErrorEl.style.display = 'none';
  entityNewErrorEl.textContent = '';
  entityNewOverlayEl.classList.add('open');
  entityNewNameEl.focus();
}

function closeNewEntityDialog() {
  entityNewOverlayEl.classList.remove('open');
}

function showNewEntityError(message) {
  entityNewErrorEl.textContent = message;
  entityNewErrorEl.style.display = 'block';
}

// New-entity default source: the GM's first source in Admin > Sources
// drag-order (sortedSources()[0]) — hand-created entities default to
// it rather than "no source", since most campaign content shares one
// dominant attribution (homebrew). Deliberately UI-level-only, applied
// at creation time; never backfilled onto existing entities.
function saveNewEntity() {
  const name = entityNewNameEl.value.trim();
  if (!name) {
    showNewEntityError('Name is required.');
    return;
  }
  const cat = entityNewCategoryEl.value;
  entityNewSaveBtn.disabled = true;
  const newId = doc(collection(db, 'entities')).id;
  const entityData = {
    slug: slugify(name),
    name: name,
    category: cat,
    ancestry: null,
    aliases: [],
    date: null,
    dateSort: null,
    parentId: null,
    relatedIds: [],
    visibility: 'gm-only',
    hasMapImage: false,
    tags: [],
    sourceId: (sortedSources()[0] && sortedSources()[0].id) || null,
    useTemplate: false,
    details: {},
    features: [],
    searchIndex: [],
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp()
  };
  // Phase 13: don't gate closing this dialog / opening the new entity
  // on the write Promise resolving -- while offline that Promise stays
  // pending until reconnect (Firestore's own local-mutation snapshot
  // notification fires almost immediately regardless), so a re-render
  // triggered by that immediate local update was leaving this dialog's
  // Save button re-enabled with the edit box still open, inviting a
  // second click that created a duplicate entity. Close/open optimistically;
  // .catch() below only surfaces an eventual failure, it doesn't try to
  // reopen state that's already moved on.
  trackWrite(setDoc(doc(db, 'entities', newId), entityData), 'Saving entity').catch(function (err) {
    window.alert('Save failed: ' + err.message);
  });
  entityNewSaveBtn.disabled = false;
  closeNewEntityDialog();
  state.selectedId = newId;
  state.detailActiveTab = 'lore';
  state.loreEdit = null;
  state.detailEditMode = true;
  state.detailEditDraft = buildEntityDraft({ name: name, category: cat, ancestry: '', aliases: [], date: '', parentId: null, tags: [], relatedIds: [] });
  renderList();
  renderDetailForSelected();
}

newEntityBtn.addEventListener('click', openNewEntityDialog);
entityNewCancelBtn.addEventListener('click', closeNewEntityDialog);
entityNewSaveBtn.addEventListener('click', saveNewEntity);
entityNewOverlayEl.addEventListener('click', function (e) {
  if (e.target === entityNewOverlayEl) closeNewEntityDialog();
});

// Deleting an entity also deletes its loreItems and images (no orphans).
// Batched: atomic, and total op count here is far below the 500-op batch
// cap. Image docs for the entity are known from the per-entity listener
// (targeted at the selection, which is the only place delete is offered).
function deleteEntity(entity) {
  const ownedLore = state.allLoreItems.filter(function (item) { return item.entityId === entity.id; });
  const ownedImages = state.currentEntityImages.filter(function (img) { return img.ownerId === entity.id; });
  const confirmed = window.confirm(
    'Delete "' + entity.name + '", its ' + ownedLore.length +
    ' lore item(s), and ' + ownedImages.length + ' image(s)? This cannot be undone.');
  if (!confirmed) return;

  const batch = writeBatch(db);
  batch.delete(doc(db, 'entities', entity.id));
  ownedLore.forEach(function (item) {
    batch.delete(doc(db, 'loreItems', item.id));
  });
  ownedImages.forEach(function (img) {
    batch.delete(doc(db, 'images', img.id));
  });
  batch.commit().then(function () {
    if (state.selectedId === entity.id) {
      state.selectedId = null;
      renderDetailForSelected();
    }
  }).catch(function (err) {
    window.alert('Delete failed: ' + err.message);
  });
}

// --- Lore tab (inline add/edit, replaces the old lore-form modal) --------

// If content is purely an unordered Markdown list (every non-blank line
// is a "-"/"*"/"+" bullet, nothing else), split it into one lore item per
// bullet. A single bullet is left as normal content (nothing to split).
function splitUnorderedListContent(content) {
  const nonBlank = content.split('\n').filter(function (l) { return l.trim().length > 0; });
  if (nonBlank.length < 2) return null;
  const items = [];
  for (let i = 0; i < nonBlank.length; i++) {
    const m = nonBlank[i].match(/^\s*[-*+]\s+(.*)$/);
    if (!m) return null;
    items.push(m[1].trim());
  }
  return items;
}

function saveLoreEdit(entity, editState, isNew, saveBtn) {
  const content = editState.content;
  if (!content.trim()) {
    window.alert('Content is required.');
    return;
  }
  saveBtn.disabled = true;

  // Phase 13: close the edit box optimistically (state.loreEdit = null,
  // render below) right after the write is initiated, not inside
  // .then() -- this is the exact bug Gregg found offline: the write
  // Promise doesn't resolve until reconnect, but the loreItems
  // listener's own optimistic local update re-renders almost
  // immediately, which was leaving this box open with saveBtn back at
  // its default (fresh render = fresh, non-disabled button), so a
  // second tap fired saveLoreEdit again with the same still-open
  // editState -- for isNew, a second addDoc -- a real duplicate, not a
  // rendering glitch. fail() only alerts on an eventual failure; it
  // doesn't try to reopen the box.
  function fail(err) {
    window.alert('Save failed: ' + err.message);
  }

  if (isNew) {
    const items = splitUnorderedListContent(content) || [content];
    const siblings = state.allLoreItems.filter(function (it) { return it.entityId === entity.id; });
    let maxOrder = siblings.reduce(function (acc, it) { return Math.max(acc, it.order || 0); }, 0);
    items.forEach(function (c) {
      maxOrder += 1;
      trackWrite(addDoc(collection(db, 'loreItems'), {
        entityId: entity.id,
        kind: 'gm-note',
        authorId: null,
        authorType: 'gm',
        visibility: editState.visibility,
        content: c,
        meta: editState.meta || null,
        sourceId: editState.sourceId || null,
        order: maxOrder,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp()
      }), 'Saving lore').catch(fail);
    });
  } else {
    trackWrite(updateDoc(doc(db, 'loreItems', editState.id), {
      content: content,
      visibility: editState.visibility,
      meta: editState.meta || null,
      sourceId: editState.sourceId || null,
      updatedAt: serverTimestamp()
    }), 'Saving lore').catch(fail);
  }
  state.loreEdit = null;
  renderDetailForSelected();
}

function deleteLoreItem(item) {
  const confirmed = window.confirm('Delete this lore item? This cannot be undone.');
  if (!confirmed) return;
  deleteDoc(doc(db, 'loreItems', item.id)).catch(function (err) {
    window.alert('Delete failed: ' + err.message);
  });
}

// One box, used for both editing an existing item (isNew=false) and
// authoring a brand-new one (isNew=true, editState.id === null).
function buildLoreEditBox(entity, editState, isNew) {
  const box = document.createElement('div');
  box.className = 'lore-item';

  // Phase 13: same pattern as the entity-edit conflict banner above --
  // only meaningful for an existing item (a brand-new unsaved draft has
  // no server doc to conflict with).
  if (!isNew) {
    const liveItem = state.allLoreItems.find(function (li) { return li.id === editState.id; });
    const liveUpdatedAtMs = liveItem ? updatedAtMs(liveItem) : null;
    const hasConflict = editState.baseUpdatedAtMs != null &&
      liveUpdatedAtMs != null &&
      liveUpdatedAtMs !== editState.baseUpdatedAtMs &&
      liveUpdatedAtMs !== editState.conflictDismissedAtMs;
    if (hasConflict) {
      const conflictBanner = document.createElement('div');
      conflictBanner.className = 'edit-conflict-banner';
      const conflictMsg = document.createElement('p');
      conflictMsg.textContent = 'This lore item was saved elsewhere while you were editing.';
      conflictBanner.appendChild(conflictMsg);
      const conflictActions = document.createElement('div');
      conflictActions.className = 'edit-conflict-actions';
      const keepBtn = document.createElement('button');
      keepBtn.textContent = 'Keep my edits';
      keepBtn.addEventListener('click', function () {
        editState.conflictDismissedAtMs = liveUpdatedAtMs;
        renderDetailForSelected();
      });
      const reloadBtn = document.createElement('button');
      reloadBtn.textContent = 'Reload latest';
      reloadBtn.addEventListener('click', function () {
        editState.content = liveItem.content;
        editState.visibility = liveItem.visibility;
        editState.meta = normalizeMetaForEdit(liveItem.meta);
        editState.sourceId = liveItem.sourceId || null;
        editState.baseUpdatedAtMs = liveUpdatedAtMs;
        editState.conflictDismissedAtMs = null;
        renderDetailForSelected();
      });
      conflictActions.appendChild(keepBtn);
      conflictActions.appendChild(reloadBtn);
      conflictBanner.appendChild(conflictActions);
      box.appendChild(conflictBanner);
    }
  }

  const toggleRow = document.createElement('div');
  toggleRow.className = 'lore-item-toggle-row';
  const toggleLabel = document.createElement('span');
  toggleLabel.className = 'toggle-switch-label';
  function updateToggleLabel() {
    const visible = editState.visibility === 'all-players';
    toggleLabel.textContent = visible ? 'Visible to party' : 'Hidden from party';
    toggleLabel.className = 'toggle-switch-label ' + (visible ? 'state-visible' : 'state-hidden');
  }
  updateToggleLabel();
  toggleRow.appendChild(toggleLabel);
  const switchLabel = document.createElement('label');
  switchLabel.className = 'toggle-switch';
  const switchInput = document.createElement('input');
  switchInput.type = 'checkbox';
  switchInput.checked = editState.visibility === 'all-players';
  switchInput.addEventListener('change', function () {
    if (switchInput.checked && !confirmRevealWithoutSource(editState.sourceId)) {
      switchInput.checked = false;
      return;
    }
    editState.visibility = switchInput.checked ? 'all-players' : 'gm-only';
    updateToggleLabel();
  });
  const switchSlider = document.createElement('span');
  switchSlider.className = 'toggle-slider';
  switchLabel.appendChild(switchInput);
  switchLabel.appendChild(switchSlider);
  toggleRow.appendChild(switchLabel);
  box.appendChild(toggleRow);

  const sourceRow = document.createElement('div');
  sourceRow.className = 'lore-item-source-row';
  const sourceRowLabel = document.createElement('span');
  sourceRowLabel.className = 'toggle-switch-label';
  sourceRowLabel.textContent = 'Source';
  sourceRow.appendChild(sourceRowLabel);
  sourceRow.appendChild(buildSourceSelect(editState.sourceId, function (v) { editState.sourceId = v; }));
  box.appendChild(sourceRow);

  const textarea = document.createElement('textarea');
  textarea.className = 'lore-edit-textarea';
  textarea.value = editState.content;
  textarea.addEventListener('input', function () { editState.content = textarea.value; });
  box.appendChild(textarea);

  const metaRow = document.createElement('div');
  metaRow.className = 'lore-item-meta-row';
  const metaRowLabel = document.createElement('span');
  metaRowLabel.className = 'toggle-switch-label';
  metaRowLabel.textContent = 'Meta';
  metaRow.appendChild(metaRowLabel);
  const metaSelect = document.createElement('select');
  metaSelect.className = 'lore-meta-select';
  [
    ['', 'None'],
    ['meta', 'Meta'],
    ['meta-details', 'Meta \u2014 Details'],
    ['meta-features', 'Meta \u2014 Features']
  ].forEach(function (pair) {
    const opt = document.createElement('option');
    opt.value = pair[0];
    opt.textContent = pair[1];
    metaSelect.appendChild(opt);
  });
  metaSelect.value = editState.meta || '';
  metaSelect.addEventListener('change', function () { editState.meta = metaSelect.value; });
  metaRow.appendChild(metaSelect);
  box.appendChild(metaRow);

  const bottomRow = document.createElement('div');
  bottomRow.className = 'actions-row';
  const left = document.createElement('div');
  left.className = 'actions-row-left';
  const hint = document.createElement('span');
  hint.className = 'lore-edit-hint';
  hint.appendChild(document.createTextNode('Use an unordered '));
  const mdLink = document.createElement('a');
  mdLink.href = 'https://www.markdownguide.org/cheat-sheet/';
  mdLink.target = '_blank';
  mdLink.rel = 'noopener noreferrer';
  mdLink.textContent = 'Markdown';
  hint.appendChild(mdLink);
  hint.appendChild(document.createTextNode(' list to add multiple items'));
  left.appendChild(hint);
  bottomRow.appendChild(left);

  const right = document.createElement('div');
  right.className = 'actions-row-right';
  const saveBtn = document.createElement('button');
  saveBtn.className = 'lore-item-btn';
  saveBtn.textContent = 'Save';
  saveBtn.addEventListener('click', function () { saveLoreEdit(entity, editState, isNew, saveBtn); });
  right.appendChild(saveBtn);
  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'lore-item-btn';
  cancelBtn.textContent = 'Cancel';
  cancelBtn.addEventListener('click', function () { state.loreEdit = null; renderDetailForSelected(); });
  right.appendChild(cancelBtn);
  bottomRow.appendChild(right);

  box.appendChild(bottomRow);
  textarea.focus();
  return box;
}

// Lore tab content. Player view: each item its own well, styled
// identically to the GM view's card (parchment-edge fill, fear left
// strip — every item shown to a player is by definition
// all-players-visible) but with no toggle/Edit/Delete controls. This
// establishes the visual language reused for map pin popups. GM
// view: each item is a small card — a reveal/hide toggle switch
// top-right (live, one-tap), Edit/Delete bottom-right; Edit swaps
// the card into buildLoreEditBox() in place.
function renderLoreTab(container, entity, gmView, readOnly) {
  const items = loreItemsForEntity(entity.id, gmView);

  if (!gmView || readOnly) {
    if (items.length === 0) {
      const emptyP = document.createElement('p');
      emptyP.className = 'lore-empty';
      emptyP.textContent = '(no lore for this view)';
      container.appendChild(emptyP);
      return;
    }
    const loreListDiv = document.createElement('div');
    loreListDiv.className = 'codex-lore-list';
    items.forEach(function (item) {
      const itemDiv = document.createElement('div');
      // GM-readOnly can include gm-only items mixed with all-players
      // ones (real player view never does, since loreItemsForEntity
      // already filtered to all-players-only when !gmView) -- reflect
      // actual per-item visibility rather than assuming all-visible.
      itemDiv.className = 'lore-item ' + (item.visibility === 'all-players' ? 'vis-visible' : 'vis-hidden');
      if (metaBadgeLabel(item.meta)) {
        const metaTag = document.createElement('span');
        metaTag.className = 'meta-tag';
        metaTag.textContent = metaBadgeLabel(item.meta);
        itemDiv.appendChild(metaTag);
      }
      const bodyDiv = document.createElement('div');
      bodyDiv.className = 'lore-item-body';
      renderMarkdownInto(bodyDiv, resolveLoreItemMarkdown(entity, item, items)).then(function () {
        applyWikiLinks(bodyDiv, entity.id, gmView);
      });
      itemDiv.appendChild(bodyDiv);
      const sourceLabelDiv = document.createElement('div');
      sourceLabelDiv.className = 'source-label';
      renderSourceLabel(sourceLabelDiv, item.sourceId, entity.sourceId);
      itemDiv.appendChild(sourceLabelDiv);
      loreListDiv.appendChild(itemDiv);
    });
    container.appendChild(loreListDiv);
    return;
  }

  const activeEdit = state.loreEdit && state.loreEdit.entityId === entity.id ? state.loreEdit : null;

  const loreListDiv = document.createElement('div');
  loreListDiv.className = 'codex-lore-list';

  if (items.length === 0 && !(activeEdit && activeEdit.id === null)) {
    const emptyP = document.createElement('p');
    emptyP.className = 'lore-empty';
    emptyP.textContent = '(no lore for this view)';
    loreListDiv.appendChild(emptyP);
  }

  items.forEach(function (item) {
    if (activeEdit && activeEdit.id === item.id) {
      loreListDiv.appendChild(buildLoreEditBox(entity, activeEdit, false));
      return;
    }

    const itemDiv = document.createElement('div');
    itemDiv.className = 'lore-item ' + (item.visibility === 'all-players' ? 'vis-visible' : 'vis-hidden');

    const toggleRow = document.createElement('div');
    toggleRow.className = 'lore-item-toggle-row';
    const toggleRowLeft = document.createElement('div');
    toggleRowLeft.className = 'lore-item-toggle-row-left';
    if (metaBadgeLabel(item.meta)) {
      const metaTag = document.createElement('span');
      metaTag.className = 'meta-tag';
      metaTag.textContent = metaBadgeLabel(item.meta);
      toggleRowLeft.appendChild(metaTag);
    }
    toggleRow.appendChild(toggleRowLeft);
    const toggleRowRight = document.createElement('div');
    toggleRowRight.className = 'lore-item-toggle-row-right';
    const toggleLabel = document.createElement('span');
    const itemVisible = item.visibility === 'all-players';
    toggleLabel.className = 'toggle-switch-label ' + (itemVisible ? 'state-visible' : 'state-hidden');
    toggleLabel.textContent = itemVisible ? 'Visible to party' : 'Hidden from party';
    toggleRowRight.appendChild(toggleLabel);
    const switchLabel = document.createElement('label');
    switchLabel.className = 'toggle-switch';
    const switchInput = document.createElement('input');
    switchInput.type = 'checkbox';
    switchInput.checked = item.visibility === 'all-players';
    switchInput.addEventListener('change', function () {
      if (switchInput.checked && !confirmRevealWithoutSource(item.sourceId)) {
        switchInput.checked = false;
        return;
      }
      updateDoc(doc(db, 'loreItems', item.id), {
        visibility: switchInput.checked ? 'all-players' : 'gm-only',
        updatedAt: serverTimestamp()
      }).catch(function (err) { window.alert('Visibility change failed: ' + err.message); });
    });
    const switchSlider = document.createElement('span');
    switchSlider.className = 'toggle-slider';
    switchLabel.appendChild(switchInput);
    switchLabel.appendChild(switchSlider);
    toggleRowRight.appendChild(switchLabel);
    toggleRow.appendChild(toggleRowRight);
    itemDiv.appendChild(toggleRow);

    const bodyDiv = document.createElement('div');
    bodyDiv.className = 'lore-item-body';
    renderMarkdownInto(bodyDiv, resolveLoreItemMarkdown(entity, item, items)).then(function () {
      applyWikiLinks(bodyDiv, entity.id, gmView);
    });
    itemDiv.appendChild(bodyDiv);

    // Hide Edit/Delete on other items while one item (or a new draft) is
    // already being edited — forces finishing that edit first, rather
    // than silently discarding it by switching targets.
    if (!activeEdit) {
      const actionsRow = document.createElement('div');
      actionsRow.className = 'lore-item-actions-row';
      const editBtn = document.createElement('button');
      editBtn.className = 'lore-item-btn';
      editBtn.textContent = 'Edit';
      editBtn.addEventListener('click', function () {
        state.loreEdit = { entityId: entity.id, id: item.id, content: item.content, visibility: item.visibility, meta: normalizeMetaForEdit(item.meta), sourceId: item.sourceId || null, baseUpdatedAtMs: updatedAtMs(item), conflictDismissedAtMs: null };
        renderDetailForSelected();
      });
      actionsRow.appendChild(editBtn);
      const delBtn = document.createElement('button');
      delBtn.className = 'lore-item-btn';
      delBtn.textContent = 'Delete';
      delBtn.addEventListener('click', function () { deleteLoreItem(item); });
      actionsRow.appendChild(delBtn);
      itemDiv.appendChild(actionsRow);
    }

    const sourceLabelDiv = document.createElement('div');
    sourceLabelDiv.className = 'source-label';
    renderSourceLabel(sourceLabelDiv, item.sourceId, entity.sourceId);
    itemDiv.appendChild(sourceLabelDiv);

    loreListDiv.appendChild(itemDiv);
  });

  if (activeEdit && activeEdit.id === null) {
    loreListDiv.appendChild(buildLoreEditBox(entity, activeEdit, true));
  }

  container.appendChild(loreListDiv);

  if (!activeEdit) {
    const loreTabActions = document.createElement('div');
    loreTabActions.className = 'actions-row';
    const right = document.createElement('div');
    right.className = 'actions-row-right';
    const newLoreBtn = document.createElement('button');
    newLoreBtn.className = 'action-btn-compact';
    newLoreBtn.textContent = '+ New lore';
    newLoreBtn.addEventListener('click', function () {
      state.loreEdit = { entityId: entity.id, id: null, content: '', visibility: 'gm-only', meta: '', sourceId: (sortedSources()[0] && sortedSources()[0].id) || null };
      renderDetailForSelected();
    });
    right.appendChild(newLoreBtn);
    loreTabActions.appendChild(right);
    container.appendChild(loreTabActions);
  }
}

// --- Set portrait dialog -----------------------------------------------
// Redesigned UX (locked): a small drag-to-move, semi-transparent floating
// panel rather than a full-screen modal, so the actual entry card stays
// visible and interactive underneath.
//   Stage A ("Select a gallery image"): click a gallery thumbnail.
//   Stage B: panel shows Zoom + H/V fade sliders + Save/Cancel; the live
//   preview and drag-to-reposition happen directly on the entry card
//   itself (via portraitPreviewOverride), not in a box inside the panel.
// Cancel (either stage) and Esc close without saving.
function openSetPortraitDialog(entity, images) {
  // Guard against a second panel: no early-return here previously, so
  // a repeat click (or a click landing while a re-render is briefly
  // mid-flight) could append a duplicate panel on top of an already-
  // open one instead of doing nothing.
  if (document.querySelector('.portrait-picker-panel')) return;
  const previousTab = state.detailActiveTab;
  const panel = document.createElement('div');
  panel.className = 'portrait-picker-panel';
  const header = document.createElement('div');
  header.className = 'portrait-picker-header';
  header.textContent = 'Select a gallery image';
  panel.appendChild(header);
  const body = document.createElement('div');
  body.className = 'portrait-picker-body';
  panel.appendChild(body);
  document.body.appendChild(panel);

  // Drag-to-move the panel itself, via the header.
  let panelDrag = null;
  header.addEventListener('pointerdown', function (ev) {
    const rect = panel.getBoundingClientRect();
    panel.style.left = rect.left + 'px';
    panel.style.top = rect.top + 'px';
    panel.style.right = 'auto';
    header.setPointerCapture(ev.pointerId);
    panelDrag = { startX: ev.clientX, startY: ev.clientY, origLeft: rect.left, origTop: rect.top };
  });
  header.addEventListener('pointermove', function (ev) {
    if (!panelDrag) return;
    panel.style.left = (panelDrag.origLeft + (ev.clientX - panelDrag.startX)) + 'px';
    panel.style.top = (panelDrag.origTop + (ev.clientY - panelDrag.startY)) + 'px';
  });
  function endPanelDrag() { panelDrag = null; }
  header.addEventListener('pointerup', endPanelDrag);
  header.addEventListener('pointercancel', endPanelDrag);

  // Card drag handlers (Stage B only) — attached to the live card's hero
  // wrapper, not a preview box. Cleared on close/stage change.
  let cardDragCleanup = null;
  let workingImg = null;

  function renderCardPreview() {
    if (cardHeroState) portraitRenderInto(cardHeroState.imgEl, cardHeroState.hWrapEl, cardHeroState.vWrapEl, cardHeroState.containerEl, workingImg);
  }

  function attachCardDrag() {
    if (!cardHeroState) return;
    const heroEl = cardHeroState.containerEl;
    let dragState = null;
    function onDown(ev) {
      heroEl.setPointerCapture(ev.pointerId);
      heroEl.classList.add('dragging');
      const cw = heroEl.clientWidth, ch = heroEl.clientHeight;
      const startPx = portraitOffsetFracToPx(workingImg, cw, ch);
      dragState = { startX: ev.clientX, startY: ev.clientY, origX: startPx.x, origY: startPx.y };
    }
    function onMove(ev) {
      if (!dragState) return;
      const cw = heroEl.clientWidth, ch = heroEl.clientHeight;
      const dx = ev.clientX - dragState.startX, dy = ev.clientY - dragState.startY;
      const clamped = portraitClampOffset(workingImg, cw, ch, dragState.origX + dx, dragState.origY + dy);
      const frac = portraitOffsetPxToFrac(workingImg, cw, ch, clamped.x, clamped.y);
      workingImg.portraitOffsetXFrac = frac.xFrac;
      workingImg.portraitOffsetYFrac = frac.yFrac;
      renderCardPreview();
    }
    function onUp() { dragState = null; heroEl.classList.remove('dragging'); }
    heroEl.classList.add('portrait-card-editable');
    detailEl.classList.add('portrait-editing');
    heroEl.addEventListener('pointerdown', onDown);
    heroEl.addEventListener('pointermove', onMove);
    heroEl.addEventListener('pointerup', onUp);
    heroEl.addEventListener('pointercancel', onUp);
    cardDragCleanup = function () {
      heroEl.classList.remove('portrait-card-editable', 'dragging');
      detailEl.classList.remove('portrait-editing');
      heroEl.removeEventListener('pointerdown', onDown);
      heroEl.removeEventListener('pointermove', onMove);
      heroEl.removeEventListener('pointerup', onUp);
      heroEl.removeEventListener('pointercancel', onUp);
    };
  }

  function onKeydown(ev) { if (ev.key === 'Escape') close(); }
  document.addEventListener('keydown', onKeydown);

  function close() {
    if (cardDragCleanup) { cardDragCleanup(); cardDragCleanup = null; }
    portraitPreviewOverride = null;
    document.removeEventListener('keydown', onKeydown);
    panel.remove();
    state.detailActiveTab = previousTab;
    renderDetailForSelected(); // restore the card to committed state
  }

  function buildStageA() {
    header.textContent = 'Select a gallery image';
    body.innerHTML = '';
    const grid = document.createElement('div');
    grid.className = 'portrait-thumb-row';
    images.forEach(function (img) {
      const thumb = document.createElement('button');
      thumb.type = 'button';
      thumb.className = 'portrait-thumb';
      const thumbImg = document.createElement('img');
      thumbImg.src = img.data;
      thumbImg.alt = '';
      thumb.appendChild(thumbImg);
      thumb.addEventListener('click', function () { enterStageB(img); });
      grid.appendChild(thumb);
    });
    body.appendChild(grid);
    const actions = document.createElement('div');
    actions.className = 'modal-actions';
    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.textContent = 'Cancel';
    cancelBtn.addEventListener('click', close);
    actions.appendChild(cancelBtn);
    body.appendChild(actions);
  }

  function enterStageB(img) {
    workingImg = {
      id: img.id, data: img.data, width: img.width, height: img.height,
      isPortrait: true,
      portraitZoomStep: typeof img.portraitZoomStep === 'number' ? img.portraitZoomStep : 0,
      portraitOffsetXFrac: typeof img.portraitOffsetXFrac === 'number' ? img.portraitOffsetXFrac : 0,
      portraitOffsetYFrac: typeof img.portraitOffsetYFrac === 'number' ? img.portraitOffsetYFrac : 0,
      portraitFadeH: typeof img.portraitFadeH === 'number' ? img.portraitFadeH : 12,
      portraitFadeV: typeof img.portraitFadeV === 'number' ? img.portraitFadeV : 12
    };
    portraitPreviewOverride = { entityId: entity.id, img: workingImg };
    state.detailActiveTab = 'lore';
    renderDetailForSelected(); // rebuilds the card's hero from the override
    attachCardDrag();
    buildStageB();
  }

  function buildStageB() {
    header.textContent = 'Set portrait \u2014 ' + entity.name;
    body.innerHTML = '';

    const instructions = document.createElement('p');
    instructions.className = 'image-edit-status';
    instructions.textContent = 'Drag the image on the card to change focus.';
    body.appendChild(instructions);

    function makeControlSlider(opts) {
      // opts: { labelText, min, max, step, getValue, setValue, formatValue }
      const row = document.createElement('label');
      row.className = 'portrait-fade-row';
      const topLine = document.createElement('div');
      topLine.className = 'portrait-fade-top';
      const span = document.createElement('span');
      span.textContent = opts.labelText;
      const valSpan = document.createElement('span');
      valSpan.className = 'portrait-fade-value';
      valSpan.textContent = opts.formatValue(opts.getValue());
      topLine.appendChild(span);
      topLine.appendChild(valSpan);
      row.appendChild(topLine);
      const input = document.createElement('input');
      input.type = 'range';
      input.min = String(opts.min);
      input.max = String(opts.max);
      input.step = String(opts.step);
      input.value = String(opts.getValue());
      input.addEventListener('input', function () {
        opts.setValue(parseInt(input.value, 10));
        valSpan.textContent = opts.formatValue(opts.getValue());
        renderCardPreview();
      });
      row.appendChild(input);
      return row;
    }

    function formatZoomPct() {
      return Math.round((1 + workingImg.portraitZoomStep * PORTRAIT_ZOOM_STEP_FACTOR) * 100) + '%';
    }
    function setZoomStep(step) {
      workingImg.portraitZoomStep = Math.max(PORTRAIT_MIN_ZOOM_STEPS, Math.min(PORTRAIT_MAX_ZOOM_STEPS, step));
      // Re-clamp the offset at the new scale so it doesn't jump out of range.
      if (cardHeroState) {
        const cw = cardHeroState.containerEl.clientWidth, ch = cardHeroState.containerEl.clientHeight;
        const clamped = portraitOffsetFracToPx(workingImg, cw, ch);
        const frac = portraitOffsetPxToFrac(workingImg, cw, ch, clamped.x, clamped.y);
        workingImg.portraitOffsetXFrac = frac.xFrac;
        workingImg.portraitOffsetYFrac = frac.yFrac;
      }
    }

    const controlsWrap = document.createElement('div');
    controlsWrap.className = 'portrait-fade-sliders';
    controlsWrap.appendChild(makeControlSlider({
      labelText: 'Zoom', min: PORTRAIT_MIN_ZOOM_STEPS, max: PORTRAIT_MAX_ZOOM_STEPS, step: 1,
      getValue: function () { return workingImg.portraitZoomStep; },
      setValue: setZoomStep,
      formatValue: formatZoomPct
    }));
    controlsWrap.appendChild(makeControlSlider({
      labelText: 'Horizontal fade', min: 0, max: 45, step: 1,
      getValue: function () { return workingImg.portraitFadeH; },
      setValue: function (v) { workingImg.portraitFadeH = v; },
      formatValue: function (v) { return v + '%'; }
    }));
    controlsWrap.appendChild(makeControlSlider({
      labelText: 'Vertical fade', min: 0, max: 45, step: 1,
      getValue: function () { return workingImg.portraitFadeV; },
      setValue: function (v) { workingImg.portraitFadeV = v; },
      formatValue: function (v) { return v + '%'; }
    }));
    body.appendChild(controlsWrap);

    const actions = document.createElement('div');
    actions.className = 'modal-actions';
    const saveBtn = document.createElement('button');
    saveBtn.type = 'button';
    saveBtn.textContent = 'Save';
    saveBtn.addEventListener('click', function () {
      saveBtn.disabled = true;
      setEntityPortrait(entity.id, workingImg.id, {
        portraitZoomStep: workingImg.portraitZoomStep,
        portraitOffsetXFrac: workingImg.portraitOffsetXFrac,
        portraitOffsetYFrac: workingImg.portraitOffsetYFrac,
        portraitFadeH: workingImg.portraitFadeH,
        portraitFadeV: workingImg.portraitFadeV
      }).then(close).catch(function (err) {
        window.alert('Set portrait failed: ' + err.message);
        saveBtn.disabled = false;
      });
    });
    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.textContent = 'Cancel';
    cancelBtn.addEventListener('click', close);
    actions.appendChild(saveBtn);
    actions.appendChild(cancelBtn);
    body.appendChild(actions);

    renderCardPreview();
  }

  buildStageA();
}

// --- Set map dialog ----------------------------------------------------
// Much simpler than Set portrait -- no crop/zoom to configure, just
// which gallery image (if any) is this Location's map. Plain modal
// (not the docked drag-panel Set portrait uses), since there's no live
// card preview to keep visible underneath while picking.
function openSetMapDialog(entity, images) {
  if (document.querySelector('.map-picker-overlay')) return;
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay map-picker-overlay open';
  const box = document.createElement('div');
  box.className = 'modal-box modal-box-wide';
  overlay.appendChild(box);

  const h3 = document.createElement('h3');
  h3.textContent = 'Set map \u2014 ' + entity.name;
  box.appendChild(h3);

  const hint = document.createElement('p');
  hint.className = 'image-edit-status';
  hint.textContent = 'Choose which gallery image is this location\u2019s map. An image can be both the portrait and the map.';
  box.appendChild(hint);

  const currentMap = images.find(function (img) { return img.isMap; });

  function close() { overlay.remove(); }

  function pinWarning(actionLabel) {
    const pinCount = state.allPins.filter(function (p) { return p.mapEntityId === entity.id; }).length;
    if (!pinCount) return true;
    return window.confirm(
      'This location already has a map image with ' + pinCount + ' pin' + (pinCount === 1 ? '' : 's') +
      ' on it. ' + actionLabel + ' may leave existing pins misaligned, since pin positions are stored ' +
      'relative to the image. Continue?'
    );
  }

  const grid = document.createElement('div');
  grid.className = 'map-picker-grid';
  images.forEach(function (img) {
    const isCurrent = !!currentMap && img.id === currentMap.id;
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'map-picker-item' + (isCurrent ? ' active' : '');
    const imgEl = document.createElement('img');
    imgEl.src = img.data;
    imgEl.alt = entity.name;
    item.appendChild(imgEl);
    item.addEventListener('click', function () {
      if (isCurrent) { close(); return; }
      if (currentMap && !pinWarning('Replacing the map image')) return;
      setEntityMap(entity.id, img.id).then(close).catch(function (err) {
        window.alert('Set map failed: ' + err.message);
      });
    });
    grid.appendChild(item);
  });
  box.appendChild(grid);

  const actions = document.createElement('div');
  actions.className = 'modal-actions';
  if (currentMap) {
    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.textContent = 'Remove map image';
    removeBtn.addEventListener('click', function () {
      if (!pinWarning('Removing the map designation')) return;
      clearEntityMap(entity.id).then(close).catch(function (err) {
        window.alert('Remove failed: ' + err.message);
      });
    });
    actions.appendChild(removeBtn);
  }
  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.textContent = 'Cancel';
  cancelBtn.addEventListener('click', close);
  actions.appendChild(cancelBtn);
  box.appendChild(actions);

  overlay.addEventListener('click', function (ev) { if (ev.target === overlay) close(); });
  document.body.appendChild(overlay);
}

// --- Gallery tab -----------------------------------------------------------
// Unlike Lore items, gallery images have no separate edit-mode UI on the
// Entry Card itself — all image management (visibility, delete, add) lives
// here in the Gallery tab, GM view only.

function openImageLightbox(src, alt) {
  const overlay = document.createElement('div');
  overlay.className = 'image-lightbox-overlay';
  const img = document.createElement('img');
  img.src = src;
  img.alt = alt || '';
  overlay.appendChild(img);
  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'image-lightbox-close';
  closeBtn.setAttribute('aria-label', 'Close');
  closeBtn.textContent = '\u2715';
  overlay.appendChild(closeBtn);

  function close() {
    overlay.remove();
    document.removeEventListener('keydown', onKey);
  }
  function onKey(ev) { if (ev.key === 'Escape') close(); }
  overlay.addEventListener('click', function (ev) { if (ev.target === overlay) close(); });
  closeBtn.addEventListener('click', close);
  document.addEventListener('keydown', onKey);
  document.body.appendChild(overlay);
}

// Lazy-loads SortableJS (same lazy-CDN pattern as marked/DOMPurify/
// CodeMirror elsewhere in this app) rather than native HTML5 drag-and-drop,
// which iOS Safari does not support for touch — SortableJS has real touch
// support, which matters since this app is primarily used from iOS.
function loadSortable() {
  if (!state.sortableModulePromise) {
    state.sortableModulePromise = import('https://esm.sh/sortablejs@1.15.2')
      .then(function (mod) { return mod.default || mod; });
  }
  return state.sortableModulePromise;
}

function persistGalleryOrder(entityId, orderedIds) {
  const batch = writeBatch(db);
  orderedIds.forEach(function (id, idx) {
    batch.update(doc(db, 'images', id), { sortOrder: idx });
  });
  batch.commit().catch(function (err) {
    window.alert('Reorder failed: ' + err.message);
    renderDetailForSelected();
  });
}

function openGalleryUploadModal(entity) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay open';
  const box = document.createElement('div');
  box.className = 'modal-box';

  const h3 = document.createElement('h3');
  h3.textContent = 'New gallery image';
  box.appendChild(h3);

  const label = document.createElement('label');
  label.textContent = 'Image file';
  box.appendChild(label);

  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/*';
  box.appendChild(input);

  const statusEl = document.createElement('p');
  statusEl.className = 'image-edit-status';
  box.appendChild(statusEl);

  let selectedFile = null;
  input.addEventListener('change', function () {
    selectedFile = input.files[0] || null;
    statusEl.textContent = selectedFile ? selectedFile.name : '';
  });

  function close() { overlay.remove(); }

  const actions = document.createElement('div');
  actions.className = 'modal-actions';
  const saveBtn = document.createElement('button');
  saveBtn.type = 'button';
  saveBtn.textContent = 'Save';
  saveBtn.addEventListener('click', function () {
    if (!selectedFile) { statusEl.textContent = 'Choose an image first.'; return; }
    saveBtn.disabled = true;
    input.disabled = true;
    uploadEntityGalleryImage(entity.id, selectedFile, {
      onStatus: function (text) { statusEl.textContent = text; }
    }).then(close).catch(function (err) {
      statusEl.textContent = err.message;
      saveBtn.disabled = false;
      input.disabled = false;
    });
  });
  actions.appendChild(saveBtn);
  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.textContent = 'Cancel';
  cancelBtn.addEventListener('click', close);
  actions.appendChild(cancelBtn);
  box.appendChild(actions);

  overlay.appendChild(box);
  overlay.addEventListener('click', function (ev) { if (ev.target === overlay) close(); });
  document.body.appendChild(overlay);
}

function renderGalleryTab(container, entity, gmView, readOnly) {
  const galleryImages = galleryImagesFor(entity.id, gmView);
  const currentPortrait = portraitImageFor(entity, gmView);
  const isLocation = entity.category === 'Location';
  const currentMapImg = isLocation ? galleryImages.find(function (img) { return img.isMap; }) : null;
  const showChrome = gmView && !readOnly;

  if (showChrome && galleryImages.length) {
    const hintBox = document.createElement('div');
    hintBox.className = 'gallery-hint-box';
    const hint = document.createElement('p');
    hint.className = 'image-edit-status';
    hint.textContent = isLocation
      ? 'Drag images to reorder them. The portrait-marked image is used for the entry card\u2019s hero header; the map-marked image is used on the Map tab. An image can be both.'
      : 'Drag images to reorder them. The portrait-marked image is used for the entry card\u2019s hero header.';
    hintBox.appendChild(hint);
    container.appendChild(hintBox);
  }

  if (galleryImages.length) {
    const galleryDiv = document.createElement('div');
    galleryDiv.className = 'codex-gallery';
    galleryImages.forEach(function (img) {
      const isCurrentPortrait = !!currentPortrait && img.id === currentPortrait.id;
      const isCurrentMap = !!currentMapImg && img.id === currentMapImg.id;
      const figDiv = document.createElement('div');
      figDiv.className = 'gallery-item ' + (img.visibility === 'all-players' ? 'vis-visible' : 'vis-hidden');
      figDiv.dataset.imageId = img.id;

      const imgWrap = document.createElement('div');
      imgWrap.className = 'gallery-item-image-wrap';
      const imgEl = document.createElement('img');
      imgEl.src = img.data;
      imgEl.alt = entity.name;
      imgEl.addEventListener('click', function () { openImageLightbox(img.data, entity.name); });
      imgWrap.appendChild(imgEl);

      // Explicitly requested exception to the "only add icons when asked"
      // rule — small partially-transparent indicator over whichever
      // thumbnail is currently the portrait and/or map (an image can be
      // both at once, so these are independent badges, not a single
      // either/or one). Don't extrapolate from this to add icons
      // elsewhere. Aligned to the image's own top-right corner (imgWrap,
      // not figDiv, so it isn't thrown off by figDiv's padding).
      if (isCurrentPortrait) {
        const indicator = document.createElement('span');
        indicator.className = 'gallery-portrait-indicator';
        indicator.title = 'Current portrait';
        indicator.innerHTML = CONFIG.icons.portrait;
        imgWrap.appendChild(indicator);
      }
      if (isCurrentMap) {
        // Deliberately a different glyph from the portrait star (per
        // Gregg's ask) -- reuses CONFIG.icons.map, the same map emoji
        // already used for the "open map" link elsewhere on this card,
        // so it reads as "this is the map" rather than needing a new
        // one-off symbol.
        const mapIndicator = document.createElement('span');
        mapIndicator.className = 'gallery-map-indicator' + (isCurrentPortrait ? ' stacked' : '');
        mapIndicator.title = 'Current map image';
        mapIndicator.innerHTML = CONFIG.icons.map;
        imgWrap.appendChild(mapIndicator);
      }
      figDiv.appendChild(imgWrap);

      const sourceLabelDiv = document.createElement('div');
      sourceLabelDiv.className = 'source-label';
      renderSourceLabel(sourceLabelDiv, img.sourceId, entity.sourceId);
      figDiv.appendChild(sourceLabelDiv);

      if (showChrome) {
        const toggleBarDiv = document.createElement('div');
        toggleBarDiv.className = 'gallery-item-bar';
        const visible = img.visibility === 'all-players';
        const toggleLabel = document.createElement('span');
        toggleLabel.className = 'toggle-switch-label ' + (visible ? 'state-visible' : 'state-hidden');
        toggleLabel.textContent = visible ? 'Visible to party' : 'Hidden from party';
        toggleBarDiv.appendChild(toggleLabel);
        const switchLabel = document.createElement('label');
        switchLabel.className = 'toggle-switch';
        const switchInput = document.createElement('input');
        switchInput.type = 'checkbox';
        switchInput.checked = visible;
        switchInput.addEventListener('change', function () {
          if (switchInput.checked && !confirmRevealWithoutSource(img.sourceId)) {
            switchInput.checked = false;
            return;
          }
          setGalleryImageVisibility(img.id, switchInput.checked ? 'all-players' : 'gm-only')
            .catch(function (err) { window.alert('Visibility change failed: ' + err.message); });
        });
        const switchSlider = document.createElement('span');
        switchSlider.className = 'toggle-slider';
        switchLabel.appendChild(switchInput);
        switchLabel.appendChild(switchSlider);
        toggleBarDiv.appendChild(switchLabel);
        figDiv.insertBefore(toggleBarDiv, imgWrap);

        // Footer: source dropdown then Delete, stacked below the image
        // (and below the read-only source-label above, if shown) per
        // Gregg's requested card order: toggle / image / source / delete.
        const footerDiv = document.createElement('div');
        footerDiv.className = 'gallery-item-footer';

        const sourceSelect = buildSourceSelect(img.sourceId, function (newSourceId) {
          setGalleryImageSource(img.id, newSourceId)
            .catch(function (err) { window.alert('Source change failed: ' + err.message); });
        });
        footerDiv.appendChild(sourceSelect);

        const delBtn = document.createElement('button');
        delBtn.type = 'button';
        delBtn.className = 'action-btn-compact';
        delBtn.textContent = 'Delete';
        delBtn.addEventListener('click', function () {
          // Same pin-misalignment warning the old standalone map-image
          // delete used to show, now scoped to "is THIS gallery image
          // currently the map" rather than a separate delete flow.
          const pinCount = img.isMap
            ? state.allPins.filter(function (p) { return p.mapEntityId === entity.id; }).length
            : 0;
          const warning = pinCount > 0
            ? 'Delete this gallery image? It\u2019s the current map image and has ' + pinCount +
              ' pin' + (pinCount === 1 ? '' : 's') + ' on it, which will be unreachable until a new map image is set.'
            : 'Delete this gallery image?';
          if (!window.confirm(warning)) return;
          deleteEntityGalleryImage(img.id).catch(function (err) { window.alert('Delete failed: ' + err.message); });
        });
        footerDiv.appendChild(delBtn);
        figDiv.appendChild(footerDiv);
      }
      galleryDiv.appendChild(figDiv);
    });
    container.appendChild(galleryDiv);

    if (showChrome && galleryImages.length > 1) {
      loadSortable().then(function (Sortable) {
        // eslint-disable-next-line no-new
        new Sortable(galleryDiv, {
          // forceFallback: same fix as the admin Sources drag (admin.js)
          // -- native HTML5 DnD (SortableJS's default for non-touch
          // input) doesn't reliably initiate from trackpad-as-mouse
          // input in Safari; a click without enough drag distance reads
          // as a text/element selection instead. Touch never uses native
          // DnD so it was unaffected, which is why this only showed up
          // on trackpad. Forcing SortableJS's own JS-simulated drag for
          // both input types fixes the asymmetry.
          forceFallback: true,
          animation: 150,
          onEnd: function () {
            const orderedIds = Array.prototype.slice.call(galleryDiv.children)
              .map(function (el) { return el.dataset.imageId; });
            persistGalleryOrder(entity.id, orderedIds);
          }
        });
      }).catch(function () { /* drag-reorder unavailable; toggle/delete still work */ });
    }
  } else {
    const emptyP = document.createElement('p');
    emptyP.className = 'lore-empty';
    emptyP.textContent = '(no gallery images)';
    container.appendChild(emptyP);
  }

  if (showChrome) {
    const actions = document.createElement('div');
    actions.className = 'actions-row';
    const right = document.createElement('div');
    right.className = 'actions-row-right';
    const newImageBtn = document.createElement('button');
    newImageBtn.className = 'action-btn-compact';
    newImageBtn.textContent = '+ New image';
    newImageBtn.addEventListener('click', function () { openGalleryUploadModal(entity); });
    right.appendChild(newImageBtn);
    if (galleryImages.length) {
      const portraitBtn = document.createElement('button');
      portraitBtn.type = 'button';
      portraitBtn.className = 'action-btn-compact';
      portraitBtn.textContent = 'Set portrait';
      portraitBtn.addEventListener('click', function () { openSetPortraitDialog(entity, galleryImages); });
      right.appendChild(portraitBtn);
      if (isLocation) {
        const mapBtn = document.createElement('button');
        mapBtn.type = 'button';
        mapBtn.className = 'action-btn-compact';
        mapBtn.textContent = 'Set map';
        mapBtn.addEventListener('click', function () { openSetMapDialog(entity, galleryImages); });
        right.appendChild(mapBtn);
      }
    }
    actions.appendChild(right);
    container.appendChild(actions);
  }
}

// --- My Knowledge (detail pane) -------------------------------------------

// Pared-down, view-only Codex entry card for map pin preview
// popups (hover on mouse, tap on touch — see map.js). Same header
// region as the full card (name, entry type/ancestry, meta line,
// tags) but with NO interactive controls (no visibility toggle, no
// map link, no tab menu) — just the first lore item if there is one,
// view-only, with a "…" hint if there are more not being shown.
// Appends formatDateSegments' {text,bold} segments as text nodes / <b>
// elements into an HTML container -- shared by both meta-line builders
// below and reused wherever an authored date string needs the spaced/
// bold-"a" display treatment outside SVG contexts (which use their own
// <tspan>-based version, see timeline.js appendDateTspans).
function appendDateSegments(container, raw) {
  formatDateSegments(raw).forEach(function (seg) {
    if (seg.bold) {
      const b = document.createElement('b');
      b.className = 'date-ago-marker';
      b.textContent = seg.text;
      container.appendChild(b);
    } else {
      container.appendChild(document.createTextNode(seg.text));
    }
  });
}

// Shared "Also known as / Date / Owned by" meta line, used by both the
// small map-pin/preview card and the full entity view card -- was
// duplicated inline in both places before; centralized here so the
// date-formatting treatment (spacing + bold "a") only needs applying
// once. Returns the built <div> (caller appends it), or null if there's
// nothing to show.
function buildEntityMetaLine(entity, gmView) {
  const bits = [];
  if (entity.aliases && entity.aliases.length) bits.push({ kind: 'text', text: 'Also known as: ' + entity.aliases.join(', ') });
  if (entity.date) bits.push({ kind: 'date', label: 'Date: ', date: entity.date, dateEnd: entity.dateEnd || null });
  if (entity.ownerId && gmView) bits.push({ kind: 'text', text: 'Owned by: ' + entity.ownerId });
  if (!bits.length) return null;

  const metaDiv = document.createElement('div');
  metaDiv.className = 'entity-meta-line';
  bits.forEach(function (bit, i) {
    if (i > 0) metaDiv.appendChild(document.createTextNode(' \u00b7 '));
    if (bit.kind === 'date') {
      metaDiv.appendChild(document.createTextNode(bit.label));
      appendDateSegments(metaDiv, bit.date);
      if (bit.dateEnd) {
        metaDiv.appendChild(document.createTextNode(' \u2013 ')); // en dash, "to"
        appendDateSegments(metaDiv, bit.dateEnd);
      }
    } else {
      metaDiv.appendChild(document.createTextNode(bit.text));
    }
  });
  return metaDiv;
}

function buildEntityPreviewCard(entity, gmView) {
  const card = document.createElement('div');
  card.className = 'entity-preview-card';

  const heading = document.createElement('h3');
  heading.textContent = entity.name;
  card.appendChild(heading);

  const catP = document.createElement('p');
  catP.className = 'entity-type-line';
  const catEm = document.createElement('em');
  catEm.textContent = entity.category || '';
  catP.appendChild(catEm);
  if (entity.ancestry) {
    catP.appendChild(document.createTextNode(' \u2014 '));
    const ancestrySpan = document.createElement('span');
    ancestrySpan.textContent = entity.ancestry;
    catP.appendChild(ancestrySpan);
    applyWikiLinks(ancestrySpan, entity.id, gmView);
  }
  if (entity.subtype) {
    catP.appendChild(document.createTextNode(' \u2014 ' + entity.subtype));
  }
  card.appendChild(catP);

  const metaLine = buildEntityMetaLine(entity, gmView);
  if (metaLine) card.appendChild(metaLine);

  if (entity.tags && entity.tags.length) {
    // Class, not #codex-tags id — this card can coexist in the DOM
    // with the real Codex tab's own #codex-detail (different active
    // tab-panel), and ids must stay unique document-wide.
    const tagsDiv = document.createElement('div');
    tagsDiv.className = 'entity-preview-tags';
    entity.tags.forEach(function (t) {
      const span = document.createElement('span');
      span.textContent = t;
      tagsDiv.appendChild(span);
    });
    card.appendChild(tagsDiv);
  }

  const items = loreItemsForEntity(entity.id, gmView);
  if (items.length) {
    const first = items[0];
    const itemDiv = document.createElement('div');
    itemDiv.className = 'lore-item ' + (first.visibility === 'all-players' ? 'vis-visible' : 'vis-hidden');
    const bodyDiv = document.createElement('div');
    bodyDiv.className = 'lore-item-body';
    renderMarkdownInto(bodyDiv, first.content).then(function () {
      applyWikiLinks(bodyDiv, entity.id, gmView);
    });
    itemDiv.appendChild(bodyDiv);
    card.appendChild(itemDiv);
    if (items.length > 1) {
      const moreP = document.createElement('p');
      moreP.className = 'entity-preview-more';
      moreP.textContent = '\u2026';
      card.appendChild(moreP);
    }
  }

  const hintP = document.createElement('p');
  hintP.className = 'entity-preview-hint';
  hintP.textContent = 'Tap/click to open';
  card.appendChild(hintP);

  return card;
}

function renderDetailForSelected() {
  const entity = state.allEntities.find(function (e) { return e.id === state.selectedId; });
  const gmView = isGmView();

  setEntityImagesTarget(entity ? entity.id : null);

  if (!entity || (!gmView && !isEntityPlayerVisible(entity.id))) {
    detailPaneEl.classList.add('empty');
    detailEl.classList.remove('vis-hidden', 'vis-visible');
    detailEl.innerHTML = '<p class="codex-empty">What would you like to read? Make a selection from your Table of Contents.</p>';
    return;
  }
  detailPaneEl.classList.remove('empty');

  detailEl.classList.remove('vis-hidden', 'vis-visible');
  detailEl.classList.add(entity.visibility === 'all-players' ? 'vis-visible' : 'vis-hidden');

  const editing = gmView && state.detailEditMode && state.detailEditDraft;
  const draft = editing ? state.detailEditDraft : null;

  detailEl.innerHTML = '';

  if (!editing) {
    renderEntityViewCard(detailEl, entity, gmView, {
      allowEdit: true,
      activeTab: state.detailActiveTab,
      onTabChange: function (tabKey) { state.detailActiveTab = tabKey; renderDetailForSelected(); },
      onRelatedClick: function (id) { selectEntity(id, true); }
    });
    return;
  }

  // --- Edit mode: no hero (avoids layering/interaction conflict with the
  // edit fields), no tabs/related/footer -- tags/related/delete are all
  // edited inline via renderEntityEditBlock instead. Kept as its own path
  // (rather than folded into renderEntityViewCard) since editing UI has no
  // read-only analog to share. ---
  detailEl.classList.remove('has-hero');
  cardHeroState = null;

  const contentWrap = document.createElement('div');
  contentWrap.className = 'codex-card-content';
  detailEl.appendChild(contentWrap);

  // Phase 13: someone else (another GM tab, or a re-sync after this GM's
  // own connection dropped) saved this entity while this edit form was
  // open. Draft text is never silently touched by this -- state.draft
  // already isolates typed content from re-renders -- this is purely a
  // heads-up + explicit choice, not a race in the data itself.
  const liveUpdatedAtMs = updatedAtMs(entity);
  const hasConflict = state.detailEditBaseUpdatedAtMs != null &&
    liveUpdatedAtMs != null &&
    liveUpdatedAtMs !== state.detailEditBaseUpdatedAtMs &&
    liveUpdatedAtMs !== state.detailEditConflictDismissedAtMs;
  if (hasConflict) {
    const conflictBanner = document.createElement('div');
    conflictBanner.className = 'edit-conflict-banner';
    const conflictMsg = document.createElement('p');
    conflictMsg.textContent = 'This entry was saved elsewhere while you were editing.';
    conflictBanner.appendChild(conflictMsg);
    const conflictActions = document.createElement('div');
    conflictActions.className = 'edit-conflict-actions';
    const keepBtn = document.createElement('button');
    keepBtn.textContent = 'Keep my edits';
    keepBtn.addEventListener('click', function () {
      state.detailEditConflictDismissedAtMs = liveUpdatedAtMs;
      renderDetailForSelected();
    });
    const reloadBtn = document.createElement('button');
    reloadBtn.textContent = 'Reload latest';
    reloadBtn.addEventListener('click', function () {
      state.detailEditDraft = buildEntityDraft(entity);
      state.detailEditBaseUpdatedAtMs = liveUpdatedAtMs;
      state.detailEditConflictDismissedAtMs = null;
      renderDetailForSelected();
    });
    conflictActions.appendChild(keepBtn);
    conflictActions.appendChild(reloadBtn);
    conflictBanner.appendChild(conflictActions);
    contentWrap.appendChild(conflictBanner);
  }

  const headingRow = document.createElement('div');
  headingRow.className = 'codex-card-heading';

  const leftCol = document.createElement('div');
  leftCol.className = 'codex-card-heading-left';

  const nameField = makeEditField('Name', draft.name, function (v) { draft.name = v; });
  nameField.classList.add('entity-name-field');
  leftCol.appendChild(nameField);
  const catWrap = document.createElement('div');
  catWrap.className = 'entity-edit-field';
  const catLabel = document.createElement('label');
  catLabel.textContent = 'Entry type';
  catWrap.appendChild(catLabel);
  const catSelect = document.createElement('select');
  CONFIG.categories.forEach(function (c) {
    const opt = document.createElement('option');
    opt.value = c;
    opt.textContent = c;
    catSelect.appendChild(opt);
  });
  catSelect.value = draft.category;
  catSelect.addEventListener('change', function () {
    draft.category = catSelect.value;
    renderDetailForSelected();
  });
  catWrap.appendChild(catSelect);
  leftCol.appendChild(catWrap);

  if ((CONFIG.subtypesByCategory[draft.category] || []).length) {
    const subtypeWrap = document.createElement('div');
    subtypeWrap.className = 'entity-edit-field';
    const subtypeLabelEl = document.createElement('label');
    subtypeLabelEl.textContent = 'Subtype';
    subtypeWrap.appendChild(subtypeLabelEl);
    const subtypeSelect = document.createElement('select');
    const noneOpt = document.createElement('option');
    noneOpt.value = '';
    noneOpt.textContent = '-- none --';
    subtypeSelect.appendChild(noneOpt);
    CONFIG.subtypesByCategory[draft.category].forEach(function (st) {
      const opt = document.createElement('option');
      opt.value = st;
      opt.textContent = subtypeLabel(st);
      subtypeSelect.appendChild(opt);
    });
    subtypeSelect.value = draft.subtype || '';
    subtypeSelect.addEventListener('change', function () { draft.subtype = subtypeSelect.value; });
    subtypeWrap.appendChild(subtypeSelect);
    leftCol.appendChild(subtypeWrap);
  }

  if (draft.category === 'Character') {
    // Dropdown, not free text -- lists every Ancestry-category entity's
    // name (stored as plain text on draft.ancestry, same as before;
    // wiki-link resolution already matches by name, so this doesn't
    // change how that works, just constrains entry to real Ancestries
    // instead of allowing typos/drift). A legacy value that doesn't
    // match any current Ancestry entity is kept as its own option
    // rather than silently dropped -- reopening for edit shouldn't
    // blank a field the GM didn't touch.
    const ancestryWrap = document.createElement('div');
    ancestryWrap.className = 'entity-edit-field';
    const ancestryLabel = document.createElement('label');
    ancestryLabel.textContent = 'Ancestry';
    ancestryWrap.appendChild(ancestryLabel);
    const ancestrySelect = document.createElement('select');
    const ancestryNoneOpt = document.createElement('option');
    ancestryNoneOpt.value = '';
    ancestryNoneOpt.textContent = '-- none --';
    ancestrySelect.appendChild(ancestryNoneOpt);
    const ancestryNames = state.allEntities
      .filter(function (e) { return e.category === 'Ancestry'; })
      .map(function (e) { return e.name; })
      .sort(function (a, b) { return a.localeCompare(b); });
    if (draft.ancestry && ancestryNames.indexOf(draft.ancestry) === -1) {
      ancestryNames.unshift(draft.ancestry);
    }
    ancestryNames.forEach(function (name) {
      const opt = document.createElement('option');
      opt.value = name;
      opt.textContent = name;
      ancestrySelect.appendChild(opt);
    });
    ancestrySelect.value = draft.ancestry || '';
    ancestrySelect.addEventListener('change', function () { draft.ancestry = ancestrySelect.value; });
    ancestryWrap.appendChild(ancestrySelect);
    leftCol.appendChild(ancestryWrap);

    leftCol.appendChild(makeEditField('Aliases (comma-separated)', draft.aliases, function (v) { draft.aliases = v; }));
    const ownerWrap = document.createElement('div');
    ownerWrap.className = 'entity-edit-field';
    const ownerLabel = document.createElement('label');
    ownerLabel.textContent = 'Owned by party member';
    ownerWrap.appendChild(ownerLabel);
    const ownerSelect = document.createElement('select');
    const noneOpt = document.createElement('option');
    noneOpt.value = '';
    noneOpt.textContent = '-- unassigned --';
    ownerSelect.appendChild(noneOpt);
    (state.allPlayers || []).slice().sort(function (a, b) { return a.id.localeCompare(b.id); }).forEach(function (p) {
      const opt = document.createElement('option');
      opt.value = p.id;
      opt.textContent = p.displayName ? (p.displayName + ' (' + p.id + ')') : p.id;
      ownerSelect.appendChild(opt);
    });
    ownerSelect.value = draft.ownerId;
    ownerSelect.addEventListener('change', function () { draft.ownerId = ownerSelect.value; });
    ownerWrap.appendChild(ownerSelect);
    leftCol.appendChild(ownerWrap);
  }
  if (draft.category === 'Scene' || draft.category === 'Event') {
    leftCol.appendChild(makeEditField('Date', draft.date, function (v) { draft.date = v; }, { placeholder: 'e.g. 12d, 45y   or   3500ya' }));
    leftCol.appendChild(makeEditField('End date (optional, for a span)', draft.dateEnd, function (v) { draft.dateEnd = v; }, { placeholder: 'leave blank for a single point in time' }));
  }
  headingRow.appendChild(leftCol);

  const rightCol = document.createElement('div');
  rightCol.className = 'codex-card-heading-right';
  rightCol.appendChild(buildEntityVisibilityToggle(entity)); // editing implies gmView
  if (entity.category === 'Location' && entity.hasMapImage) {
    const mapLink = document.createElement('button');
    mapLink.type = 'button';
    mapLink.className = 'entity-map-link';
    mapLink.title = 'Open map';
    mapLink.innerHTML = CONFIG.icons.map;
    mapLink.addEventListener('click', function () {
      if (mapNavigationHandler) mapNavigationHandler(entity.id);
    });
    rightCol.appendChild(mapLink);
  }
  headingRow.appendChild(rightCol);
  contentWrap.appendChild(headingRow);

  const editBlock = document.createElement('div');
  editBlock.className = 'entity-edit-block';
  renderEntityEditBlock(editBlock, entity, draft);
  contentWrap.appendChild(editBlock);
}

// Shared read-only entity card renderer -- hero, heading, meta/tags,
// Lore/Gallery/Notes tabs, related chips, source label. Used by the Codex
// tab's own view-mode display (opts.allowEdit:true unlocks the visibility
// toggle and GM Edit/Delete actions row) AND by read-only side panels
// (Timeline's entry-card panel now; Map's planned back-port later) with
// opts.allowEdit:false -- same rendering, no GM controls or clutter,
// regardless of the viewer's actual role. Content visibility (which lore
// items/gallery images are included) still follows the real gmView passed
// in; only editing/toggle CHROME is gated by allowEdit. Structural element
// ids from the pre-refactor single-instance version are now classes,
// since this can render into more than one container in the DOM at once
// (Codex tab + Timeline panel simultaneously) -- ids must stay
// document-unique, same reasoning as buildEntityPreviewCard's existing
// class-not-id comment.
function renderEntityViewCard(container, entity, gmView, opts) {
  opts = opts || {};
  const allowEdit = !!opts.allowEdit;

  container.classList.remove('vis-hidden', 'vis-visible');
  container.classList.add(entity.visibility === 'all-players' ? 'vis-visible' : 'vis-hidden');

  // Absolutely-positioned overlay in the card's top-left corner (e.g.
  // Map's Well-C close button) -- separate from the heading row's own
  // right-side controls, since this needs to sit at the card's own
  // corner regardless of hero-band/heading layout. .codex-entity-card
  // is already position:relative (hero-band background layer), so no
  // extra positioning context needed here.
  if (opts.topLeftExtra) {
    container.appendChild(opts.topLeftExtra);
  }

  const portrait = portraitImageFor(entity, gmView);
  container.classList.toggle('has-hero', !!portrait);
  if (portrait) {
    const band = document.createElement('div');
    band.className = 'codex-card-hero-band';
    band.appendChild(buildCardHero(entity, portrait, allowEdit));
    container.appendChild(band);
  } else if (allowEdit) {
    cardHeroState = null;
  }

  const contentWrap = document.createElement('div');
  contentWrap.className = 'codex-card-content';
  container.appendChild(contentWrap);

  const headingRow = document.createElement('div');
  headingRow.className = 'codex-card-heading';

  const leftCol = document.createElement('div');
  leftCol.className = 'codex-card-heading-left';

  const heading = document.createElement('h2');
  heading.textContent = entity.name;
  leftCol.appendChild(heading);

  const catP = document.createElement('p');
  catP.className = 'entity-type-line';
  const catEm = document.createElement('em');
  catEm.textContent = entity.category || '';
  catP.appendChild(catEm);
  if (entity.ancestry) {
    catP.appendChild(document.createTextNode(' \u2014 '));
    const ancestrySpan = document.createElement('span');
    ancestrySpan.textContent = entity.ancestry;
    catP.appendChild(ancestrySpan);
    applyWikiLinks(ancestrySpan, entity.id, gmView);
  }
  if (entity.subtype) {
    catP.appendChild(document.createTextNode(' \u2014 ' + entity.subtype));
  }
  leftCol.appendChild(catP);

  const metaLine = buildEntityMetaLine(entity, gmView);
  if (metaLine) leftCol.appendChild(metaLine);

  // Structured details/features render as a display-time merge into the
  // entity's lore items (first 'meta-details'/'meta-features' item) --
  // see resolveLoreItemMarkdown -- not as a standalone block here.

  if (entity.tags && entity.tags.length) {
    const tagsDiv = document.createElement('div');
    tagsDiv.className = 'codex-tags';
    (entity.tags || []).forEach(function (t) {
      const span = document.createElement('span');
      span.textContent = t;
      tagsDiv.appendChild(span);
    });
    leftCol.appendChild(tagsDiv);
  }
  headingRow.appendChild(leftCol);

  const rightCol = document.createElement('div');
  rightCol.className = 'codex-card-heading-right';
  if (gmView && allowEdit) {
    rightCol.appendChild(buildEntityVisibilityToggle(entity));
  }
  // Read-only panels (Timeline now, Map later) can inject their own
  // heading-right control here -- e.g. Timeline's GM-only "Edit in
  // Codex" button, which deliberately does NOT unlock inline editing
  // on the read-only card itself (that stays out of scope, per
  // Gregg's "no GM controls or clutter" call) but instead jumps to
  // the Codex tab's real edit flow for that same entity.
  if (opts.headingRightExtra) {
    rightCol.appendChild(opts.headingRightExtra);
  }
  if (entity.category === 'Location' && entity.hasMapImage) {
    const mapLink = document.createElement('button');
    mapLink.type = 'button';
    mapLink.className = 'entity-map-link';
    mapLink.title = 'Open map';
    mapLink.innerHTML = CONFIG.icons.map;
    mapLink.addEventListener('click', function () {
      if (mapNavigationHandler) mapNavigationHandler(entity.id);
    });
    rightCol.appendChild(mapLink);
  }
  headingRow.appendChild(rightCol);
  contentWrap.appendChild(headingRow);

  const tabsRow = document.createElement('div');
  tabsRow.className = 'codex-detail-tabs';
  const activeTab = opts.activeTab || 'lore';
  [['lore', 'Lore'], ['gallery', 'Gallery'], ['notes', 'Notes']].forEach(function (pair) {
    const tabKey = pair[0];
    const tabBtn = document.createElement('button');
    tabBtn.type = 'button';
    tabBtn.textContent = pair[1];
    if (activeTab === tabKey) tabBtn.classList.add('active');
    tabBtn.addEventListener('click', function () {
      if (opts.onTabChange) opts.onTabChange(tabKey);
    });
    tabsRow.appendChild(tabBtn);
  });
  contentWrap.appendChild(tabsRow);

  const tabPanel = document.createElement('div');
  tabPanel.className = 'codex-detail-tab-panel';
  contentWrap.appendChild(tabPanel);

  if (activeTab === 'notes') {
    const notesEmptyP = document.createElement('p');
    notesEmptyP.className = 'lore-empty';
    notesEmptyP.textContent = 'Notes are coming in a future update.';
    tabPanel.appendChild(notesEmptyP);
  } else if (activeTab === 'gallery') {
    renderGalleryTab(tabPanel, entity, gmView, !allowEdit);
  } else {
    renderLoreTab(tabPanel, entity, gmView, !allowEdit);
  }

  // --- Related entities ---
  // Lore-tab only (intended design) -- these chips are about the
  // entity's in-fiction connections, which belongs with its lore
  // content, not floating under Gallery/Notes too.
  // Relatedness is enforced symmetric at display time: A -> B always
  // implies B -> A, even if only one side's relatedIds array actually
  // stores the link (e.g. a link added before this rule existed, or an
  // edit that only touched one side). We don't rewrite the other side's
  // document — just union it in here — so this stays correct regardless
  // of which entity's data is stale.
  // Player view only links to targets that are themselves player-visible;
  // dangling IDs (deleted target) silently skipped.
  if (activeTab === 'lore') {
    const reverseRelatedIds = state.allEntities
      .filter(function (e) { return e.id !== entity.id && (e.relatedIds || []).indexOf(entity.id) !== -1; })
      .map(function (e) { return e.id; });
    const relatedIds = (entity.relatedIds || []).concat(reverseRelatedIds)
      .filter(function (id, idx, arr) { return arr.indexOf(id) === idx; });
    if (relatedIds.length) {
      const visibleRelated = relatedIds
        .map(function (id) { return state.allEntities.find(function (e) { return e.id === id; }); })
        .filter(function (target) { return target && (gmView || isEntityPlayerVisible(target.id)); });

      if (visibleRelated.length) {
        const relatedDiv = document.createElement('div');
        relatedDiv.className = 'codex-related';
        const chipsDiv = document.createElement('div');
        chipsDiv.className = 'codex-related-chips';
        visibleRelated.forEach(function (target) {
          const chip = document.createElement('button');
          chip.type = 'button';
          chip.className = 'related-chip';
          chip.textContent = target.name;
          chip.addEventListener('click', function () {
            if (opts.onRelatedClick) opts.onRelatedClick(target.id);
          });
          chipsDiv.appendChild(chip);
        });
        relatedDiv.appendChild(chipsDiv);
        contentWrap.appendChild(relatedDiv);
      }
    }
  }

  // --- GM Edit/Delete actions (lower-right), then source attribution
  // (lower-left) on its own row below them. Only in allowEdit mode --
  // read-only panels never show these regardless of gmView. ---
  if (gmView && allowEdit) {
    const cardActions = document.createElement('div');
    cardActions.className = 'actions-row codex-card-bottom-actions';
    const right = document.createElement('div');
    right.className = 'actions-row-right';
    const editBtn = document.createElement('button');
    editBtn.className = 'action-btn-compact';
    editBtn.textContent = 'Edit';
    editBtn.addEventListener('click', function () { enterEntityEditMode(entity); });
    right.appendChild(editBtn);
    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'action-btn-compact';
    deleteBtn.textContent = 'Delete';
    deleteBtn.addEventListener('click', function () { deleteEntity(entity); });
    right.appendChild(deleteBtn);
    cardActions.appendChild(right);
    contentWrap.appendChild(cardActions);
  }
  const sourceLabelDiv = document.createElement('div');
  sourceLabelDiv.className = 'source-label';
  renderSourceLabel(sourceLabelDiv, entity.sourceId);
  contentWrap.appendChild(sourceLabelDiv);
}

searchEl.addEventListener('input', function () {
  updateSearchClearBtnVisibility();
  renderList();
});

searchEl.addEventListener('keydown', function (ev) {
  if (ev.key !== 'Enter') return;
  ev.preventDefault();
  const gmView = isGmView();
  const filtered = state.allEntities
    .filter(matchesFilters)
    .filter(function (e) { return gmView || isEntityPlayerVisible(e.id); })
    .sort(function (a, b) { return (a.name || '').localeCompare(b.name || ''); });
  if (filtered.length > 0) {
    selectEntity(filtered[0].id, true);
  }
});

const searchClearBtn = document.getElementById('codex-search-clear-btn');
function updateSearchClearBtnVisibility() {
  if (!searchClearBtn) return;
  searchClearBtn.hidden = searchEl.value.length === 0;
}
updateSearchClearBtnVisibility();
if (searchClearBtn) {
  searchClearBtn.addEventListener('click', function () {
    clearCodexSearchInput();
    renderList();
    searchEl.focus();
  });
}

// Search tips popover: tap-toggle for touch, real-mouse-hover for
// desktop -- same pointerType-gated approach as map pin popups (see
// map.js bindPinPreviewPopup), since real touch taps never fire
// pointerenter/mouseover and CSS-only :hover doesn't work reliably on
// iPadOS trackpads either way.
const searchHelpBtn = document.getElementById('codex-search-help-btn');
const searchHelpPopup = document.getElementById('codex-search-help-popup');
const searchHelpWrap = document.getElementById('codex-search-help-wrap');
if (searchHelpBtn && searchHelpPopup && searchHelpWrap) {
  function openSearchHelp() {
    searchHelpPopup.hidden = false;
    searchHelpBtn.classList.add('active');
  }
  function closeSearchHelp() {
    searchHelpPopup.hidden = true;
    searchHelpBtn.classList.remove('active');
  }
  searchHelpBtn.addEventListener('click', function (e) {
    e.stopPropagation();
    if (searchHelpPopup.hidden) openSearchHelp(); else closeSearchHelp();
  });
  searchHelpWrap.addEventListener('pointerenter', function (e) {
    if (e.pointerType === 'mouse') openSearchHelp();
  });
  searchHelpWrap.addEventListener('pointerleave', function (e) {
    if (e.pointerType === 'mouse') closeSearchHelp();
  });
  document.addEventListener('click', function (e) {
    if (!searchHelpPopup.hidden && !searchHelpWrap.contains(e.target)) closeSearchHelp();
  });
}

export {
  attachCodexListeners, detachCodexListeners, renderList, renderDetailForSelected,
  isEntityPlayerVisible, registerVisibilityChangeHandler, registerMapNavigationHandler,
  clearCodexSearchInput, buildEntityPreviewCard, categoryGroupLabel, entityMatchesQuery,
  renderEntityViewCard, applyWikiLinks, enterEntityEditMode, appendDateSegments,
  fitCodexTabHeight, footerReserve
};
