import {
  getFirestore, collection, onSnapshot, doc, addDoc, deleteDoc
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import { firebaseApp } from './firebase.js';
import { state } from './state.js';
import { renderList, renderDetailForSelected } from './codex.js';
import { renderAdminRootMapSelect } from './admin.js';
import { getCachedImage, putCachedImage } from './images.js';

const db = getFirestore(firebaseApp);


    const mapGmControlsEl = document.getElementById('map-gm-controls');
    const addPinBtn = document.getElementById('map-add-pin-btn');
    const removePinBtn = document.getElementById('map-remove-pin-btn');
    const modeHintEl = document.getElementById('map-mode-hint');
    const mapBackBtn = document.getElementById('map-back-btn');
    const mapImageUploadEl = document.getElementById('map-image-upload');
    const mapImageUploadInputEl = document.getElementById('map-image-upload-input');
    const mapImageUploadStatusEl = document.getElementById('map-image-upload-status');

    const MAP_IMAGE_MAX_DIMENSION = 4000; // px, before compression
    const MAP_IMAGE_MAX_RAW_BYTES = 750 * 1024; // ~750KB raw ceiling (Firestore 1MiB doc cap / ~33% base64 overhead) — block, don't chunk


    function updateBackButtonVisibility() {
      mapBackBtn.style.display = state.mapNavStack.length ? 'block' : 'none';
    }

    function navigateToChildMap(mapId) {
      state.mapNavStack.push(state.currentMapId);
      state.currentMapId = mapId;
      updateBackButtonVisibility();
      loadMap(state.currentMapId);
    }

    mapBackBtn.addEventListener('click', function () {
      if (!state.mapNavStack.length) return;
      state.currentMapId = state.mapNavStack.pop();
      updateBackButtonVisibility();
      loadMap(state.currentMapId);
    });

    const pinFormOverlayEl = document.getElementById('pin-form-overlay');
    const pinFormEntryEl = document.getElementById('pin-form-entry');
    const pinFormEntryFieldsEl = document.getElementById('pin-form-entry-fields');
    const pinFormChildMapFieldsEl = document.getElementById('pin-form-childmap-fields');
    const pinFormChildMapExistingFieldsEl = document.getElementById('pin-form-childmap-existing-fields');
    const pinFormChildMapNewFieldsEl = document.getElementById('pin-form-childmap-new-fields');
    const pinFormChildMapSelectEl = document.getElementById('pin-form-childmap-select');
    const pinFormChildMapNameEl = document.getElementById('pin-form-childmap-name');
    const pinFormRadiusEl = document.getElementById('pin-form-radius');
    const pinFormErrorEl = document.getElementById('pin-form-error');
    const pinFormSaveBtn = document.getElementById('pin-form-save');
    const pinFormCancelBtn = document.getElementById('pin-form-cancel');

    function getPinFormType() {
      const checked = document.querySelector('input[name="pin-form-type"]:checked');
      return checked ? checked.value : 'entry';
    }

    function getChildMapMode() {
      const checked = document.querySelector('input[name="pin-form-childmap-mode"]:checked');
      return checked ? checked.value : 'existing';
    }

    function updatePinFormTypeVisibility() {
      const type = getPinFormType();
      pinFormEntryFieldsEl.style.display = (type === 'entry') ? 'block' : 'none';
      pinFormChildMapFieldsEl.style.display = (type === 'childmap') ? 'block' : 'none';
    }

    function updateChildMapModeVisibility() {
      const mode = getChildMapMode();
      pinFormChildMapExistingFieldsEl.style.display = (mode === 'existing') ? 'block' : 'none';
      pinFormChildMapNewFieldsEl.style.display = (mode === 'new') ? 'block' : 'none';
    }

    Array.prototype.forEach.call(document.querySelectorAll('input[name="pin-form-type"]'), function (radio) {
      radio.addEventListener('change', updatePinFormTypeVisibility);
    });
    Array.prototype.forEach.call(document.querySelectorAll('input[name="pin-form-childmap-mode"]'), function (radio) {
      radio.addEventListener('change', updateChildMapModeVisibility);
    });

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

      document.querySelector('input[name="pin-form-type"][value="entry"]').checked = true;
      document.querySelector('input[name="pin-form-childmap-mode"][value="existing"]').checked = true;
      updatePinFormTypeVisibility();
      updateChildMapModeVisibility();

      pinFormEntryEl.innerHTML = '';
      state.allEntries
        .slice()
        .sort(function (a, b) { return (a.name || '').localeCompare(b.name || ''); })
        .forEach(function (entry) {
          const opt = document.createElement('option');
          opt.value = entry.id;
          opt.textContent = entry.name;
          pinFormEntryEl.appendChild(opt);
        });

      // Candidate child maps: any map that isn't the current map itself.
      // Not excluding deeper cycles (e.g. linking to an ancestor) here —
      // simple guard, not exhaustive; GM is trusted not to build a loop.
      pinFormChildMapSelectEl.innerHTML = '';
      const candidates = state.allMaps
        .filter(function (m) { return m.id !== state.currentMapId; })
        .sort(function (a, b) { return (a.name || '').localeCompare(b.name || ''); });
      if (candidates.length === 0) {
        const opt = document.createElement('option');
        opt.textContent = '(no other maps yet — create one below)';
        opt.disabled = true;
        pinFormChildMapSelectEl.appendChild(opt);
        document.querySelector('input[name="pin-form-childmap-mode"][value="new"]').checked = true;
        updateChildMapModeVisibility();
      } else {
        candidates.forEach(function (m) {
          const opt = document.createElement('option');
          opt.value = m.id;
          opt.textContent = m.name;
          pinFormChildMapSelectEl.appendChild(opt);
        });
      }

      pinFormChildMapNameEl.value = '';
      pinFormRadiusEl.value = '150';

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

      const type = getPinFormType();

      if (type === 'entry') {
        const entryId = pinFormEntryEl.value;
        if (!entryId) {
          pinFormErrorEl.textContent = 'No entries available to link.';
          pinFormErrorEl.style.display = 'block';
          return;
        }
        savePin({
          entryId: entryId,
          x: state.pendingPinCoords.x,
          y: state.pendingPinCoords.y,
          mapId: state.currentMapId
        });
        return;
      }

      // type === 'childmap'
      const radius = Number(pinFormRadiusEl.value);
      if (!radius || radius <= 0) {
        pinFormErrorEl.textContent = 'Radius must be a positive number.';
        pinFormErrorEl.style.display = 'block';
        return;
      }

      const mode = getChildMapMode();
      if (mode === 'existing') {
        const childMapId = pinFormChildMapSelectEl.value;
        if (!childMapId) {
          pinFormErrorEl.textContent = 'No child map selected.';
          pinFormErrorEl.style.display = 'block';
          return;
        }
        savePin({
          childMapId: childMapId,
          radius: radius,
          x: state.pendingPinCoords.x,
          y: state.pendingPinCoords.y,
          mapId: state.currentMapId
        });
        return;
      }

      // mode === 'new': create the map doc first, then the pin referencing it.
      // No image field — set via "Set map image" (Phase 7b-2) after
      // navigating to the new map.
      const name = pinFormChildMapNameEl.value.trim();
      if (!name) {
        pinFormErrorEl.textContent = 'New map needs a name.';
        pinFormErrorEl.style.display = 'block';
        return;
      }

      pinFormSaveBtn.disabled = true;
      addDoc(collection(db, 'maps'), {
        name: name,
        parentMapId: state.currentMapId
      }).then(function (mapDocRef) {
        return savePin({
          childMapId: mapDocRef.id,
          radius: radius,
          x: state.pendingPinCoords.x,
          y: state.pendingPinCoords.y,
          mapId: state.currentMapId
        });
      }).catch(function (err) {
        pinFormSaveBtn.disabled = false;
        pinFormErrorEl.textContent = 'Create map failed: ' + err.message;
        pinFormErrorEl.style.display = 'block';
      });
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
      let label;
      if (pin.childMapId) {
        const targetMap = state.allMaps.find(function (m) { return m.id === pin.childMapId; });
        label = targetMap ? ('map link: ' + targetMap.name) : '(unlinked map pin)';
      } else {
        const entry = state.allEntries.find(function (e) { return e.id === pin.entryId; });
        label = entry ? entry.name : '(unlinked pin)';
      }
      const confirmed = window.confirm('Remove pin for "' + label + '"?');
      if (!confirmed) return;

      deleteDoc(doc(db, 'pins', pin.id)).catch(function (err) {
        window.alert('Remove pin failed: ' + err.message);
      });
    }

    function switchToCodexEntry(entryId) {
      state.selectedId = entryId;
      renderList();
      renderDetailForSelected();

      document.querySelectorAll('nav#tabs button').forEach(function (b) { b.classList.remove('active'); });
      document.querySelectorAll('.tab-panel').forEach(function (p) { p.classList.remove('active'); });
      document.getElementById('tab-btn-codex').classList.add('active');
      document.getElementById('codex-panel').classList.add('active');
    }

    function renderPins() {
      if (!state.leafletMap) return;
      if (!state.pinLayer) {
        state.pinLayer = L.layerGroup().addTo(state.leafletMap);
      }
      state.pinLayer.clearLayers();

      const pinsForCurrentMap = state.allPins.filter(function (pin) {
        return pin.mapId ? pin.mapId === state.currentMapId : state.currentMapId === state.rootMapId;
      });

      pinsForCurrentMap.forEach(function (pin) {
        const lat = state.mapImgHeight - pin.y;

        if (pin.childMapId) {
          // Circle pin: links to a child map. Radius is in map units (this
          // map's own pixel coordinate space), scaling visually with zoom —
          // meant to be sized to roughly match the region it zooms into.
          const targetMap = state.allMaps.find(function (m) { return m.id === pin.childMapId; });
          const circle = L.circle([lat, pin.x], {
            radius: pin.radius || 60,
            color: '#8a4fd6',
            weight: 2,
            fillColor: '#8a4fd6',
            fillOpacity: 0.2
          });
          circle.bindTooltip(targetMap ? ('\u2192 ' + targetMap.name) : '(unlinked map pin)');
          circle.on('click', function () {
            if (state.mapMode === 'remove' && state.currentRole === 'gm') {
              removePin(pin);
              return;
            }
            if (targetMap) {
              navigateToChildMap(targetMap.id);
            }
          });
          circle.addTo(state.pinLayer);
          return;
        }

        const entry = state.allEntries.find(function (e) { return e.id === pin.entryId; });
        const marker = L.marker([lat, pin.x]);
        marker.bindTooltip(entry ? entry.name : '(unlinked pin)');
        marker.on('click', function () {
          if (state.mapMode === 'remove' && state.currentRole === 'gm') {
            removePin(pin);
            return;
          }
          if (entry) {
            switchToCodexEntry(entry.id);
          }
        });
        marker.addTo(state.pinLayer);
      });
    }

    function attachPinsListener() {
      onSnapshot(collection(db, 'pins'), function (snapshot) {
        state.allPins = [];
        snapshot.forEach(function (docSnap) {
          state.allPins.push(Object.assign({ id: docSnap.id }, docSnap.data()));
        });
        renderPins();
      });
    }

    // --- Maps (Phase 6): dynamic map registry. Root is no longer a
    // structural convention (parentMapId === null) — it's a GM-selected
    // pointer in config/campaign.state.rootMapId (Phase 7b). parentMapId still
    // means "nesting parent" only; multiple maps can have it unset
    // without any of them being the app's root.
    function attachConfigListener() {
      onSnapshot(doc(db, 'config', 'campaign'), function (docSnap) {
        state.rootMapId = docSnap.exists() ? (docSnap.data().state.rootMapId || null) : null;
        // Bugfix: only fall back to state.rootMapId when state.currentMapId is
        // unset/invalid (resolveCurrentMapId's job, for maps-collection
        // changes). A root-pointer change itself must force-follow
        // whenever the user is at the top level (no child-map nav
        // stack) — otherwise switching root map->map or map->none while
        // already viewing the root silently did nothing.
        if (state.mapNavStack.length === 0) {
          state.currentMapId = state.rootMapId;
        } else {
          resolveCurrentMapId();
        }
        renderAdminRootMapSelect();
        if (document.getElementById('map-panel').classList.contains('active')) {
          ensureMapTabReady();
        }
      }, function (err) {
        console.error('Config listener error:', err.message);
      });
    }

    function resolveCurrentMapId() {
      if (!state.currentMapId || !state.allMaps.find(function (m) { return m.id === state.currentMapId; })) {
        state.currentMapId = state.rootMapId;
      }
    }

    function attachMapsListener() {
      onSnapshot(collection(db, 'maps'), function (snapshot) {
        state.allMaps = [];
        snapshot.forEach(function (docSnap) {
          state.allMaps.push(Object.assign({ id: docSnap.id }, docSnap.data()));
        });
        resolveCurrentMapId();
        renderAdminRootMapSelect();
        if (document.getElementById('map-panel').classList.contains('active')) {
          ensureMapTabReady();
        }
      });
    }

    function ensureMapTabReady() {
      // No early-return on falsy state.currentMapId: null is now a legitimate
      // steady state (root explicitly set to none), not just "not loaded
      // yet" — loadMap(null) correctly tears down any stale map and
      // shows the right placeholder either way.
      if (state.leafletMap && state.loadedMapId === state.currentMapId) {
        renderPins();
        return;
      }
      loadMap(state.currentMapId);
    }


    // --- Phase 7c-1: IndexedDB cache for map images. Not localStorage —
    // base64 image blobs can exceed its quota. Firestore's own listener
    // stays the source of truth (correctness, live updates); this cache
    // only provides instant paint from a prior session while the
    // listener does its network round-trip, keyed by the image doc ID
    // with a `version` field (uploadedAt millis) so we can tell a cached
    // entry apart from a newer live one. First application of this
    // pattern, per the phase plan — needs to provably work here before
    // 7d's tiling (many docs per map) depends on the same mechanism.
    const IMAGE_CACHE_DB_NAME = 'codexImageCache';
    const IMAGE_CACHE_DB_VERSION = 1;
    const IMAGE_CACHE_STORE = 'images';


    function loadMap(mapId) {
      const mapDoc = state.allMaps.find(function (m) { return m.id === mapId; });
      const placeholderEl = document.getElementById('map-tab-placeholder');
      const containerEl = document.getElementById('map-container');

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

      state.mapImageUploadTargetMapId = mapDoc ? mapId : null;
      mapImageUploadEl.style.display = (state.currentRole === 'gm' && mapDoc) ? 'flex' : 'none';

      if (!mapDoc) {
        placeholderEl.style.display = 'block';
        containerEl.style.display = 'none';
        placeholderEl.textContent = state.rootMapId
          ? 'No map configured yet.'
          : 'No root map selected yet.' + (state.currentRole === 'gm' ? ' Set one in the Admin tab.' : ' Ask your GM to set one up.');
        return;
      }

      if (typeof L === 'undefined') {
        placeholderEl.style.display = 'block';
        containerEl.style.display = 'none';
        placeholderEl.textContent = 'Map library (Leaflet) failed to load.';
        return;
      }

      // Phase 7b-3: image lives in Firestore (images/map_{mapId}_primary),
      // not a static Hosting path. Live-listen so a GM's upload (7b-2)
      // updates the Map tab for everyone without a reload.
      placeholderEl.style.display = 'block';
      containerEl.style.display = 'none';
      placeholderEl.textContent = 'Loading map image...';

      const imageDocId = 'map_' + mapId + '_primary';

      // Phase 7c-1: paint instantly from IndexedDB cache (if any) while
      // the listener below does its network round-trip. state.loadedMapId
      // check guards against the live snapshot having already won the
      // race and rendered first — cache is a fallback, never an override.
      getCachedImage(imageDocId).then(function (cached) {
        if (cached && state.mapImageUploadTargetMapId === mapId && state.loadedMapId !== mapId) {
          state.currentMapImageDims = { width: cached.width, height: cached.height };
          renderMapImage(mapId, mapDoc, cached);
        }
      });

      state.mapImageUnsub = onSnapshot(doc(db, 'images', imageDocId), function (imgSnap) {
        if (state.loadedMapId === mapId && state.leafletMap) {
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
            ? 'No image set for "' + (mapDoc.name || 'this map') + '" yet. Use "Set map image" above.'
            : 'This map has no image yet — ask your GM.';
          return;
        }
        const imgData = imgSnap.data();
        state.currentMapImageDims = { width: imgData.width, height: imgData.height };
        renderMapImage(mapId, mapDoc, imgData);
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
      }, function (err) {
        placeholderEl.style.display = 'block';
        containerEl.style.display = 'none';
        placeholderEl.textContent = 'Map image failed to load: ' + err.message;
      });
    }

    function renderMapImage(mapId, mapDoc, imageDoc) {
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
            state.loadedMapId = mapId;

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

export {
  attachPinsListener, attachMapsListener, attachConfigListener,
  ensureMapTabReady, loadMap
};
