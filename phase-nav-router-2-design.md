# Phase design: Bookmarkable Navigation, phase 2 (Characters/Encounters/Stables/Admin) — LOCKED

Follow-up to phase-nav-router-design.md (locked), which explicitly deferred
these four tabs.

## URL scheme

```
/characters                      → Characters tab, no selection
/characters/<entityId>           → character selected (default tab: cards)
/characters/<entityId>?tab=sheet → Sheet tab
/encounters                      → Encounters tab, no selection (GM only)
/encounters/<encId>              → encounter selected (default tab: build)
/encounters/<encId>?tab=run      → Run tab
/stables                         → Stables tab, no selection (GM only)
/stables/<dropId>                → drop selected
/admin                           → Admin tab (GM only, no entity param)
```

Same `?tab=` param name reused across all routes, including Codex's existing
`?tab=notes` (Gregg's call) — router.js doesn't validate the value per-route;
each module's own tab-switch code already defaults an unrecognized value
harmlessly (existing behavior, same as Codex today).

List-filter state (`encountersListTab`, `stablesDropsTab`) stays session-only,
NOT in the URL (Gregg's call) — same treatment as phase 1's `categoryCollapse`.

## Access gating (new vs. phase 1)

Phase 1's three routes are available to both roles, so `initRouter`'s
`accessCheck` (hasAccess only) was sufficient. Encounters/Stables/Admin are
GM-only — their tab **buttons** are already hidden for players
(`auth.js` sets `style.display='none'`), but `activateTab()`/
`parseAndActivate()` have no role check today, so a player following/pasting
a `/encounters/<id>` link would successfully activate a GM-only panel.

New in phase 2: `registerRoute()` takes an optional `gmOnly: true`.
`parseAndActivate()` checks `state.currentRole === 'gm'` for those prefixes
and falls back to root on failure — via `history.replaceState` (not
`navigateTo`/pushState), so a rejected deep link doesn't leave a dead entry
in the player's back-button history.

Assumes `state.currentRole` is already resolved by the time `accessCheck()`
passes (true today — role and hasAccess resolve together in auth.js). Not
independently re-verified; flag if this ever proves wrong.

## Call-site changes

| Function | File | Change |
|---|---|---|
| character-row click handler (~characters.js:254) | characters.js | `navigateTo('/characters/' + entity.id)` |
| "Set active" picking-mode click (~characters.js:507) | characters.js | same |
| Characters detail-tab click (~characters.js:120) | characters.js | `navigateTo('/characters/' + state.charactersSelectedId + (tab!=='cards' ? '?tab='+tab : ''))` |
| unassign/remove clearing selection (~characters.js:203,215) | characters.js | `navigateTo('/characters')` when cleared |
| encounter-row click (~encounters.js:344) | encounters.js | `navigateTo('/encounters/' + enc.id)` |
| createEncounter (~encounters.js:115) | encounters.js | same |
| Encounters detail-tab click (~encounters.js:371) | encounters.js | `navigateTo('/encounters/' + state.encountersSelectedId + (tab!=='build' ? '?tab='+tab : ''))` |
| deleteEncounter / listTab-switch clearing selection (~encounters.js:129,1806) | encounters.js | `navigateTo('/encounters')` when cleared |
| drop-row click (~stables.js:294) | stables.js | `navigateTo('/stables/' + d.id)` |
| dropsTab-switch clearing selection (~stables.js:383) | stables.js | `navigateTo('/stables')` |
| Admin tab click (no entity) | main.js | `navigateTo('/admin')` |

Each of characters.js/encounters.js/stables.js exports one `activate(id,
params)` function for router.js to call on initial parse/popstate, mirroring
phase 1: sets `*SelectedId` (and `*DetailTab` from `params.get('tab')`,
defaulted) then calls that tab's own render function — no new waiting logic
needed (existing snapshot listeners re-render on data arrival, same as phase
1's confirmed behavior). Admin has no selection state to seed; its `activate`
is a no-op beyond the role check.

## Out of scope

Nested Characters deck-viewer state (`characterDeckAbilityTab`, drag-split
fractions) — session-only, not addressed. Admin sub-tabs (db-sub-tabs,
Sources/Data/Config) — no deep link; `/admin` always lands on whatever
sub-tab was last active in-session (same non-restoration policy as phase 1's
"no last-viewed-tab restoration").
