import {
  getFirestore, collection, onSnapshot, doc, setDoc, addDoc, updateDoc, deleteDoc,
  query, where, writeBatch, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import { firebaseApp, CONFIG } from './firebase.js';
import { state } from './state.js';
import { attachListener, detachListener, safeSnapshotHandler } from './listeners.js';
import { renderMarkdownInto } from './markdown.js';
import { renderAdminRootEntitySelect, renderAdminPlayersList } from './admin.js';
import { parseDateSpec } from './dates.js';
import { buildSourceSelect, renderSourceLabel, registerSourcesChangeHandler, confirmRevealWithoutSource } from './sources.js';
import {
  uploadEntityMapImage, deleteEntityMapImage,
  uploadEntityGalleryImage, deleteEntityGalleryImage, setGalleryImageVisibility, setGalleryImageSource, setEntityPortrait
} from './images.js';

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

// slug: human-readable debugging/import aid, NOT the canonical key (auto
// doc ID is). Regenerated from name on every save; uniqueness is only
// softly enforced at import time. Kept in sync with import.js's copy.
function slugify(name) {
  return name.toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
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
function buildCardHero(entity, portrait) {
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
  cardHeroState = { imgEl: imgEl, hWrapEl: hWrap, vWrapEl: vWrap, containerEl: heroWrap, portrait: portrait };
  portraitObserveContainer(heroWrap);
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

// Exported for map.js: pins pointing at player-invisible entities are
// themselves hidden from players.
function isEntityPlayerVisible(entityId) {
  const entity = state.allEntities.find(function (e) { return e.id === entityId; });
  return !!entity && entity.visibility === 'all-players';
}

// --- List pane (Table of Contents) ---------------------------------------

function matchesFilters(entity) {
  const q = searchEl.value.trim().toLowerCase();
  if (!q) return true;
  const nameMatch = (entity.name || '').toLowerCase().indexOf(q) !== -1;
  const tagMatch = (entity.tags || []).some(function (t) {
    return t.toLowerCase().indexOf(q) !== -1;
  });
  const aliasMatch = (entity.aliases || []).some(function (a) {
    return a.toLowerCase().indexOf(q) !== -1;
  });
  return nameMatch || tagMatch || aliasMatch;
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
function clearCodexSearchInput() { searchEl.value = ''; }

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
      if (gmView && entity.visibility !== 'all-players') {
        const hiddenSpan = document.createElement('span');
        hiddenSpan.className = 'entity-hidden-badge';
        hiddenSpan.textContent = 'hidden';
        rightCol.appendChild(hiddenSpan);
      }
      if (entity.category === 'Location' && entity.hasMapImage) {
        const mapLink = document.createElement('button');
        mapLink.type = 'button';
        mapLink.className = 'entity-map-link';
        mapLink.title = 'Open map';
        mapLink.textContent = CONFIG.icons.map;
        mapLink.addEventListener('click', function (ev) {
          ev.stopPropagation();
          if (mapNavigationHandler) mapNavigationHandler(entity.id);
        });
        rightCol.appendChild(mapLink);
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
    parentId: entity.parentId || '',
    tags: (entity.tags || []).join(', '),
    relatedIds: (entity.relatedIds || []).slice(),
    ownerId: entity.ownerId || '',
    sourceId: entity.sourceId || null,
    meta: !!entity.meta
  };
}

function enterEntityEditMode(entity) {
  state.detailEditMode = true;
  state.detailEditDraft = buildEntityDraft(entity);
  renderDetailForSelected();
}

function cancelEntityEdit() {
  state.detailEditMode = false;
  state.detailEditDraft = null;
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
  }
  const entityData = {
    slug: slugify(name),
    name: name,
    category: cat,
    ancestry: (cat === 'Character' && draft.ancestry.trim()) ? draft.ancestry.trim() : null,
    subtype: ((CONFIG.subtypesByCategory[cat] || []).length && draft.subtype) ? draft.subtype : null,
    aliases: (cat === 'Character') ? aliases : [],
    date: dateStr || null,
    dateSort: dateSort,
    ownerId: (cat === 'Character' && draft.ownerId) ? draft.ownerId : null,
    parentId: draft.parentId || null,
    relatedIds: draft.relatedIds.slice(),
    tags: tags,
    sourceId: draft.sourceId || null,
    meta: !!draft.meta,
    updatedAt: serverTimestamp()
  };
  updateDoc(doc(db, 'entities', entity.id), entityData).then(function () {
    state.detailEditMode = false;
    state.detailEditDraft = null;
    renderDetailForSelected();
  }).catch(function (err) {
    window.alert('Save failed: ' + err.message);
  });
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

function buildMapImageEditSection(entity) {
  const wrap = document.createElement('div');
  wrap.className = 'entity-edit-field';
  const label = document.createElement('label');
  label.textContent = 'Map image';
  wrap.appendChild(label);
  const mapImg = state.currentEntityImages.find(function (img) {
    return img.ownerId === entity.id && img.role === 'map';
  });
  const statusEl = document.createElement('span');
  statusEl.className = 'image-edit-status';
  statusEl.textContent = mapImg
    ? 'Map image set (' + mapImg.width + 'x' + mapImg.height + ', ' + Math.round(mapImg.sizeBytes / 1024) + 'KB).'
    : 'No map image.';
  wrap.appendChild(statusEl);

  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/*';
  input.addEventListener('change', function () {
    const file = input.files[0];
    if (!file) return;
    if (mapImg) {
      const pinCount = state.allPins.filter(function (p) { return p.mapEntityId === entity.id; }).length;
      if (pinCount > 0 && !window.confirm(
        'This location already has a map image with ' + pinCount + ' pin' + (pinCount === 1 ? '' : 's') +
        ' on it. Replacing the image may leave existing pins misaligned, since pin positions are stored ' +
        'relative to the old image. Continue?'
      )) {
        input.value = '';
        return;
      }
    }
    input.disabled = true;
    uploadEntityMapImage(entity.id, file, {
      onStatus: function (text) { statusEl.textContent = text; }
    }).catch(function (err) {
      statusEl.textContent = err.message;
    }).finally(function () {
      input.disabled = false;
      input.value = '';
    });
  });
  wrap.appendChild(input);

  if (mapImg) {
    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.textContent = 'Delete map image';
    delBtn.addEventListener('click', function () {
      const pinCount = state.allPins.filter(function (p) { return p.mapEntityId === entity.id; }).length;
      const warning = pinCount > 0
        ? 'Delete this location\u2019s map image? It has ' + pinCount + ' pin' + (pinCount === 1 ? '' : 's') +
          ' on it, which will be unreachable until a new image is set.'
        : 'Delete this location\u2019s map image?';
      if (!window.confirm(warning)) return;
      deleteEntityMapImage(entity.id).catch(function (err) {
        window.alert('Delete failed: ' + err.message);
      });
    });
    wrap.appendChild(delBtn);
  }
  return wrap;
}

function renderEntityEditBlock(container, entity, draft) {
  container.appendChild(buildParentSelect(entity.id, draft.parentId, function (v) { draft.parentId = v; }));
  container.appendChild(makeEditField('Tags (comma-separated)', draft.tags, function (v) { draft.tags = v; }));

  const metaWrap = document.createElement('div');
  metaWrap.className = 'entity-edit-field entity-edit-meta-row';
  const metaSwitchLabel = document.createElement('label');
  metaSwitchLabel.className = 'toggle-switch';
  const metaSwitchInput = document.createElement('input');
  metaSwitchInput.type = 'checkbox';
  metaSwitchInput.checked = !!draft.meta;
  metaSwitchInput.addEventListener('change', function () { draft.meta = metaSwitchInput.checked; });
  const metaSwitchSlider = document.createElement('span');
  metaSwitchSlider.className = 'toggle-slider';
  metaSwitchLabel.appendChild(metaSwitchInput);
  metaSwitchLabel.appendChild(metaSwitchSlider);
  metaWrap.appendChild(metaSwitchLabel);
  const metaTextLabel = document.createElement('span');
  metaTextLabel.className = 'toggle-switch-label';
  metaTextLabel.textContent = 'Meta';
  metaWrap.appendChild(metaTextLabel);
  container.appendChild(metaWrap);

  container.appendChild(buildRelatedEditor(entity.id, draft));
  const sourceWrap = document.createElement('div');
  sourceWrap.className = 'entity-edit-field';
  const sourceLabel = document.createElement('label');
  sourceLabel.textContent = 'Source';
  sourceWrap.appendChild(sourceLabel);
  sourceWrap.appendChild(buildSourceSelect(draft.sourceId, function (v) { draft.sourceId = v; }));
  container.appendChild(sourceWrap);
  if (draft.category === 'Location') {
    container.appendChild(buildMapImageEditSection(entity));
  }

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
    sourceId: null,
    meta: false,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp()
  };
  setDoc(doc(db, 'entities', newId), entityData).then(function () {
    entityNewSaveBtn.disabled = false;
    closeNewEntityDialog();
    state.selectedId = newId;
    state.detailActiveTab = 'lore';
    state.loreEdit = null;
    state.detailEditMode = true;
    state.detailEditDraft = buildEntityDraft({ name: name, category: cat, ancestry: '', aliases: [], date: '', parentId: null, tags: [], relatedIds: [] });
    renderList();
    renderDetailForSelected();
  }).catch(function (err) {
    entityNewSaveBtn.disabled = false;
    showNewEntityError('Save failed: ' + err.message);
  });
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

  function done() {
    saveBtn.disabled = false;
    state.loreEdit = null;
    renderDetailForSelected();
  }
  function fail(err) {
    saveBtn.disabled = false;
    window.alert('Save failed: ' + err.message);
  }

  if (isNew) {
    const items = splitUnorderedListContent(content) || [content];
    const siblings = state.allLoreItems.filter(function (it) { return it.entityId === entity.id; });
    let maxOrder = siblings.reduce(function (acc, it) { return Math.max(acc, it.order || 0); }, 0);
    const writes = items.map(function (c) {
      maxOrder += 1;
      return addDoc(collection(db, 'loreItems'), {
        entityId: entity.id,
        kind: 'gm-note',
        authorId: null,
        authorType: 'gm',
        visibility: editState.visibility,
        content: c,
        meta: !!editState.meta,
        sourceId: editState.sourceId || null,
        order: maxOrder,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp()
      });
    });
    Promise.all(writes).then(done).catch(fail);
  } else {
    updateDoc(doc(db, 'loreItems', editState.id), {
      content: content,
      visibility: editState.visibility,
      meta: !!editState.meta,
      sourceId: editState.sourceId || null,
      updatedAt: serverTimestamp()
    }).then(done).catch(fail);
  }
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
  const metaSwitchLabel = document.createElement('label');
  metaSwitchLabel.className = 'toggle-switch';
  const metaSwitchInput = document.createElement('input');
  metaSwitchInput.type = 'checkbox';
  metaSwitchInput.checked = !!editState.meta;
  metaSwitchInput.addEventListener('change', function () {
    editState.meta = metaSwitchInput.checked;
  });
  const metaSwitchSlider = document.createElement('span');
  metaSwitchSlider.className = 'toggle-slider';
  metaSwitchLabel.appendChild(metaSwitchInput);
  metaSwitchLabel.appendChild(metaSwitchSlider);
  metaRow.appendChild(metaSwitchLabel);
  const metaLabel = document.createElement('span');
  metaLabel.className = 'toggle-switch-label';
  metaLabel.textContent = 'Meta';
  metaRow.appendChild(metaLabel);
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
function renderLoreTab(container, entity, gmView) {
  const items = loreItemsForEntity(entity.id, gmView);

  if (!gmView) {
    if (items.length === 0) {
      const emptyP = document.createElement('p');
      emptyP.className = 'lore-empty';
      emptyP.textContent = '(no lore for this view)';
      container.appendChild(emptyP);
      return;
    }
    const loreListDiv = document.createElement('div');
    loreListDiv.id = 'codex-lore-list';
    items.forEach(function (item) {
      const itemDiv = document.createElement('div');
      itemDiv.className = 'lore-item vis-visible';
      const bodyDiv = document.createElement('div');
      bodyDiv.className = 'lore-item-body';
      renderMarkdownInto(bodyDiv, item.content).then(function () {
        applyWikiLinks(bodyDiv, entity.id, gmView);
      });
      itemDiv.appendChild(bodyDiv);
      const sourceLabelDiv = document.createElement('div');
      sourceLabelDiv.className = 'source-label';
      renderSourceLabel(sourceLabelDiv, item.sourceId);
      itemDiv.appendChild(sourceLabelDiv);
      loreListDiv.appendChild(itemDiv);
    });
    container.appendChild(loreListDiv);
    return;
  }

  const activeEdit = state.loreEdit && state.loreEdit.entityId === entity.id ? state.loreEdit : null;

  const loreListDiv = document.createElement('div');
  loreListDiv.id = 'codex-lore-list';

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
    if (item.meta) {
      const metaTag = document.createElement('span');
      metaTag.className = 'meta-tag';
      metaTag.textContent = 'Meta';
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
    renderMarkdownInto(bodyDiv, item.content).then(function () {
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
        state.loreEdit = { entityId: entity.id, id: item.id, content: item.content, visibility: item.visibility, meta: !!item.meta, sourceId: item.sourceId || null };
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
    renderSourceLabel(sourceLabelDiv, item.sourceId);
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
      state.loreEdit = { entityId: entity.id, id: null, content: '', visibility: 'gm-only', meta: false, sourceId: null };
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

function renderGalleryTab(container, entity, gmView) {
  const galleryImages = galleryImagesFor(entity.id, gmView);
  const currentPortrait = portraitImageFor(entity, gmView);

  if (gmView && galleryImages.length) {
    const hintBox = document.createElement('div');
    hintBox.className = 'gallery-hint-box';
    const hint = document.createElement('p');
    hint.className = 'image-edit-status';
    hint.textContent = 'Drag images to reorder them. The portrait-marked image is used for the entry card\u2019s hero header.';
    hintBox.appendChild(hint);
    container.appendChild(hintBox);
  }

  if (galleryImages.length) {
    const galleryDiv = document.createElement('div');
    galleryDiv.id = 'codex-gallery';
    galleryImages.forEach(function (img) {
      const isCurrentPortrait = !!currentPortrait && img.id === currentPortrait.id;
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
      // thumbnail is currently the portrait. Don't extrapolate from this
      // to add icons elsewhere. Aligned to the image's own top-right
      // corner (imgWrap, not figDiv, so it isn't thrown off by figDiv's
      // padding).
      if (isCurrentPortrait) {
        const indicator = document.createElement('span');
        indicator.className = 'gallery-portrait-indicator';
        indicator.title = 'Current portrait';
        indicator.textContent = '\u2605';
        imgWrap.appendChild(indicator);
      }
      figDiv.appendChild(imgWrap);

      const sourceLabelDiv = document.createElement('div');
      sourceLabelDiv.className = 'source-label';
      renderSourceLabel(sourceLabelDiv, img.sourceId);
      figDiv.appendChild(sourceLabelDiv);

      if (gmView) {
        const barDiv = document.createElement('div');
        barDiv.className = 'gallery-item-bar';
        const visible = img.visibility === 'all-players';
        const toggleLabel = document.createElement('span');
        toggleLabel.className = 'toggle-switch-label ' + (visible ? 'state-visible' : 'state-hidden');
        toggleLabel.textContent = visible ? 'Visible to party' : 'Hidden from party';
        barDiv.appendChild(toggleLabel);
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
        barDiv.appendChild(switchLabel);

        const sourceSelect = buildSourceSelect(img.sourceId, function (newSourceId) {
          setGalleryImageSource(img.id, newSourceId)
            .catch(function (err) { window.alert('Source change failed: ' + err.message); });
        });
        barDiv.appendChild(sourceSelect);

        const delBtn = document.createElement('button');
        delBtn.type = 'button';
        delBtn.className = 'action-btn-compact';
        delBtn.textContent = 'Delete';
        delBtn.addEventListener('click', function () {
          if (!window.confirm('Delete this gallery image?')) return;
          deleteEntityGalleryImage(img.id).catch(function (err) { window.alert('Delete failed: ' + err.message); });
        });
        barDiv.appendChild(delBtn);
        figDiv.appendChild(barDiv);
      }
      galleryDiv.appendChild(figDiv);
    });
    container.appendChild(galleryDiv);

    if (gmView && galleryImages.length > 1) {
      loadSortable().then(function (Sortable) {
        // eslint-disable-next-line no-new
        new Sortable(galleryDiv, {
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

  if (gmView) {
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

  const metaBits = [];
  if (entity.aliases && entity.aliases.length) metaBits.push('Also known as: ' + entity.aliases.join(', '));
  if (entity.date) metaBits.push('Date: ' + entity.date);
  if (entity.ownerId && gmView) metaBits.push('Owned by: ' + entity.ownerId);
  if (metaBits.length) {
    const metaDiv = document.createElement('div');
    metaDiv.className = 'entity-meta-line';
    metaDiv.textContent = metaBits.join(' \u00b7 ');
    card.appendChild(metaDiv);
  }

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
    detailEl.innerHTML = '<p id="codex-empty">What would you like to read? Make a selection from your Table of Contents.</p>';
    return;
  }
  detailPaneEl.classList.remove('empty');

  detailEl.classList.remove('vis-hidden', 'vis-visible');
  detailEl.classList.add(entity.visibility === 'all-players' ? 'vis-visible' : 'vis-hidden');

  const editing = gmView && state.detailEditMode && state.detailEditDraft;
  const draft = editing ? state.detailEditDraft : null;

  detailEl.innerHTML = '';

  // Gallery hero — view mode only (skipped while editing, to avoid any
  // layering/interaction conflict with the edit fields). BACKGROUND
  // LAYER MODEL: the hero is an absolutely-positioned layer behind the
  // card content (z-index 0 vs content's 1), taking NO layout space —
  // UI element placement is identical with or without a portrait, at
  // any portrait size. Its height is set by portraitRenderInto to the
  // image's visible extent; the heading and everything else stay in the
  // normal content flow, rendered over the image.
  const portrait = !editing ? portraitImageFor(entity, gmView) : null;
  detailEl.classList.toggle('has-hero', !!portrait);
  if (portrait) {
    const band = document.createElement('div');
    band.className = 'codex-card-hero-band';
    band.appendChild(buildCardHero(entity, portrait));
    detailEl.appendChild(band);
  } else {
    cardHeroState = null;
  }
  const contentWrap = document.createElement('div');
  contentWrap.className = 'codex-card-content';
  detailEl.appendChild(contentWrap);
  const headingTarget = contentWrap;

  // --- Heading: name + entry type + category-specific fields (left);
  // GM/Player badge, visibility toggle, map link (upper-right stack) ---
  const headingRow = document.createElement('div');
  headingRow.id = 'codex-card-heading';

  const leftCol = document.createElement('div');
  leftCol.id = 'codex-card-heading-left';

  if (editing) {
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
      leftCol.appendChild(makeEditField('Ancestry', draft.ancestry, function (v) { draft.ancestry = v; }));
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
    }
  } else {
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

    const metaBits = [];
    if (entity.aliases && entity.aliases.length) metaBits.push('Also known as: ' + entity.aliases.join(', '));
    if (entity.date) metaBits.push('Date: ' + entity.date);
    if (entity.ownerId && gmView) metaBits.push('Owned by: ' + entity.ownerId);
    if (metaBits.length) {
      const metaDiv = document.createElement('div');
      metaDiv.className = 'entity-meta-line';
      metaDiv.textContent = metaBits.join(' \u00b7 ');
      leftCol.appendChild(metaDiv);
    }

    if (entity.tags && entity.tags.length || entity.meta) {
      const tagsDiv = document.createElement('div');
      tagsDiv.id = 'codex-tags';
      if (entity.meta) {
        const metaTag = document.createElement('span');
        metaTag.className = 'meta-tag';
        metaTag.textContent = 'Meta';
        tagsDiv.appendChild(metaTag);
      }
      (entity.tags || []).forEach(function (t) {
        const span = document.createElement('span');
        span.textContent = t;
        tagsDiv.appendChild(span);
      });
      leftCol.appendChild(tagsDiv);
    }
  }
  headingRow.appendChild(leftCol);

  const rightCol = document.createElement('div');
  rightCol.id = 'codex-card-heading-right';
  if (gmView) {
    rightCol.appendChild(buildEntityVisibilityToggle(entity));
  }
  if (entity.category === 'Location' && entity.hasMapImage) {
    const mapLink = document.createElement('button');
    mapLink.type = 'button';
    mapLink.className = 'entity-map-link';
    mapLink.title = 'Open map';
    mapLink.textContent = CONFIG.icons.map;
    mapLink.addEventListener('click', function () {
      if (mapNavigationHandler) mapNavigationHandler(entity.id);
    });
    rightCol.appendChild(mapLink);
  }
  headingRow.appendChild(rightCol);
  headingTarget.appendChild(headingRow);

  if (editing) {
    const editBlock = document.createElement('div');
    editBlock.className = 'entity-edit-block';
    renderEntityEditBlock(editBlock, entity, draft);
    contentWrap.appendChild(editBlock);
  }

  // --- Lore / Gallery / Notes tab box (view mode only — hidden while
  // editing; tags/related/delete are edited inline above instead) ---
  if (!editing) {
    const tabsRow = document.createElement('div');
    tabsRow.id = 'codex-detail-tabs';
    [['lore', 'Lore'], ['gallery', 'Gallery'], ['notes', 'Notes']].forEach(function (pair) {
      const tabKey = pair[0];
      const tabBtn = document.createElement('button');
      tabBtn.type = 'button';
      tabBtn.textContent = pair[1];
      if (state.detailActiveTab === tabKey) tabBtn.classList.add('active');
      tabBtn.addEventListener('click', function () {
        state.detailActiveTab = tabKey;
        renderDetailForSelected();
      });
      tabsRow.appendChild(tabBtn);
    });
    contentWrap.appendChild(tabsRow);

    const tabPanel = document.createElement('div');
    tabPanel.id = 'codex-detail-tab-panel';
    contentWrap.appendChild(tabPanel);

    if (state.detailActiveTab === 'notes') {
      const notesEmptyP = document.createElement('p');
      notesEmptyP.className = 'lore-empty';
      notesEmptyP.textContent = 'Notes are coming in a future update.';
      tabPanel.appendChild(notesEmptyP);
    } else if (state.detailActiveTab === 'gallery') {
      renderGalleryTab(tabPanel, entity, gmView);
    } else {
      renderLoreTab(tabPanel, entity, gmView);
    }
  }

  if (editing) return; // tags/gallery/related/delete are edited inline above; card ends here

  // --- Related entities ---
  // Relatedness is enforced symmetric at display time: A -> B always
  // implies B -> A, even if only one side's relatedIds array actually
  // stores the link (e.g. a link added before this rule existed, or an
  // edit that only touched one side). We don't rewrite the other side's
  // document — just union it in here — so this stays correct regardless
  // of which entity's data is stale.
  // Player view only links to targets that are themselves player-visible;
  // dangling IDs (deleted target) silently skipped.
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
      relatedDiv.id = 'codex-related';
      const chipsDiv = document.createElement('div');
      chipsDiv.id = 'codex-related-chips';
      visibleRelated.forEach(function (target) {
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.className = 'related-chip';
        chip.textContent = target.name;
        chip.addEventListener('click', function () { selectEntity(target.id, true); });
        chipsDiv.appendChild(chip);
      });
      relatedDiv.appendChild(chipsDiv);
      contentWrap.appendChild(relatedDiv);
    }
  }

  // --- GM Edit/Delete actions (lower-right), then source attribution
  // (lower-left) on its own row below them, for GM view. Players never
  // see the actions row, so the source label just ends up at the
  // bottom either way. ---
  if (gmView) {
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

searchEl.addEventListener('input', renderList);

export {
  attachCodexListeners, detachCodexListeners, renderList, renderDetailForSelected,
  isEntityPlayerVisible, registerVisibilityChangeHandler, registerMapNavigationHandler,
  clearCodexSearchInput, buildEntityPreviewCard, categoryGroupLabel
};
