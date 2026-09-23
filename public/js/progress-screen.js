// progress-screen.js -- the one full-screen "working" UI (Sep 2026),
// shared by two clients:
//   - Boot: first page load, from first paint until campaign data has
//     arrived. The markup lives in index.html (visible by default, so it
//     covers the module download before any JS runs); index.html's
//     inline boot script drives stage 1 (module files fetched, 0-60%)
//     on its own, then hands off here once main.js runs.
//   - Operations: op-status.js's GM-broadcast Restore/Import/SRD import,
//     shown to every connected client (replaces its old modal dialog).
// An active operation takes precedence; if boot is still in progress
// when the operation ends, the boot view comes back.
//
// Boot stages (percent of bar):
//   app files 0-60 (inline script) -> signing in 60 -> checking access
//   65 -> campaign data 70-100 (entities + lore first snapshots, 15
//   each). bootDone() is final and idempotent: later listener
//   re-attaches (sign-out/in, reconnects) never bring the boot screen
//   back.
import { CONFIG } from './firebase.js';

const BOOT_DATA_KEYS = ['entities', 'lore'];
const SLOW_HINT = 'Still working — first load after an update can take a moment.';

const els = {
  root: document.getElementById('progress-screen'),
  title: document.getElementById('ps-title'),
  fill: document.getElementById('ps-fill'),
  step: document.getElementById('ps-step'),
  hint: document.getElementById('ps-hint')
};

const boot = {
  active: true, percent: 60, step: 'Signing in…',
  dataArrived: {}, slow: false
};
let op = null;   // { title, step, percent|null } while an operation runs

function render() {
  if (!els.root) return;
  // Stage 1 belongs to index.html's inline script until now.
  window.__bootHandedOff = true;
  if (op) {
    draw(op.title || 'Working…', op.step, op.percent,
      'The app isn’t usable until this finishes — hang tight.');
    els.root.classList.add('op-active');
    show();
    return;
  }
  els.root.classList.remove('op-active');
  if (boot.active) {
    draw(CONFIG.campaignName || '', boot.step, boot.percent, boot.slow ? SLOW_HINT : '');
    show();
    return;
  }
  hide();
}

function draw(title, step, percent, hint) {
  els.title.textContent = title;
  els.step.textContent = step || '';
  els.hint.textContent = hint || '';
  els.hint.hidden = !hint;
  if (typeof percent === 'number') {
    els.fill.classList.remove('indeterminate');
    els.fill.style.width = Math.max(0, Math.min(100, percent)) + '%';
  } else {
    els.fill.classList.add('indeterminate');
    els.fill.style.width = '';
  }
}

function show() {
  els.root.hidden = false;
  els.root.classList.remove('fading');
}

// Fade, then drop out of layout/hit-testing entirely.
function hide() {
  if (els.root.hidden || els.root.classList.contains('fading')) return;
  els.root.classList.add('fading');
  setTimeout(function () {
    if (els.root.classList.contains('fading')) {
      els.root.hidden = true;
      els.root.classList.remove('fading');
    }
  }, 350);
}

// --- Boot ------------------------------------------------------------

function bootStage(percent, step) {
  if (!boot.active) return;
  boot.percent = percent;
  boot.step = step;
  render();
}

// key: one of BOOT_DATA_KEYS; first snapshot of that collection landed.
function bootDataArrived(key) {
  if (!boot.active || boot.dataArrived[key]) return;
  boot.dataArrived[key] = true;
  const got = BOOT_DATA_KEYS.filter(function (k) { return boot.dataArrived[k]; });
  if (got.length === BOOT_DATA_KEYS.length) { bootDone(); return; }
  boot.percent = 70 + 30 * got.length / BOOT_DATA_KEYS.length;
  boot.step = 'Loading campaign data… (' + BOOT_DATA_KEYS.map(function (k) {
    return (k === 'entities' ? 'entries' : k) + (boot.dataArrived[k] ? ' ✓' : '…');
  }).join(', ') + ')';
  render();
}

function bootDone() {
  if (!boot.active) return;
  boot.active = false;
  render();
}

// Slow-load hint: index.html's inline script already shows it for stage
// 1; keep it on for the rest of boot if we're past the threshold.
if (window.__bootSlow) boot.slow = true;
setTimeout(function () {
  if (boot.active) { boot.slow = true; render(); }
}, Math.max(0, 8000 - performance.now()));

// --- Operations (op-status.js) -----------------------------------------

function showOpProgress(title, step, percent) {
  op = { title: title, step: step, percent: (typeof percent === 'number') ? percent : null };
  render();
}

function hideOpProgress() {
  if (!op) return;
  op = null;
  render();
}

function isOpProgressShowing() {
  return !!op;
}

render();

export { bootStage, bootDataArrived, bootDone, showOpProgress, hideOpProgress, isOpProgressShowing };
