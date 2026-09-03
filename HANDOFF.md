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

`phase-nav-router-design.md` (this session's locked design doc) is
still in the tree — not yet swept into a cleanup pass.

## Current state (end of session, Sep 3 2026)

HEAD: `626a5ef`, tagged and released as `v0.16b`, CI green (E2E +
Deploy), **live in prod** (Gregg tested on dev first, then deployed).
Also includes `d87b93f` (Gregg's own direct commit, same session
window — CRLF-pasted-bullets lore-splitting fix, unrelated to the nav
work below).

**Main work: Nav phase 1 — bookmarkable URLs for Codex/Map/Timeline,
DONE and verified live.** Design doc: `phase-nav-router-design.md`
(locked, in tree). Scope was explicitly split at design time:
Codex/Map/Timeline this phase; Characters/Encounters/Stables/Admin
deferred to a follow-up (see Open items).

- **New `public/js/router.js`**: path-based URLs (`/codex/<id>`,
  `/codex/<id>?tab=notes`, `/map/<id>`, `/timeline/<id>`), `popstate`
  handling, `activateTab()`/`syncUrlToTab()` shared between direct
  `nav#tabs` clicks and URL-driven activation. Deliberately zero
  imports of codex.js/map.js/timeline.js — those three self-register
  via `registerRoute()` at their own top level (same pattern as
  codex.js's existing `registerVisibilityChangeHandler`/
  `registerMapNavigationHandler`), so router.js drives their
  navigation without an import cycle. `navigateTo()` no-ops on a
  redundant same-target push (Gregg's call — don't grow history on
  e.g. re-clicking a chip for the entity already open).
- `selectEntity` (codex.js), `navigateToMapForEntity` (map.js), and
  Timeline's `openEntityInPanel`/`selectFromList` now push history
  state. `switchToCodexTabForEntity` already routes through
  `selectEntity`, so every existing cross-tab entity-jump call site
  (character-deck.js, characters.js, encounters.js, map.js,
  messages.js) is covered with no changes needed at those call sites.
- `index.html` modulepreload list updated (alphabetical) for the new
  module.

**Two real bugs found during verification (not speculative — both
caught by an actual Playwright probe against the e2e emulator, run
manually this session, not committed):**

- **timeline.js's `refresh()` was discarding a deep-linked selection
  before entities even loaded.** Its guard cleared `selectedId`
  whenever the (still-empty, on cold load) `dated` array didn't
  contain it — conflating "not visible" with "not loaded yet." Fixed
  to only clear on a confirmed miss (`dated.length` non-zero AND still
  not found).
- **`index.html` had no `<base>` tag and uses relative asset paths
  throughout** (`js/main.js`, `css/styles.css`, `firebase-env.js`,
  `vendor/leaflet/...`). Fine at one-segment paths, but at a
  two-segment path like `/codex/<id>` the browser resolved
  `js/main.js` against `/codex/` and requested `/codex/js/main.js` —
  caught by `firebase.json`'s catch-all rewrite and served
  `index.html` instead of real JS, silently killing module load on
  every deep link. Added `<base href="/">`. Confirmed safe against the
  app's 6 existing `href="#"` internal links (wiki-links, scene links,
  encounter entity links, timeline explainer link) — all 6 are
  `preventDefault()`-guarded, so the browser never actually follows
  the resolved href regardless of `<base>`.

Verified (throwaway Playwright probe, not committed, deleted after
use): entity click → URL updates → browser Back restores the previous
entity; cold deep link to `/codex/<id>` resolves the entity once
entities load; Map tab click syncs the URL to `/map`. Committed e2e
suite (`player-role.spec.mjs`) stayed green throughout, 3/3.

## Open items

- **Nav phase 2 — Characters/Encounters/Stables/Admin.** Deliberately
  out of scope this phase (see `phase-nav-router-design.md`'s locked
  scope note). Same `registerRoute()` pattern extends cleanly; the
  main new wrinkle will be nested selection state (Characters:
  charId → cards/sheet → ability sub-tab; Encounters: encId →
  build/run). Not started.
- **Campaign-type gating ("Not Daggerheart" mode) — findings done,
  NOT YET a locked design doc, NOT committed to the repo.** This was
  scoped in the same session as the nav findings (before the nav work
  above) via codebase analysis in chat — two findings docs were
  produced (`nav-findings.md`, used to drive this session's work, and
  `campaign-type-findings.md`, covering the full inventory of
  SRD/mechanics-dependent surface: Characters tab entirely, Encounters
  tab entirely, the Codex-tab character-cards editor, and an open
  question about Ancestry/Community/Codex-category-list scope). If a
  future session doesn't have this in memory/chat history, it needs to
  be regenerated from the codebase (starting points: `state.js`'s
  `campaignType` field, `export-lore.js`'s `ALL_LORE_EXCLUDED_CATEGORIES`
  precedent, `templates.js`'s `TEMPLATE_SCHEMAS` keys) rather than
  assumed to exist anywhere in the tree. Four open questions were
  raised for Gregg (Ancestry/Community treatment, `activeCharacterId`
  scope, whether Codex category-list filtering is in scope for v1, and
  whether a live "Not Daggerheart" campaign exists to test against) —
  none answered yet. This is the agreed **next** piece of work after
  nav phase 2, per Gregg.
- Everything else in the previous HANDOFF's open-items list (Export
  Lore prod verification, remaining 1,287 imported-kind lore items,
  op-status indeterminate-bar exercise, dynamic-import GM-only modules,
  codex.js split, single-entry restore delete-orphans mode,
  purge-legacy-image-docs scan, player-facing Export Lore reuse) is
  **carried forward unverified** — three prod deploys (v0.14b/15b/16b)
  happened since that list was written, in session(s) this session has
  no direct record of, so some of those may already be resolved. Don't
  assume either way; check fresh if any becomes relevant.

## Carried context

- **Dev/prod GCP trial-quota trap**: a project still in Google's
  90-day free-trial status has a hard 50K reads/day cap regardless of
  Blaze billing. Fix is the trial banner's "Activate" button (NOT
  Billing's "Upgrade"). Prod was fixed this way Sep 2 2026; dev's
  status unknown as of this session — if dev misbehaves with
  resource-exhausted errors, check this before suspecting code.
- `npm run test:rules`: last known 15/15 (not re-run this session,
  firestore.rules wasn't touched); needs one-time `npm install --no-save
  firebase-tools@15 @firebase/rules-unit-testing@3` in a fresh clone.
- `npm run test:e2e`: green throughout this session (before nav work,
  after nav work + `<base>` fix, and in final CI). Needs `npm install`
  once for `@playwright/test` + one-time `npx playwright install
  --with-deps chromium` (the script does this itself).

## Session ritual

Fresh clone (never reuse a prior working tree); git identity
(whitwort@gmail.com / "Gregg Whitworth"); verify HEAD against this
doc's era; read QOL-BACKLOG.md + this file before code. Gates before
EVERY commit: `npx eslint@8 --no-eslintrc -c .eslintrc.check.json
public/js/*.js`, `node --check` per touched file, CSS + firestore.rules
brace balance, `npm run test:rules` if firestore.rules or its own test
file touched.

`npm run test:e2e` (or `bash scripts/e2e-run.sh`) before EVERY push —
widened after an earlier missing-named-export incident (see git log on
this file for the full story if needed). To debug a page that won't
load at all, or to verify new client-side behavior (like this
session's router) before it reaches Gregg: run the emulators
(`firebase emulators:start --only firestore,auth,hosting --project
demo-dcc-e2e`, with `public/firebase-env.js` temporarily swapped for
`public/firebase-env.emulator.js` — restore the real one before
committing, `scripts/e2e-run.sh` does this automatically via a trap)
and drive it with a throwaway Playwright spec (`tests/e2e/_*.spec.mjs`
— underscore prefix, delete before committing, never part of the
committed suite) rather than reasoning from symptoms or review alone.
This session's two real bugs (timeline selection-clearing,
`<base href>`) were both caught this way, not by code review.

When verifying a markdown-rendering bug fix against `marked`, test
against the ACTUAL esm.sh-served bundle (`curl https://esm.sh/marked@15`
→ follow the redirect it prints → fetch that real module file), not
`npm install marked` — version/build resolution can differ between the
two and it's cheap to just fetch the real thing.

Push via PAT URL; rebase FETCH_HEAD if remote moved (happened this
session — Gregg's own CRLF-fix commit landed mid-session, rebased
clean). CI: sleep ~74s then poll Actions API with PAT header — both
`deploy.yml` and `e2e.yml` fire on push to main independently. Prod
deploys are Release-triggered (tag push + GitHub Release) — the prod
job's pre-deploy backup step is a real Firestore dependency, so GCP
quota/trial state can block it. End every session by rewriting THIS
file.
