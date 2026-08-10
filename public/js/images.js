import {
  getFirestore, doc, collection, setDoc, addDoc, deleteDoc, updateDoc,
  writeBatch, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import { firebaseApp } from './firebase.js';
import { state } from './state.js';

const db = getFirestore(firebaseApp);

// Refactor-split fix (Aug 2026): these constants live here (their sole
// consumer) — module scope isn't shared; leaving them in map.js broke
// every reference. The eslint no-undef CI gate now catches this class.
const IMAGE_MAX_DIMENSION = 4000; // px, before compression
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

    function entityMapImageDocId(entityId) {
      return 'entity_' + entityId + '_map';
    }

    // Upload a map image for a Location entity. Deterministic doc ID:
    // overwriting it IS "replace this entity's map image" — idempotent,
    // no orphans. Also maintains the entity's hasMapImage flag (used for
    // synchronous circle-vs-marker pin rendering) — skipped when
    // opts.entityDocExists is false (New Entity form: the entity doc isn't
    // written until Save; the form sets the flag in its own save payload).
    function uploadEntityMapImage(entityId, file, opts) {
      const onStatus = opts && opts.onStatus;
      const entityDocExists = !opts || opts.entityDocExists !== false;
      return processImageFile(file, onStatus).then(function (processed) {
        if (onStatus) onStatus('Uploading...');
        const imageDocId = entityMapImageDocId(entityId);
        const imageData = {
          ownerType: 'entity',
          ownerId: entityId,
          role: 'map',
          data: processed.dataUrl,
          contentType: 'image/webp',
          width: processed.width,
          height: processed.height,
          sizeBytes: processed.sizeBytes,
          uploadedAt: serverTimestamp()
        };
        if (entityDocExists) {
          const batch = writeBatch(db);
          batch.set(doc(db, 'images', imageDocId), imageData);
          batch.update(doc(db, 'entities', entityId), {
            hasMapImage: true, updatedAt: serverTimestamp()
          });
          return batch.commit().then(function () { return imageDocId; });
        }
        return setDoc(doc(db, 'images', imageDocId), imageData)
          .then(function () { return imageDocId; });
      });
    }

    function deleteEntityMapImage(entityId, opts) {
      const entityDocExists = !opts || opts.entityDocExists !== false;
      const imageDocId = entityMapImageDocId(entityId);
      if (entityDocExists) {
        const batch = writeBatch(db);
        batch.delete(doc(db, 'images', imageDocId));
        batch.update(doc(db, 'entities', entityId), {
          hasMapImage: false, updatedAt: serverTimestamp()
        });
        return batch.commit();
      }
      return deleteDoc(doc(db, 'images', imageDocId));
    }

    // Gallery images: 0+ per entity, auto-ID docs (content entities, not
    // structural singletons), each with its own gm-only/all-players
    // visibility like loreItems. New uploads start hidden.
    function uploadEntityGalleryImage(entityId, file, opts) {
      const onStatus = opts && opts.onStatus;
      return processImageFile(file, onStatus).then(function (processed) {
        if (onStatus) onStatus('Uploading...');
        return addDoc(collection(db, 'images'), {
          ownerType: 'entity',
          ownerId: entityId,
          role: 'gallery',
          visibility: 'gm-only',
          data: processed.dataUrl,
          contentType: 'image/webp',
          width: processed.width,
          height: processed.height,
          sizeBytes: processed.sizeBytes,
          uploadedAt: serverTimestamp()
        }).then(function (ref) { return ref.id; });
      });
    }

    function deleteEntityGalleryImage(imageDocId) {
      return deleteDoc(doc(db, 'images', imageDocId));
    }

    function setGalleryImageVisibility(imageDocId, visibility) {
      return updateDoc(doc(db, 'images', imageDocId), { visibility: visibility });
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
  entityMapImageDocId,
  uploadEntityMapImage, deleteEntityMapImage,
  uploadEntityGalleryImage, deleteEntityGalleryImage, setGalleryImageVisibility,
  getCachedImage, putCachedImage
};
