import { CONFIG } from './firebase.js';
import { ensureMapTabReady } from './map.js';
import './auth.js';
import './admin.js';
import { fitCodexTabHeight } from './codex.js';
import './images.js';
import { ensureImportEditorReady } from './import.js';
import './backup.js';
import { ensureTimelineTabReady } from './timeline.js';

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
        if (btn.dataset.tab === 'codex-panel') {
          fitCodexTabHeight();
        }
        if (btn.dataset.tab === 'admin-panel') {
          ensureImportEditorReady();
        }
        if (btn.dataset.tab === 'timeline-panel') {
          ensureTimelineTabReady();
        }
      });
    });

// Codex is the default-active tab on load (no click event fires for
// it) -- fit its height once up front so it's correctly sized before
// the first render, same as the other tabs' ready-functions do on
// their own first activation.
fitCodexTabHeight();

