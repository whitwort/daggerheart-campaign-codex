import {
  getFirestore, collection, onSnapshot, doc, setDoc, updateDoc, deleteDoc, addDoc,
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
  uploadEntityGalleryImage, deleteEntityGalleryImage, setGalleryImageSource,
  setEntityPortrait, setEntityMap, clearEntityMap, migrateLegacyMapImageIfNeeded
} from './images.js';
import { getTemplateSchema, normalizeSearchTerm, computeSearchIndex } from './templates.js';
import {
  canSee, viewerContext, visibilityBadge, isShareableToWholeParty, visibilityStateClass,
  hasFullAuthority, isSharedWithActiveCharacter, isNoteAuthor, belongsOnLoreSurface,
  entityHasSecretsFor, resolveDropOverlay
} from './visibility.js';
import { shareEntityVisibility, shareLoreItemVisibility, shareImageVisibility, createLoreItemShared } from './sharing.js';
import { buildVisibilityControl, buildSharedToggle, buildNoteToggle, buildCharacterBadge } from './visibility-ui.js';
import { buildCharacterCardEditor, characterAncestryDisplayName, DEFAULT_CARDS } from './character-cards.js';

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

// Lore item 'meta' field: enum ('', 'meta', 'meta-details', 'meta-features',
// 'meta-narrative-backstory' [Phase 14 S7, §11.5 -- plain badge, no
// auto-synthesis behavior, unlike meta-details/meta-features]), null/
// absent on the doc means none. Legacy docs from before this enum
// (boolean true) still normalize to 'meta' for editing/badge purposes.
function normalizeMetaForEdit(v) {
  if (v === 'meta-details' || v === 'meta-features' || v === 'meta-narrative-backstory' || v === 'meta') return v;
  return v ? 'meta' : '';
}
function metaBadgeLabel(v) {
  if (v === 'meta-details') return 'Meta \u00b7 Details';
  if (v === 'meta-features') return 'Meta \u00b7 Features';
  if (v === 'meta-narrative-backstory') return 'Meta \u00b7 Narrative Backstory';
  if (v) return 'Meta';
  return null;
}

// Enters inline edit mode for a lore item -- factored out of the
// per-item Edit button (Phase 14 S7, §11.4) so the lore-item pop-out
// panel's own Edit shortcut can trigger the exact same flow instead of
// duplicating the edit-box machinery inside the panel.
function openLoreItemEdit(entity, item, isNote, entityAuthority) {
  if (isNote) {
    state.noteEdit = { entityId: entity.id, id: item.id, content: item.content, visibility: item.visibility, authorType: item.authorType, authorId: item.authorId || null, baseUpdatedAtMs: updatedAtMs(item), conflictDismissedAtMs: null };
  } else {
    state.loreEdit = entityAuthority
      ? { entityId: entity.id, id: item.id, content: item.content, visibility: item.visibility, characterId: item.characterId || null, characterShared: !!item.characterShared, meta: normalizeMetaForEdit(item.meta), sourceId: item.sourceId || null, baseUpdatedAtMs: updatedAtMs(item), conflictDismissedAtMs: null }
      : { entityId: entity.id, id: item.id, content: item.content, sourceId: item.sourceId || null, limited: true };
  }
  renderDetailForSelected();
}

// Phase 14 S17: long lore items get an internal v-scroll instead of the
// earlier S7/S8 collapse+fade+"Show..."+pop-out-window chrome (Gregg's
// call -- simpler UX, no extra click/window management). "Long" is
// measured post-render against actual pixel height, not markdown source
// length -- a short paragraph with a big embedded image can be "long"
// on screen even though a long line of prose might not be.
// max-height is set live against #codex-detail-pane's own bounded
// clientHeight rather than a CSS vh unit -- same reasoning as
// fitCodexTabHeight above: vh is unreliable on iOS Safari (the
// collapsing toolbar changes the effective viewport), and a cap that
// exceeds the pane's actual visible height caused the outer page to
// scroll too, not just the item.
const LORE_ITEM_SCROLL_PX = 640;
function attachLoreItemExpand(bodyDiv) {
  if (bodyDiv.scrollHeight <= LORE_ITEM_SCROLL_PX) return;
  const pane = document.getElementById('codex-detail-pane');
  const paneH = pane ? pane.clientHeight : 0;
  const cap = paneH > 0 ? Math.max(200, Math.floor(paneH * 0.6)) : LORE_ITEM_SCROLL_PX;
  bodyDiv.style.maxHeight = cap + 'px';
  bodyDiv.classList.add('lore-item-body-scrollable');
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

  // Phase 17 A1: the one deliberate exception to the "no global images
  // listener" rule — filtered to visibility=='character' (secret/green-
  // state docs only, a handful at any time) so the secret-children badge
  // and Show secrets mode can answer "does this entity have secret image
  // children" without loading every entity's gallery. The base64 `data`
  // field is STRIPPED before storing — only metadata reaches state.
  attachListener('characterImagesUnsub', function () {
    return onSnapshot(
      query(collection(db, 'images'), where('visibility', '==', 'character')),
      safeSnapshotHandler('characterImages', function (snapshot) {
        state.allCharacterImages = [];
        snapshot.forEach(function (docSnap) {
          const d = docSnap.data();
          delete d.data;
          state.allCharacterImages.push(Object.assign({ id: docSnap.id }, d));
        });
        renderList();
      }), function (err) {
        console.error('character images listener error:', err.message);
      });
  });
}

function detachCodexListeners() {
  detachListener('entitiesUnsub');
  detachListener('loreItemsUnsub');
  detachListener('characterImagesUnsub');
  state.allCharacterImages = [];
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

function galleryImagesFor(entityId, ctx, imagesOverride) {
  return (imagesOverride || state.currentEntityImages)
    .filter(function (img) {
      return img.ownerId === entityId && img.role === 'gallery' && canSee(img, ctx);
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
// null if none is explicitly set. No implicit fallback to the first
// gallery image -- portrait is deliberately explicit (Set portrait)
// only, per Gregg's call; an entity with images but no chosen portrait
// simply has no hero image, same as an entity with no images at all.
// Respects ctx (canSee) the same way galleryImagesFor does, so a gm-only
// portrait never shows to players. imagesOverride (Phase 14 S8 bugfix):
// when given, read from THIS instead of the Codex tab's own global
// state.currentEntityImages cache -- that cache is scoped to whichever
// entity is currently selected on the CODEX tab specifically
// (setEntityImagesTarget, called from renderDetailForSelected only), so
// a Map/Timeline tab card for an entity never yet opened on the Codex
// tab this session found an empty cache and silently showed no
// portrait. Callers with their own independent image source (see
// entity-images-cache.js) pass it here instead of relying on that
// single shared, Codex-tab-owned cache.
function portraitImageFor(entity, ctx, imagesOverride) {
  if (portraitPreviewOverride && portraitPreviewOverride.entityId === entity.id) {
    return portraitPreviewOverride.img;
  }
  const images = galleryImagesFor(entity.id, ctx, imagesOverride);
  if (!images.length) return null;
  return images.find(function (img) { return img.isPortrait; }) || null;
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
// Effective visibility for any lore element (entities, loreItems, images)
// is resolved by visibility.js's canSee(element, ctx) -- see that module
// for the full truth table (phase-14-design.md §4). This file just
// threads `ctx` (from viewerContext()) through its render functions the
// same way it used to thread a bare `gmView` boolean.

// --- Nav-strip role switcher (global, not per-card) -----------------------
// GM: "View" dropdown (GM/Party) drives state.gmPreview (Phase 14 S3 --
// see phase-14-design.md §5.3; was a bare bool, now null |
// {playerEmail, activeCharacterId} so S5's Characters-tab flipper can
// preview a SPECIFIC player/character later without a further state
// shape change. This toggle itself only ever sets the generic
// {playerEmail:null, activeCharacterId:null} shape -- no picker UI yet.
// True player: "Character" dropdown (nav-character-switcher, Phase 14 S3)
// lists the player's own owned Characters and writes
// players/{email}.activeCharacterId -- the live playerDocUnsub listener
// in auth.js delivers the change straight back into state.activeCharacterId
// and re-renders everywhere via notifyVisibilityChange (D2).
const navViewSwitcherEl = document.getElementById('nav-view-switcher');
const navCharacterSwitcherEl = document.getElementById('nav-character-switcher');
const gmViewSelect = document.getElementById('gm-view-select');
const playerCharacterSelectEl = document.getElementById('player-character-select');

// Populates the player's own "Character" nav dropdown from their owned
// Character entities (state.allEntities, category=='Character' &&
// ownerId==their email) -- called from updateGmToolbar() so it stays in
// sync with every entities-change/role-change re-render, same cadence as
// the GM toolbar itself. No-op (and hidden, via updateGmToolbar's own
// display toggle) for GM/viewer.
function renderPlayerCharacterSwitcher() {
  if (state.currentRole !== 'player' || !playerCharacterSelectEl) return;
  const email = (state.currentUser && state.currentUser.email) || null;
  const owned = state.allEntities
    .filter(function (e) { return e.category === 'Character' && e.ownerId === email; })
    .sort(function (a, b) { return (a.name || '').localeCompare(b.name || ''); });
  const prevValue = playerCharacterSelectEl.value;
  playerCharacterSelectEl.innerHTML = '';
  const noneOpt = document.createElement('option');
  noneOpt.value = '';
  noneOpt.textContent = '\u2014';
  playerCharacterSelectEl.appendChild(noneOpt);
  owned.forEach(function (c) {
    const opt = document.createElement('option');
    opt.value = c.id;
    opt.textContent = c.name;
    playerCharacterSelectEl.appendChild(opt);
  });
  // Prefer the live server value (state.activeCharacterId, delivered via
  // auth.js's playerDocUnsub) over whatever the select last showed --
  // this is a re-render, not user input in progress, so the live value
  // always wins; falls back to the just-rebuilt select's previous value
  // only if the live value hasn't arrived yet (e.g. immediately after
  // sign-in, one tick before the first players/{email} snapshot).
  playerCharacterSelectEl.value = state.activeCharacterId || prevValue || '';
}

playerCharacterSelectEl.addEventListener('change', function () {
  const email = (state.currentUser && state.currentUser.email) || null;
  if (!email) return;
  updateDoc(doc(db, 'players', email), { activeCharacterId: playerCharacterSelectEl.value || null })
    .catch(function (err) { window.alert('Switch character failed: ' + err.message); });
  // No optimistic local state.activeCharacterId set here -- the live
  // playerDocUnsub listener in auth.js is the single source of truth and
  // fires within one round-trip; setting it here too would just be a
  // second write to the same value once the snapshot lands.
});

function updateGmToolbar() {
  navViewSwitcherEl.style.display = (state.currentRole === 'gm') ? '' : 'none';
  navCharacterSwitcherEl.style.display = (state.currentRole === 'player') ? '' : 'none';
  if (state.currentRole === 'gm') {
    gmViewSelect.value = state.gmPreview ? 'player' : 'gm';
  }
  renderPlayerCharacterSwitcher();
}
gmViewSelect.addEventListener('change', function () {
  state.gmPreview = (gmViewSelect.value === 'player') ? { playerEmail: null, activeCharacterId: null } : null;
  updateGmToolbar();
  renderList();
  renderDetailForSelected();
  notifyVisibilityChange();
});

// --- Entry Browser footer buttons (Phase 17) -------------------------------
// Dynamic (per-render) gating, unlike #codex-new-btn's static role gating
// in auth.js, because both depend on live state: "Show secrets" exists
// only for a player-view ctx that actually HAS secrets; "+ New drop" is
// gmView-only (hidden while previewing as player — recording is a GM
// act) and locks while a recording is already open.
const secretsBtn = document.getElementById('codex-secrets-btn');
const newDropBtn = document.getElementById('codex-new-drop-btn');

function updateListActionButtons(ctx, anySecrets, secretsActive) {
  secretsBtn.style.display = (!ctx.gmView && anySecrets) ? 'inline-block' : 'none';
  secretsBtn.textContent = secretsActive ? 'Show all' : 'Show secrets';
  secretsBtn.classList.toggle('secrets-mode-active', secretsActive);
  newDropBtn.style.display = ctx.gmView ? 'inline-block' : 'none';
  newDropBtn.disabled = !!state.dropRecording;
}

secretsBtn.addEventListener('click', function () {
  state.secretsFilterActive = !state.secretsFilterActive;
  if (state.secretsFilterActive) clearCodexSearchInput();
  renderList();
});

newDropBtn.addEventListener('click', function () { openDropRecorder(); });

// --- Lore Drop recorder (Phase 17 B1) --------------------------------------

// Visibility-state chip for a recorded from/to state, reusing the Entry
// Browser badge language: gm-only = "hidden" (hope), all-players OR
// character+shared = "visible" (fear), character-unshared = the target
// character's own badge. Exported for stables.js's drop summaries (same
// visual language in the Stables detail pane).
function buildDropStateBadge(vs) {
  if (vs.visibility === 'character' && !vs.characterShared && vs.characterId) {
    const b = buildCharacterBadge(vs.characterId);
    b.title = ''; // buildCharacterBadge's share-consent tooltip doesn't apply here
    return b;
  }
  const span = document.createElement('span');
  if (vs.visibility === 'gm-only') {
    span.className = 'entity-hidden-badge';
    span.textContent = 'hidden';
  } else {
    span.className = 'entity-visible-badge';
    span.textContent = 'visible';
  }
  return span;
}

// One log/summary line per recorded change: label, from-chip, →, to-chip.
// Shared by the recorder popup and the Stables detail pane.
function buildDropChangeLine(change) {
  const line = document.createElement('div');
  line.className = 'drop-change-line';
  const label = document.createElement('span');
  label.className = 'drop-change-label';
  label.textContent = change.label;
  line.appendChild(label);
  line.appendChild(buildDropStateBadge(change.from));
  const arrow = document.createElement('span');
  arrow.className = 'drop-change-arrow';
  arrow.textContent = '\u2192';
  line.appendChild(arrow);
  line.appendChild(buildDropStateBadge(change.to));
  return line;
}

// Drop type vocabulary (Phase 17 follow-up): purely organizational for
// now — no semantic meaning; Stables groups its browser by these. Enum
// keys stored in the doc; labels rendered from this map. Missing/legacy
// docs (pre-field) read as 'lore'.
const DROP_TYPES = [
  { key: 'lore', label: 'Lore drop' },
  { key: 'scene', label: 'Scene drop' },
  { key: 'loot', label: 'Loot drop' }
];
function dropTypeLabel(key) {
  const t = DROP_TYPES.find(function (d) { return d.key === key; });
  return (t || DROP_TYPES[0]).label;
}

function openDropRecorder() {
  if (state.dropRecording) return;
  if (document.querySelector('.drop-recorder-panel')) return;
  state.dropRecording = { changes: [], overlay: {} };

  const built = buildGalleryPickerPanel();
  built.panel.classList.add('drop-recorder-panel');
  const h3 = document.createElement('h3');
  h3.textContent = 'New Lore Drop';
  built.header.appendChild(h3);

  const hint = document.createElement('p');
  hint.className = 'drop-recorder-hint';
  hint.textContent = 'Recording any visibility changes made in the Codex:';
  built.body.appendChild(hint);

  const log = document.createElement('div');
  log.className = 'drop-recorder-log';
  built.body.appendChild(log);

  const typeLabel = document.createElement('label');
  typeLabel.textContent = 'Drop type';
  built.body.appendChild(typeLabel);
  const typeSelect = document.createElement('select');
  typeSelect.className = 'drop-recorder-type';
  DROP_TYPES.forEach(function (t) {
    const opt = document.createElement('option');
    opt.value = t.key;
    opt.textContent = t.label;
    typeSelect.appendChild(opt);
  });
  built.body.appendChild(typeSelect);

  const nameLabel = document.createElement('label');
  nameLabel.textContent = 'Batch name';
  built.body.appendChild(nameLabel);
  const nameInput = document.createElement('input');
  nameInput.type = 'text';
  nameInput.className = 'drop-recorder-name';
  nameInput.placeholder = 'e.g. The Sunken Vault';
  built.body.appendChild(nameInput);

  const errorP = document.createElement('p');
  errorP.className = 'drop-recorder-error';
  errorP.style.display = 'none';
  built.body.appendChild(errorP);

  const actions = document.createElement('div');
  actions.className = 'drop-recorder-actions';
  const saveBtn = document.createElement('button');
  saveBtn.textContent = 'Save';
  const cancelBtn = document.createElement('button');
  cancelBtn.textContent = 'Cancel';
  actions.appendChild(saveBtn);
  actions.appendChild(cancelBtn);
  built.body.appendChild(actions);

  // Corner drag-to-resize (Phase 17 follow-up). Pointer-events, not CSS
  // resize, so it works on iPad (Safari has no CSS resize handle) —
  // same setPointerCapture pattern as the panel-move drag and the
  // Messages panel edge handles. Explicit width/height once dragged;
  // the log is the flex-grow region (CSS), so resizing the panel grows
  // the change log first.
  const resizeHandle = document.createElement('div');
  resizeHandle.className = 'drop-recorder-resize-handle';
  resizeHandle.title = 'Drag to resize';
  built.panel.appendChild(resizeHandle);
  let resizeDrag = null;
  resizeHandle.addEventListener('pointerdown', function (ev) {
    ev.preventDefault();
    const rect = built.panel.getBoundingClientRect();
    // Pin left/top so growing width/height extends right/down from the
    // panel's current position regardless of its original right-anchor.
    built.panel.style.left = rect.left + 'px';
    built.panel.style.top = rect.top + 'px';
    built.panel.style.right = 'auto';
    resizeHandle.setPointerCapture(ev.pointerId);
    resizeDrag = { startX: ev.clientX, startY: ev.clientY, origW: rect.width, origH: rect.height };
  });
  resizeHandle.addEventListener('pointermove', function (ev) {
    if (!resizeDrag) return;
    const w = Math.max(288, resizeDrag.origW + (ev.clientX - resizeDrag.startX));
    const h = Math.max(320, resizeDrag.origH + (ev.clientY - resizeDrag.startY));
    built.panel.style.width = w + 'px';
    built.panel.style.height = h + 'px';
  });
  function endResizeDrag() { resizeDrag = null; }
  resizeHandle.addEventListener('pointerup', endResizeDrag);
  resizeHandle.addEventListener('pointercancel', endResizeDrag);

  function renderLog() {
    log.innerHTML = '';
    if (!state.dropRecording.changes.length) {
      const empty = document.createElement('p');
      empty.className = 'drop-recorder-empty';
      empty.textContent = 'No changes recorded yet \u2014 flip visibility toggles as usual; nothing is written until the drop runs.';
      log.appendChild(empty);
      return;
    }
    state.dropRecording.changes.forEach(function (c) { log.appendChild(buildDropChangeLine(c)); });
  }
  renderLog();

  function onRecordingChange() {
    renderLog();
    // The overlay just changed what every surface should show.
    renderList();
    renderDetailForSelected();
    notifyVisibilityChange();
  }
  document.addEventListener('droprecording:change', onRecordingChange);

  function showError(msg) {
    errorP.textContent = msg;
    errorP.style.display = '';
  }

  // Save/Cancel both end recording; clearing state.dropRecording drops
  // the overlay, so the follow-up re-render visually reverts everything.
  function close() {
    document.removeEventListener('droprecording:change', onRecordingChange);
    state.dropRecording = null;
    built.panel.remove();
    renderList();
    renderDetailForSelected();
    notifyVisibilityChange();
  }

  saveBtn.addEventListener('click', function () {
    const name = nameInput.value.trim();
    const changes = state.dropRecording.changes.filter(function (c) {
      // A toggled-and-back element is a no-op — don't persist it.
      return JSON.stringify(c.from) !== JSON.stringify(c.to);
    });
    if (!name) { showError('Give the drop a name.'); return; }
    if (!changes.length) { showError('No visibility changes recorded.'); return; }
    if (changes.length > 400) { showError('Too many changes for one drop (max 400).'); return; }
    saveBtn.disabled = true;
    addDoc(collection(db, 'loreDrops'), {
      name: name,
      type: typeSelect.value,
      status: 'current',
      changes: changes,
      createdAt: serverTimestamp(),
      ranAt: null
    }).then(close).catch(function (err) {
      saveBtn.disabled = false;
      showError('Save failed: ' + err.message);
    });
  });

  cancelBtn.addEventListener('click', close);

  nameInput.focus();
}

// Authorship model: authorType is 'gm' (authorId null) or 'character'
// (authorId = the authoring Player Character's entities/ doc id — never a
// player's uid/email). "Written by" tracks in-fiction knowledge, not who's
// at the table: a player owns one or more PCs (admin.js players/ +
// entities.ownerId=email), and a PC's authorship survives the PC's death.
// So "can this player see an author-only item" resolves through the
// authoring character's owner, not the item itself. (This resolution now
// lives in visibility.js's canSee() -- see its author-only case.)
function loreItemsForEntity(entityId, ctx) {
  // Phase 14 S4: notes (kind:'note') only join Lore-tab-style surfaces
  // (this function's callers: renderLoreTab, buildEntityPreviewCard) once
  // canonized (visibility:'all-players'). A still-private note passes
  // canSee for its own author (that's the whole point of author-only),
  // but that's an access decision, not a tab-placement one -- without
  // this extra filter, an author's own unpublished note would leak into
  // these general-lore surfaces too, duplicating its correct home on the
  // Notes tab (renderNotesTab queries state.allLoreItems directly, not
  // through this function, precisely so it isn't affected by this rule).
  return state.allLoreItems
    .filter(function (item) { return item.entityId === entityId; })
    .filter(belongsOnLoreSurface)
    .filter(function (item) { return canSee(item, ctx); })
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
function buildFeaturesMarkdown(entity, tierFilter) {
  const feats = entity.features || [];
  if (!feats.length) return '';
  const schema = getTemplateSchema(entity.category, entity.subtype);
  if (schema && schema.featureGroups) {
    const groups = tierFilter
      ? schema.featureGroups.filter(function (g) {
          return Array.isArray(tierFilter) ? tierFilter.indexOf(g.key) !== -1 : g.key === tierFilter;
        })
      : schema.featureGroups;
    const lines = [];
    groups.forEach(function (g) {
      const groupFeats = feats.filter(function (f) { return f.group === g.key; });
      if (!groupFeats.length) return;
      lines.push('### ' + g.label);
      groupFeats.forEach(function (f) { lines.push('**' + f.name + '.** ' + f.text, ''); });
    });
    return lines.join('\n').trim();
  }
  const lines = ['### Features'];
  // Phase 15 (D5): hasFeatureType schemas render the type inline after
  // the name, matching the SRD statblock's own "Name - Type" format.
  // Gated on truthy f.type (not the schema flag) so hand-added features
  // without a type render exactly as before.
  feats.forEach(function (f) {
    const typeSuffix = f.type ? ' - ' + f.type : '';
    lines.push('**' + f.name + typeSuffix + '.** ' + f.text, '');
  });
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

// Character deck viewer (Phase 14 S15): full "stat block" markdown for
// an entity -- structured Details + tier-filtered Features (same
// synthesis buildDetailsMarkdown/buildFeaturesMarkdown already do for
// the Lore tab) PLUS any hand-authored leftover prose from the
// entity's own meta-details/meta-features lore items (e.g. a weapon's
// Damage bullet before that became a structured field, or GM-added
// prose beyond the structured Features -- the "additional text below
// Features in the parse" Gregg asked deck cards to include). This is
// what character-cards.js's own slotStatMarkdown does NOT do -- that
// one only reads entity.details/entity.features directly, skipping
// lore items entirely, which was fine for the build-time editor's
// verification-only card slots but not for the deck viewer's actual
// reference cards. A lore item's raw .content IS its leftover already
// (resolveLoreItemMarkdown only PREPENDS synthesis on top when
// rendering the Lore tab) -- so this reads content directly rather
// than resolving through that function, no synthesis duplication.
function resolveEntityStatBlockMarkdown(entity, ctx, tierFilter) {
  if (!entity) return '';
  const schema = getTemplateSchema(entity.category, entity.subtype);
  const items = loreItemsForEntity(entity.id, ctx);
  // No structured schema (Conditions, Items, Consumables, or any
  // entity that hasn't opted into useTemplate): there's no Details/
  // Features to synthesize, so just show the entity's own visible
  // lore content directly -- this was the actual bug behind Condition
  // cards showing no text at all (their lore items carry no
  // meta-details/meta-features tag, so the templated branch below
  // found nothing to show).
  if (!schema || !entity.useTemplate) {
    return items.map(function (it) { return it.content; }).filter(Boolean).join('\n\n');
  }
  const detailsMd = buildDetailsMarkdown(entity);
  const featsMd = buildFeaturesMarkdown(entity, tierFilter);
  const leftoverParts = [];
  const seen = {};
  items.forEach(function (it) {
    if ((it.meta === 'meta-details' || it.meta === 'meta-features') && !seen[it.meta]) {
      seen[it.meta] = true;
      if (it.content) leftoverParts.push(it.content);
    }
  });
  return [detailsMd, featsMd].concat(leftoverParts).filter(Boolean).join('\n\n');
}

// Exported shim for map.js/timeline.js: pins pointing at player-invisible
// entities are themselves hidden from players. Builds its own ctx via
// viewerContext() so external callers don't need to -- codex.js's OWN
// internal call sites call canSee(entity, ctx) directly instead, since
// they already have ctx in scope (see phase-14-design.md §5.1).
function isEntityPlayerVisible(entityId) {
  const entity = state.allEntities.find(function (e) { return e.id === entityId; });
  return !!entity && canSee(entity, viewerContext());
}

// hasMapImage alone only says "this Location has SOME map image" -- it
// says nothing about whether that specific image is gm-only or
// all-players. A player must never see a map icon/route into a map
// whose image they can't actually see (they'd land on it via
// mapNavigationHandler and hit map.js's own visibility-filtered "no
// image" placeholder, but the icon itself already implies access that
// doesn't exist). GM always sees the icon when hasMapImage is true,
// regardless of the image's own visibility. Stays on the cheap
// party-wide denormalized flag (not a full canSee) -- a per-character-
// shared map image doesn't set this flag (see §3.1); that finer-grained
// case is handled where the actual image doc is loaded (map.js's pixel-
// level gate), not in this cheap per-row list icon.
function entityMapIconVisible(entity, ctx) {
  return entity.category === 'Location' && !!entity.hasMapImage && (ctx.gmView || !!entity.mapImageVisibleToPlayers);
}

// Ancestor-chain depth (number of parentId hops to the root) -- used
// only to pick the "highest level" map when an entity has pins on more
// than one map (see resolveMapIconTarget below). Smaller depth = closer
// to the root of the Location tree = higher level (e.g. a world map
// beats a room-level local map). Lightweight local walk, same
// parentId-chain idea as map.js's buildBreadcrumbChain, duplicated
// rather than shared since that function lives in map.js (which
// imports FROM codex.js, not the other way around) and returns the
// full chain array where only its length is needed here.
function mapEntityAncestorDepth(entity) {
  let depth = 0;
  let cur = entity;
  const seen = {};
  while (cur && cur.parentId && !seen[cur.id]) {
    seen[cur.id] = true;
    cur = state.allEntities.find(function (e) { return e.id === cur.parentId; });
    depth++;
  }
  return depth;
}

// Standardized entry-card map-icon target (S14): wherever an entry
// card is shown (Codex, Map, Timeline), the map icon now covers three
// cases rather than only the first:
//  (a) the entity itself is a Location with a (player-visible unless
//      GM) map image -- link to its own map, same as before.
//  (b) the entity isn't a map itself, but is linked to a pin on
//      someone else's map -- link to that pin's map instead.
//  (c) the entity has pins on more than one map -- pick the pin whose
//      map sits highest in the Location parentId tree (smallest
//      ancestor depth), not just whichever pin was created first.
// Returns the entity id to pass to mapNavigationHandler, or null if no
// map icon should show at all (neither case applies, or the only
// candidate map(s) aren't player-visible to this viewer).
function resolveMapIconTarget(entity, ctx) {
  if (entityMapIconVisible(entity, ctx)) return entity.id;
  const pins = state.allPins.filter(function (p) { return p.entityId === entity.id; });
  if (!pins.length) return null;
  let best = null, bestDepth = Infinity;
  pins.forEach(function (pin) {
    const mapEntity = state.allEntities.find(function (e) { return e.id === pin.mapEntityId; });
    if (!mapEntity || !entityMapIconVisible(mapEntity, ctx)) return;
    const depth = mapEntityAncestorDepth(mapEntity);
    if (depth < bestDepth) { bestDepth = depth; best = mapEntity.id; }
  });
  return best;
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
      // Trailing word-boundary: without this, "level 1" substring-matches
      // "level 10" (Tier/Level/Base Score values collide numerically).
      // Only the index entries get this treatment for now -- name/tag/
      // alias substring matching is left as-is pending usability testing.
      const i = t.indexOf(qNorm);
      if (i === -1) return false;
      const after = t.charAt(i + qNorm.length);
      return !after || !/[a-z0-9]/.test(after);
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
  state.noteEdit = null;
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
  'Game Mechanics': 'Game Mechanics', 'Equipment': 'Equipment',
  'Adversary': 'Adversaries', 'Environment': 'Environments'
};
function categoryGroupLabel(cat) {
  return CATEGORY_GROUP_LABELS[cat] || cat;
}

// Table of Contents: accordion grouped by category (CONFIG.categories
// order), each group a collapsible horizontal bar, collapsed by default.
function renderList() {
  updateGmToolbar();
  const ctx = viewerContext();

  // Phase 17 A2: Show secrets mode. Player view only; the button exists
  // only while at least one entity has secrets for this viewer, and the
  // mode self-clears when the last secret is shared onward (the filter
  // below would otherwise strand an empty list with no way to see why).
  const anySecrets = !ctx.gmView && state.allEntities.some(function (e) {
    return canSee(e, ctx) && entityHasSecretsFor(e, ctx);
  });
  if (state.secretsFilterActive && !anySecrets) state.secretsFilterActive = false;
  const secretsActive = state.secretsFilterActive;
  updateListActionButtons(ctx, anySecrets, secretsActive);
  listEl.classList.toggle('secrets-mode', secretsActive);

  const filtered = state.allEntities
    .filter(matchesFilters)
    .filter(function (e) { return canSee(e, ctx); })
    .filter(function (e) { return !secretsActive || entityHasSecretsFor(e, ctx); })
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
  // duration of the search only; clearing the box restores it. Phase 17
  // A2: Show secrets mode borrows the exact same force-expand mechanic.
  const searchActive = searchEl.value.trim().length > 0 || secretsActive;

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
      if (entityMapIconVisible(entity, ctx)) {
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
      // Literal-state display (not an access gate): a viewer sees their
      // OWN entity's raw visibility value here, not filtered per-viewer
      // access, so this stays a direct value comparison rather than a
      // canSee() call. S2 makes this 3-state-aware. S12: gated on
      // hasFullAuthority (GM, OR a player viewing an entity they
      // control the visibility state for -- in practice their own
      // owned Character) rather than bare ctx.gmView -- a player
      // couldn't previously tell their own character was hidden from
      // the rest of the party while browsing their own Codex list.
      if (hasFullAuthority(entity, ctx) && !isShareableToWholeParty(entity)) {
        const hiddenSpan = document.createElement('span');
        hiddenSpan.className = 'entity-hidden-badge';
        hiddenSpan.textContent = 'hidden';
        rightCol.appendChild(hiddenSpan);
      }
      // Phase 14 S16 / Phase 17 A1: secret badge for entries shared with
      // just this player's active character (player view only, not yet
      // shared with party) — OR containing child lore elements (lore
      // items, images) in that state (entityHasSecretsFor).
      if (entityHasSecretsFor(entity, ctx)) {
        const secretSpan = document.createElement('span');
        secretSpan.className = 'entity-secret-badge';
        secretSpan.textContent = 'secret';
        rightCol.appendChild(secretSpan);
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
function applyWikiLinks(rootEl, currentEntityId, ctx) {
  const candidates = [];
  state.allEntities.forEach(function (e) {
    if (e.id === currentEntityId || !e.name) return;
    if (!canSee(e, ctx)) return;
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
  row.appendChild(buildVisibilityControl({
    getVisibility: function () { return resolveDropOverlay(entity).visibility; },
    getCharacterId: function () { return resolveDropOverlay(entity).characterId; },
    getCharacterShared: function () { return !!resolveDropOverlay(entity).characterShared; },
    sourceId: entity.sourceId,
    confirmReveal: confirmRevealWithoutSource,
    onApply: function (patch) {
      shareEntityVisibility(entity.id, patch).catch(function (err) {
        window.alert('Visibility change failed: ' + err.message);
      });
    }
  }));
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
    // Phase 14 S7 fix: 'group' must survive into the draft or reopening
    // an existing featureGroups entity (Subclass tiers; now also
    // Ancestry First/Second, §11.1) for edit silently empties every
    // group's feature list -- the editor filters on f.group === g.key,
    // and a stripped group never matches any key.
    features: (entity.features || []).map(function (f) { return { name: f.name || '', text: f.text || '', group: f.group || null, type: f.type || null }; }),
    metaAncestryTargetIds: (entity.metaAncestryTargetIds || []).slice(),
    // Phase 14 S10: Character "cards" (ancestry/community/class/
    // subclass/tier/abilities) and badgeColor now edit through this
    // SAME draft, same as every other field -- previously they wrote
    // straight to Firestore on every change, independent of this
    // form's own Save/Cancel (bug: Cancel didn't revert them). Shallow
    // copy, not a reference to the live entity's object -- every write
    // site (character-cards.js's patchCards) always replaces draft.cards
    // wholesale with a fresh object/arrays, never mutates nested fields
    // in place, so a shallow copy here is enough to keep the live
    // entity's own doc from being touched before Save.
    cards: entity.cards ? Object.assign({}, entity.cards) : null,
    badgeColor: entity.badgeColor || null
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

// Selects entityId in the Codex tab's list/detail and switches the
// active tab to Codex, without entering edit mode. Shared by: the
// Map tab's read-only "Open in Codex" icon (any view mode) and the
// GM-only "Edit in Codex" button (which calls this, then separately
// calls enterEntityEditMode).
function switchToCodexTabForEntity(entityId) {
  state.selectedId = entityId;
  clearCodexSearchInput();
  renderList();
  renderDetailForSelected();
  document.querySelectorAll('nav#tabs button').forEach(function (b) { b.classList.remove('active'); });
  document.querySelectorAll('.tab-panel').forEach(function (p) { p.classList.remove('active'); });
  document.getElementById('tab-btn-codex').classList.add('active');
  document.getElementById('codex-panel').classList.add('active');
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
    // Phase 14 S7 (§11.2): Ancestry-only, same normalize-to-empty
    // pattern as ancestry/ownerId above for other category-specific
    // fields.
    metaAncestryTargetIds: (cat === 'Ancestry') ? (draft.metaAncestryTargetIds || []) : [],
    // Phase 14 S10: cards/badgeColor now save as part of this same
    // write, same normalize-to-empty-for-other-categories pattern.
    // DEFAULT_CARDS import keeps a from-scratch Character (never
    // touched the cards editor this session, draft.cards still null)
    // saving a complete, schema-valid cards object rather than null.
    cards: (cat === 'Character') ? Object.assign({}, DEFAULT_CARDS, draft.cards || {}) : null,
    badgeColor: (cat === 'Character') ? (draft.badgeColor || null) : null,
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

function buildParentSelect(entityId, currentParentId, onChange, ctx) {
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
    .filter(function (e) { return e.id !== entityId && (ctx.gmView || canSee(e, ctx)); })
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

// Reusable entity search/browse popup (Phase 14 S8): "the SAME entry
// browse/search UI we have everywhere else" per Gregg's ask -- same
// visual language as the Codex tab's own list (category headers +
// entity rows via entity-group-header/entity-group-list, live search
// via entityMatchesQuery, category grouping/labels via
// categoryGroupLabel) but its own small self-contained component, NOT
// a re-mount of the Codex tab's own stateful renderList (that's bound
// to state.selectedId and the Codex tab's own search-input DOM element
// -- same "don't re-invoke stateful global UI for a second simultaneous
// surface" reasoning as characters.js's GM-preview card, see that
// module's header comment). Click a row to select; click away, Escape,
// or Cancel closes without selecting.
//
// opts: { title, excludeIds (array|Set), ctx, onSelect: fn(entity),
//   filter (optional extra predicate ANDed into the pool -- Phase 17
//   follow-up, the Clone-from picker's same-category restriction) }
function openEntityPickerPopup(opts) {
  if (document.querySelector('.entity-picker-panel')) return;
  const excludeIds = opts.excludeIds instanceof Set ? opts.excludeIds : new Set(opts.excludeIds || []);
  const ctx = opts.ctx;

  const built = buildGalleryPickerPanel();
  built.panel.classList.add('entity-picker-panel');
  built.header.textContent = opts.title || 'Choose an entry';

  const searchInput = document.createElement('input');
  searchInput.type = 'text';
  searchInput.placeholder = 'Search\u2026';
  searchInput.className = 'entity-picker-search';
  built.body.appendChild(searchInput);

  const listEl = document.createElement('div');
  listEl.className = 'entity-picker-list';
  built.body.appendChild(listEl);

  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.textContent = 'Cancel';
  cancelBtn.addEventListener('click', close);
  built.body.appendChild(cancelBtn);

  function renderResults() {
    listEl.innerHTML = '';
    const pool = state.allEntities
      .filter(function (e) {
        return !excludeIds.has(e.id) && (ctx.gmView || canSee(e, ctx)) &&
          (!opts.filter || opts.filter(e)) && entityMatchesQuery(e, searchInput.value);
      })
      .sort(function (a, b) { return (a.name || '').localeCompare(b.name || ''); });

    if (!pool.length) {
      const p = document.createElement('p');
      p.className = 'lore-empty';
      p.textContent = 'No matches.';
      listEl.appendChild(p);
      return;
    }

    const byCategory = {};
    pool.forEach(function (e) {
      const cat = e.category || '(uncategorized)';
      (byCategory[cat] = byCategory[cat] || []).push(e);
    });
    const orderedCats = CONFIG.categories.filter(function (c) { return byCategory[c]; });
    Object.keys(byCategory).forEach(function (c) { if (orderedCats.indexOf(c) === -1) orderedCats.push(c); });

    orderedCats.forEach(function (cat) {
      const header = document.createElement('div');
      header.className = 'entity-group-header';
      const dotSpan = document.createElement('span');
      dotSpan.className = 'entity-group-dot ' + categoryPinClassLocal(cat);
      const titleSpan = document.createElement('span');
      titleSpan.className = 'entity-group-title';
      titleSpan.textContent = categoryGroupLabel(cat);
      const countSpan = document.createElement('span');
      countSpan.className = 'entity-group-count';
      countSpan.textContent = '(' + byCategory[cat].length + ')';
      header.appendChild(dotSpan);
      header.appendChild(titleSpan);
      header.appendChild(countSpan);
      listEl.appendChild(header);

      const ul = document.createElement('ul');
      ul.className = 'entity-group-list';
      byCategory[cat]
        .sort(function (a, b) { return (a.name || '').localeCompare(b.name || ''); })
        .forEach(function (e) {
          const li = document.createElement('li');
          const nameDiv = document.createElement('div');
          nameDiv.className = 'entity-name';
          nameDiv.textContent = e.name;
          li.appendChild(nameDiv);
          li.addEventListener('click', function () {
            opts.onSelect(e);
            close();
          });
          ul.appendChild(li);
        });
      listEl.appendChild(ul);
    });
  }

  searchInput.addEventListener('input', renderResults);
  renderResults();
  searchInput.focus();

  function onDocClick(ev) {
    if (!built.panel.contains(ev.target)) close();
  }
  function onKeydown(ev) { if (ev.key === 'Escape') close(); }
  // Deferred by a tick: the SAME click that opened this popup (the
  // triggering "Add" button's own click event) is still bubbling up to
  // document when this listener would otherwise attach synchronously,
  // which would close the popup the instant it opens.
  setTimeout(function () { document.addEventListener('click', onDocClick); }, 0);
  document.addEventListener('keydown', onKeydown);

  function close() {
    document.removeEventListener('click', onDocClick);
    document.removeEventListener('keydown', onKeydown);
    built.panel.remove();
  }
}

// "Suggest Related" (Phase 14 S8): scans this entity's OWN lore items'
// raw markdown content for other entities' name/alias mentions -- the
// same word-boundary name-matching approach applyWikiLinks already
// uses to turn mentions into clickable links (candidates sorted
// longest-name-first so e.g. "Lor'thak Felwind" matches before a
// shorter overlapping alias would), just run against the raw source
// strings instead of rendered DOM (nothing to mutate here, just
// scanning for candidates to suggest -- no tree-walk/link-avoidance
// needed). excludeIds keeps already-related entities and self out of
// the results.
function findRelatedSuggestions(entityId, excludeIds, ctx) {
  const loreText = state.allLoreItems
    .filter(function (it) { return it.entityId === entityId; })
    .map(function (it) { return it.content || ''; })
    .join('\n');
  if (!loreText.trim()) return [];

  const nameCandidates = [];
  state.allEntities.forEach(function (e) {
    if (e.id === entityId || !e.name || excludeIds.indexOf(e.id) !== -1) return;
    if (!canSee(e, ctx)) return;
    nameCandidates.push({ name: e.name, id: e.id });
    (e.aliases || []).forEach(function (a) { if (a) nameCandidates.push({ name: a, id: e.id }); });
  });
  if (!nameCandidates.length) return [];
  nameCandidates.sort(function (a, b) { return b.name.length - a.name.length; });

  function isWordChar(ch) { return /[A-Za-z0-9]/.test(ch); }
  const matchedIds = new Set();
  nameCandidates.forEach(function (cand) {
    if (matchedIds.has(cand.id)) return;
    const escaped = cand.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(escaped, 'g');
    let m;
    while ((m = re.exec(loreText)) !== null) {
      const before = m.index > 0 ? loreText.charAt(m.index - 1) : '';
      const after = loreText.charAt(m.index + m[0].length);
      if (!((before && isWordChar(before)) || (after && isWordChar(after)))) {
        matchedIds.add(cand.id);
        break;
      }
    }
  });

  return state.allEntities
    .filter(function (e) { return matchedIds.has(e.id); })
    .sort(function (a, b) { return (a.name || '').localeCompare(b.name || ''); });
}

// Suggestion popup: checkbox per suggestion (all pre-checked -- the
// common case is "yes, add all of these"), "Add selected" commits only
// the checked ones. Same floating-panel/click-away/Escape pattern as
// openEntityPickerPopup, reused rather than duplicated.
function openSuggestRelatedPopup(entityId, draft, ctx) {
  if (document.querySelector('.entity-picker-panel')) return;
  const suggestions = findRelatedSuggestions(entityId, [entityId].concat(draft.relatedIds), ctx);

  const built = buildGalleryPickerPanel();
  built.panel.classList.add('entity-picker-panel');
  built.header.textContent = 'Suggested related entries';

  const listEl = document.createElement('div');
  listEl.className = 'entity-picker-list';
  built.body.appendChild(listEl);

  if (!suggestions.length) {
    const p = document.createElement('p');
    p.className = 'lore-empty';
    p.textContent = 'No name mentions found in this entry\u2019s lore.';
    listEl.appendChild(p);
  } else {
    const checks = [];
    const ul = document.createElement('ul');
    ul.className = 'related-edit-list';
    suggestions.forEach(function (e) {
      const li = document.createElement('li');
      const rowLabel = document.createElement('label');
      rowLabel.className = 'related-suggest-row';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = true;
      rowLabel.appendChild(cb);
      const nameSpan = document.createElement('span');
      nameSpan.textContent = e.name;
      rowLabel.appendChild(nameSpan);
      li.appendChild(rowLabel);
      ul.appendChild(li);
      checks.push({ id: e.id, cb: cb });
    });
    listEl.appendChild(ul);

    const addBtn = document.createElement('button');
    addBtn.type = 'button';
    addBtn.textContent = 'Add selected';
    addBtn.addEventListener('click', function () {
      checks.forEach(function (c) {
        if (c.cb.checked && draft.relatedIds.indexOf(c.id) === -1) draft.relatedIds.push(c.id);
      });
      close();
      renderDetailForSelected();
    });
    built.body.appendChild(addBtn);
  }

  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.textContent = 'Cancel';
  cancelBtn.addEventListener('click', close);
  built.body.appendChild(cancelBtn);

  function onDocClick(ev) {
    if (!built.panel.contains(ev.target)) close();
  }
  function onKeydown(ev) { if (ev.key === 'Escape') close(); }
  setTimeout(function () { document.addEventListener('click', onDocClick); }, 0);
  document.addEventListener('keydown', onKeydown);

  function close() {
    document.removeEventListener('click', onDocClick);
    document.removeEventListener('keydown', onKeydown);
    built.panel.remove();
  }
}

function buildRelatedEditor(entityId, draft, ctx) {
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
  addRow.className = 'actions-row';
  const addRowRight = document.createElement('div');
  addRowRight.className = 'actions-row-right';
  const addBtn = document.createElement('button');
  addBtn.type = 'button';
  addBtn.className = 'action-btn-compact';
  addBtn.textContent = '+ Add related';
  addBtn.addEventListener('click', function () {
    openEntityPickerPopup({
      title: 'Add related entry',
      excludeIds: [entityId].concat(draft.relatedIds),
      ctx: ctx,
      onSelect: function (entity) {
        if (draft.relatedIds.indexOf(entity.id) === -1) draft.relatedIds.push(entity.id);
        renderDetailForSelected();
      }
    });
  });
  const suggestBtn = document.createElement('button');
  suggestBtn.type = 'button';
  suggestBtn.className = 'action-btn-compact';
  suggestBtn.textContent = 'Suggest related';
  suggestBtn.addEventListener('click', function () {
    openSuggestRelatedPopup(entityId, draft, ctx);
  });
  addRowRight.appendChild(suggestBtn);
  addRowRight.appendChild(addBtn);
  addRow.appendChild(addRowRight);
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
        // Phase 15 (D5/A3): schemas with hasFeatureType edit a per-
        // feature type (Action/Passive/Reaction). Free text with a
        // datalist, NOT a strict select -- the SRD source carries
        // compound values ("Reaction: Countdown (5)") that a closed
        // enum would reject. Datalist shared per document via fixed id;
        // created once, first time any typed feature row renders.
        if (schema.hasFeatureType) {
          const typeInput = document.createElement('input');
          typeInput.type = 'text';
          typeInput.className = 'template-feature-type-input';
          typeInput.placeholder = 'Type';
          typeInput.setAttribute('list', 'feature-type-options');
          if (!document.getElementById('feature-type-options')) {
            const dl = document.createElement('datalist');
            dl.id = 'feature-type-options';
            ['Action', 'Passive', 'Reaction'].forEach(function (t) {
              const opt = document.createElement('option');
              opt.value = t;
              dl.appendChild(opt);
            });
            document.body.appendChild(dl);
          }
          typeInput.value = f.type || '';
          typeInput.addEventListener('input', function () { f.type = typeInput.value; });
          row.appendChild(typeInput);
        }
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

function renderEntityEditBlock(container, entity, draft, ctx) {
  container.appendChild(buildParentSelect(entity.id, draft.parentId, function (v) { draft.parentId = v; }, ctx));
  container.appendChild(makeEditField('Tags (comma-separated)', draft.tags, function (v) { draft.tags = v; }));

  const templateEditor = buildTemplateEditor(draft);
  if (templateEditor) container.appendChild(templateEditor);

  container.appendChild(buildRelatedEditor(entity.id, draft, ctx));
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
const entityNewCloneBtn = document.getElementById('entity-new-clone');

CONFIG.categories.forEach(function (cat) {
  const opt = document.createElement('option');
  opt.value = cat;
  opt.textContent = cat;
  entityNewCategoryEl.appendChild(opt);
});

// preset (optional): { category, tags } -- Phase 14 S8, Characters tab's
// "+ New Entity"/"+ Create Character" buttons pre-fill category (locked
// to Character, since that's the only category either button ever
// wants) and stash tags for createNewEntity to write (the mini dialog has
// no tags field of its own; the tags become visible once the post-save
// edit form opens, same "already selected"/"already in tag list" as the
// category preselect).
let pendingNewEntityPreset = null;
function openNewEntityDialog(preset) {
  pendingNewEntityPreset = preset || null;
  entityNewNameEl.value = '';
  entityNewCategoryEl.value = (preset && preset.category) || CONFIG.categories[0];
  entityNewCategoryEl.disabled = !!(preset && preset.category);
  entityNewErrorEl.style.display = 'none';
  entityNewErrorEl.textContent = '';
  entityNewOverlayEl.classList.add('open');
  entityNewNameEl.focus();
}

function closeNewEntityDialog() {
  entityNewOverlayEl.classList.remove('open');
  entityNewCategoryEl.disabled = false;
  pendingNewEntityPreset = null;
}

function showNewEntityError(message) {
  entityNewErrorEl.textContent = message;
  entityNewErrorEl.style.display = 'block';
}

// New-entity default source: the GM's first source in Admin > Sources
// drag-order (sortedSources()[0]) — hand-created entities default to
// it rather than "no source", since most campaign content shares one
// dominant attribution (homebrew). Deliberately UI-level-only, applied
// at creation time; never backfilled onto existing entities. The same
// value must also be threaded into the post-save edit-form draft below
// (buildEntityDraft's seed object) — that draft doesn't read the just-
// written Firestore doc, so without this the form that pops open
// immediately after Save showed "no source" despite the doc itself
// being correct.
// Phase 17 follow-up: create and clone-create share this body. `source`
// is null (blank Create) or an existing entity of the SAME category to
// copy content fields from. Cloning copies the draft-able content
// (ancestry/subtype/aliases/dates/parent/related/tags/source/template
// mode + details/features/metaAncestryTargetIds/cards/badgeColor) but
// NEVER identity or exposure state: visibility starts gm-only with no
// character targeting, ownerId is not carried (except the player
// self-create path, unchanged), hasMapImage is false (images aren't
// cloned), and slug derives from the NEW name. An empty name field on a
// clone defaults to "<source name> (copy)" instead of erroring.
function createNewEntity(source) {
  let name = entityNewNameEl.value.trim();
  if (!name && source) name = (source.name || '(unnamed)') + ' (copy)';
  if (!name) {
    showNewEntityError('Name is required.');
    return;
  }
  const ctx = viewerContext();
  const cat = entityNewCategoryEl.value;
  const presetTags = (pendingNewEntityPreset && pendingNewEntityPreset.tags) || [];
  entityNewSaveBtn.disabled = true;
  const newId = doc(collection(db, 'entities')).id;
  // Player creation is rules-restricted to category=='Character' with
  // ownerId==self set in the SAME write (firestore.rules) -- the
  // Characters tab's player-facing "+ Create Character" button routes
  // here via the preset path, so ownerId must be set now, not left for
  // a later updateDoc (which the player-edit rule forbids touching
  // anyway). GM-triggered creates (this dialog's normal path, and the
  // Characters tab's GM "+ New Entity") leave ownerId unset -- the GM
  // assigns ownership afterward via the Players & Characters panel.
  const entityData = {
    slug: slugify(name),
    name: name,
    category: cat,
    ancestry: (source && source.ancestry) || null,
    aliases: source ? (source.aliases || []).slice() : [],
    date: (source && source.date) || null,
    dateSort: (source && source.dateSort != null) ? source.dateSort : null,
    parentId: (source && source.parentId) || null,
    relatedIds: source ? (source.relatedIds || []).slice() : [],
    visibility: 'gm-only',
    hasMapImage: false,
    tags: source ? (source.tags || []).slice() : presetTags.slice(),
    sourceId: source
      ? (source.sourceId || null)
      : ((sortedSources()[0] && sortedSources()[0].id) || null),
    useTemplate: !!(source && source.useTemplate),
    details: source ? Object.assign({}, source.details || {}) : {},
    features: source
      ? (source.features || []).map(function (f) {
          return { name: f.name || '', text: f.text || '', group: f.group || null, type: f.type || null };
        })
      : [],
    searchIndex: source ? (source.searchIndex || []).slice() : [],
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp()
  };
  if (source) {
    if (source.subtype) entityData.subtype = source.subtype;
    if (source.dateEnd) { entityData.dateEnd = source.dateEnd; entityData.dateEndSort = source.dateEndSort != null ? source.dateEndSort : null; }
    if (source.metaAncestryTargetIds && source.metaAncestryTargetIds.length) entityData.metaAncestryTargetIds = source.metaAncestryTargetIds.slice();
    if (source.cards) entityData.cards = Object.assign({}, source.cards);
    if (source.badgeColor) entityData.badgeColor = source.badgeColor;
  }
  if (cat === 'Character' && !ctx.gmView) {
    entityData.ownerId = ctx.email;
  }
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
  state.noteEdit = null;
  state.detailEditMode = true;
  // Draft seeds from the just-built entityData (not the Firestore doc,
  // which hasn't round-tripped) -- for a clone that carries every
  // copied field, template mode included, into the edit form that pops
  // open next.
  state.detailEditDraft = buildEntityDraft(
    Object.assign({}, entityData, { ownerId: entityData.ownerId || '' }));
  renderList();
  renderDetailForSelected();
  // Always land on the Codex tab with the new entity selected -- a no-op
  // when this dialog was already opened from Codex (the normal GM "+ New
  // entry" path), but required when opened from the Characters tab's "+
  // New Entity"/"+ Create Character" buttons (Phase 14 S8).
  document.querySelectorAll('nav#tabs button').forEach(function (b) { b.classList.remove('active'); });
  document.querySelectorAll('.tab-panel').forEach(function (p) { p.classList.remove('active'); });
  document.getElementById('tab-btn-codex').classList.add('active');
  document.getElementById('codex-panel').classList.add('active');
}

newEntityBtn.addEventListener('click', function () { openNewEntityDialog(); });
entityNewCancelBtn.addEventListener('click', closeNewEntityDialog);
entityNewSaveBtn.addEventListener('click', function () { createNewEntity(null); });
// Clone from...: pick any existing entry of the category currently
// selected in this dialog; the pick creates immediately (same flow as
// Create) with content fields copied from the picked entry.
entityNewCloneBtn.addEventListener('click', function () {
  const cat = entityNewCategoryEl.value;
  openEntityPickerPopup({
    title: 'Clone from\u2026 (' + categoryGroupLabel(cat) + ')',
    ctx: viewerContext(),
    filter: function (e) { return e.category === cat; },
    onSelect: function (sourceEntity) { createNewEntity(sourceEntity); }
  });
});
entityNewOverlayEl.addEventListener('click', function (e) {
  if (e.target === entityNewOverlayEl) closeNewEntityDialog();
});
// Enter-to-save (name field or category select) -- name/category
// validity is createNewEntity's own job (shows "Name is required." same
// as a Save-button click with an empty name), this just wires the key.
// Shift/Ctrl/Meta+Enter excluded in case a future revision adds a
// multi-line field here that wants its own Enter behavior.
function handleNewEntityEnterKey(ev) {
  if (ev.key !== 'Enter' || ev.shiftKey || ev.ctrlKey || ev.metaKey) return;
  ev.preventDefault();
  createNewEntity(null);
}
entityNewNameEl.addEventListener('keydown', handleNewEntityEnterKey);
entityNewCategoryEl.addEventListener('keydown', handleNewEntityEnterKey);

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
      // Phase 14 S6: creation routes through sharing.js — the edit box's
      // visibility control works before first save, so a brand-new item
      // can be born already shared, which must fan out notifications
      // like any other share transition (R4).
      trackWrite(createLoreItemShared({
        entityId: entity.id,
        // 'character-lore' (Phase 14 S3): a distinct kind, not a
        // repurposed 'gm-note', for content a player authors under
        // their own owned Character -- 'gm-note' now means specifically
        // GM-authored, matching its name for the first time. Gregg's
        // call: introduce the enum level rather than let authorType
        // silently carry the real distinction under a misleading kind.
        kind: editState.authorType === 'character' ? 'character-lore' : 'gm-note',
        authorId: editState.authorType === 'character' ? editState.authorId : null,
        authorType: editState.authorType || 'gm',
        visibility: editState.visibility,
        characterId: editState.characterId || null,
        characterShared: !!editState.characterShared,
        content: c,
        meta: editState.meta || null,
        sourceId: editState.sourceId || null,
        order: maxOrder,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp()
      }), 'Saving lore').catch(fail);
    });
  } else {
    trackWrite(shareLoreItemVisibility(editState.id, {
      content: content,
      visibility: editState.visibility,
      characterId: editState.characterId || null,
      characterShared: !!editState.characterShared,
      meta: editState.meta || null,
      sourceId: editState.sourceId || null
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

// Phase 14 S4 (§6.3): Notes-tab / cannon-note-on-Lore-tab save. A note
// never has meta/sourceId/characterId/characterShared (§3.2 -- those
// keys are simply omitted from the doc, not set to null) and, unlike
// saveLoreEdit, is never split on Markdown list boundaries
// (splitUnorderedListContent is a GM-lore-dump convenience; a note is
// one personal entry). Content and the binary visibility ("Just for
// me"/"Make it cannon!") save together in one write, same
// combined-write reasoning as saveLoreEdit.
function saveNoteEdit(entity, editState, isNew, saveBtn) {
  const content = editState.content;
  if (!content.trim()) {
    window.alert('Content is required.');
    return;
  }
  saveBtn.disabled = true;

  function fail(err) {
    window.alert('Save failed: ' + err.message);
  }

  if (isNew) {
    const siblings = state.allLoreItems.filter(function (it) { return it.entityId === entity.id; });
    const maxOrder = siblings.reduce(function (acc, it) { return Math.max(acc, it.order || 0); }, 0);
    // Phase 14 S6: same share-at-create routing as saveLoreEdit above —
    // a note can be born already cannon ("Make it cannon!" flipped before
    // first save), which is a share transition that must fan out.
    trackWrite(createLoreItemShared({
      entityId: entity.id,
      kind: 'note',
      authorId: editState.authorId,
      authorType: editState.authorType,
      visibility: editState.visibility,
      content: content,
      order: maxOrder + 1,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    }), 'Saving note').catch(fail);
  } else {
    trackWrite(shareLoreItemVisibility(editState.id, {
      content: content,
      visibility: editState.visibility
    }), 'Saving note').catch(fail);
  }
  state.noteEdit = null;
  renderDetailForSelected();
}

// Phase 14 S3 (§6.2): the player's edit path on a loreItem the GM shared
// with their active character -- content + sourceId only (no visibility/
// characterId, no meta, no delete; rules enforce the same field set).
// characterShared has its own separate toggle (buildSharedToggle, live-
// written immediately on flip) -- not part of this save.
function saveSharedLoreItem(editState, saveBtn) {
  const content = editState.content;
  if (!content.trim()) {
    window.alert('Content is required.');
    return;
  }
  saveBtn.disabled = true;
  trackWrite(shareLoreItemVisibility(editState.id, {
    content: content,
    sourceId: editState.sourceId || null
  }), 'Saving lore').catch(function (err) {
    window.alert('Save failed: ' + err.message);
  });
  state.loreEdit = null;
  renderDetailForSelected();
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
        editState.characterId = liveItem.characterId || null;
        editState.characterShared = !!liveItem.characterShared;
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
  toggleRow.appendChild(buildVisibilityControl({
    getVisibility: function () { return editState.visibility; },
    getCharacterId: function () { return editState.characterId; },
    getCharacterShared: function () { return !!editState.characterShared; },
    sourceId: editState.sourceId,
    confirmReveal: confirmRevealWithoutSource,
    onApply: function (patch) {
      editState.visibility = patch.visibility;
      editState.characterId = patch.characterId;
      if ('characterShared' in patch) editState.characterShared = patch.characterShared;
    }
  }));
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
    ['meta-features', 'Meta \u2014 Features'],
    ['meta-narrative-backstory', 'Meta \u2014 Narrative Backstory']
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

// Phase 14 S3 (§6.2): reduced edit box for a loreItem the GM shared with
// the player's active character -- content + source only, no kebab (the
// player never sets visibility/characterId), no meta select (GM
// bookkeeping, not a player concern), no Delete (rules don't allow it).
// The characterShared toggle lives on the item's own row, not in here --
// same live-write-immediately pattern as the GM kebab, not part of this
// box's Save/Cancel.
function buildSharedLoreEditBox(editState) {
  const box = document.createElement('div');
  box.className = 'lore-item';

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

  const bottomRow = document.createElement('div');
  bottomRow.className = 'actions-row';
  const right = document.createElement('div');
  right.className = 'actions-row-right';
  const saveBtn = document.createElement('button');
  saveBtn.className = 'lore-item-btn';
  saveBtn.textContent = 'Save';
  saveBtn.addEventListener('click', function () { saveSharedLoreItem(editState, saveBtn); });
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

// Phase 14 S4 (§6.3): note edit box -- content + binary "Just for me"/
// "Make it cannon!" toggle only, no source/meta rows (notes don't carry
// either) and no kebab (D6: binary visibility, never 3-state). Reachable
// from both the Notes tab (own private notes) and the Lore tab (editing
// an already-cannon note you authored, or -- for the entity's owner/GM --
// any cannon note filed under it). Same conflict-banner pattern as
// buildLoreEditBox.
function buildNoteEditBox(entity, editState, isNew) {
  const box = document.createElement('div');
  box.className = 'lore-item';

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
      conflictMsg.textContent = 'This note was saved elsewhere while you were editing.';
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
  toggleRow.appendChild(buildNoteToggle({
    getVisibility: function () { return editState.visibility; },
    onToggle: function (newVisibility) { editState.visibility = newVisibility; }
  }));
  box.appendChild(toggleRow);

  const textarea = document.createElement('textarea');
  textarea.className = 'lore-edit-textarea';
  textarea.value = editState.content;
  textarea.addEventListener('input', function () { editState.content = textarea.value; });
  box.appendChild(textarea);

  const bottomRow = document.createElement('div');
  bottomRow.className = 'actions-row';
  const right = document.createElement('div');
  right.className = 'actions-row-right';
  const saveBtn = document.createElement('button');
  saveBtn.className = 'lore-item-btn';
  saveBtn.textContent = 'Save';
  saveBtn.addEventListener('click', function () { saveNoteEdit(entity, editState, isNew, saveBtn); });
  right.appendChild(saveBtn);
  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'lore-item-btn';
  cancelBtn.textContent = 'Cancel';
  cancelBtn.addEventListener('click', function () { state.noteEdit = null; renderDetailForSelected(); });
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
// Phase 14 S3: lore tab rendering is now item-tier-aware rather than a
// single gmView/readOnly branch. Three tiers per item:
//   1. entityAuthority (GM, or a player who owns this Character entity)
//      -- full GM-equivalent chrome for EVERY item under this entity:
//      kebab toggle, drag-reorder, Edit/Delete, "+New lore".
//   2. itemShared (only reachable when entityAuthority is false) -- a
//      single item the GM shared with the viewer's active character
//      (§6.2), even on an entity the player doesn't own at all (e.g. a
//      GM-owned NPC). Gets Edit (content/source, via
//      buildSharedLoreEditBox) + a characterShared-only toggle, no
//      Delete, no kebab.
//   3. read-only -- everything else, unchanged visual (meta tag + body +
//      source label, no controls).
// Phase 14 S4 addendum: cannon notes (kind:'note', visibility:'all-players'
// -- "Make it cannon!" flipped from the Notes tab) join this same list via
// loreItemsForEntity (which now special-cases kind:'note' to only pass
// through once cannon -- see that function's own comment; a still-private
// note stays exclusive to the Notes tab even for its own author) --
// pure render-time projection, no data movement — §6.3. They never use
// the general entityAuthority-tier 3-state kebab (D6: notes are
// binary-visibility only) -- instead, note-specific chrome (the "Just for
// me"/"Make it cannon!" toggle + Edit/Delete) is gated on noteChrome, which
// is TRUE for either (a) entityAuthority (GM, or the owner of the Character
// entity this note is filed under -- mirrors the rules' general
// ownsCharacter(entityId) grant, which is not kind-restricted) or (b)
// isNoteAuthor (the viewer wrote this specific note, regardless of which
// entity it's filed under -- mirrors the rules' ownsCharacter(authorId)
// grant). A non-author, non-owning viewer sees a cannon note exactly like
// any other published lore item: read-only.
function renderLoreTab(container, entity, ctx, readOnly) {
  const items = loreItemsForEntity(entity.id, ctx);
  const entityAuthority = !readOnly && hasFullAuthority(entity, ctx);
  const activeLoreEdit = state.loreEdit && state.loreEdit.entityId === entity.id ? state.loreEdit : null;
  const activeNoteEdit = state.noteEdit && state.noteEdit.entityId === entity.id ? state.noteEdit : null;
  const anyActiveEdit = activeLoreEdit || activeNoteEdit;

  const loreListDiv = document.createElement('div');
  loreListDiv.className = 'codex-lore-list';

  if (items.length === 0 && !(activeLoreEdit && activeLoreEdit.id === null)) {
    const emptyP = document.createElement('p');
    emptyP.className = 'lore-empty';
    emptyP.textContent = '(no lore for this view)';
    loreListDiv.appendChild(emptyP);
  }

  items.forEach(function (item) {
    if (activeLoreEdit && activeLoreEdit.id === item.id) {
      loreListDiv.appendChild(activeLoreEdit.limited ? buildSharedLoreEditBox(activeLoreEdit) : buildLoreEditBox(entity, activeLoreEdit, false));
      return;
    }
    if (activeNoteEdit && activeNoteEdit.id === item.id) {
      loreListDiv.appendChild(buildNoteEditBox(entity, activeNoteEdit, false));
      return;
    }

    const isNote = item.kind === 'note';
    const itemShared = !entityAuthority && !readOnly && !isNote && isSharedWithActiveCharacter(item, ctx);
    const noteChrome = isNote && !readOnly && (entityAuthority || isNoteAuthor(item, ctx));
    const hasChrome = (entityAuthority && !isNote) || itemShared || noteChrome;

    const itemDiv = document.createElement('div');
    itemDiv.className = 'lore-item ' + visibilityStateClass(item);
    itemDiv.dataset.itemId = item.id;

    if (hasChrome) {
      const toggleRow = document.createElement('div');
      toggleRow.className = 'lore-item-toggle-row';
      const toggleRowLeft = document.createElement('div');
      toggleRowLeft.className = 'lore-item-toggle-row-left';
      if (entityAuthority && !isNote && !anyActiveEdit && items.length > 1) {
        const dragHandle = document.createElement('span');
        dragHandle.className = 'lore-item-drag-handle';
        dragHandle.title = 'Drag to reorder';
        dragHandle.textContent = '\u22ee\u22ee';
        toggleRowLeft.appendChild(dragHandle);
      }
      if (metaBadgeLabel(item.meta)) {
        const metaTag = document.createElement('span');
        metaTag.className = 'meta-tag';
        metaTag.textContent = metaBadgeLabel(item.meta);
        toggleRowLeft.appendChild(metaTag);
      }
      toggleRow.appendChild(toggleRowLeft);
      const toggleRowRight = document.createElement('div');
      toggleRowRight.className = 'lore-item-toggle-row-right';
      if (noteChrome) {
        toggleRowRight.appendChild(buildNoteToggle({
          getVisibility: function () { return resolveDropOverlay(item).visibility; },
          onToggle: function (newVisibility) {
            shareLoreItemVisibility(item.id, { visibility: newVisibility }).catch(function (err) {
              window.alert('Visibility change failed: ' + err.message);
            });
          }
        }));
      } else if (entityAuthority) {
        toggleRowRight.appendChild(buildVisibilityControl({
          getVisibility: function () { return resolveDropOverlay(item).visibility; },
          getCharacterId: function () { return resolveDropOverlay(item).characterId; },
          getCharacterShared: function () { return !!resolveDropOverlay(item).characterShared; },
          sourceId: item.sourceId,
          confirmReveal: confirmRevealWithoutSource,
          onApply: function (patch) {
            shareLoreItemVisibility(item.id, patch).catch(function (err) {
              window.alert('Visibility change failed: ' + err.message);
            });
          }
        }));
      } else {
        toggleRowRight.appendChild(buildSharedToggle({
          getShared: function () { return !!item.characterShared; },
          onToggle: function (patch) {
            shareLoreItemVisibility(item.id, patch).catch(function (err) {
              window.alert('Visibility change failed: ' + err.message);
            });
          }
        }));
      }
      toggleRow.appendChild(toggleRowRight);
      itemDiv.appendChild(toggleRow);
    } else if (metaBadgeLabel(item.meta)) {
      const metaTag = document.createElement('span');
      metaTag.className = 'meta-tag';
      metaTag.textContent = metaBadgeLabel(item.meta);
      itemDiv.appendChild(metaTag);
    }

    const bodyDiv = document.createElement('div');
    bodyDiv.className = 'lore-item-body';
    renderMarkdownInto(bodyDiv, resolveLoreItemMarkdown(entity, item, items)).then(function () {
      applyWikiLinks(bodyDiv, entity.id, ctx);
      // Phase 14 S17: v-scroll applied post-render, since it depends on
      // actual rendered height, not raw markdown length (a short
      // paragraph with a big embedded image is "long" on screen; a long
      // line of prose might not be).
      attachLoreItemExpand(bodyDiv);
    });
    itemDiv.appendChild(bodyDiv);

    // Hide Edit/Delete on other items while one item (or a new draft) is
    // already being edited — forces finishing that edit first, rather
    // than silently discarding it by switching targets.
    if (!anyActiveEdit && hasChrome) {
      const actionsRow = document.createElement('div');
      actionsRow.className = 'lore-item-actions-row';
      const editBtn = document.createElement('button');
      editBtn.className = 'lore-item-btn';
      editBtn.textContent = 'Edit';
      editBtn.addEventListener('click', function () { openLoreItemEdit(entity, item, isNote, entityAuthority); });
      actionsRow.appendChild(editBtn);
      if (entityAuthority || noteChrome) {
        const delBtn = document.createElement('button');
        delBtn.className = 'lore-item-btn';
        delBtn.textContent = 'Delete';
        delBtn.addEventListener('click', function () { deleteLoreItem(item); });
        actionsRow.appendChild(delBtn);
      }
      itemDiv.appendChild(actionsRow);
    }

    const sourceLabelDiv = document.createElement('div');
    sourceLabelDiv.className = 'source-label';
    renderSourceLabel(sourceLabelDiv, item.sourceId, entity.sourceId);
    // Character badge (D3/§6.3): renders for a characterShared element or
    // a character-authored cannon note -- i.e. anything the party is
    // seeing because a PLAYER chose to share it, never a GM-set state.
    // Lives in the same row as the source label (right of it, or in
    // place of it when there's no source) since both are small
    // attribution-style footers on the item.
    const badge = visibilityBadge(item, ctx);
    if (badge) {
      sourceLabelDiv.style.display = '';
      sourceLabelDiv.appendChild(buildCharacterBadge(badge.characterId));
    }
    itemDiv.appendChild(sourceLabelDiv);

    loreListDiv.appendChild(itemDiv);
  });

  if (activeLoreEdit && activeLoreEdit.id === null) {
    loreListDiv.appendChild(buildLoreEditBox(entity, activeLoreEdit, true));
  }

  container.appendChild(loreListDiv);

  if (entityAuthority && !anyActiveEdit && items.length > 1) {
    loadSortable().then(function (Sortable) {
      // eslint-disable-next-line no-new
      new Sortable(loreListDiv, {
        handle: '.lore-item-drag-handle',
        // forceFallback: same reason as the Gallery tab's drag-reorder
        // (see persistGalleryOrder's call site) -- native HTML5 DnD
        // doesn't reliably initiate from trackpad-as-mouse input in
        // Safari, so force SortableJS's own JS-simulated drag for
        // consistent mouse/trackpad/touch behavior.
        forceFallback: true,
        animation: 150,
        onEnd: function () {
          const orderedIds = Array.prototype.slice.call(loreListDiv.children)
            .map(function (el) { return el.dataset.itemId; })
            .filter(Boolean); // defensive: skip any non-item child (shouldn't occur while !anyActiveEdit)
          persistLoreOrder(entity.id, orderedIds);
        }
      });
    }).catch(function () { /* drag-reorder unavailable; edit/delete still work */ });
  }

  if (entityAuthority && !anyActiveEdit) {
    const loreTabActions = document.createElement('div');
    loreTabActions.className = 'actions-row';
    const right = document.createElement('div');
    right.className = 'actions-row-right';
    const newLoreBtn = document.createElement('button');
    newLoreBtn.className = 'action-btn-compact';
    newLoreBtn.textContent = '+ New lore';
    newLoreBtn.addEventListener('click', function () {
      // authorType/authorId (Phase 14 S3, §5.3's authorship convention):
      // the GM's "+New lore" authors as GM (authorId null); an owner
      // adding lore under their OWN Character authors as that character
      // (authorId = the character's own entity id -- "written by this
      // PC", not "written by a player").
      state.loreEdit = ctx.gmView
        ? { entityId: entity.id, id: null, content: '', visibility: 'gm-only', characterId: null, characterShared: false, meta: '', sourceId: (sortedSources()[0] && sortedSources()[0].id) || null, authorType: 'gm', authorId: null }
        : { entityId: entity.id, id: null, content: '', visibility: 'gm-only', characterId: null, characterShared: false, meta: '', sourceId: (sortedSources()[0] && sortedSources()[0].id) || null, authorType: 'character', authorId: entity.id };
      renderDetailForSelected();
    });
    right.appendChild(newLoreBtn);
    loreTabActions.appendChild(right);
    container.appendChild(loreTabActions);
  }
}

// Notes tab content (§6.3). Lists only the viewer's own private notes for
// this entity -- kind:'note' && visibility=='author-only', filtered
// through canSee (whose author-only branch, by construction, is true
// exactly when the viewer is the note's author -- see visibility.js --
// so no separate ownership check is needed here). Cannon notes
// (visibility:'all-players') are deliberately NOT listed here; they
// render on the Lore tab instead, alongside everything else the party
// can see (pure render-time projection -- see renderLoreTab's Phase 14
// S4 addendum). "+ New Note" needs an author identity to attach the note
// to: always available to the GM, available to a player only once
// they've picked an active character (nav dropdown, Phase 14 S3).
function renderNotesTab(container, entity, ctx, readOnly) {
  const canAuthor = !readOnly && (ctx.gmView || !!ctx.activeCharacterId);
  const items = state.allLoreItems
    .filter(function (item) { return item.entityId === entity.id && item.kind === 'note' && item.visibility === 'author-only'; })
    .filter(function (item) { return canSee(item, ctx); })
    .sort(function (a, b) { return (a.order || 0) - (b.order || 0); });
  const activeNoteEdit = state.noteEdit && state.noteEdit.entityId === entity.id ? state.noteEdit : null;

  const listDiv = document.createElement('div');
  listDiv.className = 'codex-lore-list';

  if (items.length === 0 && !(activeNoteEdit && activeNoteEdit.id === null)) {
    const emptyP = document.createElement('p');
    emptyP.className = 'lore-empty';
    emptyP.textContent = '(no private notes for this view)';
    listDiv.appendChild(emptyP);
  }

  items.forEach(function (item) {
    if (activeNoteEdit && activeNoteEdit.id === item.id) {
      listDiv.appendChild(buildNoteEditBox(entity, activeNoteEdit, false));
      return;
    }

    const itemDiv = document.createElement('div');
    itemDiv.className = 'lore-item ' + visibilityStateClass(item);
    itemDiv.dataset.itemId = item.id;

    if (!readOnly) {
      const toggleRow = document.createElement('div');
      toggleRow.className = 'lore-item-toggle-row';
      toggleRow.appendChild(buildNoteToggle({
        getVisibility: function () { return item.visibility; },
        onToggle: function (newVisibility) {
          shareLoreItemVisibility(item.id, { visibility: newVisibility }).catch(function (err) {
            window.alert('Visibility change failed: ' + err.message);
          });
        }
      }));
      itemDiv.appendChild(toggleRow);
    }

    const bodyDiv = document.createElement('div');
    bodyDiv.className = 'lore-item-body';
    renderMarkdownInto(bodyDiv, item.content).then(function () {
      applyWikiLinks(bodyDiv, entity.id, ctx);
    });
    itemDiv.appendChild(bodyDiv);

    if (!readOnly && !activeNoteEdit) {
      const actionsRow = document.createElement('div');
      actionsRow.className = 'lore-item-actions-row';
      const editBtn = document.createElement('button');
      editBtn.className = 'lore-item-btn';
      editBtn.textContent = 'Edit';
      editBtn.addEventListener('click', function () {
        state.noteEdit = { entityId: entity.id, id: item.id, content: item.content, visibility: item.visibility, authorType: item.authorType, authorId: item.authorId || null, baseUpdatedAtMs: updatedAtMs(item), conflictDismissedAtMs: null };
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

    listDiv.appendChild(itemDiv);
  });

  if (activeNoteEdit && activeNoteEdit.id === null) {
    listDiv.appendChild(buildNoteEditBox(entity, activeNoteEdit, true));
  }

  container.appendChild(listDiv);

  if (canAuthor && !activeNoteEdit) {
    const notesTabActions = document.createElement('div');
    notesTabActions.className = 'actions-row';
    const right = document.createElement('div');
    right.className = 'actions-row-right';
    const newNoteBtn = document.createElement('button');
    newNoteBtn.className = 'action-btn-compact';
    newNoteBtn.textContent = '+ New Note';
    newNoteBtn.addEventListener('click', function () {
      state.noteEdit = ctx.gmView
        ? { entityId: entity.id, id: null, content: '', visibility: 'author-only', authorType: 'gm', authorId: null }
        : { entityId: entity.id, id: null, content: '', visibility: 'author-only', authorType: 'character', authorId: ctx.activeCharacterId };
      renderDetailForSelected();
    });
    right.appendChild(newNoteBtn);
    notesTabActions.appendChild(right);
    container.appendChild(notesTabActions);
  }
}

// --- Gallery picker panel: shared by Set portrait and Set map --------------
// Redesigned UX (locked): a small drag-to-move, semi-transparent floating
// panel rather than a full-screen modal, so the actual entry card / gallery
// stays visible and interactive underneath. Both workflows share the same
// "Select image" step: the panel just gives instructions; the user clicks
// a card directly in the (already-visible) Gallery tab below, rather than
// picking from a duplicate thumbnail grid inside the panel.
//   Portrait: picking an image moves to a Stage B with Zoom + H/V fade
//   sliders and live preview/drag-to-reposition directly on the entry
//   card (via portraitPreviewOverride), then Save/Cancel.
//   Map: single-step -- picking an image saves it as the map immediately,
//   no confirmation stage (Gregg's call: map has no adjustments to make,
//   so a second dialog is pointless friction).
// Cancel and Esc close without saving.

// Set while a Stage-A panel is open: { entityId, onPick(img) }. Read by
// renderGalleryTab's image click handler so clicking a gallery card picks
// an image instead of opening the lightbox. Null the rest of the time.
let galleryPickMode = null;

function buildGalleryPickerPanel() {
  const panel = document.createElement('div');
  panel.className = 'gallery-picker-panel';
  const header = document.createElement('div');
  header.className = 'gallery-picker-header';
  panel.appendChild(header);
  const body = document.createElement('div');
  body.className = 'gallery-picker-body';
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

  return { panel: panel, header: header, body: body };
}

function openSetPortraitDialog(entity, images) {
  // Guard against a second panel: no early-return here previously, so
  // a repeat click (or a click landing while a re-render is briefly
  // mid-flight) could append a duplicate panel on top of an already-
  // open one instead of doing nothing.
  if (document.querySelector('.gallery-picker-panel')) return;
  const previousTab = state.detailActiveTab;
  const built = buildGalleryPickerPanel();
  const panel = built.panel;
  const header = built.header;
  const body = built.body;

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
    galleryPickMode = null;
    document.removeEventListener('keydown', onKeydown);
    panel.remove();
    state.detailActiveTab = previousTab;
    renderDetailForSelected(); // restore the card to committed state
  }

  function buildStageA() {
    header.textContent = 'Select image';
    body.innerHTML = '';
    const instructions = document.createElement('p');
    instructions.className = 'image-edit-status';
    instructions.textContent = 'Click an image in the gallery below to use as the portrait.';
    body.appendChild(instructions);
    const actions = document.createElement('div');
    actions.className = 'modal-actions';
    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.textContent = 'Cancel';
    cancelBtn.addEventListener('click', close);
    actions.appendChild(cancelBtn);
    body.appendChild(actions);

    galleryPickMode = { entityId: entity.id, onPick: enterStageB };
    renderDetailForSelected(); // re-render so the gallery cards pick up pick-mode styling/handlers
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
    galleryPickMode = null;
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
// Same docked gallery-picker-panel pattern as Set portrait (see that
// section's comment), but single-step -- unlike portrait (which needs
// a Stage B for zoom/fade adjustments), clicking a gallery image here
// sets it as the map immediately, no confirmation step. "Remove map
// image" lives alongside the instructions, shown whenever a map image
// is already set.
function openSetMapDialog(entity, images) {
  if (document.querySelector('.gallery-picker-panel')) return;
  const previousTab = state.detailActiveTab;
  const built = buildGalleryPickerPanel();
  const panel = built.panel;
  const header = built.header;
  const body = built.body;

  const currentMap = images.find(function (img) { return img.isMap; });

  function onKeydown(ev) { if (ev.key === 'Escape') close(); }
  document.addEventListener('keydown', onKeydown);

  function close() {
    galleryPickMode = null;
    document.removeEventListener('keydown', onKeydown);
    panel.remove();
    state.detailActiveTab = previousTab;
    renderDetailForSelected();
  }

  function pinWarning(actionLabel) {
    const pinCount = state.allPins.filter(function (p) { return p.mapEntityId === entity.id; }).length;
    if (!pinCount) return true;
    return window.confirm(
      'This location already has a map image with ' + pinCount + ' pin' + (pinCount === 1 ? '' : 's') +
      ' on it. ' + actionLabel + ' may leave existing pins misaligned, since pin positions are stored ' +
      'relative to the image. Continue?'
    );
  }

  function onPick(img) {
    if (currentMap && currentMap.id === img.id) { close(); return; }
    if (currentMap && !pinWarning('Replacing the map image')) return;
    galleryPickMode = null;
    setEntityMap(entity.id, img.id).then(close).catch(function (err) {
      window.alert('Set map failed: ' + err.message);
      galleryPickMode = { entityId: entity.id, onPick: onPick };
    });
  }

  header.textContent = 'Select image';
  const instructions = document.createElement('p');
  instructions.className = 'image-edit-status';
  instructions.textContent = 'Click an image in the gallery below to use as the map.';
  body.appendChild(instructions);

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
  body.appendChild(actions);

  galleryPickMode = { entityId: entity.id, onPick: onPick };
  renderDetailForSelected(); // re-render so the gallery cards pick up pick-mode styling/handlers
}

// --- Gallery tab -----------------------------------------------------------
// Unlike Lore items, gallery images have no separate edit-mode UI on the
// Entry Card itself — all image management (visibility, delete, add) lives
// here in the Gallery tab, GM view only.

// images: array of gallery image docs (already visibility-filtered,
// order-sorted -- same array renderGalleryTab iterates to build the
// thumbnails). startIndex: which one to open first. altBase: entity
// name, used as the alt text base for every image in the set.
function openImageLightbox(images, startIndex, altBase) {
  let index = startIndex;
  const overlay = document.createElement('div');
  overlay.className = 'image-lightbox-overlay';
  const img = document.createElement('img');
  overlay.appendChild(img);

  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'image-lightbox-close';
  closeBtn.setAttribute('aria-label', 'Close');
  closeBtn.textContent = '\u2715';
  overlay.appendChild(closeBtn);

  const multi = images.length > 1;
  let prevBtn = null;
  let nextBtn = null;
  if (multi) {
    prevBtn = document.createElement('button');
    prevBtn.type = 'button';
    prevBtn.className = 'image-lightbox-nav image-lightbox-prev';
    prevBtn.setAttribute('aria-label', 'Previous image');
    prevBtn.textContent = '\u2039';
    overlay.appendChild(prevBtn);

    nextBtn = document.createElement('button');
    nextBtn.type = 'button';
    nextBtn.className = 'image-lightbox-nav image-lightbox-next';
    nextBtn.setAttribute('aria-label', 'Next image');
    nextBtn.textContent = '\u203a';
    overlay.appendChild(nextBtn);
  }

  function showIndex(i) {
    index = (i + images.length) % images.length; // wraps both directions
    img.src = images[index].data;
    img.alt = altBase || '';
  }
  function showPrev() { showIndex(index - 1); }
  function showNext() { showIndex(index + 1); }

  function close() {
    overlay.remove();
    document.removeEventListener('keydown', onKey);
  }
  function onKey(ev) {
    if (ev.key === 'Escape') { close(); return; }
    if (!multi) return;
    if (ev.key === 'ArrowLeft') showPrev();
    else if (ev.key === 'ArrowRight') showNext();
  }
  overlay.addEventListener('click', function (ev) { if (ev.target === overlay) close(); });
  closeBtn.addEventListener('click', close);
  if (multi) {
    prevBtn.addEventListener('click', function (ev) { ev.stopPropagation(); showPrev(); });
    nextBtn.addEventListener('click', function (ev) { ev.stopPropagation(); showNext(); });

    // Touch swipe: horizontal drag past a small threshold switches
    // image; a short/near-vertical drag is treated as a tap/scroll
    // attempt and ignored, not a swipe.
    let touchStartX = null;
    let touchStartY = null;
    overlay.addEventListener('touchstart', function (ev) {
      if (ev.touches.length !== 1) return;
      touchStartX = ev.touches[0].clientX;
      touchStartY = ev.touches[0].clientY;
    }, { passive: true });
    overlay.addEventListener('touchend', function (ev) {
      if (touchStartX === null) return;
      const touch = ev.changedTouches[0];
      const dx = touch.clientX - touchStartX;
      const dy = touch.clientY - touchStartY;
      touchStartX = null;
      touchStartY = null;
      if (Math.abs(dx) < 40 || Math.abs(dx) < Math.abs(dy)) return;
      if (dx < 0) showNext(); else showPrev();
    });
  }
  document.addEventListener('keydown', onKey);
  document.body.appendChild(overlay);
  showIndex(index);
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

function persistLoreOrder(entityId, orderedIds) {
  const batch = writeBatch(db);
  orderedIds.forEach(function (id, idx) {
    batch.update(doc(db, 'loreItems', id), { order: idx });
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
  h3.textContent = 'New gallery images';
  box.appendChild(h3);

  const label = document.createElement('label');
  label.textContent = 'Image file(s)';
  box.appendChild(label);

  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/*';
  // Phase 14 S7: multi-select upload -- each file still goes through
  // uploadEntityGalleryImage individually (own addDoc, own compression
  // pass); this modal just sequences the calls. See saveBtn's click
  // handler for why sequential, not Promise.all.
  input.multiple = true;
  box.appendChild(input);

  const statusEl = document.createElement('p');
  statusEl.className = 'image-edit-status';
  box.appendChild(statusEl);

  let selectedFiles = [];
  input.addEventListener('change', function () {
    selectedFiles = Array.prototype.slice.call(input.files || []);
    if (!selectedFiles.length) statusEl.textContent = '';
    else if (selectedFiles.length === 1) statusEl.textContent = selectedFiles[0].name;
    else statusEl.textContent = selectedFiles.length + ' images selected';
  });

  function close() { overlay.remove(); }

  const actions = document.createElement('div');
  actions.className = 'modal-actions';
  const saveBtn = document.createElement('button');
  saveBtn.type = 'button';
  saveBtn.textContent = 'Save';
  saveBtn.addEventListener('click', function () {
    if (!selectedFiles.length) { statusEl.textContent = 'Choose at least one image first.'; return; }
    saveBtn.disabled = true;
    input.disabled = true;
    const total = selectedFiles.length;
    const failures = [];
    // Sequential, not Promise.all -- WebP encoding is CPU-heavy WASM
    // work and this app is primarily used on iPad; running several
    // encodes at once would be rough on it. Sequencing also gives a
    // clean per-file progress line instead of N simultaneous status
    // updates racing each other. A single file's failure doesn't abort
    // the rest of the batch -- collected and summarized at the end so
    // the successful uploads in the batch aren't lost.
    function uploadNext(i) {
      if (i >= total) {
        if (!failures.length) { close(); return; }
        statusEl.textContent = (total - failures.length) + ' of ' + total + ' uploaded. Failed: ' +
          failures.map(function (f) { return f.name + ' (' + f.err + ')'; }).join('; ');
        saveBtn.disabled = false;
        input.disabled = false;
        return;
      }
      const file = selectedFiles[i];
      const prefix = total > 1 ? ('Image ' + (i + 1) + ' of ' + total + ': ') : '';
      uploadEntityGalleryImage(entity.id, file, {
        onStatus: function (text) { statusEl.textContent = prefix + text; }
      }).then(function () {
        uploadNext(i + 1);
      }).catch(function (err) {
        failures.push({ name: file.name, err: err.message });
        uploadNext(i + 1);
      });
    }
    uploadNext(0);
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

function renderGalleryTab(container, entity, ctx, readOnly, imagesOverride) {
  const galleryImages = galleryImagesFor(entity.id, ctx, imagesOverride);
  const currentPortrait = portraitImageFor(entity, ctx, imagesOverride);
  const isLocation = entity.category === 'Location';
  const currentMapImg = isLocation ? galleryImages.find(function (img) { return img.isMap; }) : null;
  const showChrome = hasFullAuthority(entity, ctx) && !readOnly;

  if (showChrome && galleryImages.length) {
    const hintBox = document.createElement('div');
    hintBox.className = 'gallery-hint-box';
    const hint = document.createElement('p');
    hint.className = 'image-edit-status';
    const portraitIconHtml = '<span class="inline-help-icon">' + CONFIG.icons.portrait + '</span>';
    const mapIconHtml = '<span class="inline-help-icon">' + CONFIG.icons.map + '</span>';
    hint.innerHTML = isLocation
      ? 'Drag images to reorder them. The ' + portraitIconHtml + ' portrait-marked image is used for the entry card\u2019s hero header; the ' + mapIconHtml + ' map-marked image is used on the Map tab. An image can be both.'
      : 'Drag images to reorder them. The ' + portraitIconHtml + ' portrait-marked image is used for the entry card\u2019s hero header.';
    hintBox.appendChild(hint);
    container.appendChild(hintBox);
  }

  if (galleryImages.length) {
    const galleryDiv = document.createElement('div');
    galleryDiv.className = 'codex-gallery';
    const picking = !!galleryPickMode && galleryPickMode.entityId === entity.id;
    galleryImages.forEach(function (img, imgIndex) {
      const isCurrentPortrait = !!currentPortrait && img.id === currentPortrait.id;
      const isCurrentMap = !!currentMapImg && img.id === currentMapImg.id;
      const figDiv = document.createElement('div');
      figDiv.className = 'gallery-item ' + visibilityStateClass(img) +
        (picking ? ' gallery-item-pickable' : '');
      figDiv.dataset.imageId = img.id;

      const imgWrap = document.createElement('div');
      imgWrap.className = 'gallery-item-image-wrap';
      const imgEl = document.createElement('img');
      imgEl.src = img.data;
      imgEl.alt = entity.name;
      imgEl.addEventListener('click', function () {
        if (picking && galleryPickMode) { galleryPickMode.onPick(img); return; }
        openImageLightbox(galleryImages, imgIndex, entity.name);
      });
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
      renderSourceLabel(sourceLabelDiv, img.sourceId, entity.sourceId, true);
      figDiv.appendChild(sourceLabelDiv);

      if (showChrome) {
        const toggleBarDiv = document.createElement('div');
        toggleBarDiv.className = 'gallery-item-bar';
        toggleBarDiv.appendChild(buildVisibilityControl({
          getVisibility: function () { return resolveDropOverlay(img).visibility; },
          getCharacterId: function () { return resolveDropOverlay(img).characterId; },
          getCharacterShared: function () { return !!resolveDropOverlay(img).characterShared; },
          sourceId: img.sourceId,
          confirmReveal: confirmRevealWithoutSource,
          onApply: function (patch) {
            shareImageVisibility(img.id, patch).catch(function (err) {
              window.alert('Visibility change failed: ' + err.message);
            });
          }
        }));
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
      } else if (!readOnly && isSharedWithActiveCharacter(img, ctx)) {
        // Phase 14 S3 (§6.2): a gallery image the GM shared with the
        // player's active character -- own characterShared toggle (no
        // kebab, no delete) + a source-only footer. No content/data
        // replace here: no "replace image binary" function exists
        // anywhere in the app yet, GM included (delete+reupload is the
        // only pattern today) -- deferred, flagged in the handoff.
        const toggleBarDiv = document.createElement('div');
        toggleBarDiv.className = 'gallery-item-bar';
        toggleBarDiv.appendChild(buildSharedToggle({
          getShared: function () { return !!img.characterShared; },
          onToggle: function (patch) {
            shareImageVisibility(img.id, patch).catch(function (err) {
              window.alert('Visibility change failed: ' + err.message);
            });
          }
        }));
        figDiv.insertBefore(toggleBarDiv, imgWrap);

        const footerDiv = document.createElement('div');
        footerDiv.className = 'gallery-item-footer';
        const sourceSelect = buildSourceSelect(img.sourceId, function (newSourceId) {
          setGalleryImageSource(img.id, newSourceId)
            .catch(function (err) { window.alert('Source change failed: ' + err.message); });
        });
        footerDiv.appendChild(sourceSelect);
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
    newImageBtn.textContent = '+ New images';
    newImageBtn.addEventListener('click', function () { openGalleryUploadModal(entity); });
    right.appendChild(newImageBtn);
    if (galleryImages.length) {
      if (isLocation) {
        const mapBtn = document.createElement('button');
        mapBtn.type = 'button';
        mapBtn.className = 'action-btn-compact';
        mapBtn.textContent = 'Set map';
        mapBtn.addEventListener('click', function () { openSetMapDialog(entity, galleryImages); });
        right.appendChild(mapBtn);
      }
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

// Shared "Also known as / Date" + "Owned by" meta lines, used by both
// the small map-pin/preview card and the full entity view card -- was
// duplicated inline in both places before; centralized here so the
// date-formatting treatment (spacing + bold "a") only needs applying
// once. "Owned by" renders as its OWN line below Also-known-as/Date
// (not joined onto the same line with " · ") -- distinct enough
// information (GM-only account/assignment context vs. narrative alias/
// date) that it reads better on its own row. Returns a wrapping <div>
// containing 1-2 line divs (caller appends it), or null if there's
// nothing to show at all.
function buildEntityMetaLine(entity, ctx) {
  const bits = [];
  if (entity.aliases && entity.aliases.length) bits.push({ kind: 'text', text: 'Also known as: ' + entity.aliases.join(', ') });
  if (entity.date) bits.push({ kind: 'date', label: 'Date: ', date: entity.date, dateEnd: entity.dateEnd || null });
  const showOwner = entity.ownerId && ctx.gmView;
  if (!bits.length && !showOwner) return null;

  const wrap = document.createElement('div');

  if (bits.length) {
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
    wrap.appendChild(metaDiv);
  }

  if (showOwner) {
    const ownerDiv = document.createElement('div');
    ownerDiv.className = 'entity-meta-line';
    ownerDiv.textContent = 'Owned by: ' + entity.ownerId;
    wrap.appendChild(ownerDiv);
  }

  return wrap;
}

function buildEntityPreviewCard(entity, ctx) {
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
  if (characterAncestryDisplayName(entity)) {
    catP.appendChild(document.createTextNode(' \u2014 '));
    const ancestrySpan = document.createElement('span');
    ancestrySpan.textContent = characterAncestryDisplayName(entity);
    catP.appendChild(ancestrySpan);
    applyWikiLinks(ancestrySpan, entity.id, ctx);
  }
  if (entity.subtype) {
    catP.appendChild(document.createTextNode(' \u2014 ' + entity.subtype));
  }
  card.appendChild(catP);

  const metaLine = buildEntityMetaLine(entity, ctx);
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

  const items = loreItemsForEntity(entity.id, ctx);
  if (items.length) {
    const first = items[0];
    const itemDiv = document.createElement('div');
    itemDiv.className = 'lore-item ' + visibilityStateClass(first);
    const bodyDiv = document.createElement('div');
    bodyDiv.className = 'lore-item-body';
    renderMarkdownInto(bodyDiv, first.content).then(function () {
      applyWikiLinks(bodyDiv, entity.id, ctx);
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
  const ctx = viewerContext();

  setEntityImagesTarget(entity ? entity.id : null);

  if (!entity || !canSee(entity, ctx)) {
    detailPaneEl.classList.add('empty');
    detailEl.classList.remove('vis-hidden', 'vis-visible', 'vis-character');
    detailEl.innerHTML = '<p class="codex-empty">What would you like to read? Make a selection from your Table of Contents.</p>';
    return;
  }
  detailPaneEl.classList.remove('empty');

  detailEl.classList.remove('vis-hidden', 'vis-visible', 'vis-character');
  detailEl.classList.add(visibilityStateClass(entity));

  const editing = hasFullAuthority(entity, ctx) && state.detailEditMode && state.detailEditDraft;
  const draft = editing ? state.detailEditDraft : null;

  detailEl.innerHTML = '';

  if (!editing) {
    renderEntityViewCard(detailEl, entity, ctx, {
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
  //
  // S9 had character-cards.js writing straight to Firestore on every
  // field change, independent of this form's own Save/Cancel, which
  // required a workaround here to stop those self-writes from tripping
  // this same banner. S10 moved cards editing onto this form's own
  // draft (see character-cards.js header) -- cards changes no longer
  // write anything until Save, so that workaround is gone; this is
  // back to only ever firing on a genuine external edit.
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
  // Phase 14 S3 (§6.2): category is NOT player-editable, even on an owned
  // Character -- omit the select entirely for a non-GM editor (rules
  // enforce this too: entities update path 2 rejects any diff touching
  // 'category'). Static label instead, so the field isn't just silently
  // missing with no explanation.
  if (ctx.gmView) {
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
  } else {
    const catStatic = document.createElement('p');
    catStatic.className = 'entity-type-line';
    const catStaticEm = document.createElement('em');
    catStaticEm.textContent = draft.category;
    catStatic.appendChild(catStaticEm);
    leftCol.appendChild(catStatic);
  }

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
    leftCol.appendChild(makeEditField('Aliases (comma-separated)', draft.aliases, function (v) { draft.aliases = v; }));

    // Phase 14 S8: Player <-> Character assignment moved to the
    // Characters tab's "Players & Characters" panel (GM-only assign/
    // unassign UI there) -- no longer editable from this card, GM or
    // player. draft.ownerId still round-trips through buildEntityDraft/
    // saveEntityEdit unchanged (whatever the entity already has), just
    // nothing on this form writes to it anymore.
    if (ctx.gmView) {
      const ownerHint = document.createElement('p');
      ownerHint.className = 'admin-hint';
      ownerHint.textContent = draft.ownerId
        ? ('Owned by: ' + draft.ownerId + ' -- reassign on the Characters tab.')
        : 'Unowned -- assign a party member on the Characters tab.';
      leftCol.appendChild(ownerHint);
    }
  }
  if (draft.category === 'Ancestry') {
    // Phase 14 S7 (§11.2): 0-2 target Ancestry entities this one
    // functionally resolves to (flavor-only "meta" ancestry, e.g. a
    // homebrew "Goat" that mechanically plays as Faun). Chaining is
    // disallowed by excluding already-meta ancestries (ones that
    // themselves have metaAncestryTargetIds set) from this picker's
    // options -- keeps resolution a single lookup, never a walk.
    const metaWrap = document.createElement('div');
    metaWrap.className = 'entity-edit-field';
    const metaLabel = document.createElement('label');
    metaLabel.textContent = 'Functional ancestry (optional -- for flavor-only "meta" ancestries)';
    metaWrap.appendChild(metaLabel);
    const metaTargets = draft.metaAncestryTargetIds || [];
    const metaList = document.createElement('ul');
    metaList.className = 'related-edit-list';
    metaTargets.forEach(function (id) {
      const target = state.allEntities.find(function (e) { return e.id === id; });
      const li = document.createElement('li');
      const span = document.createElement('span');
      span.textContent = target ? target.name : '(deleted ancestry)';
      const removeBtn = document.createElement('button');
      removeBtn.type = 'button';
      removeBtn.textContent = 'Remove';
      removeBtn.addEventListener('click', function () {
        draft.metaAncestryTargetIds = metaTargets.filter(function (x) { return x !== id; });
        renderDetailForSelected();
      });
      li.appendChild(span);
      li.appendChild(removeBtn);
      metaList.appendChild(li);
    });
    metaWrap.appendChild(metaList);
    const metaAddRow = document.createElement('div');
    metaAddRow.className = 'related-edit-add';
    const metaSelect = document.createElement('select');
    const metaAvailable = state.allEntities.filter(function (e) {
      return e.category === 'Ancestry' && e.id !== entity.id
        && metaTargets.indexOf(e.id) === -1 && metaTargets.length < 2
        && !(e.metaAncestryTargetIds && e.metaAncestryTargetIds.length);
    });
    if (!metaAvailable.length) {
      const opt = document.createElement('option');
      opt.textContent = metaTargets.length >= 2 ? '(maximum 2)' : '(no eligible ancestries)';
      opt.disabled = true;
      metaSelect.appendChild(opt);
    } else {
      const placeholder = document.createElement('option');
      placeholder.value = '';
      placeholder.textContent = '-- choose --';
      metaSelect.appendChild(placeholder);
      metaAvailable.sort(function (a, b) { return a.name.localeCompare(b.name); }).forEach(function (e) {
        const opt = document.createElement('option');
        opt.value = e.id;
        opt.textContent = e.name;
        metaSelect.appendChild(opt);
      });
    }
    const metaAddBtn = document.createElement('button');
    metaAddBtn.type = 'button';
    metaAddBtn.textContent = 'Add';
    metaAddBtn.addEventListener('click', function () {
      if (!metaSelect.value || metaTargets.length >= 2) return;
      draft.metaAncestryTargetIds = metaTargets.concat([metaSelect.value]);
      renderDetailForSelected();
    });
    metaAddRow.appendChild(metaSelect);
    metaAddRow.appendChild(metaAddBtn);
    metaWrap.appendChild(metaAddRow);
    leftCol.appendChild(metaWrap);
  }
  if (draft.category === 'Scene' || draft.category === 'Event') {
    leftCol.appendChild(makeEditField('Date', draft.date, function (v) { draft.date = v; }, { placeholder: 'e.g. 12d, 45y   or   3500ya' }));
    leftCol.appendChild(makeEditField('End date (optional, for a span)', draft.dateEnd, function (v) { draft.dateEnd = v; }, { placeholder: 'leave blank for a single point in time' }));
  }
  headingRow.appendChild(leftCol);

  const rightCol = document.createElement('div');
  rightCol.className = 'codex-card-heading-right';
  rightCol.appendChild(buildEntityVisibilityToggle(entity)); // editing implies hasFullAuthority (GM, or owns this Character -- §6.2 gives full kebab rights on an owned Character)
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

  // Character "cards" (ancestry/community/class/subclass/abilities,
  // badge color) -- Phase 14 S10: this is now the ONLY place cards are
  // viewed or edited at all (Characters tab's own viewer/editor were
  // removed -- see character-cards.js header). Edits mutate `draft`
  // directly (draft.cards/draft.badgeColor), same as every other field
  // below -- Save/Cancel govern these too now, not just name/tags/etc.
  if (draft.category === 'Character') {
    const cardsWrap = document.createElement('div');
    cardsWrap.className = 'codex-character-cards';
    cardsWrap.appendChild(buildCharacterCardEditor(entity, draft, ctx, renderDetailForSelected));
    contentWrap.appendChild(cardsWrap);
  }

  const editBlock = document.createElement('div');
  editBlock.className = 'entity-edit-block';
  renderEntityEditBlock(editBlock, entity, draft, ctx);
  contentWrap.appendChild(editBlock);
}

// Shared read-only entity card renderer -- hero, heading, meta/tags,
// Lore/Gallery/Notes tabs, related chips, source label. Used by the Codex
// tab's own view-mode display (opts.allowEdit:true unlocks the visibility
// toggle and GM Edit/Delete actions row) AND by read-only side panels
// (Timeline's entry-card panel now; Map's planned back-port later) with
// opts.allowEdit:false -- same rendering, no GM controls or clutter,
// regardless of the viewer's actual role. Content visibility (which lore
// items/gallery images are included) still follows the real ctx passed
// in; only editing/toggle CHROME is gated by allowEdit. Structural element
// ids from the pre-refactor single-instance version are now classes,
// since this can render into more than one container in the DOM at once
// (Codex tab + Timeline panel simultaneously) -- ids must stay
// document-unique, same reasoning as buildEntityPreviewCard's existing
// class-not-id comment.
function renderEntityViewCard(container, entity, ctx, opts) {
  opts = opts || {};
  const allowEdit = !!opts.allowEdit;

  container.classList.remove('vis-hidden', 'vis-visible', 'vis-character');
  container.classList.add(visibilityStateClass(entity));

  // Absolutely-positioned overlay in the card's top-left corner (e.g.
  // Map's Well-C close button) -- separate from the heading row's own
  // right-side controls, since this needs to sit at the card's own
  // corner regardless of hero-band/heading layout. .codex-entity-card
  // is already position:relative (hero-band background layer), so no
  // extra positioning context needed here.
  if (opts.topLeftExtra) {
    container.appendChild(opts.topLeftExtra);
  }

  const portrait = portraitImageFor(entity, ctx, opts.images);
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
  if (characterAncestryDisplayName(entity)) {
    catP.appendChild(document.createTextNode(' \u2014 '));
    const ancestrySpan = document.createElement('span');
    ancestrySpan.textContent = characterAncestryDisplayName(entity);
    catP.appendChild(ancestrySpan);
    applyWikiLinks(ancestrySpan, entity.id, ctx);
  }
  if (entity.subtype) {
    catP.appendChild(document.createTextNode(' \u2014 ' + entity.subtype));
  }
  leftCol.appendChild(catP);

  const metaLine = buildEntityMetaLine(entity, ctx);
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
  if (allowEdit && hasFullAuthority(entity, ctx)) {
    // GM, or a player editing their own owned Character: the full
    // GM-equivalent 3-state kebab control (§6.2 -- "the same GM edit
    // affordances render for players on owned-character entries";
    // rules give full CRUD, including visibility/characterId/
    // characterShared, on an owned Character entity).
    rightCol.appendChild(buildEntityVisibilityToggle(entity));
  } else if (allowEdit && isSharedWithActiveCharacter(entity, ctx)) {
    // Entity itself shared to this player's active character (a GM-
    // owned entity, e.g. an NPC, deliberately shown to one PC): the
    // rules only allow a characterShared flip here, no content edit
    // (phase-14-design.md §7's entities row is deliberately narrower
    // than loreItems/images) -- so this gets ONLY the onward-share
    // toggle, not the full kebab.
    rightCol.appendChild(buildSharedToggle({
      getShared: function () { return !!entity.characterShared; },
      onToggle: function (patch) {
        shareEntityVisibility(entity.id, patch).catch(function (err) {
          window.alert('Visibility change failed: ' + err.message);
        });
      }
    }));
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
  if (opts.onOpenInCodex) {
    const codexLink = document.createElement('button');
    codexLink.type = 'button';
    codexLink.className = 'entity-map-link';
    codexLink.title = 'Open in Codex';
    codexLink.innerHTML = CONFIG.icons.codex;
    codexLink.addEventListener('click', function () { opts.onOpenInCodex(); });
    rightCol.appendChild(codexLink);
  }
  if (resolveMapIconTarget(entity, ctx)) {
    const mapLink = document.createElement('button');
    mapLink.type = 'button';
    mapLink.className = 'entity-map-link';
    mapLink.title = 'Open map';
    mapLink.innerHTML = CONFIG.icons.map;
    mapLink.addEventListener('click', function () {
      const targetId = resolveMapIconTarget(entity, ctx);
      if (mapNavigationHandler && targetId) mapNavigationHandler(targetId);
    });
    rightCol.appendChild(mapLink);
  }
  headingRow.appendChild(rightCol);
  contentWrap.appendChild(headingRow);

  const tabsRow = document.createElement('div');
  tabsRow.className = 'codex-detail-tabs';
  const activeTab = opts.hideSubTabs ? 'lore' : (opts.activeTab || 'lore');
  if (!opts.hideSubTabs) {
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
  }

  const tabPanel = document.createElement('div');
  tabPanel.className = 'codex-detail-tab-panel';
  contentWrap.appendChild(tabPanel);

  if (activeTab === 'notes') {
    renderNotesTab(tabPanel, entity, ctx, !allowEdit);
  } else if (activeTab === 'gallery') {
    renderGalleryTab(tabPanel, entity, ctx, !allowEdit, opts.images);
  } else {
    renderLoreTab(tabPanel, entity, ctx, !allowEdit);
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
        .filter(function (target) { return target && canSee(target, ctx); });

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

  // --- Edit/Delete actions (lower-right), then source attribution
  // (lower-left) on its own row below them. Only in allowEdit mode --
  // read-only panels never show these regardless of authority. Phase 14
  // S3: gated on hasFullAuthority (GM OR owns this Character), not bare
  // ctx.gmView -- D4, "players can delete characters they own". A
  // shared-with-active-character entity (isSharedWithActiveCharacter)
  // gets NEITHER button, only the characterShared toggle above -- the
  // rules only allow that one field for that case (§7).
  if (allowEdit && hasFullAuthority(entity, ctx)) {
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
  // Phase 17 A2: search and Show secrets mode are mutually exclusive —
  // typing a query exits secrets mode rather than intersecting with it.
  if (searchEl.value.trim().length > 0) state.secretsFilterActive = false;
  updateSearchClearBtnVisibility();
  renderList();
});

searchEl.addEventListener('keydown', function (ev) {
  if (ev.key !== 'Enter') return;
  ev.preventDefault();
  const ctx = viewerContext();
  const filtered = state.allEntities
    .filter(matchesFilters)
    .filter(function (e) { return canSee(e, ctx); })
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
  fitCodexTabHeight, footerReserve, switchToCodexTabForEntity, notifyVisibilityChange,
  openNewEntityDialog, resolveEntityStatBlockMarkdown, buildDropChangeLine,
  DROP_TYPES, dropTypeLabel
};
