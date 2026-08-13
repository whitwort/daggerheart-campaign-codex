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
