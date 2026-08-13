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

// nav#tabs full-bleeds via a --viewport-w custom property instead of the
// literal 100vw unit: 100vw always includes the scrollbar gutter, but the
// actually-visible width (clientWidth) doesn't — whenever a page-level
// vertical scrollbar is present the two diverge and the full-bleed math
// falls short of the real edge. Some tabs' content (e.g. Map, with tall
// images/popups) toggles that scrollbar on and off more than others,
// which is why this was Map-tab-specific and width-dependent rather than
// a constant offset. Measuring the real value directly sidesteps the
// mismatch instead of guessing at a correction.
function updateViewportWidthVar() {
  document.documentElement.style.setProperty('--viewport-w', document.documentElement.clientWidth + 'px');
}
updateViewportWidthVar();
let viewportWResizeTimer = null;
window.addEventListener('resize', function () {
  clearTimeout(viewportWResizeTimer);
  viewportWResizeTimer = setTimeout(updateViewportWidthVar, 150);
});
// Window resize alone doesn't catch the scrollbar toggling on/off from a
// content-height change (e.g. switching to the Map tab) with no actual
// window resize — a ResizeObserver on body catches that case too.
// Doesn't mutate anything the observed element's own size depends on
// (unlike the portrait hero band's observer in codex.js), so there's no
// self-triggering loop risk here.
new ResizeObserver(function () {
  clearTimeout(viewportWResizeTimer);
  viewportWResizeTimer = setTimeout(updateViewportWidthVar, 150);
}).observe(document.body);

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

