# Phase design: Bookmarkable Navigation (Codex/Map/Timeline) — LOCKED

Findings this design is based on: nav-findings.md (session doc, not committed —
recoverable from chat history if needed). Characters/Encounters/Stables nav is
a deliberate follow-up phase, not in scope here.

## URL scheme

```
/                              → default: Codex tab, no selection
/codex/<entityId>              → Codex tab, entity selected
/codex/<entityId>?tab=notes    → detailActiveTab (default 'lore', omitted when default)
/map/<entityId>                → Map tab, showing that Location's map
/map                           → Map tab, no entity (root)
/timeline/<entityId>           → Timeline tab, entity selected
/timeline                      → Timeline tab, no selection
```

Path-based (firebase.json already rewrites `**` → `/index.html`). No query
params besides `?tab=` on `/codex/*`.

## router.js (new module)

- `activateTab(tabId)` — factored out of main.js's nav#tabs click handler so
  both the click handler and the router call the same tab-activation logic
  (class toggles + the relevant `ensure*TabReady()`).
- `navigateTo(path)` — `history.pushState` wrapper. No-ops (state update only,
  no history push) if `path === location.pathname` — per Gregg, skip redundant
  entries on same-target clicks (e.g. re-clicking a chip for the entity
  already open).
- `initRouter()` — called once from main.js, after other modules' top-level
  code has run (same placement rule as the existing
  `registerVisibilityChangeHandler` calls in main.js). Parses
  `location.pathname` on load, defers activation until `hasAccess` is true if
  called before auth resolves, then calls `activateTab` + seeds the relevant
  tab's selection state.
- `popstate` listener: same parse → activate path as initial load.
- Root `/` (or any unrecognized path) → Codex tab, no selection. No
  last-viewed-tab restoration.

## Call-site changes

| Function | File | Change |
|---|---|---|
| `selectEntity` | codex.js:1239 | `navigateTo('/codex/' + entityId)` |
| detail-tab click handler | codex.js | `navigateTo('/codex/' + state.selectedId + (tab !== 'lore' ? '?tab=' + tab : ''))` |
| `navigateToMapForEntity` | map.js:110 | `navigateTo('/map/' + entityId)` |
| `openEntityInPanel` / `selectFromList` | timeline.js:271,285 | `navigateTo('/timeline/' + entityId)` |

`switchToCodexTabForEntity` (codex.js:1686) routes through the same Codex
navigateTo call already covered by `selectEntity` — no separate handling.

Each of codex.js/map.js/timeline.js exports one function for the router to
call on initial parse / popstate, reusing `selectEntity` /
`navigateToMapForEntity` / `openEntityInPanel` directly — all three already
degrade gracefully when the id isn't in `state.allEntities` yet (confirmed:
codex.js's entitiesUnsub snapshot callback re-renders list + detail on every
update, so a deep link set before data arrives resolves itself once the first
snapshot lands — no special-cased waiting needed).

## Access gating

Codex/Map/Timeline are available to both `gm` and `player` roles already — no
role-based redirect needed for this phase. `initRouter()` defers activation
until `hasAccess` (auth.js:150) is true.

## Explicitly out of scope

Modals/dialogs, search query, edit-mode/draft state, Leaflet pan/zoom,
timeline zoom/pan, Admin db-sub-tabs, Characters/Encounters/Stables selection
(follow-up phase).
