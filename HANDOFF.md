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

`phase-nav-router-design.md` (nav phase 1) and
`phase-nav-router-2-design.md` (nav phase 2, this session) are both
locked design docs still in the tree — not yet swept into a cleanup
pass.

## Current state (end of session, Sep 7 2026)

HEAD: `8694fe5`, CI green (E2E + Deploy), live on **dev only**
(`daggerheart-campaign-codex-dev.web.app` — see the firebaseapp.com
note below for why the domain matters). Not yet released to prod.

**Three pieces of work this session, in order:**

1. **QOL-BACKLOG.md cleanup** (`c86395c`) — marked done+tested: input-
   padding audit, character-select dropdown JS error, backup-workflow
   test (Phase 16), Phase 13 prod-persistence rollout. Removed as
   out-of-scope (per Gregg): player-facing JSON subset export, dev
   Firestore trial activation.

2. **firebaseapp.com → web.app redirect** (`8b924e4`) — Gregg found
   that `<project>.firebaseapp.com` and `<project>.web.app` serve
   identical files but are DIFFERENT ORIGINS (IndexedDB/localStorage —
   Firestore's `persistentLocalCache`, Firebase Auth session — doesn't
   carry across). Landing on `.firebaseapp.com` broke back-navigation
   on dev and never loaded Firestore data on prod. Fixed with a
   client-side `location.replace` in `index.html`'s FIRST `<head>`
   script (runs before any module/listener starts). **Always use
   `.web.app` going forward when sharing/testing links** — recorded in
   decisions-and-learnings memory too.

3. **Nav phase 2 — bookmarkable Characters/Encounters/Stables/Admin
   URLs, DONE and e2e-verified on dev** (`1303ce5` design doc,
   `8694fe5` implementation). Design doc: `phase-nav-router-2-design.md`
   (locked). This closes out the nav-router work entirely — no more
   deferred tabs.
   - `router.js`: `registerRoute()` gains an optional `gmOnly: true`.
     `parseAndActivate()` now checks `state.currentRole === 'gm'` for
     those routes and falls back to Codex root via
     `history.replaceState` (not `navigateTo`'s `pushState`) on
     failure — a rejected deep link doesn't leave a dead entry in a
     player's back-button history. This closes a real gap: Encounters/
     Stables/Admin tab **buttons** were already role-hidden
     (`auth.js`), but nothing previously stopped a pasted `/encounters/
     <id>` link from activating the panel for a player.
   - `characters.js`/`encounters.js`/`stables.js`/`admin.js` each
     self-register with `router.js` (same zero-cycle pattern as phase
     1 — `router.js` only imports `state.js`, so this is safe even for
     characters.js/encounters.js despite their own codex.js import
     cycle). `?tab=` reused across all routes (Codex/notes,
     Characters/sheet, Encounters/run) — Gregg's call. List-filter tabs
     (`encountersListTab`, `stablesDropsTab`) stay session-only, NOT in
     the URL — also Gregg's call.
   - Admin/Characters/Encounters/Stables tab-**button** clicks get URL
     sync for free via main.js's existing generic `syncUrlToTab()` —
     no main.js changes were needed.
   - Verified via a throwaway Playwright probe (not committed, deleted
     after use): Characters select+tab-switch+Back, Encounters
     create+tab-switch, Stables select, Admin tab-click, and a player
     deep-link to a gmOnly route landing back on Codex root — all
     passed. `player-role.spec.mjs` (committed suite) stayed green
     throughout, 3/3.

## Open items

- **Not yet released to prod.** Nav phase 2 is dev-verified only —
  needs a Gregg go/no-go + tag+Release before it reaches players.
- **Campaign-type gating ("Not Daggerheart" mode) — findings done, NOT
  YET a locked design doc, NOT committed to the repo.** Now the ONE
  remaining piece of the nav/campaign-gating work (nav phase 2 above
  closed out the other half). Two findings docs were produced in an
  earlier session (`nav-findings.md`, `campaign-type-findings.md` —
  neither committed; not in this tree). If a future session doesn't
  have this in memory/chat history, it needs to be regenerated from
  the codebase (starting points: `state.js`'s `campaignType` field,
  `export-lore.js`'s `ALL_LORE_EXCLUDED_CATEGORIES` precedent,
  `templates.js`'s `TEMPLATE_SCHEMAS` keys). Four open questions still
  unanswered: Ancestry/Community treatment, `activeCharacterId` scope,
  whether Codex category-list filtering is in scope for v1, whether a
  live "Not Daggerheart" campaign exists to test against.
- Everything else in older HANDOFF open-items lists (Export Lore prod
  verification, remaining imported-kind lore items, op-status
  indeterminate-bar exercise, dynamic-import GM-only modules, codex.js
  split, single-entry restore delete-orphans mode, player-facing
  Export Lore reuse) is **carried forward unverified** — multiple prod
  deploys have happened since those lists were written, in sessions
  this session has no direct record of. Don't assume either way; check
  fresh if any becomes relevant.

## Carried context

- **firebaseapp.com vs web.app**: different origins, same files — see
  item 2 above. The redirect fix covers the app itself; still worth
  remembering when manually testing/sharing links so you're not
  debugging a phantom "data won't load" report that's actually just
  the wrong domain.
- **Dev/prod GCP trial-quota trap**: a project still in Google's
  90-day free-trial status has a hard 50K reads/day cap regardless of
  Blaze billing. Fix is the trial banner's "Activate" button (NOT
  Billing's "Upgrade"). Prod was fixed this way Sep 2 2026; dev's
  status still not activated as of this session (Gregg's call to leave
  it out of scope for now) — if dev misbehaves with resource-exhausted
  errors, check this before suspecting code.
- `npm run test:rules`: last known 15/15 (not re-run this session,
  firestore.rules wasn't touched).
- `npm run test:e2e`: green throughout this session (after each of the
  three pieces of work above, and in final CI).

## Session ritual

Fresh clone (never reuse a prior working tree); git identity
(whitwort@gmail.com / "Gregg Whitworth"); verify HEAD against this
doc's era; read QOL-BACKLOG.md + this file before code. Gates before
EVERY commit: `npx eslint@8 --no-eslintrc -c .eslintrc.check.json
public/js/*.js`, `node --check` per touched file, CSS + firestore.rules
brace balance, `npm run test:rules` if firestore.rules or its own test
file touched, `npm run test:e2e` if auth.js/firebase.js/tests/e2e/*
touched.

For navigation/routing work specifically: verify with a throwaway
Playwright probe (`tests/e2e/_*.spec.mjs` — underscore prefix, delete
before committing, never part of the committed suite) against the e2e
emulator rather than reasoning from review alone — nav phase 1's two
real bugs and nav phase 2's implementation were both confirmed this
way. Gotchas hit writing this session's probe: (1) Firestore-emulator
seed docs used in a Playwright `beforeAll` should use deterministic
doc IDs (`.doc('some-id').set(...)`) not `.add()` — a worker restart
after a timeout re-runs the file's module scope including `beforeAll`,
and `.add()` silently duplicates seed data on a re-run while `.set()`
on a fixed id doesn't; (2) `getByText(...)` isn't scoped to a hidden
tab panel by default — scope to the panel's container id (e.g.
`#characters-panel`) to avoid strict-mode violations against
same-named text elsewhere in the DOM (Export Lore's picker list, in
this case); (3) the Characters tab's GM roster only lists OWNED
characters (grouped by owning player) — an unowned seed entity is
invisible there unless it's also `pc`-tagged and the "+assign" picker
for a specific player is expanded.

When verifying a markdown-rendering bug fix against `marked`, test
against the ACTUAL esm.sh-served bundle (`curl https://esm.sh/marked@15`
→ follow the redirect it prints → fetch that real module file), not
`npm install marked` — version/build resolution can differ between the
two and it's cheap to just fetch the real thing.

Push via PAT URL. CI: sleep ~74s then poll Actions API with PAT header
— both `deploy.yml` and `e2e.yml` fire on push to main independently.
Prod deploys are Release-triggered (tag push + GitHub Release) — the
prod job's pre-deploy backup step is a real Firestore dependency, so
GCP quota/trial state can block it. End every session by rewriting
THIS file.
