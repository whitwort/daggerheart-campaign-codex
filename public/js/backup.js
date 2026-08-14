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

const db = getFirestore(firebaseApp);

const COLLECTIONS = ['config', 'entities', 'images', 'joinRequests', 'loreItems', 'pins', 'players'];
const RESTORABLE_COLLECTIONS = COLLECTIONS.filter(function (c) { return c !== 'joinRequests'; });
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
    dump.collections[name] = snap.docs.map(function (d) {
      return { id: d.id, data: serializeValue(d.data()) };
    });
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
  }
  log('joinRequests: skipped (GM cannot recreate other users\u2019 pending requests \u2014 see backup.js header)');
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
