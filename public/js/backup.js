// Full raw database backup/restore, client-side (Admin tab, Database >
// Backup sub-tab). Distinct from import.js's structured entity/lore
// importer above it: this dumps/restores every collection verbatim by
// doc id, for dev<->prod migration and manual ad hoc backups. GM-only —
// gated by the same Firestore Security Rules as every other admin write,
// not by anything in this file. No Admin SDK, no service account, no
// cross-project credentials: export and restore are both same-project
// operations, run from whichever build (dev or prod) is currently open.
//
// Serialization mirrors scripts/firestore-backup.js's Timestamp marker
// format ({__type:'timestamp', value: isoString}) so dumps are
// interchangeable between that Node/Admin-SDK tool and this one, even
// though they use different Timestamp classes.
//
// joinRequests is exported for visibility but excluded from the restore
// write step: its Security Rule requires the writer's own auth email to
// equal the doc id ("create" only your own request), so GM cannot
// recreate other users' pending-request docs here. Wipe mode still
// deletes them (GM has delete rights); anyone with a lost pending
// request just re-submits it. The Node script doesn't have this
// limitation (Admin SDK bypasses Security Rules via IAM) — the two
// tools aren't fully interchangeable for that one collection.

import {
  getFirestore, collection, doc, getDocs, writeBatch, Timestamp
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import { firebaseApp } from './firebase.js';
import { entityMatchesQuery, categoryGroupLabel } from './codex.js';

const db = getFirestore(firebaseApp);

const COLLECTIONS = ['config', 'encounters', 'entities', 'images', 'joinRequests', 'loreDrops', 'loreItems', 'notifications', 'pins', 'players', 'sources', 'threads', 'transferRequests'];
// Client-side restore skips what the rules make impossible for a GM:
// joinRequests and transferRequests (create is locked to the requesting
// user's own email). threads restores its DOCS but not the messages
// subcollection -- message create is author-role-locked and delete is
// `if false` for everyone (immutable-chat-log design), so the client can
// neither write player-authored history back nor wipe it. Full-fidelity
// restore incl. messages is the Admin-SDK script's job (bypasses rules).
const RESTORABLE_COLLECTIONS = COLLECTIONS.filter(function (c) { return c !== 'joinRequests' && c !== 'transferRequests'; });
const SUBCOLLECTIONS = { threads: ['messages'] };
const BATCH_LIMIT = 500;

function serializeValue(v) {
  if (v instanceof Timestamp) {
    return { __type: 'timestamp', value: v.toDate().toISOString() };
  }
  if (Array.isArray(v)) return v.map(serializeValue);
  if (v && typeof v === 'object') {
    const out = {};
    Object.keys(v).forEach(function (k) { out[k] = serializeValue(v[k]); });
    return out;
  }
  return v;
}

function deserializeValue(v) {
  if (v && typeof v === 'object' && v.__type === 'timestamp') {
    return Timestamp.fromDate(new Date(v.value));
  }
  if (Array.isArray(v)) return v.map(deserializeValue);
  if (v && typeof v === 'object') {
    const out = {};
    Object.keys(v).forEach(function (k) { out[k] = deserializeValue(v[k]); });
    return out;
  }
  return v;
}

async function runBackupExport() {
  const projectId = window.FIREBASE_ENV.projectId;
  const dump = { exportedAt: new Date().toISOString(), project: projectId, collections: {} };
  const counts = [];
  for (const name of COLLECTIONS) {
    const snap = await getDocs(collection(db, name));
    const entries = [];
    for (const d of snap.docs) {
      const entry = { id: d.id, data: serializeValue(d.data()) };
      for (const sub of (SUBCOLLECTIONS[name] || [])) {
        const subSnap = await getDocs(collection(db, name, d.id, sub));
        entry[sub] = subSnap.docs.map(function (sd) {
          return { id: sd.id, data: serializeValue(sd.data()) };
        });
      }
      entries.push(entry);
    }
    dump.collections[name] = entries;
    counts.push(name + ': ' + snap.size);
  }
  const blob = new Blob([JSON.stringify(dump, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = projectId + '-backup-' + dump.exportedAt.slice(0, 10) + '.json';
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  return counts;
}

async function wipeCollection(name) {
  const snap = await getDocs(collection(db, name));
  const refs = snap.docs.map(function (d) { return d.ref; });
  for (let i = 0; i < refs.length; i += BATCH_LIMIT) {
    const batch = writeBatch(db);
    refs.slice(i, i + BATCH_LIMIT).forEach(function (ref) { batch.delete(ref); });
    await batch.commit();
  }
  return refs.length;
}

async function runBackupRestore(dump, mode, log) {
  if (mode === 'wipe') {
    for (const name of COLLECTIONS) {
      const n = await wipeCollection(name);
      log(name + ': wiped ' + n + ' docs');
      if (name === 'threads' && n > 0) {
        log('threads: message subcollections NOT wiped (rules forbid message deletes for everyone) \u2014 orphaned messages re-attach if a thread doc with the same email is recreated');
      }
    }
  }
  for (const name of RESTORABLE_COLLECTIONS) {
    const docs = (dump.collections && dump.collections[name]) || [];
    for (let i = 0; i < docs.length; i += BATCH_LIMIT) {
      const batch = writeBatch(db);
      docs.slice(i, i + BATCH_LIMIT).forEach(function (entry) {
        batch.set(doc(db, name, entry.id), deserializeValue(entry.data));
      });
      await batch.commit();
    }
    log(name + ': wrote ' + docs.length + ' docs');
    if (name === 'threads' && docs.some(function (d) { return (d.messages || []).length; })) {
      log('threads: messages skipped (author-role-locked create \u2014 use the Admin-SDK backup script for full-fidelity restore)');
    }
  }
  log('joinRequests, transferRequests: skipped (creates are locked to the requesting user \u2014 see backup.js header)');
}

// --- UI wiring ----------------------------------------------------------
const downloadBtn = document.getElementById('backup-download-btn');
const downloadStatusEl = document.getElementById('backup-download-status');
const restoreModeEl = document.getElementById('backup-restore-mode');
const restoreUploadBtn = document.getElementById('backup-restore-upload-btn');
const restoreFileInputEl = document.getElementById('backup-restore-file-input');
const restoreRunBtn = document.getElementById('backup-restore-run-btn');
const restoreSummaryEl = document.getElementById('backup-restore-summary');

let pendingDump = null;

downloadBtn.addEventListener('click', function () {
  downloadBtn.disabled = true;
  downloadStatusEl.textContent = 'Exporting\u2026';
  runBackupExport().then(function (counts) {
    downloadStatusEl.textContent = 'Downloaded. ' + counts.join(', ');
    downloadBtn.disabled = false;
  }).catch(function (err) {
    downloadStatusEl.textContent = 'Export failed: ' + err.message;
    downloadBtn.disabled = false;
  });
});

restoreUploadBtn.addEventListener('click', function () { restoreFileInputEl.click(); });

function summarizeDump(d) {
  return Object.keys(d.collections || {}).map(function (k) {
    return k + ': ' + d.collections[k].length;
  }).join(', ');
}

restoreFileInputEl.addEventListener('change', function () {
  const file = restoreFileInputEl.files[0];
  restoreFileInputEl.value = '';
  if (!file) return;
  const reader = new FileReader();
  reader.onload = function () {
    try {
      const parsed = JSON.parse(reader.result);
      pendingDump = parsed;
      restoreSummaryEl.textContent = 'Loaded ' + file.name + ' (project: ' + (parsed.project || 'unknown')
        + ', exported ' + (parsed.exportedAt || 'unknown') + '). ' + summarizeDump(parsed);
      restoreRunBtn.disabled = false;
    } catch (err) {
      pendingDump = null;
      restoreSummaryEl.textContent = 'Invalid JSON: ' + err.message;
      restoreRunBtn.disabled = true;
    }
  };
  reader.readAsText(file);
});

restoreRunBtn.addEventListener('click', function () {
  if (!pendingDump) return;
  const mode = restoreModeEl.value;
  const connected = window.FIREBASE_ENV.projectId;
  const counts = summarizeDump(pendingDump);
  const source = (pendingDump.project || 'unknown source') + ', ' + (pendingDump.exportedAt || 'unknown date');

  const message = mode === 'wipe'
    ? 'WIPE every collection in "' + connected + '" and replace with this backup (' + source + ')?\n\n'
      + counts + '\n\nThis cannot be undone.'
    : 'Write this backup (' + source + ') into "' + connected + '", overwriting any matching ids '
      + '(existing docs not in the backup are left alone)?\n\n' + counts;

  if (!window.confirm(message)) return;

  restoreRunBtn.disabled = true;
  const lines = [];
  function log(line) { lines.push(line); restoreSummaryEl.textContent = lines.join('\n'); }

  runBackupRestore(pendingDump, mode, log).then(function () {
    log('Done.');
    restoreRunBtn.disabled = false;
  }).catch(function (err) {
    log('Restore failed: ' + err.message);
    restoreRunBtn.disabled = false;
  });
});

// --- Single-entry restore ------------------------------------------------
// Restores one entity plus its associated loreItems (entityId), pins
// (entityId), and images (ownerId) from a full-dump backup file, without
// touching any other live data. Additive/overwrite-by-id only (v1) --
// deliberately does NOT delete live docs absent from the backup (e.g. lore
// items added after the backup was taken); a "delete orphans" mode is a
// possible future addition if that's ever needed.
function entryRestoreEntityPool(dump) {
  return ((dump.collections && dump.collections.entities) || []).map(function (entry) {
    return Object.assign({ id: entry.id }, entry.data);
  });
}

function computeEntryRestorePlan(dump, entityId) {
  const loreItems = ((dump.collections && dump.collections.loreItems) || [])
    .filter(function (entry) { return entry.data && entry.data.entityId === entityId; });
  const pins = ((dump.collections && dump.collections.pins) || [])
    .filter(function (entry) { return entry.data && entry.data.entityId === entityId; });
  const images = ((dump.collections && dump.collections.images) || [])
    .filter(function (entry) { return entry.data && entry.data.ownerId === entityId; });
  return { loreItems, pins, images };
}

async function runEntryRestore(entity, plan, log) {
  const writes = [{ collectionName: 'entities', entries: [{ id: entity.id, data: entity }] }]
    .concat([
      { collectionName: 'loreItems', entries: plan.loreItems },
      { collectionName: 'pins', entries: plan.pins },
      { collectionName: 'images', entries: plan.images },
    ]);
  for (const w of writes) {
    for (let i = 0; i < w.entries.length; i += BATCH_LIMIT) {
      const batch = writeBatch(db);
      w.entries.slice(i, i + BATCH_LIMIT).forEach(function (entry) {
        batch.set(doc(db, w.collectionName, entry.id), deserializeValue(entry.data));
      });
      await batch.commit();
    }
    log(w.collectionName + ': wrote ' + w.entries.length + ' doc' + (w.entries.length === 1 ? '' : 's'));
  }
}

// --- Single-entry restore UI wiring --------------------------------------
const entryRestoreUploadBtn = document.getElementById('entry-restore-upload-btn');
const entryRestoreFileInputEl = document.getElementById('entry-restore-file-input');
const entryRestoreLoadStatusEl = document.getElementById('entry-restore-load-status');
const entryRestoreSearchEl = document.getElementById('entry-restore-search');
const entryRestoreListEl = document.getElementById('entry-restore-list');
const entryRestorePreviewEl = document.getElementById('entry-restore-preview');
const entryRestoreRunBtn = document.getElementById('entry-restore-run-btn');
const entryRestoreSummaryEl = document.getElementById('entry-restore-summary');

let entryRestoreDump = null;
let entryRestorePool = [];
let entryRestoreSelected = null; // { entity, plan }

entryRestoreUploadBtn.addEventListener('click', function () { entryRestoreFileInputEl.click(); });

entryRestoreFileInputEl.addEventListener('change', function () {
  const file = entryRestoreFileInputEl.files[0];
  entryRestoreFileInputEl.value = '';
  if (!file) return;
  const reader = new FileReader();
  reader.onload = function () {
    try {
      const parsed = JSON.parse(reader.result);
      entryRestoreDump = parsed;
      entryRestorePool = entryRestoreEntityPool(parsed);
      entryRestoreSelected = null;
      entryRestoreRunBtn.disabled = true;
      entryRestorePreviewEl.textContent = '';
      entryRestoreSummaryEl.textContent = '';
      entryRestoreLoadStatusEl.textContent = 'Loaded ' + file.name + ' (' + entryRestorePool.length + ' entries available).';
      entryRestoreSearchEl.style.display = '';
      entryRestoreSearchEl.value = '';
      renderEntryRestoreList();
    } catch (err) {
      entryRestoreDump = null;
      entryRestorePool = [];
      entryRestoreLoadStatusEl.textContent = 'Invalid JSON: ' + err.message;
      entryRestoreSearchEl.style.display = 'none';
      entryRestoreListEl.innerHTML = '';
    }
  };
  reader.readAsText(file);
});

entryRestoreSearchEl.addEventListener('input', renderEntryRestoreList);

function renderEntryRestoreList() {
  entryRestoreListEl.innerHTML = '';
  const pool = entryRestorePool
    .filter(function (e) { return entityMatchesQuery(e, entryRestoreSearchEl.value); })
    .sort(function (a, b) { return (a.name || '').localeCompare(b.name || ''); });

  if (!pool.length) {
    const p = document.createElement('p');
    p.className = 'lore-empty';
    p.textContent = 'No matches.';
    entryRestoreListEl.appendChild(p);
    return;
  }

  const byCategory = {};
  pool.forEach(function (e) {
    const cat = e.category || '(uncategorized)';
    (byCategory[cat] = byCategory[cat] || []).push(e);
  });

  Object.keys(byCategory).sort().forEach(function (cat) {
    const header = document.createElement('div');
    header.className = 'entity-group-header';
    const titleSpan = document.createElement('span');
    titleSpan.className = 'entity-group-title';
    titleSpan.textContent = categoryGroupLabel(cat);
    const countSpan = document.createElement('span');
    countSpan.className = 'entity-group-count';
    countSpan.textContent = '(' + byCategory[cat].length + ')';
    header.appendChild(titleSpan);
    header.appendChild(countSpan);
    entryRestoreListEl.appendChild(header);

    const ul = document.createElement('ul');
    ul.className = 'entity-group-list';
    byCategory[cat]
      .sort(function (a, b) { return (a.name || '').localeCompare(b.name || ''); })
      .forEach(function (e) {
        const li = document.createElement('li');
        li.className = 'entry-restore-row';
        if (entryRestoreSelected && entryRestoreSelected.entity.id === e.id) li.classList.add('active');
        const nameDiv = document.createElement('div');
        nameDiv.className = 'entity-name';
        nameDiv.textContent = e.name;
        li.appendChild(nameDiv);
        li.addEventListener('click', function () { selectEntryRestoreEntity(e); });
        ul.appendChild(li);
      });
    entryRestoreListEl.appendChild(ul);
  });
}

function selectEntryRestoreEntity(entity) {
  const plan = computeEntryRestorePlan(entryRestoreDump, entity.id);
  entryRestoreSelected = { entity, plan };
  renderEntryRestoreList();
  entryRestorePreviewEl.textContent = entity.name + ' (' + categoryGroupLabel(entity.category || '(uncategorized)') + ') \u2014 '
    + plan.loreItems.length + ' lore item' + (plan.loreItems.length === 1 ? '' : 's') + ', '
    + plan.pins.length + ' pin' + (plan.pins.length === 1 ? '' : 's') + ', '
    + plan.images.length + ' image' + (plan.images.length === 1 ? '' : 's') + '.';
  entryRestoreRunBtn.disabled = false;
  entryRestoreSummaryEl.textContent = '';
}

entryRestoreRunBtn.addEventListener('click', function () {
  if (!entryRestoreSelected) return;
  const { entity, plan } = entryRestoreSelected;
  const connected = window.FIREBASE_ENV.projectId;
  const message = 'Restore "' + entity.name + '" into "' + connected + '"?\n\n'
    + '1 entity, ' + plan.loreItems.length + ' lore item(s), ' + plan.pins.length + ' pin(s), ' + plan.images.length + ' image(s).\n\n'
    + 'Existing docs with matching ids will be overwritten. Nothing else is touched or deleted.';
  if (!window.confirm(message)) return;

  entryRestoreRunBtn.disabled = true;
  const lines = [];
  function log(line) { lines.push(line); entryRestoreSummaryEl.textContent = lines.join('\n'); }

  runEntryRestore(entity, plan, log).then(function () {
    log('Done.');
    entryRestoreRunBtn.disabled = false;
  }).catch(function (err) {
    log('Restore failed: ' + err.message);
    entryRestoreRunBtn.disabled = false;
  });
});
