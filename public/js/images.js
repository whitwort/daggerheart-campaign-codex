import {
  getFirestore, doc, setDoc, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import { firebaseApp } from './firebase.js';
import { state } from './state.js';

const db = getFirestore(firebaseApp);

const mapImageUploadInputEl = document.getElementById('map-image-upload-input');
const mapImageUploadStatusEl = document.getElementById('map-image-upload-status');

    function saveMapImage(mapId, base64Data, width, height, sizeBytes) {
      // Deterministic doc ID: overwriting it IS "delete prior primary
      // image for this map" — no separate query+delete needed, no
      // orphaned docs possible.
      return setDoc(doc(db, 'images', 'map_' + mapId + '_primary'), {
        ownerType: 'map',
        ownerId: mapId,
        role: 'primary',
        data: base64Data,
        contentType: 'image/webp',
        width: width,
        height: height,
        sizeBytes: sizeBytes,
        uploadedAt: serverTimestamp()
      });
    }

    // Real WebP encoder (Phase 7b fix): canvas.toBlob('image/webp') isn't
    // reliable — iOS Safari silently falls back to PNG with no error, and
    // even where browsers do encode real WebP, native encoders compress
    // worse than libwebp at the same nominal quality. jSquash ships an
    // actual libwebp build compiled to WASM, matching the old offline
    // `convert -quality 85` pipeline. Loaded lazily (only when a GM
    // actually uploads) and dynamically, not as a top-level import, so a
    // CDN hiccup breaks only the upload feature, never the whole app.
    function loadWebpEncoder() {
      if (!state.webpEncoderModulePromise) {
        state.webpEncoderModulePromise = import('https://esm.sh/@jsquash/webp');
      }
      return state.webpEncoderModulePromise;
    }


    mapImageUploadInputEl.addEventListener('change', function () {
      const file = mapImageUploadInputEl.files[0];
      if (!file) return;
      const targetMapId = state.mapImageUploadTargetMapId;
      if (!targetMapId) {
        mapImageUploadStatusEl.textContent = 'No map selected.';
        mapImageUploadInputEl.value = '';
        return;
      }

      mapImageUploadInputEl.disabled = true;
      mapImageUploadStatusEl.textContent = 'Processing...';
      const priorDims = state.currentMapImageDims; // captured before overwrite, for the dimension-change warning below

      const objectUrl = URL.createObjectURL(file);
      const img = new Image();

      function fail(message) {
        mapImageUploadStatusEl.textContent = message;
        mapImageUploadInputEl.disabled = false;
        mapImageUploadInputEl.value = '';
      }

      img.onload = function () {
        URL.revokeObjectURL(objectUrl);
        try {
          let targetW = img.naturalWidth;
          let targetH = img.naturalHeight;
          if (targetW > MAP_IMAGE_MAX_DIMENSION || targetH > MAP_IMAGE_MAX_DIMENSION) {
            const scale = MAP_IMAGE_MAX_DIMENSION / Math.max(targetW, targetH);
            targetW = Math.round(targetW * scale);
            targetH = Math.round(targetH * scale);
          }

          const canvas = document.createElement('canvas');
          canvas.width = targetW;
          canvas.height = targetH;
          const ctx = canvas.getContext('2d');
          ctx.drawImage(img, 0, 0, targetW, targetH);
          const imageData = ctx.getImageData(0, 0, targetW, targetH);

          mapImageUploadStatusEl.textContent = 'Encoding...';
          loadWebpEncoder().then(function (webpModule) {
            return webpModule.encode(imageData, { quality: 85 });
          }).then(function (arrayBuffer) {
            const blob = new Blob([arrayBuffer], { type: 'image/webp' });
            console.log('[map-image-upload] libwebp encode: ' + blob.size + ' bytes (' +
              Math.round(blob.size / 1024) + 'KB), dims=' + targetW + 'x' + targetH);

            if (blob.size > MAP_IMAGE_MAX_RAW_BYTES) {
              fail('Image too large after compression (' + Math.round(blob.size / 1024) +
                'KB, max ' + Math.round(MAP_IMAGE_MAX_RAW_BYTES / 1024) + 'KB). Try a smaller source image.');
              return;
            }

            const reader = new FileReader();
            reader.onload = function () {
              mapImageUploadStatusEl.textContent = 'Uploading...';
              saveMapImage(targetMapId, reader.result, targetW, targetH, blob.size)
                .then(function () {
                  mapImageUploadStatusEl.textContent = 'Image updated (' + Math.round(blob.size / 1024) + 'KB).';
                  mapImageUploadInputEl.disabled = false;
                  mapImageUploadInputEl.value = '';
                  // QOL backlog item: replace this with a guided pin-fixup
                  // flow instead of a bare warning (see QOL-BACKLOG.md).
                  if (priorDims && (priorDims.width !== targetW || priorDims.height !== targetH)) {
                    alert('Warning: this map\'s image dimensions changed (' +
                      priorDims.width + 'x' + priorDims.height + ' \u2192 ' + targetW + 'x' + targetH +
                      '). Existing pins on this map are stored in the old pixel coordinates and may now be misaligned.');
                  }
                })
                .catch(function (err) { fail('Upload failed: ' + err.message); });
            };
            reader.onerror = function () { fail('Read failed.'); };
            reader.readAsDataURL(blob);
          }).catch(function (err) {
            fail('WebP encoding failed: ' + err.message);
          });
        } catch (err) {
          fail('Processing error: ' + err.message);
        }
      };
      img.onerror = function () {
        URL.revokeObjectURL(objectUrl);
        fail('Could not read image file.');
      };
      img.src = objectUrl;
    });


    function openImageCacheDb() {
      if (!state.imageCacheDbPromise) {
        state.imageCacheDbPromise = new Promise(function (resolve, reject) {
          if (!('indexedDB' in window)) {
            reject(new Error('IndexedDB not available'));
            return;
          }
          const req = indexedDB.open(IMAGE_CACHE_DB_NAME, IMAGE_CACHE_DB_VERSION);
          req.onupgradeneeded = function () {
            if (!req.result.objectStoreNames.contains(IMAGE_CACHE_STORE)) {
              req.result.createObjectStore(IMAGE_CACHE_STORE, { keyPath: 'docId' });
            }
          };
          req.onsuccess = function () { resolve(req.result); };
          req.onerror = function () { reject(req.error); };
        });
      }
      return state.imageCacheDbPromise;
    }

    function getCachedImage(docId) {
      return openImageCacheDb().then(function (db) {
        return new Promise(function (resolve, reject) {
          const tx = db.transaction(IMAGE_CACHE_STORE, 'readonly');
          const req = tx.objectStore(IMAGE_CACHE_STORE).get(docId);
          req.onsuccess = function () { resolve(req.result || null); };
          req.onerror = function () { reject(req.error); };
        });
      }).catch(function (err) {
        console.warn('[image-cache] read failed:', err.message);
        return null; // cache is an optimization only, never block the real load path on failure
      });
    }

    function putCachedImage(record) {
      return openImageCacheDb().then(function (db) {
        return new Promise(function (resolve, reject) {
          const tx = db.transaction(IMAGE_CACHE_STORE, 'readwrite');
          tx.objectStore(IMAGE_CACHE_STORE).put(record);
          tx.oncomplete = function () { resolve(); };
          tx.onerror = function () { reject(tx.error); };
        });
      }).catch(function (err) {
        console.warn('[image-cache] write failed:', err.message);
      });
    }


export { saveMapImage, getCachedImage, putCachedImage };
