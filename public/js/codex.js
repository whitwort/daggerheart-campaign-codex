import {
  getFirestore, collection, onSnapshot, doc, setDoc, addDoc, updateDoc, deleteDoc,
  query, where, writeBatch, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import { firebaseApp, CONFIG } from './firebase.js';
import { state } from './state.js';
import { attachListener, detachListener, safeSnapshotHandler } from './listeners.js';
import { renderMarkdownInto } from './markdown.js';
import { renderAdminRootEntitySelect } from './admin.js';
import {
  uploadEntityMapImage, deleteEntityMapImage,
  uploadEntityGalleryImage, deleteEntityGalleryImage, setGalleryImageVisibility
} from './images.js';

const db = getFirestore(firebaseApp);

    // --- Codex tab: entities + loreItems (Phase 8 schema) -------------------
    // `entities` unifies lore entries and locations; per-entity content
    // lives in `loreItems` docs with individual visibility. The old
    // `entries` collection (content_gm/content_player fields) is dead —
    // wipe decision, no migration.
    const categoryFilterEl = document.getElementById('codex-category-filter');
    const searchEl = document.getElementById('codex-search');
    const listEl = document.getElementById('codex-entities');
    const detailEl = document.getElementById('codex-detail');

    const formCategoryEl = document.getElementById('entity-form-category');

    CONFIG.categories.forEach(function (cat) {
      const filterOpt = document.createElement('option');
      filterOpt.value = cat;
      filterOpt.textContent = cat;
      categoryFilterEl.appendChild(filterOpt);

      const formOpt = document.createElement('option');
      formOpt.value = cat;
      formOpt.textContent = cat;
      formCategoryEl.appendChild(formOpt);
    });

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
          notifyVisibilityChange();
        }), function (err) {
          listEl.innerHTML = '<li>Error loading entities: ' + err.message + '</li>';
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
    // collection listener is off the table — we live-listen only to the
    // one entity currently in focus (open form wins over selection).
    // Manual lifecycle, same deliberate-exception stance as mapImageUnsub.
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
          renderEntityFormImages();
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
          const ta = (a.uploadedAt && a.uploadedAt.toMillis) ? a.uploadedAt.toMillis() : 0;
          const tb = (b.uploadedAt && b.uploadedAt.toMillis) ? b.uploadedAt.toMillis() : 0;
          return ta - tb;
        });
    }

    // Modules whose rendering depends on lore visibility (map.js: pin
    // filtering) register here — codex.js can't import map.js back
    // without a module cycle, so the dependency is inverted.
    const visibilityChangeHandlers = [];
    function registerVisibilityChangeHandler(fn) {
      visibilityChangeHandlers.push(fn);
    }
    function notifyVisibilityChange() {
      visibilityChangeHandlers.forEach(function (fn) { fn(); });
    }

    // --- Visibility model ---------------------------------------------------
    // Entities carry an explicit visibility flag ('gm-only' | 'all-players')
    // controlling whether players see the entity at all (list, pins,
    // related chips). Within a visible entity, loreItems keep their own
    // per-item visibility. All client-side render logic per the locked
    // security model. Docs missing the field (pre-flag test data) are
    // treated as gm-only.

    function isGmView() {
      return state.currentRole === 'gm' && !state.gmPreviewAsPlayer;
    }

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

    // --- List pane ----------------------------------------------------------

    function matchesFilters(entity) {
      const cat = categoryFilterEl.value;
      if (cat && entity.category !== cat) return false;

      const q = searchEl.value.trim().toLowerCase();
      if (!q) return true;
      const nameMatch = (entity.name || '').toLowerCase().indexOf(q) !== -1;
      const tagMatch = (entity.tags || []).some(function (t) {
        return t.toLowerCase().indexOf(q) !== -1;
      });
      return nameMatch || tagMatch;
    }

    function renderList() {
      const gmView = isGmView();
      const filtered = state.allEntities
        .filter(matchesFilters)
        .filter(function (e) { return gmView || isEntityPlayerVisible(e.id); })
        .sort(function (a, b) { return (a.name || '').localeCompare(b.name || ''); });

      listEl.innerHTML = '';
      if (filtered.length === 0) {
        const li = document.createElement('li');
        li.textContent = 'No entities match.';
        listEl.appendChild(li);
        return;
      }

      filtered.forEach(function (entity) {
        const li = document.createElement('li');
        li.dataset.id = entity.id;
        if (entity.id === state.selectedId) li.classList.add('active');

        const nameDiv = document.createElement('div');
        nameDiv.textContent = entity.name;
        if (gmView && entity.visibility !== 'all-players') {
          const hiddenSpan = document.createElement('span');
          hiddenSpan.className = 'entity-hidden-badge';
          hiddenSpan.textContent = 'hidden';
          nameDiv.appendChild(hiddenSpan);
        }
        const catDiv = document.createElement('div');
        catDiv.className = 'entity-category';
        catDiv.textContent = entity.category || '';

        li.appendChild(nameDiv);
        li.appendChild(catDiv);
        li.addEventListener('click', function () {
          state.selectedId = entity.id;
          renderList();
          renderDetailForSelected();
        });
        listEl.appendChild(li);
      });
    }

    // --- Detail pane --------------------------------------------------------

    function renderDetailForSelected() {
      const entity = state.allEntities.find(function (e) { return e.id === state.selectedId; });
      const gmView = isGmView();

      // Keep the per-entity images listener pointed at the entity in
      // focus; an open entity form wins (it may be a New form with a
      // pre-generated id that differs from the selection).
      if (!formOverlayEl.classList.contains('open')) {
        setEntityImagesTarget(entity ? entity.id : null);
      }

      if (!entity || (!gmView && !isEntityPlayerVisible(entity.id))) {
        detailEl.innerHTML = '<p id="codex-empty">Select an entity.</p>';
        return;
      }

      detailEl.innerHTML = '';

      const heading = document.createElement('h2');
      heading.textContent = entity.name;

      const badge = document.createElement('span');
      badge.id = 'codex-view-badge';
      badge.className = gmView ? 'gm' : 'player';
      badge.textContent = gmView ? 'GM view' : 'Player view';
      heading.appendChild(badge);
      detailEl.appendChild(heading);

      if (state.currentRole === 'gm' && gmView) {
        const entityHidden = entity.visibility !== 'all-players';
        const revealEntityBtn = document.createElement('button');
        revealEntityBtn.textContent = entityHidden ? 'Reveal entity' : 'Hide entity';
        revealEntityBtn.style.marginRight = '0.5rem';
        revealEntityBtn.addEventListener('click', function () {
          updateDoc(doc(db, 'entities', entity.id), {
            visibility: entityHidden ? 'all-players' : 'gm-only',
            updatedAt: serverTimestamp()
          }).catch(function (err) {
            window.alert('Visibility change failed: ' + err.message);
          });
        });
        detailEl.appendChild(revealEntityBtn);
      }

      if (state.currentRole === 'gm') {
        const toggleBtn = document.createElement('button');
        toggleBtn.textContent = state.gmPreviewAsPlayer ? 'Show GM content' : 'Preview player view';
        toggleBtn.addEventListener('click', function () {
          state.gmPreviewAsPlayer = !state.gmPreviewAsPlayer;
          renderList();
          renderDetailForSelected();
          notifyVisibilityChange();
        });
        detailEl.appendChild(toggleBtn);
      }

      const catP = document.createElement('p');
      const catEm = document.createElement('em');
      catEm.textContent = entity.category || '';
      catP.appendChild(catEm);
      detailEl.appendChild(catP);

      // --- Lore items ---
      const items = loreItemsForEntity(entity.id, gmView);
      const loreListDiv = document.createElement('div');
      loreListDiv.id = 'codex-lore-list';

      if (items.length === 0) {
        const emptyP = document.createElement('p');
        emptyP.className = 'lore-empty';
        emptyP.textContent = '(no lore for this view)';
        loreListDiv.appendChild(emptyP);
      }

      items.forEach(function (item) {
        const itemDiv = document.createElement('div');
        itemDiv.className = 'lore-item';

        if (gmView) {
          const barDiv = document.createElement('div');
          barDiv.className = 'lore-item-bar';

          const visBadge = document.createElement('span');
          visBadge.className = 'lore-vis-badge ' +
            (item.visibility === 'all-players' ? 'visible' : 'hidden');
          visBadge.textContent = item.visibility;
          barDiv.appendChild(visBadge);

          // One-tap reveal/hide — the core table interaction. No form,
          // no modal, single write. (Notifications wired in later.)
          if (item.visibility === 'gm-only' || item.visibility === 'all-players') {
            const revealBtn = document.createElement('button');
            revealBtn.className = 'lore-item-btn';
            revealBtn.textContent = item.visibility === 'gm-only' ? 'Reveal' : 'Hide';
            revealBtn.addEventListener('click', function () {
              const next = item.visibility === 'gm-only' ? 'all-players' : 'gm-only';
              updateDoc(doc(db, 'loreItems', item.id), {
                visibility: next,
                updatedAt: serverTimestamp()
              }).catch(function (err) {
                window.alert('Visibility change failed: ' + err.message);
              });
            });
            barDiv.appendChild(revealBtn);
          }

          const editBtn = document.createElement('button');
          editBtn.className = 'lore-item-btn';
          editBtn.textContent = 'Edit';
          editBtn.addEventListener('click', function () {
            openLoreForm(entity.id, item);
          });
          barDiv.appendChild(editBtn);

          const delBtn = document.createElement('button');
          delBtn.className = 'lore-item-btn';
          delBtn.textContent = 'Delete';
          delBtn.addEventListener('click', function () {
            deleteLoreItem(item);
          });
          barDiv.appendChild(delBtn);

          itemDiv.appendChild(barDiv);
        }

        const bodyDiv = document.createElement('div');
        bodyDiv.className = 'lore-item-body';
        renderMarkdownInto(bodyDiv, item.content);
        itemDiv.appendChild(bodyDiv);

        loreListDiv.appendChild(itemDiv);
      });
      detailEl.appendChild(loreListDiv);

      if (state.currentRole === 'gm' && gmView) {
        const addLoreBtn = document.createElement('button');
        addLoreBtn.textContent = '+ Add lore';
        addLoreBtn.addEventListener('click', function () {
          openLoreForm(entity.id, null);
        });
        detailEl.appendChild(addLoreBtn);
      }

      // --- Tags ---
      if (entity.tags && entity.tags.length) {
        const tagsDiv = document.createElement('div');
        tagsDiv.id = 'codex-tags';
        entity.tags.forEach(function (t) {
          const span = document.createElement('span');
          span.textContent = t;
          tagsDiv.appendChild(span);
        });
        detailEl.appendChild(tagsDiv);
      }

      // --- Gallery ---
      const galleryImages = galleryImagesFor(entity.id, gmView);
      if (galleryImages.length) {
        const galleryDiv = document.createElement('div');
        galleryDiv.id = 'codex-gallery';
        galleryImages.forEach(function (img) {
          const figDiv = document.createElement('div');
          figDiv.className = 'gallery-item';

          const imgEl = document.createElement('img');
          imgEl.src = img.data;
          imgEl.alt = entity.name;
          figDiv.appendChild(imgEl);

          if (gmView) {
            const barDiv = document.createElement('div');
            barDiv.className = 'gallery-item-bar';
            const visBadge = document.createElement('span');
            visBadge.className = 'lore-vis-badge ' +
              (img.visibility === 'all-players' ? 'visible' : 'hidden');
            visBadge.textContent = img.visibility;
            barDiv.appendChild(visBadge);

            const revealBtn = document.createElement('button');
            revealBtn.className = 'lore-item-btn';
            revealBtn.textContent = img.visibility === 'gm-only' ? 'Reveal' : 'Hide';
            revealBtn.addEventListener('click', function () {
              setGalleryImageVisibility(img.id,
                img.visibility === 'gm-only' ? 'all-players' : 'gm-only'
              ).catch(function (err) {
                window.alert('Visibility change failed: ' + err.message);
              });
            });
            barDiv.appendChild(revealBtn);
            figDiv.appendChild(barDiv);
          }

          galleryDiv.appendChild(figDiv);
        });
        detailEl.appendChild(galleryDiv);
      }

      // --- Related entities ---
      // Player view only links to targets that are themselves player-
      // visible; dangling IDs (deleted target) silently skipped.
      const relatedIds = entity.relatedIds || [];
      if (relatedIds.length) {
        const visibleRelated = relatedIds
          .map(function (id) { return state.allEntities.find(function (e) { return e.id === id; }); })
          .filter(function (target) {
            if (!target) return false;
            return gmView || isEntityPlayerVisible(target.id);
          });

        if (visibleRelated.length) {
          const relatedDiv = document.createElement('div');
          relatedDiv.id = 'codex-related';
          const relHeading = document.createElement('h4');
          relHeading.textContent = 'Related';
          relatedDiv.appendChild(relHeading);

          const chipsDiv = document.createElement('div');
          chipsDiv.id = 'codex-related-chips';
          visibleRelated.forEach(function (target) {
            const chip = document.createElement('button');
            chip.type = 'button';
            chip.className = 'related-chip';
            chip.textContent = target.name;
            chip.addEventListener('click', function () {
              state.selectedId = target.id;
              renderList();
              renderDetailForSelected();
            });
            chipsDiv.appendChild(chip);
          });
          relatedDiv.appendChild(chipsDiv);
          detailEl.appendChild(relatedDiv);
        }
      }

      if (state.currentRole === 'gm') {
        const editBtn = document.createElement('button');
        editBtn.textContent = 'Edit entity';
        editBtn.style.marginTop = '1rem';
        editBtn.addEventListener('click', function () {
          openEntityForm(entity);
        });
        detailEl.appendChild(editBtn);

        const deleteBtn = document.createElement('button');
        deleteBtn.textContent = 'Delete entity';
        deleteBtn.style.marginTop = '1rem';
        deleteBtn.style.marginLeft = '0.5rem';
        deleteBtn.addEventListener('click', function () {
          deleteEntity(entity);
        });
        detailEl.appendChild(deleteBtn);
      }
    }

    categoryFilterEl.addEventListener('change', renderList);
    searchEl.addEventListener('input', renderList);

    // --- Entity authoring (GM only) -----------------------------------------
    const newEntityBtn = document.getElementById('codex-new-btn');
    const formOverlayEl = document.getElementById('entity-form-overlay');
    const formTitleEl = document.getElementById('entity-form-title');
    const formNameEl = document.getElementById('entity-form-name');
    const formParentEl = document.getElementById('entity-form-parent');
    const formTagsEl = document.getElementById('entity-form-tags');
    const formRelatedListEl = document.getElementById('entity-form-related-list');
    const formRelatedSelectEl = document.getElementById('entity-form-related-select');
    const formRelatedAddBtn = document.getElementById('entity-form-related-add-btn');
    const formErrorEl = document.getElementById('entity-form-error');
    const formSaveBtn = document.getElementById('entity-form-save');
    const formCancelBtn = document.getElementById('entity-form-cancel');
    const formMapImageSectionEl = document.getElementById('entity-form-map-image-section');
    const formMapImageStatusEl = document.getElementById('entity-form-map-image-status');
    const formMapImageInputEl = document.getElementById('entity-form-map-image-input');
    const formMapImageDeleteBtn = document.getElementById('entity-form-map-image-delete');
    const formGalleryListEl = document.getElementById('entity-form-gallery-list');
    const formGalleryInputEl = document.getElementById('entity-form-gallery-input');
    const formGalleryStatusEl = document.getElementById('entity-form-gallery-status');

    // slug: human-readable debugging/import aid, NOT the canonical key
    // (auto doc ID is). Regenerated from name on every save; uniqueness is
    // only softly enforced at import time.
    function slugify(name) {
      return name.toLowerCase().trim()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
    }

    function renderRelatedFormList() {
      formRelatedListEl.innerHTML = '';
      state.formRelatedIds.forEach(function (id) {
        const target = state.allEntities.find(function (e) { return e.id === id; });
        const li = document.createElement('li');
        const nameSpan = document.createElement('span');
        nameSpan.textContent = target ? target.name : '(deleted entity)';
        const removeBtn = document.createElement('button');
        removeBtn.type = 'button';
        removeBtn.textContent = 'Remove';
        removeBtn.addEventListener('click', function () {
          state.formRelatedIds = state.formRelatedIds.filter(function (rid) { return rid !== id; });
          renderRelatedFormList();
          populateRelatedSelect();
        });
        li.appendChild(nameSpan);
        li.appendChild(removeBtn);
        formRelatedListEl.appendChild(li);
      });
    }

    function populateRelatedSelect() {
      formRelatedSelectEl.innerHTML = '';
      const available = state.allEntities
        .filter(function (e) { return e.id !== state.editingEntityId && state.formRelatedIds.indexOf(e.id) === -1; })
        .sort(function (a, b) { return (a.name || '').localeCompare(b.name || ''); });
      if (available.length === 0) {
        const opt = document.createElement('option');
        opt.textContent = '(no more entities to link)';
        opt.disabled = true;
        formRelatedSelectEl.appendChild(opt);
        return;
      }
      available.forEach(function (e) {
        const opt = document.createElement('option');
        opt.value = e.id;
        opt.textContent = e.name;
        formRelatedSelectEl.appendChild(opt);
      });
    }

    // Parent select: any other entity, or none. Only self is excluded —
    // deeper cycle prevention (linking to a descendant) is not enforced;
    // GM is trusted, same stance as child-map pins.
    function populateParentSelect(currentParentId) {
      formParentEl.innerHTML = '';
      const noneOpt = document.createElement('option');
      noneOpt.value = '';
      noneOpt.textContent = '-- none --';
      formParentEl.appendChild(noneOpt);
      state.allEntities
        .filter(function (e) { return e.id !== state.editingEntityId; })
        .sort(function (a, b) { return (a.name || '').localeCompare(b.name || ''); })
        .forEach(function (e) {
          const opt = document.createElement('option');
          opt.value = e.id;
          opt.textContent = e.name;
          formParentEl.appendChild(opt);
        });
      formParentEl.value = currentParentId || '';
    }

    formRelatedAddBtn.addEventListener('click', function () {
      const id = formRelatedSelectEl.value;
      if (!id || state.formRelatedIds.indexOf(id) !== -1) return;
      state.formRelatedIds.push(id);
      renderRelatedFormList();
      populateRelatedSelect();
    });

    function openEntityForm(entity) {
      state.editingEntityId = entity ? entity.id : null;
      state.entityFormIsNew = !entity;
      // New: pre-generate the doc id so images can be uploaded before the
      // first save (they reference the entity id). The entity doc itself
      // is only written on Save; Cancel cleans up any images uploaded in
      // this form session.
      state.entityFormDocId = entity ? entity.id : doc(collection(db, 'entities')).id;
      state.entityFormUploadedImageIds = [];
      state.entityFormHasMapImage = !!(entity && entity.hasMapImage);
      setEntityImagesTarget(state.entityFormDocId);
      formTitleEl.textContent = entity ? 'Edit Entity' : 'New Entity';
      formNameEl.value = entity ? entity.name || '' : '';
      formCategoryEl.value = entity ? (entity.category || CONFIG.categories[0]) : CONFIG.categories[0];
      formTagsEl.value = entity && entity.tags ? entity.tags.join(', ') : '';
      state.formRelatedIds = entity && entity.relatedIds ? entity.relatedIds.slice() : [];
      populateParentSelect(entity ? entity.parentId : null);
      renderRelatedFormList();
      populateRelatedSelect();
      formErrorEl.style.display = 'none';
      formErrorEl.textContent = '';
      formMapImageStatusEl.textContent = '';
      formGalleryStatusEl.textContent = '';
      formOverlayEl.classList.add('open');
      // Must run AFTER the overlay is open: renderEntityFormImages()
      // no-ops when the form is closed, so calling it before .add('open')
      // left the map-image section showing its stale display state from
      // the previous form session.
      renderEntityFormImages();
      formNameEl.focus();
    }

    function closeEntityForm() {
      formOverlayEl.classList.remove('open');
      state.entityFormDocId = null;
      // Point the images listener back at the selection.
      const selected = state.allEntities.find(function (e) { return e.id === state.selectedId; });
      setEntityImagesTarget(selected ? selected.id : null);
    }

    // Cancel on a New entity: the entity doc was never written, so any
    // images uploaded during this form session would be orphans — delete
    // them. On Edit, image changes applied live and Cancel keeps them
    // (only the field edits are discarded).
    function cancelEntityForm() {
      if (state.entityFormIsNew && state.entityFormUploadedImageIds.length) {
        state.entityFormUploadedImageIds.forEach(function (imageId) {
          deleteDoc(doc(db, 'images', imageId)).catch(function (err) {
            console.warn('orphan image cleanup failed:', err.message);
          });
        });
      }
      closeEntityForm();
    }

    // --- Entity form image sections -----------------------------------------
    // Map image section only applies to Locations (0 or 1 map image);
    // gallery applies to every entity (0+ images, each with visibility).
    function renderEntityFormImages() {
      if (!formOverlayEl.classList.contains('open')) return;

      formMapImageSectionEl.style.display =
        (formCategoryEl.value === 'Location') ? 'block' : 'none';

      const entityId = state.entityFormDocId;
      const mapImg = state.currentEntityImages.find(function (img) {
        return img.ownerId === entityId && img.role === 'map';
      });
      formMapImageStatusEl.textContent = mapImg
        ? 'Map image set (' + mapImg.width + 'x' + mapImg.height + ', ' + Math.round(mapImg.sizeBytes / 1024) + 'KB).'
        : 'No map image.';
      formMapImageDeleteBtn.style.display = mapImg ? 'inline-block' : 'none';

      formGalleryListEl.innerHTML = '';
      galleryImagesFor(entityId, true).forEach(function (img) {
        const li = document.createElement('li');
        const thumb = document.createElement('img');
        thumb.src = img.data;
        li.appendChild(thumb);

        const visBadge = document.createElement('span');
        visBadge.className = 'lore-vis-badge ' +
          (img.visibility === 'all-players' ? 'visible' : 'hidden');
        visBadge.textContent = img.visibility;
        li.appendChild(visBadge);

        const revealBtn = document.createElement('button');
        revealBtn.type = 'button';
        revealBtn.className = 'lore-item-btn';
        revealBtn.textContent = img.visibility === 'gm-only' ? 'Reveal' : 'Hide';
        revealBtn.addEventListener('click', function () {
          setGalleryImageVisibility(img.id,
            img.visibility === 'gm-only' ? 'all-players' : 'gm-only'
          ).catch(function (err) {
            window.alert('Visibility change failed: ' + err.message);
          });
        });
        li.appendChild(revealBtn);

        const delBtn = document.createElement('button');
        delBtn.type = 'button';
        delBtn.className = 'lore-item-btn';
        delBtn.textContent = 'Delete';
        delBtn.addEventListener('click', function () {
          if (!window.confirm('Delete this gallery image?')) return;
          deleteEntityGalleryImage(img.id).then(function () {
            state.entityFormUploadedImageIds = state.entityFormUploadedImageIds
              .filter(function (id) { return id !== img.id; });
          }).catch(function (err) {
            window.alert('Delete failed: ' + err.message);
          });
        });
        li.appendChild(delBtn);

        formGalleryListEl.appendChild(li);
      });
    }

    formCategoryEl.addEventListener('change', renderEntityFormImages);

    formMapImageInputEl.addEventListener('change', function () {
      const file = formMapImageInputEl.files[0];
      if (!file) return;
      formMapImageInputEl.disabled = true;
      uploadEntityMapImage(state.entityFormDocId, file, {
        entityDocExists: !state.entityFormIsNew,
        onStatus: function (text) { formMapImageStatusEl.textContent = text; }
      }).then(function (imageId) {
        state.entityFormHasMapImage = true;
        if (state.entityFormUploadedImageIds.indexOf(imageId) === -1) {
          state.entityFormUploadedImageIds.push(imageId);
        }
        // Status text refreshed by the images listener snapshot.
      }).catch(function (err) {
        formMapImageStatusEl.textContent = err.message;
      }).finally(function () {
        formMapImageInputEl.disabled = false;
        formMapImageInputEl.value = '';
      });
    });

    formMapImageDeleteBtn.addEventListener('click', function () {
      if (!window.confirm('Delete this location\u2019s map image? Pins on its map will be unreachable until a new image is set.')) return;
      deleteEntityMapImage(state.entityFormDocId, {
        entityDocExists: !state.entityFormIsNew
      }).then(function () {
        state.entityFormHasMapImage = false;
      }).catch(function (err) {
        window.alert('Delete failed: ' + err.message);
      });
    });

    formGalleryInputEl.addEventListener('change', function () {
      const file = formGalleryInputEl.files[0];
      if (!file) return;
      formGalleryInputEl.disabled = true;
      uploadEntityGalleryImage(state.entityFormDocId, file, {
        onStatus: function (text) { formGalleryStatusEl.textContent = text; }
      }).then(function (imageId) {
        state.entityFormUploadedImageIds.push(imageId);
        formGalleryStatusEl.textContent = '';
      }).catch(function (err) {
        formGalleryStatusEl.textContent = err.message;
      }).finally(function () {
        formGalleryInputEl.disabled = false;
        formGalleryInputEl.value = '';
      });
    });

    function showFormError(message) {
      formErrorEl.textContent = message;
      formErrorEl.style.display = 'block';
    }

    function saveEntity() {
      const name = formNameEl.value.trim();
      if (!name) {
        showFormError('Name is required.');
        return;
      }

      const tags = formTagsEl.value
        .split(',')
        .map(function (t) { return t.trim(); })
        .filter(function (t) { return t.length > 0; });

      const entityData = {
        slug: slugify(name),
        name: name,
        category: formCategoryEl.value,
        parentId: formParentEl.value || null,
        relatedIds: state.formRelatedIds.slice(),
        visibility: 'gm-only',  // new entities start hidden; one-tap Reveal in detail
        hasMapImage: state.entityFormHasMapImage,
        tags: tags,
        updatedAt: serverTimestamp()
      };

      formSaveBtn.disabled = true;
      let savePromise;
      if (state.editingEntityId) {
        const existing = state.allEntities.find(function (e) { return e.id === state.editingEntityId; });
        // Form doesn't manage visibility; preserved on edit, flipped only
        // via the one-tap Reveal/Hide button.
        entityData.visibility = (existing && existing.visibility === 'all-players') ? 'all-players' : 'gm-only';
        savePromise = updateDoc(doc(db, 'entities', state.editingEntityId), entityData);
      } else {
        entityData.createdAt = serverTimestamp();
        // setDoc with the pre-generated id (not addDoc) — images uploaded
        // during this form session already reference it.
        savePromise = setDoc(doc(db, 'entities', state.entityFormDocId), entityData);
      }

      savePromise.then(function () {
        formSaveBtn.disabled = false;
        closeEntityForm();
      }).catch(function (err) {
        formSaveBtn.disabled = false;
        showFormError('Save failed: ' + err.message);
      });
    }

    // Deleting an entity also deletes its loreItems and images (no
    // orphans). Batched: atomic, and total op count here is far below the
    // 500-op batch cap. Image docs for the entity are known from the
    // per-entity listener (targeted at the selection, which is the only
    // place delete is offered).
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

    newEntityBtn.addEventListener('click', function () { openEntityForm(); });
    formCancelBtn.addEventListener('click', cancelEntityForm);
    formSaveBtn.addEventListener('click', saveEntity);
    formOverlayEl.addEventListener('click', function (e) {
      if (e.target === formOverlayEl) cancelEntityForm();
    });

    // --- Lore item authoring (GM only for now) ------------------------------
    const loreOverlayEl = document.getElementById('lore-form-overlay');
    const loreTitleEl = document.getElementById('lore-form-title');
    const loreContentEl = document.getElementById('lore-form-content');
    const loreVisibilityEl = document.getElementById('lore-form-visibility');
    const loreErrorEl = document.getElementById('lore-form-error');
    const loreSaveBtn = document.getElementById('lore-form-save');
    const loreCancelBtn = document.getElementById('lore-form-cancel');

    function openLoreForm(entityId, item) {
      state.loreFormEntityId = entityId;
      state.editingLoreItemId = item ? item.id : null;
      loreTitleEl.textContent = item ? 'Edit Lore' : 'Add Lore';
      loreContentEl.value = item ? item.content || '' : '';
      loreVisibilityEl.value = item ? item.visibility : 'gm-only';
      loreErrorEl.style.display = 'none';
      loreErrorEl.textContent = '';
      loreOverlayEl.classList.add('open');
      loreContentEl.focus();
    }

    function closeLoreForm() {
      loreOverlayEl.classList.remove('open');
    }

    function showLoreFormError(message) {
      loreErrorEl.textContent = message;
      loreErrorEl.style.display = 'block';
    }

    function saveLoreItem() {
      const content = loreContentEl.value;
      if (!content.trim()) {
        showLoreFormError('Content is required.');
        return;
      }

      loreSaveBtn.disabled = true;
      let savePromise;
      if (state.editingLoreItemId) {
        savePromise = updateDoc(doc(db, 'loreItems', state.editingLoreItemId), {
          content: content,
          visibility: loreVisibilityEl.value,
          updatedAt: serverTimestamp()
        });
      } else {
        // order: append after the entity's current max, preserving
        // authored/imported sequence.
        const siblings = state.allLoreItems.filter(function (it) {
          return it.entityId === state.loreFormEntityId;
        });
        const maxOrder = siblings.reduce(function (acc, it) {
          return Math.max(acc, it.order || 0);
        }, 0);
        savePromise = addDoc(collection(db, 'loreItems'), {
          entityId: state.loreFormEntityId,
          kind: 'gm-note',
          authorId: state.currentUser ? state.currentUser.uid : null,
          authorType: 'gm',
          visibility: loreVisibilityEl.value,
          content: content,
          order: maxOrder + 1,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp()
        });
      }

      savePromise.then(function () {
        loreSaveBtn.disabled = false;
        closeLoreForm();
      }).catch(function (err) {
        loreSaveBtn.disabled = false;
        showLoreFormError('Save failed: ' + err.message);
      });
    }

    function deleteLoreItem(item) {
      const confirmed = window.confirm('Delete this lore item? This cannot be undone.');
      if (!confirmed) return;
      deleteDoc(doc(db, 'loreItems', item.id)).catch(function (err) {
        window.alert('Delete failed: ' + err.message);
      });
    }

    loreCancelBtn.addEventListener('click', closeLoreForm);
    loreSaveBtn.addEventListener('click', saveLoreItem);
    loreOverlayEl.addEventListener('click', function (e) {
      if (e.target === loreOverlayEl) closeLoreForm();
    });

export {
  attachCodexListeners, detachCodexListeners, renderList, renderDetailForSelected,
  isEntityPlayerVisible, registerVisibilityChangeHandler
};
