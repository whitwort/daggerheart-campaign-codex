import {
  getFirestore, doc, collection, addDoc, deleteDoc, updateDoc,
  writeBatch, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import { firebaseApp } from './firebase.js';
import { state } from './state.js';
import { sortedSources } from './sources.js';
import { isShareableToWholeParty } from './visibility.js';

const db = getFirestore(firebaseApp);

// Refactor-split fix (Aug 2026): these constants live here (their sole
// consumer) — module scope isn't shared; leaving them in map.js broke
// every reference. The eslint no-undef CI gate now catches this class.
const IMAGE_MAX_DIMENSION = 6000; // px, before compression
const IMAGE_MAX_RAW_BYTES = 750 * 1024; // ~750KB raw ceiling (Firestore 1MiB doc cap / ~33% base64 overhead) — block, don't chunk
// Phase 10a: quality search, highest first. Fixed quality:85 wasted headroom
// on simple/high-contrast images (flat colors, line art, text) that
// compress well under budget at much higher quality; this tries each level
// in turn and keeps the first (highest) that fits IMAGE_MAX_RAW_BYTES.
const IMAGE_QUALITY_LEVELS = [95, 92, 88, 85, 80, 75];
const IMAGE_CACHE_DB_NAME = 'codexImageCache';
const IMAGE_CACHE_DB_VERSION = 1;
const IMAGE_CACHE_STORE = 'images';

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

    // Process a File through the resize/WebP pipeline. Resolves
    // { dataUrl, width, height, sizeBytes }; rejects with a user-facing
    // Error message on any failure.
    function processImageFile(file, onStatus) {
      function status(text) { if (onStatus) onStatus(text); }
      return new Promise(function (resolve, reject) {
        status('Processing...');
        const objectUrl = URL.createObjectURL(file);
        const img = new Image();

        img.onload = function () {
          URL.revokeObjectURL(objectUrl);
          try {
            let targetW = img.naturalWidth;
            let targetH = img.naturalHeight;
            if (targetW > IMAGE_MAX_DIMENSION || targetH > IMAGE_MAX_DIMENSION) {
              const scale = IMAGE_MAX_DIMENSION / Math.max(targetW, targetH);
              targetW = Math.round(targetW * scale);
              targetH = Math.round(targetH * scale);
            }

            const canvas = document.createElement('canvas');
            canvas.width = targetW;
            canvas.height = targetH;
            const ctx = canvas.getContext('2d');
            ctx.drawImage(img, 0, 0, targetW, targetH);
            const imageData = ctx.getImageData(0, 0, targetW, targetH);

            status('Encoding...');
            loadWebpEncoder().then(function (webpModule) {
              // Try quality levels highest-first; keep the first (best) one
              // that fits under the byte ceiling. Sequential, not parallel:
              // stops as soon as one fits, so the common case (simple map
              // art fits at 95) only pays for one encode.
              function tryQuality(i) {
                if (i >= IMAGE_QUALITY_LEVELS.length) {
                  reject(new Error('Image too large after compression even at lowest quality (max ' +
                    Math.round(IMAGE_MAX_RAW_BYTES / 1024) + 'KB). Try a smaller source image.'));
                  return;
                }
                const q = IMAGE_QUALITY_LEVELS[i];
                webpModule.encode(imageData, { quality: q }).then(function (arrayBuffer) {
                  const blob = new Blob([arrayBuffer], { type: 'image/webp' });
                  console.log('[entity-image-upload] libwebp encode @q' + q + ': ' + blob.size + ' bytes (' +
                    Math.round(blob.size / 1024) + 'KB), dims=' + targetW + 'x' + targetH);

                  if (blob.size > IMAGE_MAX_RAW_BYTES) {
                    tryQuality(i + 1);
                    return;
                  }

                  const reader = new FileReader();
                  reader.onload = function () {
                    resolve({ dataUrl: reader.result, width: targetW, height: targetH, sizeBytes: blob.size });
                  };
                  reader.onerror = function () { reject(new Error('Read failed.')); };
                  reader.readAsDataURL(blob);
                }).catch(function (err) {
                  reject(new Error('WebP encoding failed: ' + err.message));
                });
              }
              tryQuality(0);
            }).catch(function (err) {
              reject(new Error('WebP encoding failed: ' + err.message));
            });
          } catch (err) {
            reject(new Error('Processing error: ' + err.message));
          }
        };
        img.onerror = function () {
          URL.revokeObjectURL(objectUrl);
          reject(new Error('Could not read image file.'));
        };
        img.src = objectUrl;
      });
    }

    // Gallery images: 0+ per entity, auto-ID docs (content entities, not
    // structural singletons), each with its own gm-only/all-players
    // visibility like loreItems. New uploads start hidden.

    function uploadEntityGalleryImage(entityId, file, opts) {
      const onStatus = opts && opts.onStatus;
      return processImageFile(file, onStatus).then(function (processed) {
        if (onStatus) onStatus('Uploading...');
        // Portrait is explicit only (Set portrait) -- no auto-promotion
        // of an entity's first upload, even into an empty gallery.
        const doc_ = {
          ownerType: 'entity',
          ownerId: entityId,
          role: 'gallery',
          visibility: 'gm-only',
          sourceId: (sortedSources()[0] && sortedSources()[0].id) || null,
          data: processed.dataUrl,
          contentType: 'image/webp',
          width: processed.width,
          height: processed.height,
          sizeBytes: processed.sizeBytes,
          uploadedAt: serverTimestamp(),
          isPortrait: false
        };
        return addDoc(collection(db, 'images'), doc_).then(function (ref) { return ref.id; });
      });
    }

    // Deleting the gallery image currently flagged isMap must also clear
    // the owning entity's hasMapImage -- otherwise map.js's synchronous
    // marker-vs-circle pin decision (isMapEntity) keeps treating this
    // Location as having a map after the image backing it is gone.
    function deleteEntityGalleryImage(imageDocId) {
      const img = state.currentEntityImages.find(function (i) { return i.id === imageDocId; });
      if (img && img.isMap) {
        const batch = writeBatch(db);
        batch.delete(doc(db, 'images', imageDocId));
        batch.update(doc(db, 'entities', img.ownerId), {
          hasMapImage: false, mapImageVisibleToPlayers: false, updatedAt: serverTimestamp()
        });
        return batch.commit();
      }
      return deleteDoc(doc(db, 'images', imageDocId));
    }

    // Gallery image visibility writes (toggle switch, and any future
    // 3-state control) go through sharing.js's shareImageVisibility --
    // that's the single write seam S6 hooks notification fan-out into.
    // The map-sync batch that used to live here (keeping
    // entities.mapImageVisibleToPlayers in sync when the toggled image is
    // the entity's current map image) moved there with it, verbatim.

    function setGalleryImageSource(imageDocId, sourceId) {
      return updateDoc(doc(db, 'images', imageDocId), { sourceId: sourceId });
    }

    // Sets imageDocId as entityId's portrait (clearing isPortrait on any
    // previous one) and saves its crop state in the same batch.
    function setEntityPortrait(entityId, imageDocId, cropState) {
      const batch = writeBatch(db);
      state.currentEntityImages.forEach(function (img) {
        if (img.ownerId === entityId && img.role === 'gallery' && img.isPortrait && img.id !== imageDocId) {
          batch.update(doc(db, 'images', img.id), { isPortrait: false });
        }
      });
      batch.update(doc(db, 'images', imageDocId), Object.assign({ isPortrait: true }, cropState));
      return batch.commit();
    }

    // Map designation (Phase 13+ rework -- replaces the old standalone
    // Map image upload/delete UI): isMap on a gallery image, same
    // pattern as isPortrait -- at most one true per entity, cleared on
    // any previous holder in the same batch. entities.hasMapImage and
    // entities.mapImageVisibleToPlayers stay in sync in the same batch
    // too -- map.js's marker-vs-circle pin decision (isMapEntity) and
    // the player-visibility gating on the map icon both need this
    // synchronously for every entity with a pin/list row on screen, not
    // just the one entity whose images happen to be live-loaded (the
    // per-entity images listener only ever covers the currently-selected
    // Codex entity).
    function setEntityMap(entityId, imageDocId) {
      const batch = writeBatch(db);
      let pickedImg = null;
      state.currentEntityImages.forEach(function (img) {
        if (img.ownerId === entityId && img.role === 'gallery' && img.isMap && img.id !== imageDocId) {
          batch.update(doc(db, 'images', img.id), { isMap: false });
        }
        if (img.id === imageDocId) pickedImg = img;
      });
      batch.update(doc(db, 'images', imageDocId), { isMap: true });
      batch.update(doc(db, 'entities', entityId), {
        hasMapImage: true,
        mapImageVisibleToPlayers: !!pickedImg && isShareableToWholeParty(pickedImg),
        updatedAt: serverTimestamp()
      });
      return batch.commit();
    }

    // Unlike portrait (always resolves to SOME image once a gallery is
    // non-empty), a Location can legitimately have no map image at all
    // -- this clears the designation entirely rather than reassigning
    // it, for whichever image currently holds it.
    function clearEntityMap(entityId) {
      const batch = writeBatch(db);
      state.currentEntityImages.forEach(function (img) {
        if (img.ownerId === entityId && img.role === 'gallery' && img.isMap) {
          batch.update(doc(db, 'images', img.id), { isMap: false });
        }
      });
      batch.update(doc(db, 'entities', entityId), { hasMapImage: false, mapImageVisibleToPlayers: false, updatedAt: serverTimestamp() });
      return batch.commit();
    }

    // One-time, idempotent migration: an entity's OLD standalone map
    // image (role:'map', deterministic doc ID entity_{id}_map, from
    // before the Gallery's Set map button existed) becomes a normal
    // gallery image with isMap:true instead. Safe to call repeatedly --
    // once the legacy doc is gone, legacyDoc won't be found again and
    // this is a no-op. Triggered from codex.js's setEntityImagesTarget
    // whenever that entity's images are loaded (i.e. its Codex card is
    // opened) and a legacy doc is present with no gallery image already
    // holding isMap -- NOT run proactively for every entity, so an
    // entity whose Codex card is never opened keeps working via
    // map.js's own legacy-doc fallback read until it happens to migrate.
    function migrateLegacyMapImageIfNeeded(entityId, images) {
      const legacyDoc = images.find(function (img) { return img.ownerId === entityId && img.role === 'map'; });
      if (!legacyDoc) return;
      const alreadyHasNewMap = images.some(function (img) {
        return img.ownerId === entityId && img.role === 'gallery' && img.isMap;
      });
      if (alreadyHasNewMap) return;
      const newRef = doc(collection(db, 'images'));
      const batch = writeBatch(db);
      batch.set(newRef, {
        ownerType: 'entity',
        ownerId: entityId,
        role: 'gallery',
        visibility: 'gm-only',
        sourceId: (sortedSources()[0] && sortedSources()[0].id) || null,
        isMap: true,
        data: legacyDoc.data,
        contentType: legacyDoc.contentType,
        width: legacyDoc.width,
        height: legacyDoc.height,
        sizeBytes: legacyDoc.sizeBytes,
        uploadedAt: legacyDoc.uploadedAt || serverTimestamp()
      });
      batch.delete(doc(db, 'images', legacyDoc.id));
      // hasMapImage is already true (that's how the legacy doc got
      // created in the first place) -- but mapImageVisibleToPlayers may
      // not exist yet on an entity doc this old, and the migrated image
      // is always gm-only (see visibility above), so set it explicitly
      // rather than leaving it absent.
      batch.update(doc(db, 'entities', entityId), { mapImageVisibleToPlayers: false });
      batch.commit().catch(function (err) {
        console.error('[images] legacy map image migration failed:', err.message);
      });
    }


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


export {
  uploadEntityGalleryImage, deleteEntityGalleryImage, setGalleryImageSource,
  setEntityPortrait, setEntityMap, clearEntityMap, migrateLegacyMapImageIfNeeded,
  getCachedImage, putCachedImage
};
