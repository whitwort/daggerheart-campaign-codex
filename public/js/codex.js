import {
  getFirestore, collection, onSnapshot, doc, addDoc, updateDoc, deleteDoc
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import { firebaseApp, CONFIG } from './firebase.js';
import { state } from './state.js';
import { attachListener, detachListener } from './listeners.js';
import { renderMarkdownInto } from './markdown.js';

const db = getFirestore(firebaseApp);

    // --- Codex tab: live entries read --------------------------------------
    const categoryFilterEl = document.getElementById('codex-category-filter');
    const searchEl = document.getElementById('codex-search');
    const listEl = document.getElementById('codex-entries');
    const detailEl = document.getElementById('codex-detail');

    const formCategoryEl = document.getElementById('entry-form-category');

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


    // Phase 7a bugfix: this listener (and the pins/maps ones further down)
    // used to attach unconditionally at page load. For a signed-in-but-
    // unlisted or signed-out user that hits permission-denied immediately,
    // and Firestore's SDK does NOT auto-retry a listener after a definitive
    // permission error — so even after the user became GM/Player, the dead
    // listener never resumed and entries/map stayed stuck on the error.
    // Fix: only attach once hasAccess is true (see attachDataListeners,
    // called from updateAccessUI), same pattern as attachAdminListeners.
    function attachEntriesListener() {
      attachListener('entriesUnsub', function () {
        return onSnapshot(collection(db, 'entries'), function (snapshot) {
          state.allEntries = [];
          snapshot.forEach(function (docSnap) {
            const data = docSnap.data();
            if (data.type === 'codex') {
              state.allEntries.push(Object.assign({ id: docSnap.id }, data));
            }
          });
          renderList();
          renderDetailForSelected();
        }, function (err) {
          listEl.innerHTML = '<li>Error loading entries: ' + err.message + '</li>';
        });
      });
    }

    // Phase 7a-1: `public` field / backfill removed — auth-model overhaul
    // (Aug 2026) means there's no unauthenticated read path to gate at all,
    // so the field is unnecessary. See firestore.rules.

    function matchesFilters(entry) {
      const cat = categoryFilterEl.value;
      if (cat && entry.category !== cat) return false;

      const q = searchEl.value.trim().toLowerCase();
      if (!q) return true;
      const nameMatch = (entry.name || '').toLowerCase().indexOf(q) !== -1;
      const tagMatch = (entry.tags || []).some(function (t) {
        return t.toLowerCase().indexOf(q) !== -1;
      });
      return nameMatch || tagMatch;
    }

    function renderList() {
      const filtered = state.allEntries
        .filter(matchesFilters)
        .sort(function (a, b) { return (a.name || '').localeCompare(b.name || ''); });

      listEl.innerHTML = '';
      if (filtered.length === 0) {
        const li = document.createElement('li');
        li.textContent = 'No entries match.';
        listEl.appendChild(li);
        return;
      }

      filtered.forEach(function (entry) {
        const li = document.createElement('li');
        li.dataset.id = entry.id;
        if (entry.id === state.selectedId) li.classList.add('active');

        const nameDiv = document.createElement('div');
        nameDiv.textContent = entry.name;
        const catDiv = document.createElement('div');
        catDiv.className = 'entry-category';
        catDiv.textContent = entry.category || '';

        li.appendChild(nameDiv);
        li.appendChild(catDiv);
        li.addEventListener('click', function () {
          state.selectedId = entry.id;
          renderList();
          renderDetailForSelected();
        });
        listEl.appendChild(li);
      });
    }

    function renderDetailForSelected() {
      const entry = state.allEntries.find(function (e) { return e.id === state.selectedId; });
      if (!entry) {
        detailEl.innerHTML = '<p id="codex-empty">Select an entry.</p>';
        return;
      }

      const effectiveRole = (state.currentRole === 'gm' && state.gmPreviewAsPlayer) ? 'player' : state.currentRole;
      const showGmContent = effectiveRole === 'gm';
      const bodyText = showGmContent ? entry.content_gm : entry.content_player;

      detailEl.innerHTML = '';

      const heading = document.createElement('h2');
      heading.textContent = entry.name;

      const badge = document.createElement('span');
      badge.id = 'codex-view-badge';
      badge.className = showGmContent ? 'gm' : 'player';
      badge.textContent = showGmContent ? 'GM view' : 'Player view';
      heading.appendChild(badge);
      detailEl.appendChild(heading);

      if (state.currentRole === 'gm') {
        const toggleBtn = document.createElement('button');
        toggleBtn.textContent = state.gmPreviewAsPlayer ? 'Show GM content' : 'Preview player view';
        toggleBtn.addEventListener('click', function () {
          state.gmPreviewAsPlayer = !state.gmPreviewAsPlayer;
          renderDetailForSelected();
        });
        detailEl.appendChild(toggleBtn);
      }

      const catP = document.createElement('p');
      catP.innerHTML = '<em>' + (entry.category || '') + '</em>';
      detailEl.appendChild(catP);

      const bodyDiv = document.createElement('div');
      bodyDiv.className = 'codex-body';
      if (bodyText) {
        renderMarkdownInto(bodyDiv, bodyText);
      } else {
        bodyDiv.textContent = '(no content for this view)';
      }
      detailEl.appendChild(bodyDiv);

      if (entry.tags && entry.tags.length) {
        const tagsDiv = document.createElement('div');
        tagsDiv.id = 'codex-tags';
        entry.tags.forEach(function (t) {
          const span = document.createElement('span');
          span.textContent = t;
          tagsDiv.appendChild(span);
        });
        detailEl.appendChild(tagsDiv);
      }

      // Related entries: only show links to targets visible in the current
      // effective view (GM sees all; player/viewer only sees targets that
      // themselves have player-visible content). Dangling IDs (deleted
      // target entry) are silently skipped.
      const relatedIds = entry.relatedIds || [];
      if (relatedIds.length) {
        const visibleRelated = relatedIds
          .map(function (id) { return state.allEntries.find(function (e) { return e.id === id; }); })
          .filter(function (target) {
            if (!target) return false;
            if (showGmContent) return true;
            return !!(target.content_player && target.content_player.trim());
          });

        if (visibleRelated.length) {
          const relatedDiv = document.createElement('div');
          relatedDiv.id = 'codex-related';
          const heading = document.createElement('h4');
          heading.textContent = 'Related';
          relatedDiv.appendChild(heading);

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
        editBtn.textContent = 'Edit entry';
        editBtn.style.marginTop = '1rem';
        editBtn.addEventListener('click', function () {
          openEntryForm(entry);
        });
        detailEl.appendChild(editBtn);

        const deleteBtn = document.createElement('button');
        deleteBtn.textContent = 'Delete entry';
        deleteBtn.style.marginTop = '1rem';
        deleteBtn.style.marginLeft = '0.5rem';
        deleteBtn.addEventListener('click', function () {
          deleteEntry(entry);
        });
        detailEl.appendChild(deleteBtn);
      }
    }

    categoryFilterEl.addEventListener('change', renderList);
    searchEl.addEventListener('input', renderList);

    // --- Entry authoring (GM only): create ---------------------------------
    const newEntryBtn = document.getElementById('codex-new-btn');
    const formOverlayEl = document.getElementById('entry-form-overlay');
    const formTitleEl = document.getElementById('entry-form-title');
    const formNameEl = document.getElementById('entry-form-name');
    const formTagsEl = document.getElementById('entry-form-tags');
    const formContentGmEl = document.getElementById('entry-form-content-gm');
    const formContentPlayerEl = document.getElementById('entry-form-content-player');
    const formRelatedListEl = document.getElementById('entry-form-related-list');
    const formRelatedSelectEl = document.getElementById('entry-form-related-select');
    const formRelatedAddBtn = document.getElementById('entry-form-related-add-btn');
    const formErrorEl = document.getElementById('entry-form-error');
    const formSaveBtn = document.getElementById('entry-form-save');
    const formCancelBtn = document.getElementById('entry-form-cancel');


    function renderRelatedFormList() {
      formRelatedListEl.innerHTML = '';
      state.formRelatedIds.forEach(function (id) {
        const target = state.allEntries.find(function (e) { return e.id === id; });
        const li = document.createElement('li');
        const nameSpan = document.createElement('span');
        nameSpan.textContent = target ? target.name : '(deleted entry)';
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
      const available = state.allEntries
        .filter(function (e) { return e.id !== state.editingEntryId && state.formRelatedIds.indexOf(e.id) === -1; })
        .sort(function (a, b) { return (a.name || '').localeCompare(b.name || ''); });
      if (available.length === 0) {
        const opt = document.createElement('option');
        opt.textContent = '(no more entries to link)';
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

    formRelatedAddBtn.addEventListener('click', function () {
      const id = formRelatedSelectEl.value;
      if (!id || state.formRelatedIds.indexOf(id) !== -1) return;
      state.formRelatedIds.push(id);
      renderRelatedFormList();
      populateRelatedSelect();
    });

    function openEntryForm(entry) {
      state.editingEntryId = entry ? entry.id : null;
      formTitleEl.textContent = entry ? 'Edit Entry' : 'New Entry';
      formNameEl.value = entry ? entry.name || '' : '';
      formCategoryEl.value = entry ? (entry.category || CONFIG.categories[0]) : CONFIG.categories[0];
      formTagsEl.value = entry && entry.tags ? entry.tags.join(', ') : '';
      formContentGmEl.value = entry ? entry.content_gm || '' : '';
      formContentPlayerEl.value = entry ? entry.content_player || '' : '';
      state.formRelatedIds = entry && entry.relatedIds ? entry.relatedIds.slice() : [];
      renderRelatedFormList();
      populateRelatedSelect();
      formErrorEl.style.display = 'none';
      formErrorEl.textContent = '';
      formOverlayEl.classList.add('open');
      formNameEl.focus();
    }

    function closeEntryForm() {
      formOverlayEl.classList.remove('open');
    }

    function showFormError(message) {
      formErrorEl.textContent = message;
      formErrorEl.style.display = 'block';
    }

    function saveEntry() {
      const name = formNameEl.value.trim();
      if (!name) {
        showFormError('Name is required.');
        return;
      }

      const tags = formTagsEl.value
        .split(',')
        .map(function (t) { return t.trim(); })
        .filter(function (t) { return t.length > 0; });

      const entryData = {
        type: 'codex',
        name: name,
        category: formCategoryEl.value,
        tags: tags,
        content_gm: formContentGmEl.value,
        content_player: formContentPlayerEl.value,
        relatedIds: state.formRelatedIds.slice()
      };

      formSaveBtn.disabled = true;
      const savePromise = state.editingEntryId
        ? updateDoc(doc(db, 'entries', state.editingEntryId), entryData)
        : addDoc(collection(db, 'entries'), entryData);

      savePromise.then(function () {
        formSaveBtn.disabled = false;
        closeEntryForm();
      }).catch(function (err) {
        formSaveBtn.disabled = false;
        showFormError('Save failed: ' + err.message);
      });
    }

    function deleteEntry(entry) {
      const confirmed = window.confirm('Delete "' + entry.name + '"? This cannot be undone.');
      if (!confirmed) return;

      deleteDoc(doc(db, 'entries', entry.id)).then(function () {
        if (state.selectedId === entry.id) {
          state.selectedId = null;
          renderDetailForSelected();
        }
      }).catch(function (err) {
        window.alert('Delete failed: ' + err.message);
      });
    }

    newEntryBtn.addEventListener('click', function () { openEntryForm(); });
    formCancelBtn.addEventListener('click', closeEntryForm);
    formSaveBtn.addEventListener('click', saveEntry);
    formOverlayEl.addEventListener('click', function (e) {
      if (e.target === formOverlayEl) closeEntryForm();
    });


function detachEntriesListener() {
  detachListener('entriesUnsub');
}

export {
  attachEntriesListener, detachEntriesListener, renderList, renderDetailForSelected,
  openEntryForm, closeEntryForm, saveEntry, deleteEntry
};
