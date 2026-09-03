import { CONFIG } from './firebase.js';
import { state } from './state.js';
import { ensureMapTabReady } from './map.js';
import './auth.js';
import './admin.js';
import { fitCodexTabHeight, registerVisibilityChangeHandler } from './codex.js';
import './images.js';
import { ensureImportEditorReady } from './import.js';
import './export-lore.js';
import './backup.js';
import { ensureTimelineTabReady } from './timeline.js';
import { ensureCharactersTabReady, renderCharactersTab } from './characters.js';
import { ensureEncountersTabReady } from './encounters.js';
import { ensureStablesTabReady } from './stables.js';
import { renderMessagesTray } from './messages.js';
import { renderMarkdownInto } from './markdown.js';
import { activateTab, syncUrlToTab, registerTabActivator, initRouter } from './router.js';

renderMarkdownInto(
  document.getElementById('build-footer-links'),
  '[License & Project](https://github.com/whitwort/daggerheart-campaign-codex) information on Github.'
);

// Phase 14 S5: registered here (not at characters.js's own top level) --
// see the NOTE at the bottom of characters.js for why a real import
// cycle (codex.js -> admin.js -> characters.js -> codex.js) makes this
// registration unsafe from inside that cycle (TDZ on codex.js's own
// module-scope state). main.js is the entry point and outside the cycle
// -- every module's top-level code has fully run by the time main.js's
// own body executes.
registerVisibilityChangeHandler(renderCharactersTab);

// Phase 14 S6: same outside-the-cycle registration reasoning as
// renderCharactersTab above -- messages.js imports codex.js
// (switchToCodexTabForEntity), so registering from messages.js's own top
// level would be unsafe if that module ever gets pulled into the cycle.
// The tray re-renders here on role/active-character/visibility changes
// (badge colors, character names, entity-name visibility in the digest).
registerVisibilityChangeHandler(renderMessagesTray);

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

    // --- Tab wiring ------------------------------------------------------
    // Nav phase: activateTab()/syncUrlToTab() (router.js) now own the
    // class-toggle + ensureReady dance formerly inline here, so both a
    // direct button click and a URL-driven (router) activation go through
    // one place. registerTabActivator covers all 7 tabs (only
    // codex/map/timeline are actually URL-routed -- see router.js header --
    // but the other 4 still need their ensureReady wired for plain clicks).
    registerTabActivator('codex-panel', fitCodexTabHeight);
    registerTabActivator('map-panel', ensureMapTabReady);
    registerTabActivator('timeline-panel', ensureTimelineTabReady);
    registerTabActivator('characters-panel', ensureCharactersTabReady);
    registerTabActivator('encounters-panel', ensureEncountersTabReady);
    registerTabActivator('stables-panel', ensureStablesTabReady);
    registerTabActivator('admin-panel', ensureImportEditorReady);

    document.querySelectorAll('nav#tabs button').forEach(function (btn) {
      btn.addEventListener('click', function () {
        activateTab(btn.dataset.tab);
        syncUrlToTab(btn.dataset.tab.replace('-panel', ''));
      });
    });

// hasAccess mirrors auth.js's own updateAccessUI check (role === 'gm' ||
// role === 'player') -- duplicated rather than imported since auth.js
// exports nothing today (side-effect-only module); state.currentRole is
// the shared source of truth either way.
initRouter(function () {
  return state.currentRole === 'gm' || state.currentRole === 'player';
});

