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

## Current state (end of session, Sep 9 2026)

HEAD: `ee3ddb4`, CI green (Deploy + E2E), live on **dev only**. Not
released to prod. App code itself unchanged this session — nav phase 2
and campaign-type gating (both dev-verified as of the prior session)
are still the pending prod release; nothing below adds to or blocks
that release.

**Backup retention — DONE.** `backup.yml`'s daily prod export to the
private `aethers-children-data` repo had no pruning logic; the repo
would have grown one JSON file per day forever.
- New `scripts/backup-retention.js`: keep all backups <=14 days old,
  1/week for 15d-6mo, 1/month for 6mo-2y, delete anything older. Within
  a week/month bucket the newest backup is kept. Verified against a
  synthetic multi-year set of dated files before wiring in.
- `backup.yml` runs it as a new "Apply retention policy" step between
  export and commit; `git add .` (already in the commit step) stages
  the deletions along with the day's new export.
- This is a CI-workflow change only — it runs on `main` directly
  (`backup.yml` isn't part of the Hosting deploy pipeline), so it's
  already in effect, not something the pending prod Release covers.

**E2E flake fix — DONE.** `E2E (player role)` failed twice in a row on
unrelated pushes with an apt `Hash Sum mismatch` fetching
`dl.google.com/linux/chrome-stable/deb`. Root cause: GitHub's
`ubuntu-latest` image pre-bakes a Google Chrome apt source; running
`playwright install --with-deps` triggers `apt-get update`, which
refreshes *all* configured sources including that one, and it has a
recurring, long-standing upstream bug (stale `Packages.gz` vs a newer
`Release` file) — confirmed via matching Chromium tracker/community
reports going back to 2014, most recently Sep 2025. Not caused by, or
fixable from, this repo.
- Fix: `scripts/e2e-run.sh` now runs `npx playwright install chromium`
  (browser binary only, Playwright's own CDN) instead of
  `install --with-deps chromium` — skips the apt call entirely.
  `ubuntu-latest` ships Chrome preinstalled, so Chromium's shared-lib
  deps are already present; confirmed by a subsequent green E2E run on
  `ee3ddb4`.
- Learning recorded in decisions-and-learnings memory (CI/infra
  section) in case a future runner image needs `install-deps` again —
  scope it away from the google-chrome source list rather than
  reintroducing bare `--with-deps`.

## Open items

- **Release to prod: nav phase 2 + campaign-type gating are dev-
  verified and ready for one combined GitHub Release**
  (`target_commitish: "main"`). Nothing blocking this batch as of this
  handoff. The two CI/backup fixes above are independent and already
  live on `main` regardless of when this Release happens.
- Everything else in older HANDOFF open-items lists (Export Lore prod
  verification, remaining imported-kind lore items, op-status
  indeterminate-bar exercise, dynamic-import GM-only modules, codex.js
  split, single-entry restore delete-orphans mode, player-facing
  Export Lore reuse) is **carried forward unverified** — multiple prod
  deploys have happened since those lists were written, in sessions
  this session has no direct record of. Don't assume either way; check
  fresh if any becomes relevant.

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
- **Google Chrome apt source flakiness** (this session): see E2E fix
  above — if any other workflow ever adds `apt-get update`/
  `--with-deps` back in, watch for the same `dl.google.com` hash
  mismatch.
- `npm run test:rules`: last known 15/15 (not touched/re-run this
  session).
- `npm run test:e2e`: not re-run locally this session — verified via
  CI (`ee3ddb4` green) instead, since the fix itself was CI-environment-
  specific (GH runner's apt sources) and wouldn't reproduce identically
  in a local dev sandbox.

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
GCP quota/trial state can block it. End every session by rewriting
THIS file.
