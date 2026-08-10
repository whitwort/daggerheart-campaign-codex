import {
  getFirestore, collection, onSnapshot, doc, addDoc, updateDoc, deleteDoc
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import { firebaseApp, CONFIG } from './firebase.js';
import { state } from './state.js';
import {
  renderList, renderDetailForSelected, isEntityPlayerVisible,
  registerVisibilityChangeHandler, registerMapNavigationHandler
} from './codex.js';
import { renderAdminRootEntitySelect } from './admin.js';
import { entityMapImageDocId, getCachedImage, putCachedImage } from './images.js';
import { attachListener, detachListener, safeSnapshotHandler } from './listeners.js';

const db = getFirestore(firebaseApp);

// Image size/cache constants live in images.js (their sole consumer)
// since the module split — see that file.

const mapGmControlsEl = document.getElementById('map-gm-controls');
const newPinBtn = document.getElementById('map-new-pin-btn');
const editPinBtn = document.getElementById('map-edit-pin-btn');
const removePinBtn = document.getElementById('map-remove-pin-btn');
const modeHintEl = document.getElementById('map-mode-hint');
const breadcrumbEl = document.getElementById('map-breadcrumb');

// A pin always links to an entity — no pin "type". Whether it renders as
// a marker (plain entity) or a zoom circle (Location with a map image)
// is derived from the target entity at render time, never from anything
// captured at pin-creation time — so a location that gains a map image
// after pins already point at it still upgrades to a circle.
function isMapEntity(entity) {
  return !!entity && entity.category === 'Location' && !!entity.hasMapImage;
}

// CSS class carrying the entry-type color (see styles.css "Pin color
// legend" block — that's the single place to edit colors).
function categoryPinClass(category) {
  const slug = (category || 'default').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return 'pin-cat-' + (slug || 'default');
}

// Teardrop marker icon (Leaflet's classic map-pin shape), colored by
// entry type via the CSS custom property set on its wrapping .pin-cat-*
// class (see styles.css "Pin color legend"). Anchor sits at the tip.
function pinDivIcon(category, extraClass) {
  const svg = '<svg class="map-pin-marker-svg" width="26" height="36" viewBox="0 0 26 36" xmlns="http://www.w3.org/2000/svg">'
    + '<path d="M13 0C5.8 0 0 5.8 0 13c0 9.75 13 23 13 23s13-13.25 13-23C26 5.8 20.2 0 13 0z" class="map-pin-marker-body"/>'
    + '<circle cx="13" cy="13" r="5" class="map-pin-marker-dot"/>'
    + '</svg>';
  return L.divIcon({
    className: 'map-pin-marker ' + categoryPinClass(category) + (extraClass ? ' ' + extraClass : ''),
    html: svg,
    iconSize: [26, 36],
    iconAnchor: [13, 36]
  });
}

// --- Navigation: a Location's map, jumped to directly by id. Used by
// breadcrumb links, the Entry Browser's "map" link, and clicking a
// circle pin. Position in the map hierarchy is always derived live from
// entity.parentId (see buildBreadcrumbChain) rather than a click-history
// stack, so this is a plain jump — no stack bookkeeping needed. -----------
function navigateToMapForEntity(entityId) {
  state.currentMapEntityId = entityId;
  const mapTabBtn = document.getElementById('tab-btn-map');
  if (mapTabBtn && !document.getElementById('map-panel').classList.contains('active')) {
    mapTabBtn.click();
  } else {
    loadMap(entityId);
  }
}
registerMapNavigationHandler(navigateToMapForEntity);

function switchToCodexEntity(entityId) {
  state.selectedId = entityId;
  renderList();
  renderDetailForSelected();

  document.querySelectorAll('nav#tabs button').forEach(function (b) { b.classList.remove('active'); });
  document.querySelectorAll('.tab-panel').forEach(function (p) { p.classList.remove('active'); });
  document.getElementById('tab-btn-codex').classList.add('active');
  document.getElementById('codex-panel').classList.add('active');
}

// --- Breadcrumb: walks entity.parentId from the current map entity up
// to the top of the tree (structural hierarchy, not navigation history —
// stable no matter how the GM got here: pin click, Entry Browser link,
// or another breadcrumb link). Each link opens that entity's map if it
// has one, otherwise its Codex entry. -------------------------------------
function buildBreadcrumbChain(mapEntityId) {
  const chain = [];
  const seen = {};
  let cur = state.allEntities.find(function (e) { return e.id === mapEntityId; });
  while (cur && !seen[cur.id]) {
    chain.unshift(cur);
    seen[cur.id] = true;
    cur = cur.parentId ? state.allEntities.find(function (e) { return e.id === cur.parentId; }) : null;
  }
  return chain;
}

function renderBreadcrumb() {
  breadcrumbEl.innerHTML = '';
  const chain = buildBreadcrumbChain(state.currentMapEntityId);
  if (chain.length < 2) {
    breadcrumbEl.style.display = 'none';
    return;
  }
  breadcrumbEl.style.display = 'flex';
  chain.forEach(function (entity, idx) {
    if (idx > 0) {
      const sep = document.createElement('span');
      sep.className = 'map-breadcrumb-sep';
      sep.textContent = '/';
      breadcrumbEl.appendChild(sep);
    }
    const isCurrent = idx === chain.length - 1;
    const link = document.createElement('button');
    link.type = 'button';
    link.className = 'map-breadcrumb-link' + (isCurrent ? ' current' : '');
    link.textContent = entity.name;
    link.addEventListener('click', function () {
      if (isMapEntity(entity)) {
        navigateToMapForEntity(entity.id);
      } else {
        switchToCodexEntity(entity.id);
      }
    });
    breadcrumbEl.appendChild(link);
    const icon = document.createElement('span');
    icon.className = 'map-breadcrumb-icon';
    icon.textContent = isMapEntity(entity) ? CONFIG.icons.map : CONFIG.icons.codex;
    breadcrumbEl.appendChild(icon);
  });
}

// --- GM pin controls: New / Edit / Remove, mutually exclusive modes ------
function setMapMode(mode) {
  state.mapMode = (state.mapMode === mode) ? null : mode;
  newPinBtn.classList.toggle('active-mode', state.mapMode === 'add');
  editPinBtn.classList.toggle('active-mode', state.mapMode === 'edit');
  removePinBtn.classList.toggle('active-mode', state.mapMode === 'remove');
  if (state.mapMode === 'add') {
    modeHintEl.textContent = 'Click the map to place a pin.';
  } else if (state.mapMode === 'edit') {
    modeHintEl.textContent = 'Click a pin to edit it.';
  } else if (state.mapMode === 'remove') {
    modeHintEl.textContent = 'Click a pin to remove it.';
  } else {
    modeHintEl.textContent = '';
  }
}

newPinBtn.addEventListener('click', function () { setMapMode('add'); });
editPinBtn.addEventListener('click', function () { setMapMode('edit'); });
removePinBtn.addEventListener('click', function () { setMapMode('remove'); });

function removePin(pin) {
  const entity = state.allEntities.find(function (e) { return e.id === pin.entityId; });
  const label = entity ? entity.name : '(unlinked pin)';
  const confirmed = window.confirm('Remove pin for "' + label + '"?');
  if (!confirmed) return;
  deleteDoc(doc(db, 'pins', pin.id)).catch(function (err) {
    window.alert('Remove pin failed: ' + err.message);
  });
}

// --- Pin panel: docked side panel (map stays visible/clickable behind
// it), rich entity picker (item 3), live radius-slider preview, and a
// draggable-marker "move" mode — all built once here, opened for both
// New and Edit. ------------------------------------------------------------
const pinPanelEl = document.getElementById('pin-panel');
const pinPanelTitleEl = document.getElementById('pin-panel-title');
const pinPanelSearchEl = document.getElementById('pin-panel-search');
const pinPanelEntityListEl = document.getElementById('pin-panel-entity-list');
const pinPanelRadiusRowEl = document.getElementById('pin-panel-radius-row');
const pinPanelRadiusEl = document.getElementById('pin-panel-radius');
const pinPanelRadiusValueEl = document.getElementById('pin-panel-radius-value');
const pinPanelMoveBtn = document.getElementById('pin-panel-move-btn');
const pinPanelMoveHintEl = document.getElementById('pin-panel-move-hint');
const pinPanelErrorEl = document.getElementById('pin-panel-error');
const pinPanelSaveBtn = document.getElementById('pin-panel-save');
const pinPanelCancelBtn = document.getElementById('pin-panel-cancel');
const pinMoveIndicatorEl = document.getElementById('pin-move-indicator');
const pinMoveDoneBtn = document.getElementById('pin-move-done-btn');

// Preview layer: shows the pin being placed/edited directly on the map
// while the panel is open — a draggable marker (position handle) plus,
// for circle-type targets, a non-interactive circle synced to it.
let previewMarker = null;
let previewCircle = null;

function clearPinPreview() {
  if (previewMarker) { state.leafletMap.removeLayer(previewMarker); previewMarker = null; }
  if (previewCircle) { state.leafletMap.removeLayer(previewCircle); previewCircle = null; }
}

function updatePinPreview() {
  if (!state.leafletMap || !state.pinDraft) return;
  const draft = state.pinDraft;
  const target = state.allEntities.find(function (e) { return e.id === draft.entityId; });
  const lat = state.mapImgHeight - draft.y;

  if (!previewMarker) {
    previewMarker = L.marker([lat, draft.x], { draggable: !!draft.moveMode });
    previewMarker.on('drag', function (e) {
      const pos = e.target.getLatLng();
      draft.x = pos.lng;
      draft.y = state.mapImgHeight - pos.lat;
      if (previewCircle) previewCircle.setLatLng(pos);
    });
    previewMarker.on('dragend', function () {
      exitMoveMode();
    });
    previewMarker.addTo(state.leafletMap);
  } else {
    previewMarker.setLatLng([lat, draft.x]);
  }
  previewMarker.setIcon(pinDivIcon(target ? target.category : null, 'preview'));
  previewMarker.dragging[draft.moveMode ? 'enable' : 'disable']();

  const wantsCircle = isMapEntity(target);
  if (wantsCircle) {
    if (!previewCircle) {
      previewCircle = L.circle([lat, draft.x], {
        radius: draft.radius || 150,
        className: 'map-pin-circle ' + categoryPinClass(target.category),
        weight: 2, fillOpacity: 0.2, interactive: false
      });
      previewCircle.addTo(state.leafletMap);
    } else {
      previewCircle.setLatLng([lat, draft.x]);
      previewCircle.setRadius(draft.radius || 150);
      previewCircle.setStyle({ className: 'map-pin-circle ' + categoryPinClass(target.category) });
    }
  } else if (previewCircle) {
    state.leafletMap.removeLayer(previewCircle);
    previewCircle = null;
  }
}

function isMetaCategory(category) {
  return (CONFIG.metaCategories || []).indexOf(category) !== -1;
}

function renderPinPickerEntityList() {
  pinPanelEntityListEl.innerHTML = '';
  const draft = state.pinDraft;
  const q = pinPanelSearchEl.value.trim().toLowerCase();

  const candidates = state.allEntities
    .filter(function (e) { return e.id !== state.currentMapEntityId; }) // no self-pin
    .filter(function (e) { return !isMetaCategory(e.category); }) // Meta types never get a pin
    .filter(function (e) {
      if (!q) return true;
      return (e.name || '').toLowerCase().indexOf(q) !== -1;
    })
    .sort(function (a, b) { return (a.name || '').localeCompare(b.name || ''); });

  const byCategory = {};
  candidates.forEach(function (e) {
    const cat = e.category || '(uncategorized)';
    if (!byCategory[cat]) byCategory[cat] = [];
    byCategory[cat].push(e);
  });
  const orderedCats = CONFIG.categories.filter(function (c) { return byCategory[c]; });
  Object.keys(byCategory).forEach(function (c) { if (orderedCats.indexOf(c) === -1) orderedCats.push(c); });

  if (!orderedCats.length) {
    const emptyP = document.createElement('p');
    emptyP.className = 'lore-empty';
    emptyP.textContent = 'No matching entities.';
    pinPanelEntityListEl.appendChild(emptyP);
    return;
  }

  orderedCats.forEach(function (cat) {
    const entities = byCategory[cat];
    const collapsed = q ? false : (state.pinPickerCollapse[cat] !== false);

    const header = document.createElement('div');
    header.className = 'entity-group-header' + (collapsed ? ' collapsed' : '');
    header.textContent = cat + ' (' + entities.length + ')';
    header.addEventListener('click', function () {
      state.pinPickerCollapse[cat] = collapsed ? false : true;
      renderPinPickerEntityList();
    });
    pinPanelEntityListEl.appendChild(header);

    const ul = document.createElement('ul');
    ul.className = 'entity-group-list' + (collapsed ? ' collapsed' : '');
    entities.forEach(function (entity) {
      const li = document.createElement('li');
      li.textContent = entity.name;
      if (draft && draft.entityId === entity.id) li.classList.add('active');
      li.addEventListener('click', function () {
        draft.entityId = entity.id;
        updatePinPanelForTarget();
        renderPinPickerEntityList();
        updatePinPreview();
      });
      ul.appendChild(li);
    });
    pinPanelEntityListEl.appendChild(ul);
  });
}

function updatePinPanelForTarget() {
  const draft = state.pinDraft;
  const target = state.allEntities.find(function (e) { return e.id === draft.entityId; });
  const showRadius = isMapEntity(target);
  pinPanelRadiusRowEl.style.display = showRadius ? 'block' : 'none';
  if (showRadius) {
    pinPanelRadiusEl.value = draft.radius || 150;
    pinPanelRadiusValueEl.textContent = pinPanelRadiusEl.value;
  }
}

pinPanelSearchEl.addEventListener('input', renderPinPickerEntityList);
pinPanelRadiusEl.addEventListener('input', function () {
  if (!state.pinDraft) return;
  state.pinDraft.radius = Number(pinPanelRadiusEl.value);
  pinPanelRadiusValueEl.textContent = pinPanelRadiusEl.value;
  updatePinPreview();
});
pinPanelMoveBtn.addEventListener('click', function () {
  if (!state.pinDraft) return;
  if (state.pinDraft.moveMode) {
    exitMoveMode();
  } else {
    enterMoveMode();
  }
});
pinMoveDoneBtn.addEventListener('click', exitMoveMode);

// Move mode: hides the pin panel entirely (item 6/7 — nothing should sit
// over the map while dragging) and hides the pin's own static rendering
// in the pin layer (so the draggable preview marker reads as "the one
// true pin", not a ghost on top of a still-visible original). A small
// corner indicator replaces the panel so there's always a way out even
// if the user never actually drags.
function enterMoveMode() {
  state.pinDraft.moveMode = true;
  pinPanelEl.classList.add('move-mode');
  pinPanelMoveBtn.classList.add('active-mode');
  pinPanelMoveBtn.textContent = 'Stop moving';
  pinPanelMoveHintEl.style.display = 'block';
  pinMoveIndicatorEl.classList.add('open');
  updatePinPreview();
  renderPins();
}

function exitMoveMode() {
  if (!state.pinDraft) return;
  state.pinDraft.moveMode = false;
  pinPanelEl.classList.remove('move-mode');
  pinMoveIndicatorEl.classList.remove('open');
  pinPanelMoveBtn.classList.remove('active-mode');
  pinPanelMoveBtn.textContent = 'Move pin position';
  pinPanelMoveHintEl.style.display = 'none';
  updatePinPreview();
  renderPins();
}

function openPinPanel(existingPin, coords) {
  state.pinDraft = existingPin
    ? { id: existingPin.id, entityId: existingPin.entityId, x: existingPin.x, y: existingPin.y, radius: existingPin.radius || 150, moveMode: false }
    : { id: null, entityId: null, x: coords.x, y: coords.y, radius: 150, moveMode: false };

  // Default to the first available entity so the preview has something
  // to show immediately (New pin only — Edit already has one).
  if (!state.pinDraft.entityId) {
    const first = state.allEntities.find(function (e) { return e.id !== state.currentMapEntityId && !isMetaCategory(e.category); });
    if (first) state.pinDraft.entityId = first.id;
  }

  pinPanelTitleEl.textContent = existingPin ? 'Edit pin' : 'New pin';
  pinPanelSearchEl.value = '';
  pinPanelEl.classList.remove('move-mode');
  pinMoveIndicatorEl.classList.remove('open');
  pinPanelMoveBtn.classList.remove('active-mode');
  pinPanelMoveBtn.textContent = 'Move pin position';
  pinPanelMoveHintEl.style.display = 'none';
  pinPanelErrorEl.style.display = 'none';
  pinPanelErrorEl.textContent = '';

  updatePinPanelForTarget();
  renderPinPickerEntityList();
  clearPinPreview();
  updatePinPreview();
  pinPanelEl.classList.add('open');
  renderPins(); // hides the pin being edited, if it already exists
}

function closePinPanel() {
  pinPanelEl.classList.remove('open');
  pinPanelEl.classList.remove('move-mode');
  pinMoveIndicatorEl.classList.remove('open');
  clearPinPreview();
  state.pinDraft = null;
  renderPins(); // un-hides it
}

function showPinPanelError(message) {
  pinPanelErrorEl.textContent = message;
  pinPanelErrorEl.style.display = 'block';
}

pinPanelCancelBtn.addEventListener('click', function () {
  closePinPanel();
  setMapMode(null);
});

pinPanelSaveBtn.addEventListener('click', function () {
  const draft = state.pinDraft;
  if (!draft) return;
  if (!draft.entityId) {
    showPinPanelError('Choose a target entity.');
    return;
  }
  const target = state.allEntities.find(function (e) { return e.id === draft.entityId; });
  const pinData = {
    entityId: draft.entityId,
    x: draft.x,
    y: draft.y,
    mapEntityId: state.currentMapEntityId
  };
  if (isMapEntity(target)) {
    const radius = Number(draft.radius);
    if (!radius || radius <= 0) {
      showPinPanelError('Radius must be a positive number.');
      return;
    }
    pinData.radius = radius;
  }

  pinPanelSaveBtn.disabled = true;
  const savePromise = draft.id
    ? updateDoc(doc(db, 'pins', draft.id), pinData)
    : addDoc(collection(db, 'pins'), pinData);
  savePromise.then(function () {
    pinPanelSaveBtn.disabled = false;
    closePinPanel();
    setMapMode(null);
  }).catch(function (err) {
    pinPanelSaveBtn.disabled = false;
    showPinPanelError('Save failed: ' + err.message);
  });
});

// --- Pin rendering ---------------------------------------------------------

function renderPins() {
  if (!state.leafletMap) return;
  if (!state.pinLayer) {
    state.pinLayer = L.layerGroup().addTo(state.leafletMap);
  }
  state.pinLayer.clearLayers();

  const pinsForCurrentMap = state.allPins.filter(function (pin) {
    return pin.mapEntityId === state.currentMapEntityId;
  });

  const gmView = state.currentRole === 'gm' && !state.gmPreviewAsPlayer;

  // The pin being edited is hidden from its static rendering for the
  // whole time the panel is open (not just mid-drag) — otherwise it
  // reappears the moment a drag ends, before Save/Cancel, which looks
  // like two pins for a beat. The draggable preview marker stands in
  // for it the entire session.
  const editingPinId = state.pinDraft ? state.pinDraft.id : null;

  // Legend scoping: track which categories actually have a rendered pin
  // on this map, in this view (GM/player), so the legend only lists
  // types actually present here rather than every category that ever
  // exists anywhere. Built alongside the same filter pass rather than a
  // second pass so it can't drift from what's actually on screen.
  const categoriesPresent = new Set();

  pinsForCurrentMap.forEach(function (pin) {
    if (pin.id === editingPinId) return;
    const lat = state.mapImgHeight - pin.y;
    const entity = state.allEntities.find(function (e) { return e.id === pin.entityId; });

    // Players don't see pins for hidden entities — a pin whose tooltip
    // names a secret entity is itself a spoiler.
    if (entity && !gmView && !isEntityPlayerVisible(entity.id)) return;

    if (entity) categoriesPresent.add(entity.category);

    function handleClick() {
      if (state.mapMode === 'remove' && state.currentRole === 'gm') {
        removePin(pin);
        return false;
      }
      if (state.mapMode === 'edit' && state.currentRole === 'gm') {
        openPinPanel(pin, null);
        return false;
      }
      return true;
    }

    if (isMapEntity(entity)) {
      // Location with a map image: zoom circle. Radius is in map units
      // (this map's own pixel coordinate space), scaling visually with
      // zoom — sized to roughly match the region it zooms into.
      const circle = L.circle([lat, pin.x], {
        radius: pin.radius || 150,
        className: 'map-pin-circle ' + categoryPinClass(entity.category),
        weight: 2, fillOpacity: 0.2
      });
      circle.bindTooltip('\u2192 ' + entity.name);
      circle.on('click', function () {
        if (!handleClick()) return;
        navigateToMapForEntity(entity.id);
      });
      circle.addTo(state.pinLayer);
      return;
    }

    // Any other entity (or a location without a map image yet): a small
    // colored marker (color = entry type) that jumps to the codex detail.
    const marker = L.marker([lat, pin.x], { icon: pinDivIcon(entity ? entity.category : null) });
    marker.bindTooltip(entity ? entity.name : '(unlinked pin)');
    marker.on('click', function () {
      if (!handleClick()) return;
      if (entity) switchToCodexEntity(entity.id);
    });
    marker.addTo(state.pinLayer);
  });

  updateLegend(categoriesPresent);
}

// --- Legend: a small Leaflet control listing entry-type -> color, so the
// colors used above are self-explanatory on the map itself. Scoped to
// only the categories with a visible pin on the current map/view (see
// renderPins' categoriesPresent) rather than every category that exists
// campaign-wide, so it stays a short, relevant key instead of a fixed
// list most of which is usually absent from any single map. -------------
function addLegendControl(map) {
  const legend = L.control({ position: 'bottomleft' });
  legend.onAdd = function () {
    const div = L.DomUtil.create('div', 'map-pin-legend');
    L.DomEvent.disableClickPropagation(div);
    state.mapLegendDiv = div;
    return div;
  };
  legend.addTo(map);
}

// Rebuild the legend's rows from a Set of category names. Called at the
// end of every renderPins() so the legend tracks live pin/visibility
// changes (GM reveal, preview toggle, add/remove pin), not just the
// state at map load.
function updateLegend(categoriesPresent) {
  const div = state.mapLegendDiv;
  if (!div) return;
  div.innerHTML = '';
  CONFIG.categories
    .filter(function (cat) { return !isMetaCategory(cat) && categoriesPresent.has(cat); })
    .forEach(function (cat) {
      const row = document.createElement('div');
      row.className = 'map-pin-legend-row';
      const swatch = document.createElement('span');
      swatch.className = 'map-pin-legend-swatch ' + categoryPinClass(cat);
      row.appendChild(swatch);
      const label = document.createElement('span');
      label.textContent = cat;
      row.appendChild(label);
      div.appendChild(row);
    });
}

function attachPinsListener() {
  attachListener('pinsUnsub', function () {
    return onSnapshot(collection(db, 'pins'), safeSnapshotHandler('pins', function (snapshot) {
      state.allPins = [];
      snapshot.forEach(function (docSnap) {
        state.allPins.push(Object.assign({ id: docSnap.id }, docSnap.data()));
      });
      renderPins();
    }), function (err) {
      console.error('pins listener error:', err.message);
    });
  });
}

// --- Root pointer: config/campaign.rootEntityId — a GM-selected Location
// entity whose map image is the top-level map. Entity data itself
// arrives via codex.js's entities listener (which notifies the
// visibility-change handler below for revalidation). Tracks whether the
// current view was "following" the root so a root change re-follows it,
// without needing a navigation-history stack (breadcrumbs derive
// position from parentId, not from history).
let lastKnownRootEntityId = null;
function attachConfigListener() {
  attachListener('configUnsub', function () {
    return onSnapshot(doc(db, 'config', 'campaign'), safeSnapshotHandler('config', function (docSnap) {
      const newRoot = docSnap.exists() ? (docSnap.data().rootEntityId || null) : null;
      const wasFollowingRoot = state.currentMapEntityId === lastKnownRootEntityId;
      state.rootEntityId = newRoot;
      if (wasFollowingRoot) {
        state.currentMapEntityId = newRoot;
      } else {
        resolveCurrentMapEntityId();
      }
      lastKnownRootEntityId = newRoot;
      renderAdminRootEntitySelect();
      if (document.getElementById('map-panel').classList.contains('active')) {
        ensureMapTabReady();
      }
    }), function (err) {
      console.error('Config listener error:', err.message);
    });
  });
}

function resolveCurrentMapEntityId() {
  if (!state.currentMapEntityId
      || !state.allEntities.find(function (e) { return e.id === state.currentMapEntityId; })) {
    state.currentMapEntityId = state.rootEntityId;
  }
}

function ensureMapTabReady() {
  // No early-return on falsy currentMapEntityId: null is a legitimate
  // steady state (no root configured), not just "not loaded yet" —
  // loadMap(null) tears down any stale map and shows the right
  // placeholder either way.
  if (state.leafletMap && state.loadedMapId === state.currentMapEntityId) {
    // Tab was hidden (display:none) then shown again: the container's
    // measured size goes stale while hidden, which is what produces the
    // "map drifted off-center with grey margins" bug — invalidateSize()
    // re-measures and re-centers without a full reload.
    state.leafletMap.invalidateSize();
    renderPins();
    renderBreadcrumb();
    return;
  }
  loadMap(state.currentMapEntityId);
}

// Re-render pins whenever entity/lore visibility or entity data changes
// (GM reveal, preview toggle, hasMapImage flips) so pin filtering and
// marker-vs-circle shape track live.
registerVisibilityChangeHandler(function () {
  resolveCurrentMapEntityId();
  if (document.getElementById('map-panel').classList.contains('active')) {
    ensureMapTabReady();
  }
  renderPins();
  renderBreadcrumb();
});

// Extracted so sign-out can also fully tear down the map view (not just
// re-load into it): previously only loadMap() did this cleanup, so on
// sign-out the live image listener (mapImageUnsub) kept running with no
// auth token, died on permission-denied, and left its error text on
// screen -- and since leafletMap/loadedMapId were never reset either,
// ensureMapTabReady()'s "already loaded" shortcut skipped calling
// loadMap() again on sign-back-in, so the stale error never cleared
// without a full page reload.
function teardownMapRuntime() {
  closePinPanel();
  setMapMode(null);
  if (state.leafletMap) {
    state.leafletMap.remove();
    state.leafletMap = null;
    state.pinLayer = null;
    state.mapLegendDiv = null;
  }
  if (state.mapImageUnsub) {
    state.mapImageUnsub();
    state.mapImageUnsub = null;
  }
  state.currentMapImageDims = null;
  state.loadedMapId = null;
  state.loadingMapId = null;
}

function loadMap(mapEntityId) {
  // Dedup: the entities-change handler and attachConfigListener can both
  // fire ensureMapTabReady() -> loadMap() for the same entity within the
  // same tick (e.g. right after sign-in, or an entities change alongside
  // a config change). Without this guard, the second call's
  // teardownMapRuntime() unsubscribes the first call's image listener
  // before it ever receives its first snapshot -- nothing ever renders,
  // and the placeholder is stuck on "Loading map image..." until
  // something else calls loadMap() again as the sole in-flight caller.
  if (state.loadingMapId === mapEntityId && state.mapImageUnsub) {
    return;
  }

  const mapEntity = state.allEntities.find(function (e) { return e.id === mapEntityId; });
  const placeholderEl = document.getElementById('map-tab-placeholder');
  const containerEl = document.getElementById('map-container');

  teardownMapRuntime();
  state.loadingMapId = mapEntityId;
  renderBreadcrumb();

  if (!mapEntity) {
    placeholderEl.style.display = 'block';
    containerEl.style.display = 'none';
    placeholderEl.textContent = state.rootEntityId
      ? 'No map configured yet.'
      : 'No root location selected yet.' + (state.currentRole === 'gm' ? ' Set one in the Admin tab.' : ' Ask your GM to set one up.');
    return;
  }

  if (typeof L === 'undefined') {
    placeholderEl.style.display = 'block';
    containerEl.style.display = 'none';
    placeholderEl.textContent = 'Map library (Leaflet) failed to load.';
    return;
  }

  // Image lives in Firestore (images/entity_{id}_map). Live-listen so a
  // GM's upload (via the entity edit fields) updates the Map tab for
  // everyone without a reload.
  placeholderEl.style.display = 'block';
  containerEl.style.display = 'none';
  placeholderEl.textContent = 'Loading map image...';

  const imageDocId = entityMapImageDocId(mapEntityId);

  // Phase 7c-1: paint instantly from IndexedDB cache (if any) while the
  // listener below does its network round-trip. state.loadedMapId check
  // guards against the live snapshot having already won the race and
  // rendered first — cache is a fallback, never an override.
  getCachedImage(imageDocId).then(function (cached) {
    if (cached && state.loadingMapId === mapEntityId && state.loadedMapId !== mapEntityId) {
      state.currentMapImageDims = { width: cached.width, height: cached.height };
      renderMapImage(mapEntityId, cached);
    }
  });

  state.mapImageUnsub = onSnapshot(doc(db, 'images', imageDocId), safeSnapshotHandler('mapImage', function (imgSnap) {
    if (state.loadedMapId === mapEntityId && state.leafletMap) {
      // Already rendered this map; a later snapshot for the same map
      // (e.g. after a re-upload) means the image changed under us —
      // simplest correct handling is a full reload of this map.
      state.leafletMap.remove();
      state.leafletMap = null;
      state.pinLayer = null;
      state.loadedMapId = null;
    }
    if (!imgSnap.exists()) {
      state.currentMapImageDims = null;
      placeholderEl.style.display = 'block';
      containerEl.style.display = 'none';
      placeholderEl.textContent = state.currentRole === 'gm'
        ? 'No map image for "' + (mapEntity.name || 'this location') + '" yet. Add one via Edit on its Codex entry.'
        : 'This map has no image yet — ask your GM.';
      return;
    }
    const imgData = imgSnap.data();
    state.currentMapImageDims = { width: imgData.width, height: imgData.height };
    renderMapImage(mapEntityId, imgData);
    // Fire-and-forget cache write; source-of-truth render above never
    // waits on this.
    putCachedImage({
      docId: imageDocId,
      version: (imgData.uploadedAt && imgData.uploadedAt.toMillis) ? imgData.uploadedAt.toMillis() : Date.now(),
      data: imgData.data,
      width: imgData.width,
      height: imgData.height,
      contentType: imgData.contentType
    });
  }), function (err) {
    placeholderEl.style.display = 'block';
    containerEl.style.display = 'none';
    placeholderEl.textContent = 'Map image failed to load: ' + err.message;
  });
}

function renderMapImage(mapEntityId, imageDoc) {
  const placeholderEl = document.getElementById('map-tab-placeholder');
  const containerEl = document.getElementById('map-container');
  try {
    const img = new Image();
    img.onload = function () {
      try {
        placeholderEl.style.display = 'none';
        containerEl.style.display = 'block';

        // Size the container to exactly match the image's aspect ratio
        // (constrained by whichever of width/max-height binds first), so
        // fitBounds has no mismatched axis to leave a margin on.
        const aspect = img.naturalHeight / img.naturalWidth;
        const availableWidth = containerEl.clientWidth;
        const maxHeight = window.innerHeight * 0.8;

        let targetWidth = availableWidth;
        let targetHeight = targetWidth * aspect;
        if (targetHeight > maxHeight) {
          targetHeight = maxHeight;
          targetWidth = targetHeight / aspect;
        }
        containerEl.style.width = targetWidth + 'px';
        containerEl.style.height = targetHeight + 'px';
        containerEl.style.margin = '1rem auto 0';

        state.mapImgHeight = img.naturalHeight;
        const bounds = [[0, 0], [img.naturalHeight, img.naturalWidth]];
        const map = L.map('map-container', {
          crs: L.CRS.Simple,
          minZoom: -3,
          zoomSnap: 0,
          zoomDelta: 0.5,
          maxBoundsViscosity: 1.0
        });
        L.imageOverlay(imageDoc.data, bounds).addTo(map);
        addLegendControl(map);
        state.leafletMap = map;
        state.loadedMapId = mapEntityId;

        map.on('click', function (e) {
          if (state.mapMode !== 'add' || state.currentRole !== 'gm') return;
          const x = e.latlng.lng;
          const y = state.mapImgHeight - e.latlng.lat;
          openPinPanel(null, { x: x, y: y });
        });

        setTimeout(function () {
          map.invalidateSize();
          map.fitBounds(bounds);
          map.setMinZoom(map.getZoom());
          map.setMaxBounds(bounds);

          renderPins();
          renderBreadcrumb();
        }, 0);
      } catch (err) {
        placeholderEl.style.display = 'block';
        containerEl.style.display = 'none';
        placeholderEl.textContent = 'Map render error: ' + err.message;
      }
    };
    img.onerror = function () {
      placeholderEl.style.display = 'block';
      containerEl.style.display = 'none';
      placeholderEl.textContent = 'Map image failed to load (corrupt data?).';
    };
    img.src = imageDoc.data;
  } catch (err) {
    placeholderEl.style.display = 'block';
    containerEl.style.display = 'none';
    placeholderEl.textContent = 'Map init error: ' + err.message;
  }
}

function detachMapDataListeners() {
  detachListener('pinsUnsub');
  detachListener('configUnsub');
  teardownMapRuntime();
}

export {
  attachPinsListener, attachConfigListener, detachMapDataListeners,
  ensureMapTabReady, loadMap
};
