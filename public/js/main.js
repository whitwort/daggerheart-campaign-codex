import { CONFIG } from './firebase.js';
import { ensureMapTabReady } from './map.js';
import './auth.js';
import './admin.js';
import './codex.js';
import './images.js';
import { ensureImportEditorReady } from './import.js';

document.getElementById('campaign-title').textContent = CONFIG.campaignName;
document.getElementById('tab-btn-codex').textContent = CONFIG.tabs.codex;
document.getElementById('tab-btn-map').textContent = CONFIG.tabs.map;

// nav#tabs' full-bleed is pure CSS (percentage of body's content box,
// see styles.css) — no JS-measured viewport width. A measured snapshot
// (--viewport-w, tried previously) goes stale whenever a content-height
// change toggles the page scrollbar with no resize/tab event to
// re-measure, and the reactive fix (ResizeObserver on body) fed back on
// its own side effects. Percentages re-resolve at layout time, so the
// entire staleness class is gone.

    // --- Map tab -------------------------------------------------------
    document.querySelectorAll('nav#tabs button').forEach(function (btn) {
      btn.addEventListener('click', function () {
        document.querySelectorAll('nav#tabs button').forEach(function (b) { b.classList.remove('active'); });
        document.querySelectorAll('.tab-panel').forEach(function (p) { p.classList.remove('active'); });
        btn.classList.add('active');
        document.getElementById(btn.dataset.tab).classList.add('active');

        if (btn.dataset.tab === 'map-panel') {
          ensureMapTabReady();
        }
        if (btn.dataset.tab === 'admin-panel') {
          ensureImportEditorReady();
        }
      });
    });

// iPadOS Safari split/Stage Manager resize can RESCALE the page
// instead of reflowing it: the layout viewport keeps a stale width
// (here: clientWidth stuck at a mid-drag value) and a <1 scale is
// applied to the whole canvas, leaving a gap at the right edge that
// no CSS can address (100% and clientWidth both resolve against the
// same stale layout viewport — which is also why the earlier
// --viewport-w JS never helped). Rewriting the viewport meta content
// after resizes settle forces WebKit to recompute the layout width
// from device-width and reset scale to 1. The two content strings
// are semantically identical (1 vs 1.0) — alternating guarantees the
// attribute actually changes so WebKit reprocesses it.
(function () {
  const meta = document.querySelector('meta[name="viewport"]');
  if (!meta) return;
  const variants = ['width=device-width, initial-scale=1', 'width=device-width, initial-scale=1.0'];
  let flip = 0;
  let settleTimer = null;
  function reassert() {
    // Trigger ONLY on the broken-state signature: scale below 1
    // (users can pinch-zoom IN past 1, never OUT below fit, so a
    // sub-1 scale is always Safari's stale-resize state, and
    // checking > 1 here would stomp intentional user zoom). Fallback
    // without visualViewport: layout narrower than the window, which
    // is likewise impossible via user zoom.
    const scaledDown = window.visualViewport
      ? window.visualViewport.scale < 0.999
      : document.documentElement.clientWidth < window.innerWidth - 1;
    if (scaledDown) {
      flip = 1 - flip;
      meta.setAttribute('content', variants[flip]);
    }
  }
  function schedule() {
    clearTimeout(settleTimer);
    settleTimer = setTimeout(reassert, 250);
  }
  window.addEventListener('resize', schedule);
  if (window.visualViewport) window.visualViewport.addEventListener('resize', schedule);
  schedule();
})();

// TEMP DEBUG (remove after nav-width diagnosis): live width readout.
// Distinguishes a stale layout viewport (clientWidth) from the real
// window size (innerWidth / visualViewport.width) after iPad split
// resizes. If clientWidth < innerWidth after growing the split, the
// ICB itself is stale — no CSS on nav can fix that.
(function () {
  const el = document.createElement('div');
  el.id = 'debug-width-readout';
  el.style.cssText = 'position:fixed;bottom:4px;left:4px;z-index:99999;background:#000;color:#0f0;font:12px monospace;padding:4px 8px;border-radius:4px;opacity:0.85;pointer-events:none;';
  document.body.appendChild(el);
  function upd() {
    el.textContent =
      'client:' + document.documentElement.clientWidth +
      ' inner:' + window.innerWidth +
      (window.visualViewport ? ' vv:' + Math.round(window.visualViewport.width) + ' scale:' + window.visualViewport.scale.toFixed(3) : '') +
      ' navR:' + Math.round(document.getElementById('tabs').getBoundingClientRect().right);
  }
  upd();
  window.addEventListener('resize', upd);
  if (window.visualViewport) window.visualViewport.addEventListener('resize', upd);
  setInterval(upd, 1000);
})();
