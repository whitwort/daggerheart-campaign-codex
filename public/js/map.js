import {
  getFirestore, collection, onSnapshot, doc, addDoc, deleteDoc
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import { firebaseApp } from './firebase.js';
import { state } from './state.js';
import {
  renderList, renderDetailForSelected, isEntityPlayerVisible,
  registerVisibilityChangeHandler, registerMapNavigationHandler
} from './codex.js';
import { renderAdminRootEntitySelect } from './admin.js';
import { entityMapImageDocId, getCachedImage, putCachedImage } from './images.js';
import { attachListener, detachListener, safeSnapshotHandler } from './listeners.js';

const db = getFirestore(firebaseApp);


    const mapGmControlsEl = document.getElementById('map-gm-controls');
    const addPinBtn = document.getElementById('map-add-pin-btn');
    const removePinBtn = document.getElementById('map-remove-pin-btn');
    const modeHintEl = document.getElementById('map-mode-hint');
    const mapBackBtn = document.getElementById('map-back-btn');

    // Image size/cache constants live in images.js (their sole consumer)
    // since the module split — see that file.

    function updateBackButtonVisibility() {
      mapBackBtn.style.display = state.mapNavStack.length ? 'block' : 'none';
    }

    // "Maps" are Location entities with a map image; navigation walks
    // entity ids. The old standalone `maps` collection is dead.
    function navigateToMapEntity(entityId) {
      state.mapNavStack.push(state.currentMapEntityId);
      state.currentMapEntityId = entityId;
      updateBackButtonVisibility();
      loadMap(state.currentMapEntityId);
    }

    mapBackBtn.addEventListener('click', function () {
      if (!state.mapNavStack.length) return;
      state.currentMapEntityId = state.mapNavStack.pop();
      updateBackButtonVisibility();
      loadMap(state.currentMapEntityId);
    });

    const pinFormOverlayEl = document.getElementById('pin-form-overlay');
    const pinFormEntityEl = document.getElementById('pin-form-entity');
    const pinFormRadiusRowEl = document.getElementById('pin-form-radius-row');
    const pinFormRadiusEl = document.getElementById('pin-form-radius');
    const pinFormErrorEl = document.getElementById('pin-form-error');
    const pinFormSaveBtn = document.getElementById('pin-form-save');
    const pinFormCancelBtn = document.getElementById('pin-form-cancel');

    // A pin always links to an entity — no pin "type". Whether it renders
    // as a marker (plain entity) or a zoom circle (Location with a map
    // image) is derived from the target entity at render time. The radius
    // input only applies to the circle case.
    function isMapEntity(entity) {
      return !!entity && entity.category === 'Location' && !!entity.hasMapImage;
    }

    function updatePinFormRadiusVisibility() {
      const target = state.allEntities.find(function (e) { return e.id === pinFormEntityEl.value; });
      pinFormRadiusRowEl.style.display = isMapEntity(target) ? 'block' : 'none';
    }

    pinFormEntityEl.addEventListener('change', updatePinFormRadiusVisibility);

    function setMapMode(mode) {
      state.mapMode = (state.mapMode === mode) ? null : mode;
      addPinBtn.classList.toggle('active-mode', state.mapMode === 'add');
      removePinBtn.classList.toggle('active-mode', state.mapMode === 'remove');
      if (state.mapMode === 'add') {
        modeHintEl.textContent = 'Click the map to place a pin.';
      } else if (state.mapMode === 'remove') {
        modeHintEl.textContent = 'Click a pin to remove it.';
      } else {
        modeHintEl.textContent = '';
      }
    }

    addPinBtn.addEventListener('click', function () { setMapMode('add'); });
    removePinBtn.addEventListener('click', function () { setMapMode('remove'); });

    function openPinForm(coords) {
      state.pendingPinCoords = coords;

      pinFormEntityEl.innerHTML = '';
      state.allEntities
        .slice()
        // Not offering the currently-viewed location itself as a target —
        // a self-pin would be a circle that zooms to the map it's on.
        .filter(function (e) { return e.id !== state.currentMapEntityId; })
        .sort(function (a, b) { return (a.name || '').localeCompare(b.name || ''); })
        .forEach(function (entity) {
          const opt = document.createElement('option');
          opt.value = entity.id;
          opt.textContent = entity.name;
          pinFormEntityEl.appendChild(opt);
        });

      pinFormRadiusEl.value = '150';
      updatePinFormRadiusVisibility();

      pinFormErrorEl.style.display = 'none';
      pinFormErrorEl.textContent = '';
      pinFormOverlayEl.classList.add('open');
    }

    function closePinForm() {
      pinFormOverlayEl.classList.remove('open');
      state.pendingPinCoords = null;
    }

    pinFormCancelBtn.addEventListener('click', closePinForm);
    pinFormOverlayEl.addEventListener('click', function (e) {
      if (e.target === pinFormOverlayEl) closePinForm();
    });

    pinFormSaveBtn.addEventListener('click', function () {
      if (!state.pendingPinCoords) {
        closePinForm();
        return;
      }

      const entityId = pinFormEntityEl.value;
      if (!entityId) {
        pinFormErrorEl.textContent = 'No entities available to link.';
        pinFormErrorEl.style.display = 'block';
        return;
      }

      const pinData = {
        entityId: entityId,
        x: state.pendingPinCoords.x,
        y: state.pendingPinCoords.y,
        mapEntityId: state.currentMapEntityId
      };

      const target = state.allEntities.find(function (e) { return e.id === entityId; });
      if (isMapEntity(target)) {
        const radius = Number(pinFormRadiusEl.value);
        if (!radius || radius <= 0) {
          pinFormErrorEl.textContent = 'Radius must be a positive number.';
          pinFormErrorEl.style.display = 'block';
          return;
        }
        pinData.radius = radius;
      }

      savePin(pinData);
    });

    function savePin(pinData) {
      pinFormSaveBtn.disabled = true;
      return addDoc(collection(db, 'pins'), pinData).then(function () {
        pinFormSaveBtn.disabled = false;
        closePinForm();
        setMapMode('add'); // toggles back off, matching the button that opened it
      }).catch(function (err) {
        pinFormSaveBtn.disabled = false;
        pinFormErrorEl.textContent = 'Save failed: ' + err.message;
        pinFormErrorEl.style.display = 'block';
      });
    }

    function removePin(pin) {
      const entity = state.allEntities.find(function (e) { return e.id === pin.entityId; });
      const label = entity ? entity.name : '(unlinked pin)';
      const confirmed = window.confirm('Remove pin for "' + label + '"?');
      if (!confirmed) return;

      deleteDoc(doc(db, 'pins', pin.id)).catch(function (err) {
        window.alert('Remove pin failed: ' + err.message);
      });
    }

    function switchToCodexEntity(entityId) {
      state.selectedId = entityId;
      renderList();
      renderDetailForSelected();

      document.querySelectorAll('nav#tabs button').forEach(function (b) { b.classList.remove('active'); });
      document.querySelectorAll('.tab-panel').forEach(function (p) { p.classList.remove('active'); });
      document.getElementById('tab-btn-codex').classList.add('active');
      document.getElementById('codex-panel').classList.add('active');
    }

    // Re-render pins whenever entity/lore visibility or entity data
    // changes (GM reveal, preview toggle, hasMapImage flips) so pin
    // filtering and marker-vs-circle shape track live.
    registerVisibilityChangeHandler(function () {
      resolveCurrentMapEntityId();
      if (document.getElementById('map-panel').classList.contains('active')) {
        ensureMapTabReady();
      }
      renderPins();
    });

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

      pinsForCurrentMap.forEach(function (pin) {
        const lat = state.mapImgHeight - pin.y;
        const entity = state.allEntities.find(function (e) { return e.id === pin.entityId; });

        // Players don't see pins for hidden entities — a pin whose tooltip
        // names a secret entity is itself a spoiler.
        if (entity && !gmView && !isEntityPlayerVisible(entity.id)) return;

        if (isMapEntity(entity)) {
          // Location with a map image: zoom circle. Radius is in map units
          // (this map's own pixel coordinate space), scaling visually with
          // zoom — sized to roughly match the region it zooms into.
          const circle = L.circle([lat, pin.x], {
            radius: pin.radius || 150,
            color: '#8a4fd6',
            weight: 2,
            fillColor: '#8a4fd6',
            fillOpacity: 0.2
          });
          circle.bindTooltip('\u2192 ' + entity.name);
          circle.on('click', function () {
            if (state.mapMode === 'remove' && state.currentRole === 'gm') {
              removePin(pin);
              return;
            }
            navigateToMapEntity(entity.id);
          });
          circle.addTo(state.pinLayer);
          return;
        }

        // Any other entity (or a location without a map image yet): marker
        // that jumps to the codex detail.
        const marker = L.marker([lat, pin.x]);
        marker.bindTooltip(entity ? entity.name : '(unlinked pin)');
        marker.on('click', function () {
          if (state.mapMode === 'remove' && state.currentRole === 'gm') {
            removePin(pin);
            return;
          }
          if (entity) {
            switchToCodexEntity(entity.id);
          }
        });
        marker.addTo(state.pinLayer);
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

    // --- Root pointer: config/campaign.rootEntityId — a GM-selected
    // Location entity whose map image is the top-level map. Entity data
    // itself arrives via codex.js's entities listener (which notifies the
    // visibility-change handler above for revalidation).
    function attachConfigListener() {
      attachListener('configUnsub', function () {
        return onSnapshot(doc(db, 'config', 'campaign'), safeSnapshotHandler('config', function (docSnap) {
          state.rootEntityId = docSnap.exists() ? (docSnap.data().rootEntityId || null) : null;
          // Bugfix (carried over): a root-pointer change must force-follow
          // whenever the user is at the top level (no nav stack) —
          // otherwise switching the root while already viewing it
          // silently did nothing.
          if (state.mapNavStack.length === 0) {
            state.currentMapEntityId = state.rootEntityId;
          } else {
            resolveCurrentMapEntityId();
          }
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
        renderPins();
        return;
      }
      loadMap(state.currentMapEntityId);
    }

    // Entry Browser "map" link: jump straight to a Location's map,
    // resetting the back-nav stack (it's a fresh top-level view, not a
    // descent from whatever map was open before).
    function navigateToMapForEntity(entityId) {
      state.currentMapEntityId = entityId;
      state.mapNavStack = [];
      const mapTabBtn = document.getElementById('tab-btn-map');
      if (mapTabBtn) mapTabBtn.click();
    }
    registerMapNavigationHandler(navigateToMapForEntity);


    // --- Phase 7c-1: IndexedDB cache for map images. Not localStorage —
    // base64 image blobs can exceed its quota. Firestore's own listener
    // stays the source of truth (correctness, live updates); this cache
    // only provides instant paint from a prior session while the
    // listener does its network round-trip, keyed by the image doc ID
    // with a `version` field (uploadedAt millis) so we can tell a cached
    // entry apart from a newer live one. First application of this
    // pattern, per the phase plan — needs to provably work here before
    // 7d's tiling (many docs per map) depends on the same mechanism.
    // Cache constants + IndexedDB plumbing live in images.js.


    // Extracted so sign-out can also fully tear down the map view (not
    // just re-load into it): previously only loadMap() did this cleanup,
    // so on sign-out the live image listener (mapImageUnsub) kept running
    // with no auth token, died on permission-denied, and left its error
    // text on screen -- and since leafletMap/loadedMapId were never
    // reset either, ensureMapTabReady()'s "already loaded" shortcut
    // skipped calling loadMap() again on sign-back-in, so the stale
    // error never cleared without a full page reload.
    function teardownMapRuntime() {
      if (state.leafletMap) {
        state.leafletMap.remove();
        state.leafletMap = null;
        state.pinLayer = null;
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
      // Dedup: the entities-change handler and attachConfigListener can
      // both fire ensureMapTabReady() -> loadMap() for the same entity
      // within the same tick (e.g. right after sign-in, or an entities
      // change alongside a config change). Without this guard, the second
      // call's teardownMapRuntime() unsubscribes the first call's image
      // listener before it ever receives its first snapshot -- nothing
      // ever renders, and the placeholder is stuck on "Loading map
      // image..." until something else calls loadMap() again as the sole
      // in-flight caller.
      if (state.loadingMapId === mapEntityId && state.mapImageUnsub) {
        return;
      }

      const mapEntity = state.allEntities.find(function (e) { return e.id === mapEntityId; });
      const placeholderEl = document.getElementById('map-tab-placeholder');
      const containerEl = document.getElementById('map-container');

      teardownMapRuntime();
      state.loadingMapId = mapEntityId;

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

      // Image lives in Firestore (images/entity_{id}_map). Live-listen so
      // a GM's upload (via the entity form) updates the Map tab for
      // everyone without a reload.
      placeholderEl.style.display = 'block';
      containerEl.style.display = 'none';
      placeholderEl.textContent = 'Loading map image...';

      const imageDocId = entityMapImageDocId(mapEntityId);

      // Phase 7c-1: paint instantly from IndexedDB cache (if any) while
      // the listener below does its network round-trip. state.loadedMapId
      // check guards against the live snapshot having already won the
      // race and rendered first — cache is a fallback, never an override.
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
            ? 'No map image for "' + (mapEntity.name || 'this location') + '" yet. Add one via Edit Entity in the Codex.'
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
            // (constrained by whichever of width/max-height binds first),
            // so fitBounds has no mismatched axis to leave a margin on.
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
            state.leafletMap = map;
            state.loadedMapId = mapEntityId;

            map.on('click', function (e) {
              if (state.mapMode !== 'add' || state.currentRole !== 'gm') return;
              const x = e.latlng.lng;
              const y = state.mapImgHeight - e.latlng.lat;
              openPinForm({ x: x, y: y });
            });

            setTimeout(function () {
              map.invalidateSize();
              map.fitBounds(bounds);
              map.setMinZoom(map.getZoom());
              map.setMaxBounds(bounds);

              renderPins();
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
