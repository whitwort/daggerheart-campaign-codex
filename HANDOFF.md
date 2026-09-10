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
`phase-nav-router-2-design.md` (nav phase 2) are both locked design
docs still in the tree — not yet swept into a cleanup pass.

## Current state (end of session, Sep 10 2026)

HEAD: `d4dd35c`, CI green (Deploy + E2E). Live on **dev only** as of
this write — Gregg is tagging **1.0** off this commit right after this
handoff, so by the time anyone reads this it should also be in prod
(confirm against the live footer / `_meta/version` if in doubt, same as
always).

Session work, in order:
1. **Backup retention** (`scripts/backup-retention.js` + `backup.yml`):
   keep all daily backups <=14d, 1/week for 15d-6mo, 1/month for
   6mo-2y, delete older. Runs on `main` directly, not release-gated.
2. **E2E apt flake fix** (`scripts/e2e-run.sh`): dropped
   `playwright install --with-deps` (triggered `apt-get update`, which
   hit a recurring stale-mirror bug in GitHub's pre-baked Google Chrome
   apt source) for `install chromium` (browser binary only, no apt
   call). Confirmed via a subsequent green E2E run.
3. **Import Lore: clear textarea on success** (`import.js`) — clears
   via a direct CodeMirror `setValue` with the 'change' listener
   detached, so it doesn't route through the debounce-clear that would
   otherwise wipe the "Import complete..." line 650ms later.
4. **Messages: Party chat channel** — new shared tab visible to every
   whitelisted player + GM at once (`threads/party` doc +
   `threads/party/messages` subcollection with `authorEmail`, locked
   server-side to the writer's own auth email; per-user read state in
   `threads/party/readState/{email}`, self-only). New firestore.rules
   match block, sibling to the existing 1:1 `threads/{playerEmail}`
   wildcard (Firestore ORs across matching blocks, so this couldn't
   weaken the 1:1 rules). 4 new rules tests, 19/19 passing.
5. **Messages: tab-overlap fix, two passes.** First pass fixed
   `.msg-strip-tab` (collapsed strip) — missing `flex-shrink:0` let
   many-player GM views squeeze tab labels into overlapping each
   other. Gregg reported the SAME symptom persisting afterward on
   "default chat width" — root cause was that `.msg-panel-tab` (the
   EXPANDED panel's tab row) had the identical missing
   `flex-shrink:0`, never actually fixed in pass one, and the panel's
   default width (`applyPanelSizing`) is derived from that row's
   natural size. Second pass fixed the panel tabs too; also explains
   the reported "misaligned color lines" (the badge-color border was
   sized to the shrunk box, not the overflowing label text). Both
   fixes are in; if this class of bug resurfaces anywhere else tabs +
   `overflow-x:auto` are combined, check for missing `flex-shrink:0`
   first.

## Pre-1.0 open-items sweep (this session)

Went through every item HANDOFF had been carrying forward unverified
across several prod deploys. Verified what code inspection + a fetch
of the live prod bundle could confirm; flagged what can't be checked
without a live authenticated session or DB credentials (neither
available from an agent sandbox).

- **Export Lore prod verification — CONFIRMED LIVE.** Shipped in
  `v0.17b` (git ancestry: `bcce7fe` predates that tag) and a direct
  fetch of `daggerheart-campaign-codex.web.app/js/export-lore.js`
  confirms it's being served from prod. Not click-tested interactively
  (no browser in an agent sandbox) — if Gregg hasn't personally run
  through all four mode x format combos in prod, that's still worth a
  manual pass, but the code is deployed and correct per review.
- **Op-status indeterminate-bar — DONE, confirmed exercised.**
  `admin.js` calls `updateOp(line, null)` (SRD import path) — the
  indeterminate branch isn't just built, it's live in a real op.
  Nothing left here; drop from future carry-forward lists.
- **Dynamic-import GM-only modules — CONFIRMED NOT STARTED.** Zero
  `import()` calls anywhere in `public/js/` — every module is still a
  static top-level import. Real perf work, not done, no code laid
  down toward it yet.
- **codex.js split — CONFIRMED NOT DONE.** Still 5,148 lines, ~4.5x
  the next-largest file (`encounters.js`, 1,846 lines). Untouched.
- **Single-entry restore delete-orphans mode — CONFIRMED NOT BUILT.**
  `backup.js`'s own comment: v1 is deliberately additive/overwrite-by-
  id only; "a possible future addition if that's ever needed."
- **Player-facing Export Lore reuse — CONFIRMED NOT BUILT.**
  `index.html`: the Export Lore UI is mounted only under
  `admin-db-tabs` (GM-only Admin > Database). `export-lore.js`'s own
  header comment says the mode/format/resolution logic was
  deliberately built viewer-ctx-driven for this future reuse, but no
  player entry point exists yet — would need a new mount point, not a
  rewrite of the underlying logic.
- **Remaining imported-kind lore items — UNVERIFIABLE FROM HERE.**
  This is a live-data/content-curation question (how many
  `kind:'imported'` lore docs are still unreviewed), not a repo or
  deploy fact. Needs a logged-in session or DB query Gregg runs
  himself; carry forward as genuinely unknown, not "still open" in the
  code sense the other items above are.

None of the still-open items above are broken behavior — all are
deliberate deferrals with their own "not done yet" comment already in
the code. Nothing here blocks 1.0 unless Gregg wants one of them
(player Export Lore reuse is the most likely candidate) as a hard
requirement for it, which as of this handoff he hasn't indicated.

## Open items

- **Nav phase 2 + campaign-type gating**: dev-verified, was the
  pending prod Release as of last handoff — by the time this reads,
  Gregg's 1.0 tag should have carried this to prod along with
  everything in this session. Re-verify against the live prod tag/
  footer rather than assuming.
- Six items above (dynamic-import, codex.js split, delete-orphans
  restore mode, player Export Lore reuse, imported-lore-items count)
  carry forward as confirmed-status per the sweep — see that section,
  don't re-derive from scratch next time.

## Carried context

- **firebaseapp.com vs web.app**: different origins, same files.
  Always use `.web.app` when sharing/testing links — see
  decisions-and-learnings memory for the full writeup.
- **Dev/prod GCP trial-quota trap**: a project still in Google's
  90-day free-trial status has a hard 50K reads/day cap regardless of
  Blaze billing. Fix is the trial banner's "Activate" button (NOT
  Billing's "Upgrade"). Prod activated Sep 2 2026; dev's status still
  not activated (Gregg's call, out of scope) — if dev misbehaves with
  resource-exhausted errors, check this before suspecting code.
- **Google Chrome apt source flakiness**: `scripts/e2e-run.sh` uses
  `playwright install chromium` (no `--with-deps`) specifically to
  avoid this — see item 2 above if it needs revisiting.
- `npm run test:rules`: 19/19 passing as of this session (party chat
  added 4 new cases). Needed a fresh `npm install` in this sandbox
  (`@firebase/rules-unit-testing` wasn't present) — not an issue on a
  normal dev machine with node_modules already installed, just a
  first-run-in-a-fresh-clone note.
- `npm run test:e2e`: green on every push this session (`d4dd35c`
  included) — the apt fix (item 2) has now held across multiple runs.

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
emulator rather than reasoning from review alone.

When verifying a markdown-rendering bug fix against `marked`, test
against the ACTUAL esm.sh-served bundle (`curl https://esm.sh/marked@15`
→ follow the redirect it prints → fetch that real module file), not
`npm install marked` — version/build resolution can differ between the
two and it's cheap to just fetch the real thing.

Push via PAT URL. CI: sleep ~74s then poll Actions API with PAT header
— both `deploy.yml` and `e2e.yml` fire on push to main independently.
Prod deploys are Release-triggered (tag push + GitHub Release) — the
prod job's pre-deploy backup step is a real Firestore dependency, so
GCP quota/trial state can block it. A live prod bundle file is
fetchable directly (e.g. `curl https://daggerheart-campaign-codex.web.app/js/<file>.js`)
to confirm what's actually deployed, without needing a browser or
credentials — useful for spot-verifying carry-forward items like this
session's sweep above. End every session by rewriting THIS file.
