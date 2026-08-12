import {
  getFirestore, collection, onSnapshot, doc, setDoc, addDoc, updateDoc, deleteDoc,
  query, where, writeBatch, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import { firebaseApp, CONFIG } from './firebase.js';
import { state } from './state.js';
import { attachListener, detachListener, safeSnapshotHandler } from './listeners.js';
import { renderMarkdownInto } from './markdown.js';
import { renderAdminRootEntitySelect, renderAdminPlayersList } from './admin.js';
import {
  uploadEntityMapImage, deleteEntityMapImage,
  uploadEntityGalleryImage, deleteEntityGalleryImage, setGalleryImageVisibility, setEntityPortrait
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
const PORTRAIT_MIN_OVERLAP_FRAC = 0.28; // mid-point of mockup's tunable 22-35% range
// Aspect ratio of the card's hero band. The crop math (offsets stored as
// fractions of the scaled image) reproduces the same framing regardless
// of container size, but the band itself needs a fixed aspect so it
// doesn't reflow oddly at different card widths.
const PORTRAIT_PREVIEW_ASPECT = '2.2 / 1';

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

function portraitCoverScale(cw, ch, iw, ih) {
  return Math.max(cw / iw, ch / ih);
}

function portraitCurrentScale(img, cw, ch) {
  const base = portraitCoverScale(cw, ch, img.width, img.height);
  const step = typeof img.portraitZoomStep === 'number' ? img.portraitZoomStep : 0;
  return base * (1 + step * PORTRAIT_ZOOM_STEP_FACTOR);
}

// ox/oy here are the *scaled* px offsets being tested (not yet clamped or
// converted to/from the stored fractions).
function portraitClampOffset(img, cw, ch, ox, oy) {
  const scale = portraitCurrentScale(img, cw, ch);
  const scaledW = img.width * scale, scaledH = img.height * scale;
  const minOverlapX = cw * PORTRAIT_MIN_OVERLAP_FRAC;
  const minOverlapY = ch * PORTRAIT_MIN_OVERLAP_FRAC;
  const minX = Math.min(0, cw - scaledW) - (cw - minOverlapX);
  const maxX = 0 + (cw - minOverlapX);
  const minY = Math.min(0, ch - scaledH) - (ch - minOverlapY);
  const maxY = 0 + (ch - minOverlapY);
  return { x: Math.max(minX, Math.min(maxX, ox)), y: Math.max(minY, Math.min(maxY, oy)) };
}

// Stored offsets are fractions of the *scaled* image size at the current
// zoom step, so the crop reproduces the same relative framing regardless
// of the rendering container's actual pixel size (card vs. dialog
// preview, different screen widths, etc).
function portraitOffsetFracToPx(img, cw, ch) {
  const scale = portraitCurrentScale(img, cw, ch);
  const scaledW = img.width * scale, scaledH = img.height * scale;
  const fx = typeof img.portraitOffsetXFrac === 'number' ? img.portraitOffsetXFrac : 0;
  const fy = typeof img.portraitOffsetYFrac === 'number' ? img.portraitOffsetYFrac : 0;
  return portraitClampOffset(img, cw, ch, fx * scaledW, fy * scaledH);
}

function portraitOffsetPxToFrac(img, cw, ch, px, py) {
  const scale = portraitCurrentScale(img, cw, ch);
  const scaledW = img.width * scale, scaledH = img.height * scale;
  return { xFrac: scaledW ? px / scaledW : 0, yFrac: scaledH ? py / scaledH : 0 };
}

// Two independently-masked nested wrappers — NOT a corner-anchored
// ellipse, and NOT two gradients combined via mask-composite on one
// element. Both of those were wrong for a different reason each:
//
// - The ellipse (previous attempt) put both H and V into a single
//   radial distance from one corner — but a point sitting ON the
//   bottom edge has zero vertical offset from that corner, so V never
//   affects the bottom edge at all, no matter its value. That's
//   exactly the reported "V does nothing" bug — confirmed by
//   inspecting the actual computed mask-image: rx/ry were exactly the
//   values intended, so the gradient was applying correctly; the
//   *shape* was wrong for what independent H/V edge control needs.
// - mask-composite: intersect (an even earlier attempt, before this
//   session) combined two gradients on the SAME element — the
//   handoff notes for this project explicitly flagged
//   mask-composite's iOS Safari support as unverified, and iOS Safari
//   is the primary target here, so that's the likely cause of the
//   original L-shaped/stepped-corner complaint that started all of
//   this.
//
// This avoids both: hWrap gets ONE single mask-image (a plain
// horizontal gradient, fades the left edge only, per the originally
// locked spec), containing vWrap with its OWN single mask-image (a
// plain vertical gradient, fades the bottom edge only). CSS masks on
// nested elements multiply naturally — no composite property
// involved anywhere, so no cross-browser risk. H and V now can't
// possibly interfere with each other: each is a single independent
// gradient on its own element.
function portraitApplyEdgeFade(hWrapEl, vWrapEl, img) {
  const hPct = typeof img.portraitFadeH === 'number' ? img.portraitFadeH : 12;
  const vPct = typeof img.portraitFadeV === 'number' ? img.portraitFadeV : 12;
  const hEndPct = Math.max(1, (hPct / 45) * 100);
  const vEndPct = Math.max(1, (vPct / 45) * 100);
  const hGrad = 'linear-gradient(to right, transparent 0%, black ' + hEndPct + '%)';
  const vGrad = 'linear-gradient(to top, transparent 0%, black ' + vEndPct + '%)';
  hWrapEl.style.webkitMaskImage = hGrad;
  hWrapEl.style.maskImage = hGrad;
  vWrapEl.style.webkitMaskImage = vGrad;
  vWrapEl.style.maskImage = vGrad;
}

// Renders img (a portrait-flagged image doc, using its saved crop state)
// into imgEl, sized to containerEl's current dimensions, with the edge
// fade applied to hWrapEl/vWrapEl (see portraitApplyEdgeFade).
function portraitRenderInto(imgEl, hWrapEl, vWrapEl, containerEl, img) {
  const cw = containerEl.clientWidth, ch = containerEl.clientHeight;
  if (!img.width || !img.height || !cw || !ch) return;
  const scale = portraitCurrentScale(img, cw, ch);
  const clamped = portraitOffsetFracToPx(img, cw, ch);
  imgEl.style.width = (img.width * scale) + 'px';
  imgEl.style.height = (img.height * scale) + 'px';
  imgEl.style.transform = 'translate(' + clamped.x + 'px, ' + clamped.y + 'px)';
  portraitApplyEdgeFade(hWrapEl, vWrapEl, img);
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
  requestAnimationFrame(function () { portraitRenderInto(imgEl, hWrap, vWrap, heroWrap, portrait); });
  return heroWrap;
}
window.addEventListener('resize', function () {
  if (cardHeroState && cardHeroState.containerEl.isConnected) {
    portraitRenderInto(cardHeroState.imgEl, cardHeroState.hWrapEl, cardHeroState.vWrapEl, cardHeroState.containerEl, cardHeroState.portrait);
  }
});

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

function loreItemVisibleToPlayer(item) {
  if (item.visibility === 'all-players') return true;
  return item.visibility === 'author-only'
    && state.currentUser && item.authorId === state.currentUser.uid;
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

// TOC group headers show the category as a group label ("Characters (41)")
// so plural reads more naturally than the singular per-entity type name
// used everywhere else (entity type line, category dropdown, etc).
// Already-plural compound categories (ending in 's') pass through unchanged.
const CATEGORY_GROUP_LABELS = {
  'Character': 'Characters', 'Faction': 'Factions', 'Location': 'Locations',
  'Item': 'Items', 'World Facts': 'World Facts', 'Organization': 'Organizations',
  'Event': 'Events', 'Scene': 'Scenes', 'Ancestry': 'Ancestries', 'Game Mechanics': 'Game Mechanics'
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
    entities.forEach(function (entity) {
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
      ul.appendChild(li);
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
    aliases: (entity.aliases || []).join(', '),
    date: entity.date || '',
    parentId: entity.parentId || '',
    tags: (entity.tags || []).join(', '),
    relatedIds: (entity.relatedIds || []).slice(),
    ownerId: entity.ownerId || ''
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
  const entityData = {
    slug: slugify(name),
    name: name,
    category: cat,
    ancestry: (cat === 'Character' && draft.ancestry.trim()) ? draft.ancestry.trim() : null,
    aliases: (cat === 'Character') ? aliases : [],
    date: ((cat === 'Scene' || cat === 'Event') && draft.date.trim()) ? draft.date.trim() : null,
    ownerId: (cat === 'Character' && draft.ownerId) ? draft.ownerId : null,
    parentId: draft.parentId || null,
    relatedIds: draft.relatedIds.slice(),
    tags: tags,
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
      if (!window.confirm('Delete this location\u2019s map image? Pins on its map will be unreachable until a new image is set.')) return;
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
  container.appendChild(buildRelatedEditor(entity.id, draft));
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
    parentId: null,
    relatedIds: [],
    visibility: 'gm-only',
    hasMapImage: false,
    tags: [],
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
        authorId: state.currentUser ? state.currentUser.uid : null,
        authorType: 'gm',
        visibility: editState.visibility,
        content: c,
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
    editState.visibility = switchInput.checked ? 'all-players' : 'gm-only';
    updateToggleLabel();
  });
  const switchSlider = document.createElement('span');
  switchSlider.className = 'toggle-slider';
  switchLabel.appendChild(switchInput);
  switchLabel.appendChild(switchSlider);
  toggleRow.appendChild(switchLabel);
  box.appendChild(toggleRow);

  const textarea = document.createElement('textarea');
  textarea.className = 'lore-edit-textarea';
  textarea.value = editState.content;
  textarea.addEventListener('input', function () { editState.content = textarea.value; });
  box.appendChild(textarea);

  const bottomRow = document.createElement('div');
  bottomRow.className = 'actions-row';
  const left = document.createElement('div');
  left.className = 'actions-row-left';
  const hint = document.createElement('span');
  hint.className = 'lore-edit-hint';
  hint.textContent = 'Use an unordered Markdown list to add multiple items';
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

// Lore tab content. Player view: a plain bulleted list (no per-item
// controls). GM view: each item is a small card — a reveal/hide toggle
// switch top-right (live, one-tap), Edit/Delete bottom-right; Edit swaps
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
    const well = document.createElement('div');
    well.className = 'lore-bullet-well';
    const ul = document.createElement('ul');
    ul.className = 'lore-bullet-list';
    items.forEach(function (item) {
      const li = document.createElement('li');
      renderMarkdownInto(li, item.content).then(function () {
        applyWikiLinks(li, entity.id, gmView);
      });
      ul.appendChild(li);
    });
    well.appendChild(ul);
    container.appendChild(well);
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
    const toggleLabel = document.createElement('span');
    const itemVisible = item.visibility === 'all-players';
    toggleLabel.className = 'toggle-switch-label ' + (itemVisible ? 'state-visible' : 'state-hidden');
    toggleLabel.textContent = itemVisible ? 'Visible to party' : 'Hidden from party';
    toggleRow.appendChild(toggleLabel);
    const switchLabel = document.createElement('label');
    switchLabel.className = 'toggle-switch';
    const switchInput = document.createElement('input');
    switchInput.type = 'checkbox';
    switchInput.checked = item.visibility === 'all-players';
    switchInput.addEventListener('change', function () {
      updateDoc(doc(db, 'loreItems', item.id), {
        visibility: switchInput.checked ? 'all-players' : 'gm-only',
        updatedAt: serverTimestamp()
      }).catch(function (err) { window.alert('Visibility change failed: ' + err.message); });
    });
    const switchSlider = document.createElement('span');
    switchSlider.className = 'toggle-slider';
    switchLabel.appendChild(switchInput);
    switchLabel.appendChild(switchSlider);
    toggleRow.appendChild(switchLabel);
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
        state.loreEdit = { entityId: entity.id, id: item.id, content: item.content, visibility: item.visibility };
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
    newLoreBtn.textContent = '+ New lore';
    newLoreBtn.addEventListener('click', function () {
      state.loreEdit = { entityId: entity.id, id: null, content: '', visibility: 'gm-only' };
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

  let debugEl = null;
  function renderCardPreview() {
    if (cardHeroState) portraitRenderInto(cardHeroState.imgEl, cardHeroState.hWrapEl, cardHeroState.vWrapEl, cardHeroState.containerEl, workingImg);
    if (debugEl && cardHeroState) {
      const hCs = window.getComputedStyle(cardHeroState.hWrapEl);
      const vCs = window.getComputedStyle(cardHeroState.vWrapEl);
      const hApplied = hCs.maskImage && hCs.maskImage !== 'none' ? hCs.maskImage : (hCs.webkitMaskImage || 'none');
      const vApplied = vCs.maskImage && vCs.maskImage !== 'none' ? vCs.maskImage : (vCs.webkitMaskImage || 'none');
      const cw = cardHeroState.containerEl.clientWidth, ch = cardHeroState.containerEl.clientHeight;
      const imgEl = cardHeroState.imgEl;
      const iw = parseFloat(imgEl.style.width), ih = parseFloat(imgEl.style.height);
      const m = /translate\(([-\d.]+)px,\s*([-\d.]+)px\)/.exec(imgEl.style.transform) || [];
      const tx = parseFloat(m[1]) || 0, ty = parseFloat(m[2]) || 0;
      // Does the image's actual rendered+positioned box cover the
      // container on each edge? If not, the "hard line" could be the
      // image's own real edge (raw card background showing through,
      // by design — the drag clamp allows under-coverage), not a mask
      // problem at all.
      const coverTop = ty <= 0, coverLeft = tx <= 0;
      const coverRight = tx + iw >= cw, coverBottom = ty + ih >= ch;
      debugEl.textContent = 'container: ' + cw + 'x' + ch + 'px\n'
        + 'image box: ' + Math.round(iw) + 'x' + Math.round(ih) + 'px at (' + Math.round(tx) + ',' + Math.round(ty) + ')\n'
        + 'covers top:' + coverTop + ' bottom:' + coverBottom + ' left:' + coverLeft + ' right:' + coverRight + '\n'
        + 'H:' + workingImg.portraitFadeH + '% V:' + workingImg.portraitFadeV + '%\n'
        + 'H mask:\n' + hApplied + '\n'
        + 'V mask:\n' + vApplied;
    }
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
      workingImg.portraitZoomStep = Math.max(0, Math.min(PORTRAIT_MAX_ZOOM_STEPS, step));
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
      labelText: 'Zoom', min: 0, max: PORTRAIT_MAX_ZOOM_STEPS, step: 1,
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

    // TEMP debug aid (iOS Safari has no devtools to check this directly)
    // — reports the browser's actual computed mask-image on the fade
    // wrapper, live as sliders/drag move. Remove once the fade math is
    // confirmed working. 'none' here means the gradient string was
    // rejected outright (syntax issue); the actual gradient string
    // means it's parsing fine and any remaining problem is geometry.
    debugEl = document.createElement('pre');
    debugEl.className = 'portrait-debug-readout';
    body.appendChild(debugEl);

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
          setGalleryImageVisibility(img.id, switchInput.checked ? 'all-players' : 'gm-only')
            .catch(function (err) { window.alert('Visibility change failed: ' + err.message); });
        });
        const switchSlider = document.createElement('span');
        switchSlider.className = 'toggle-slider';
        switchLabel.appendChild(switchInput);
        switchLabel.appendChild(switchSlider);
        barDiv.appendChild(switchLabel);

        const delBtn = document.createElement('button');
        delBtn.type = 'button';
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
    newImageBtn.textContent = '+ New image';
    newImageBtn.addEventListener('click', function () { openGalleryUploadModal(entity); });
    right.appendChild(newImageBtn);
    if (galleryImages.length) {
      const portraitBtn = document.createElement('button');
      portraitBtn.type = 'button';
      portraitBtn.textContent = 'Set portrait';
      portraitBtn.addEventListener('click', function () { openSetPortraitDialog(entity, galleryImages); });
      right.appendChild(portraitBtn);
    }
    actions.appendChild(right);
    container.appendChild(actions);
  }
}

// --- My Knowledge (detail pane) -------------------------------------------

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

  // Gallery hero header — view mode only (skipped while editing, to avoid
  // any layering/interaction conflict with the edit fields). Confined to
  // a fixed-aspect band (PORTRAIT_PREVIEW_ASPECT, shared with the dialog
  // preview) behind the heading only — NOT the whole card. The crop math
  // (offsets as fractions of the scaled image) only reproduces the same
  // framing when the render container's aspect ratio matches what was
  // shown while cropping; stretching the hero across the full card
  // (heading + tabs + gallery + everything below, which can be several
  // times taller than the dialog's compact preview) was the bug that
  // made zoom/position look "way off" between the dialog and the real
  // card — fixed by giving both the same aspect ratio instead.
  const portrait = !editing ? portraitImageFor(entity, gmView) : null;
  detailEl.classList.toggle('has-hero', !!portrait);
  let headingTarget;
  if (portrait) {
    const band = document.createElement('div');
    band.className = 'codex-card-hero-band';
    band.style.aspectRatio = PORTRAIT_PREVIEW_ASPECT;
    band.appendChild(buildCardHero(entity, portrait));
    const headingInner = document.createElement('div');
    headingInner.className = 'codex-card-heading-inner';
    band.appendChild(headingInner);
    detailEl.appendChild(band);
    headingTarget = headingInner;
  } else {
    cardHeroState = null;
  }
  const contentWrap = document.createElement('div');
  contentWrap.className = 'codex-card-content';
  detailEl.appendChild(contentWrap);
  if (!headingTarget) headingTarget = contentWrap;

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
      leftCol.appendChild(makeEditField('Date', draft.date, function (v) { draft.date = v; }, { placeholder: 'e.g. Day 2, 3500 ya' }));
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
      catP.appendChild(document.createTextNode(' \u2014 ' + entity.ancestry));
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

    if (entity.tags && entity.tags.length) {
      const tagsDiv = document.createElement('div');
      tagsDiv.id = 'codex-tags';
      entity.tags.forEach(function (t) {
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
  // Player view only links to targets that are themselves player-visible;
  // dangling IDs (deleted target) silently skipped.
  const relatedIds = entity.relatedIds || [];
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

  // --- Entity-level GM actions: bottom-right of the Entry Card ---
  if (gmView) {
    const cardActions = document.createElement('div');
    cardActions.className = 'actions-row codex-card-bottom-actions';
    const right = document.createElement('div');
    right.className = 'actions-row-right';
    const editBtn = document.createElement('button');
    editBtn.textContent = 'Edit';
    editBtn.addEventListener('click', function () { enterEntityEditMode(entity); });
    right.appendChild(editBtn);
    const deleteBtn = document.createElement('button');
    deleteBtn.textContent = 'Delete';
    deleteBtn.addEventListener('click', function () { deleteEntity(entity); });
    right.appendChild(deleteBtn);
    cardActions.appendChild(right);
    contentWrap.appendChild(cardActions);
  }
}

searchEl.addEventListener('input', renderList);

export {
  attachCodexListeners, detachCodexListeners, renderList, renderDetailForSelected,
  isEntityPlayerVisible, registerVisibilityChangeHandler, registerMapNavigationHandler,
  clearCodexSearchInput
};
