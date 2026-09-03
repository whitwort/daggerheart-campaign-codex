// router.js — Nav phase (bookmarkable Codex/Map/Timeline URLs). See
// phase-nav-router-design.md (locked) for the full design. Characters/
// Encounters/Stables/Admin stay unrouted (follow-up phase) — their tab
// buttons still work via plain activateTab(), just with no URL.
//
// Deliberately has ZERO imports of codex.js/map.js/timeline.js. Those three
// modules instead call registerRoute() at their OWN top level (same
// self-registration pattern codex.js already uses for
// registerVisibilityChangeHandler/registerMapNavigationHandler) — that
// keeps this a one-directional import (feature module -> router.js) with
// no cycle, even though this module drives their navigation.
//
// URL scheme (path-based; firebase.json already rewrites ** -> /index.html,
// no hosting change needed):
//   /                            -> Codex tab, no selection (default)
//   /codex/<entityId>            -> Codex tab, entity selected
//   /codex/<entityId>?tab=notes  -> detailActiveTab (default 'lore', omitted when default)
//   /map/<entityId>              -> Map tab, showing that Location's map
//   /map                         -> Map tab, no entity (root)
//   /timeline/<entityId>         -> Timeline tab, entity selected
//   /timeline                    -> Timeline tab, no selection

const routeHandlers = {}; // prefix ('codex'|'map'|'timeline') -> { activate(entityId, params), currentPath() }
const tabActivators = {}; // tabId ('codex-panel'|...) -> ensureReady fn, for ALL 7 tabs (not just routed ones)

function registerRoute(prefix, handlers) {
  routeHandlers[prefix] = handlers;
}

function registerTabActivator(tabId, ensureReadyFn) {
  tabActivators[tabId] = ensureReadyFn;
}

// Shared tab-switch logic — used both by direct nav#tabs button clicks
// (main.js) and by the router's own URL-driven activation, so there's one
// place that does the class-toggle + ensureReady dance.
function activateTab(tabId) {
  document.querySelectorAll('nav#tabs button').forEach(function (b) { b.classList.remove('active'); });
  document.querySelectorAll('.tab-panel').forEach(function (p) { p.classList.remove('active'); });
  const btn = document.querySelector('nav#tabs button[data-tab="' + tabId + '"]');
  if (btn) btn.classList.add('active');
  const panel = document.getElementById(tabId);
  if (panel) panel.classList.add('active');
  const ensureReady = tabActivators[tabId];
  if (ensureReady) ensureReady();
}

// No-op when the target already matches the current URL — Gregg's call:
// don't grow history on a redundant same-target click (e.g. re-clicking a
// related-entity chip for the entity already open).
function navigateTo(path) {
  if (path === location.pathname + location.search) return;
  history.pushState(null, '', path);
}

// Called after a plain tab-button click (not an entity-link navigateTo
// call) so e.g. clicking the Map tab directly still lands the URL on
// /map/<currentMapEntityId> if one's already loaded, rather than leaving a
// stale URL from whichever tab was open before.
function syncUrlToTab(prefix) {
  const handler = routeHandlers[prefix];
  if (handler) navigateTo(handler.currentPath());
}

// activate() runs BEFORE activateTab() deliberately: it only seeds
// module state (selection/tab), it doesn't touch DOM visibility — so it's
// safe to call while the target panel is still hidden. activateTab() then
// reveals the panel and calls that tab's ensureReady() with state already
// correct, instead of ensureReady() running first against stale state.
function parseAndActivate() {
  const parts = location.pathname.split('/').filter(Boolean);
  const prefix = parts[0];
  const entityId = parts[1] ? decodeURIComponent(parts[1]) : null;
  const params = new URLSearchParams(location.search);

  if (routeHandlers[prefix]) {
    routeHandlers[prefix].activate(entityId, params);
    activateTab(prefix + '-panel');
    return;
  }
  // Unrecognized/root path -> Codex tab, no selection (the default).
  activateTab('codex-panel');
}

let accessCheck = function () { return true; };

function initRouter(check) {
  accessCheck = check;
  window.addEventListener('popstate', function () {
    if (accessCheck()) parseAndActivate();
  });
  if (accessCheck()) parseAndActivate();
}

// Called by auth.js once hasAccess is true (may be before or after
// initRouter's own call, depending on auth resolution timing) — safe to
// call repeatedly, parseAndActivate() just re-syncs from the current URL.
function routeOnAccessGranted() {
  if (accessCheck()) parseAndActivate();
}

export {
  registerRoute, registerTabActivator, activateTab, navigateTo, syncUrlToTab,
  initRouter, routeOnAccessGranted
};
