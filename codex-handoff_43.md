# Codex handoff 43 — deep code review + cleanup pass

HEAD at session end: `7d8f203`. Six commits, all pushed, dev deploy CI
green on `7d8f203`. This session was the full-repo code review Gregg
requested ahead of the first prod release, then implementation of every
finding he approved (his call sheet: A1(a), A2–A4 yes, B/C/D/E/F fix,
plus prod suppression of the debug banner).

## What changed (by commit)

1. `947a98c` — **Repo/rules hygiene.** Deleted
   `backups/prod-2026-08-13.json` (committed by the pre-`b8d6867`
   backup workflow; tree-only removal — Gregg chose (a), no history
   purge; the file remains in history at `26ec881`, contents were his
   own wlu.edu email + 1 image + 3 pins). Removed from
   `firestore.rules`: `/_health` (Phase 0 smoke test, was the app's
   only unauthenticated read), legacy `/entries` and `/maps` blocks
   (no client code references either collection), duplicate `/_meta`
   block. 16 live match blocks remain.
2. `4c5968c` — **Dead code.** Removed: codex.js
   `buildEntityPreviewCard` (~60 lines; callers removed back in
   `7f7cfad`/`af003ff`) + its CSS (`.entity-preview-*`),
   `isEntityPlayerVisible`, connectivity.js `flashPendingWrite`,
   templates.js `hasTemplateSchema`, vestigial `mapCardActiveTab`
   (map.js) and `activeTab` (timeline.js), unused imports (admin.js
   `updateDoc`/`CONFIG`, sharing.js `updateDoc`, characters.js
   `canSee`), 12 redundant `export` keywords on internal-only names,
   dead CSS (`.lore-vis-badge`, `.character-name-chip`,
   `.character-player-eye-view`, `.import-conflict-row`,
   `.admin-notification-message`/`-error`, `#map-image-upload*`), and
   the unreferenced `public/about.md`.
3. `153382e` — **Dedupe.** New `public/js/picker-panel.js`:
   `buildPickerPanel({className,title,draggable})` +
   `attachPickerDismiss(panel,onClose)` (outside-click/Escape,
   deferred-tick doc listener, idempotent close). Imports nothing —
   the cycle-avoidance reason character-cards.js carried its own copy
   is gone. codex.js `buildGalleryPickerPanel` and character-cards.js
   `buildFloatingPickerPanel` are now thin wrappers; encounters.js's
   adversary picker uses the shared builder directly and deliberately
   keeps Escape/Close-only dismissal (multi-add clicks must not close
   it); openSetPortraitDialog likewise keeps its own close (gallery
   click-through). `recipientCtxFor` deduped: stables.js now imports
   it from sharing.js (bodies were byte-identical) — sharing.js stays
   the single notification seam. **Not consolidated (per review
   recommendation, Gregg can override):** codex-internal
   template-editor feature-row clones (~2177/2246, 2700–2950 region)
   and the lore-edit Save/Cancel row pair (2826/2873).
4. `87d65cf` — **Docs.** README feature list + file tree rewritten to
   cover the actual app (was ~Phase 7 vintage). Stale comments fixed:
   characters.js "Sheet tab is a placeholder", visibility.js caller
   list, firestore.rules `Config.gs` reference.
5. `a7f5996` — **Load time.** Leaflet 1.9.4 vendored into
   `public/vendor/leaflet/` (official npm tarball dist: js/css/images)
   — unpkg removed as a runtime dependency; version bumps are now a
   manual re-vendor. index.html: `preconnect` to www.gstatic.com,
   `modulepreload` for the 3 Firebase SDK URLs + all 33 local modules
   (graph was 10 imports deep × no-cache = up to 10 serial
   revalidation round-trips; now one parallel wave). **Keep the
   preload list in sync when adding/removing modules under js/** — a
   comment in index.html says the same.
6. `7d8f203` — **Runtime + prod banner.** Hidden-panel guards on
   `renderCharactersTab`/`renderEncountersTab`/`renderStablesTab`
   (timeline already had one; ensure*TabReady re-renders on
   activation, main.js adds `.active` first). characterImages-listener
   comment corrected (deleting `data` saves memory, not bandwidth;
   hasSecretImages-mirror escape hatch documented).
   `migrateLegacyMapImageIfNeeded` removed — map.js's `role:'map'`
   read fallback kept and is now the ONLY legacy path (**caveat:**
   restoring a pre-migration-era backup resurfaces legacy docs in
   display-only form; they'll render on the Map tab but never migrate
   to gallery). Codex search debounced 120ms (Enter/clear immediate).
   Debug banner: `__showDebugBanner` now no-ops unless the Firebase
   projectId ends in `-dev` or the build is unstamped local — prod
   players never see the red panel; dev keeps it; firebase.js's
   persistence-fallback warning routes through the same gate. The
   placeholder comparison uses a split literal (`'__BUILD'+'_HASH__'`)
   so CI's sed stamping can't clobber it.

## Needs Gregg's dev verification (all UI-touching changes)

- Pickers still behave: Related-entries picker, ability/experience/card
  pickers (deck), Clone-from picker, adversary picker (drag-to-move +
  multi-add without closing), Set portrait/Set map panels.
- Characters/Encounters/Stables tabs render correctly on first
  activation and after background snapshot changes (the new guards).
- Codex search feels unchanged (120ms debounce), clear button + Enter
  still immediate.
- Map tab loads with self-hosted Leaflet (check pins/zoom on iPad).
- On dev, force an error (e.g. brief airplane-mode toggle) — banner
  still appears. On prod (post-launch), it must not.

## Review findings NOT actioned (for the record)

- Dynamic-`import()` of GM-only modules (import/srd-import/backup/
  encounters/stables ≈ 3,000 lines) — post-launch payload optimization.
- codex.js split (4.8k lines, 5-module import cycle) — post-launch.
- `vendor/**` long-cache header — safe (immutable-by-path) but left
  out to keep the deliberate blanket no-cache policy untouched.
- QOL-BACKLOG DONE/CLOSED sections kept as history (file says carry
  forward).
- `setEntityImagesTarget` stuck-listener gap — still open from
  handoff 41.

## Open items carried forward (unchanged from handoff 42)

- **Fix `BACKUP_REPO_PAT`** (Gregg, GitHub UI) — still the top
  pre-launch item; prod's daily backup depends on it.
- First prod release: bump nothing, tag `v0.1b` GitHub Release →
  first-ever run of `deploy-hosting-prod`; verify `_meta/version` in
  prod, footer label, rules/indexes deploy. Note the rules deploy now
  DELETES the `_health`/`entries`/`maps`/dup-`_meta` blocks on both
  projects — expected.
- Deploy-workflow recommendations (approval gate, rules unit tests,
  pre-deploy backup, post-deploy smoke test) — decide priority.
- Encounter-builder integration exploration — resume after launch.
- Single-entry restore "delete orphans" mode — deferred.

## Session ritual reminder

Fresh clone, verify HEAD `7d8f203`, git identity, rebase FETCH_HEAD if
remote moved. Read QOL-BACKLOG.md + this doc first. Gates before every
commit: /tmp/import-check.py, eslint check config, node --check loop,
CSS + rules brace balance. CI poll ~74s, json.loads(strict=False).
