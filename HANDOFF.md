# HANDOFF — single rolling session-transfer doc

**Convention (established at repo cleanup, Aug 2026): this is the ONLY
session-transfer file.** Each session ends by REWRITING this file with
current state — do not create codex-handoff_N.md files. Old handoffs
and phase design docs get periodically deleted from the tree in cleanup
passes; all remain retrievable from git history
(`git log --all --oneline -- 'codex-handoff_*.md' 'phase-*.md'`).
Code comments citing e.g. "phase-14-design.md §5.1" are historical
pointers into deleted docs — resolve via git history, don't "fix" the
comments.

Durable conventions (identity, pre-commit gate, CI/deploy, locked
decisions, lore-import standard) now live in `CLAUDE.md` and
`docs/claude/` (added Sep 23) — Claude Code loads `CLAUDE.md`
automatically. This file is current state + recent history only.

`phase-nav-router-design.md` and `phase-nav-router-2-design.md` are
still in the tree (locked nav design docs, not yet swept).

## Current state (end of session, Sep 23–24 2026)

HEAD: `9ddcd05`, CI green on every push this session (Deploy + E2E +
Author check), except the one Author-check failure noted below.
**Prod is at `v1.0.3` = `533506f`** (Sep 21). **14 commits on dev
ahead of prod** — everything in the list below. Next Release ships
all of it, including two `firestore.rules` changes (loreItems
`encounterStatus`, entities `pendingRelatedSlugs`) and the deploy-time
cache-busting step (first prod run of `scripts/stamp-asset-versions.mjs`).

**Known red X, left on purpose (Gregg's call):** `cb17ea7` "Test push
access to main (empty commit)" was committed as `noreply@anthropic.com`
and fails Author check. Empty commit, no code. Don't rewrite history
for it; later pushes only check their own range and are green.

History was rewritten Sep 21 (filter-repo, all hashes changed) — never
trust a pre-Sep-21 remembered SHA; `git log --grep` instead. The
GitHub web "Contributors" sidebar still shows the old typo account
("DarrylWhitworth"); repo, tags, commit search and the contributors
API are all clean (verified Sep 23) — it's a stale GitHub web cache.
Fix is a GitHub Support request, not more rewriting.

## This session (Sep 22–24) — all on dev, none in prod yet

Applied from patches (chat sessions that couldn't push):
- **Encounter notifications redesign** (`0d85f05`): entry-linked vs
  standalone notification shapes. Then debugged on dev with Gregg —
  see the encounter section below.
- **CLAUDE.md + docs/claude/** (`f25b09f`).

Features / fixes:
- **Lore import: pending related links** (`a7cf9ed`). Unresolvable
  `relatedSlugs` are no longer errors: stored slugified in
  `entities.pendingRelatedSlugs`, listed in the import report as
  "Pending related links". New `public/js/related.js` resolves them at
  READ time against live slugs (Codex Related chips both directions,
  edit draft, clone, Export Lore round-trip). `parentSlug` stays
  strict. Gregg-verified on dev (after the cache issue below).
- **Item/Consumable card cap by rendered height** (`890620e`).
  `buildMiniCard` `clampLines` (max-height N×line-height + fade when
  overflowing). The old `truncateCardMd` 20-source-line cap missed long
  single-line paragraphs. Gregg-verified.
- **Deploy-time cache busting** (`2366009`). Root cause found: after a
  deploy, a reload could pair fresh index.html with a stale cached
  module (Gregg saw old import.js under the new build label).
  `scripts/stamp-asset-versions.mjs` (run in both deploy jobs) injects
  an import map at index.html's `__IMPORT_MAP__` placeholder mapping
  every `/js/x.js` → `/js/x.js?v=<hash>`, and versions local
  src/href URLs. Fails the deploy if anything local is left
  unversioned. **Never add `?v=` to JS import specifiers by hand**
  (two URLs = duplicated singletons like state.js). Dev deploy green.
- **Loading screen + unified progress UI** (`567e1a5`).
  `public/js/progress-screen.js` + markup/inline boot script in
  index.html. Boot: 0–60% module files (PerformanceObserver vs
  modulepreload count), 60 signing in, 65 checking access, 70–100
  entities+lore first snapshots; 8s "still working" hint, 45s "try
  reloading". `op-status.js` (Restore/Import broadcast) renders through
  the same screen now (old modal + `.op-status-*` CSS removed).
  `version.js` auto-reload guard checks `isOpProgressShowing()`. E2E
  green; GM path and op screen not yet eyeballed by Gregg.
- **Encounter notification bugs** (`57dd866`, `5b7b104`, `363373b`,
  `02a85e4`) — Gregg-tested iteratively on dev:
  - Duplicate starts: local-write snapshot lag let fast HP taps fire
    'start' repeatedly. In-memory once-per-run guard
    (`revealApplied[encId|phase]`), cleared by Reset.
  - Standalone encounters always notify now (were gated on content).
  - Start reveals a hidden linked entry (Gregg's choice) via
    `shareEntityVisibility` — players also get "You have discovered".
  - Player digest: one line per encounter per entry (latest
    transition), keyed by loreItemId (covers legacy no-encId docs);
    preposition by category (Location/Environment "at", Scene/Event
    "during", else "in"). Reset also deletes legacy reveal docs.
  - `encounterRevealMd` rebuilt per phase (start "You see:",
    completion "You fought:" + "You found:"), no longer appended.
- **Loot always revealed on completion** (`fa8025e`); toggle removed.
- **Live encounter status** (`bb8c36c`). Build tab "Live status":
  Show Adversary Status / Show Player Status (off by default). While
  Started, the linked lore item shows HP/Stress boxes.
  `public/js/encounter-status.js`. Adversaries: GM client writes
  `loreItems.encounterStatus` from the encounters listener
  (`syncEncounterStatuses`, diffed); names generic ("Adversary n")
  unless adversaries revealed at Start. Party: player-owned
  Characters' `cards.sheet` read live at render. Gregg-verified ("green").
  Known gap (accepted): linking a lore item mid-run shows the panel
  only after the next encounter change; adversary Codex stat edits
  mid-run wait for the next mark.
- **No GM notification for Sheet-tab edits** (`9ddcd05`). Cards tab,
  level and Codex edit-form saves still notify (Gregg asked whether to
  silence Cards-tab conditions/equipment too — unanswered).

## Open items

- **Prod Release** for the 14 commits above — Gregg's call.
- **Loading screen**: GM boot path and Restore/Import op screen not yet
  seen live by Gregg.
- **Cards-tab GM notifications** (conditions/equipment during play):
  keep or silence? Unanswered.
- **Cards tab Sep 14 fixes** (`f136757`): still never confirmed by
  Gregg in the app.
- **Contributors sidebar**: GitHub Support cache refresh (Gregg).
- Pre-1.0 sweep deferrals, unchanged since Sep 10, none broken
  behavior: dynamic-import GM-only modules (not started); codex.js
  split (~5,200 lines, not done); single-entry restore delete-orphans
  (not built, deliberately additive-only); player-facing Export Lore
  mount (not built); remaining imported-kind lore items (live-data
  question, Gregg checks).

## Carried context

- **Claude Code cloud sandbox limits (learned this session):**
  - The app can't run here: gstatic.com (Firebase SDK) and the
    `.web.app` sites are egress-blocked. Can't curl live bundles
    either. Verify UI by loading the real module(s) in Chromium with
    stubs (Playwright `route()` for `js/firebase.js`), or run pure
    logic in Node with a harness copy of the module.
  - `scripts/e2e-run.sh` fails at `playwright install`; use the
    preinstalled `/opt/pw-browsers/chromium` via `executablePath`. Full
    e2e still can't run (gstatic), so CI's E2E is the real check for
    auth.js changes.
  - GitHub: push works directly (git identity from CLAUDE.md); branch
    deletes are blocked by the git proxy. CI status via the GitHub MCP
    `actions_list` tool, not PAT/curl.
- **Encounters ↔ Codex data path:** `encounters` is GM-only in rules,
  so anything players see from an encounter must be WRITTEN onto the
  linked Meta-Encounter lore item (`encounterRevealMd`,
  `encounterStatus`) by the GM client. Player-readable data (entities,
  character sheets) can be read live instead.
- **Local-write snapshot lag** (IndexedDB persistence, iPad): don't
  rely on `enc.runStatus` etc. from the last snapshot to dedupe a
  side effect fired by rapid clicks — use an in-memory guard.
- **firebaseapp.com vs web.app**: different origins. Always `.web.app`.
- **Dev/prod GCP trial-quota trap**: free-trial caps 50K reads/day
  regardless of Blaze. Fix = trial banner "Activate", NOT Billing
  "Upgrade". Prod activated; dev not. resource-exhausted on dev →
  check this first.
- **Source dropdowns depend on async `state.allSources`** — register
  via `registerSourcesChangeHandler`; same lesson for any UI reading a
  Firestore-backed `state.*` collection.
- **Cards-tab compact view** (`character-deck.js`): `cleanCardMd`,
  `truncateCardMd`, and `buildMiniCard`'s `clampLines`. Cards tab only.
- **Sortable + clickable children:** `filter` the clickable element
  with `preventOnFilter: false` (Sep 16 iPad gallery fix; details in
  `codex.js` `renderGalleryTab` comments). iPadOS trackpad behavior
  is not reproducible in Chromium or Playwright WebKit — Gregg's
  device is the oracle for touch/trackpad bugs.
- **modulepreload list in index.html must list every `js/*.js`** —
  add a line when adding a module (related.js was missed once).
- `npm run test:rules`: 19/19. Fresh clone needs `npm install`.
- `npm run test:e2e`: green in CI on every push this session.

## Session ritual

See `CLAUDE.md` (identity, gate, CI, deploy). Additions:
- Throwaway Playwright probes: `tests/e2e/_*.spec.mjs`, delete before
  commit.
- Markdown-render bugs: test against the real esm.sh `marked@15`
  bundle, not `npm install marked`.
- End every session by rewriting THIS file.
