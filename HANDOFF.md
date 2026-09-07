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

## Current state (end of session, Sep 7 2026)

HEAD: `57e648b`, CI green (Deploy + E2E), live on **dev only**. Not
released to prod.

**Campaign-type gating — DONE, dev-verified.** Scope negotiated down
from the prior session's four open questions (Gregg's calls, this
session):
- Ancestry/Community treatment — **skip**, out of scope (Daggerheart-
  specific, not worth gating).
- Codex category-list filtering for v1 — **skip**, out of scope.
- No live "Not Daggerheart" test campaign exists or is planned —
  Gregg's only real use case is a Daggerheart campaign; this is a
  bare-bones off-switch, not a feature built against a second
  campaign.
- `activeCharacterId`/ownership/claim/visibility-by-character — **kept
  as-is**, not Daggerheart-specific, applies in both modes.
- Actual scope landed on one thing: in not-daggerheart mode, characters
  are name/ownership only. `buildCharacterDetailShell` (`characters.js`)
  now returns just `buildDeckHeader` (badge/name/View-Edit-in-Codex)
  when `state.campaignType !== 'daggerheart'`, skipping the Level
  dropdown, Cards/Sheet tab strip, and deck/sheet panel entirely.
  `state.campaignType` defaults to `'daggerheart'` when the config doc
  or field is missing (`map.js`'s listener normalizes this) — no
  migration needed for existing campaigns.
- This closes out the item nav phase 2 was waiting on.

**Nav phase 2** (bookmarkable Characters/Encounters/Stables/Admin URLs)
remains done and dev-verified from the prior session — no changes this
session.

## Open items

- **Release to prod: BOTH nav phase 2 and campaign-type gating are now
  done and dev-verified — ready for one combined Release.** Next
  session's job (unless Gregg redirects): tag + create the GitHub
  Release (`target_commitish: "main"`) covering both. Nothing else is
  blocking this batch as of this handoff.
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
- `npm run test:rules`: last known 15/15 (not touched/re-run this
  session).
- `npm run test:e2e`: not re-run locally this session (characters.js
  change didn't touch auth.js/firebase.js/tests/e2e/*, so the local
  gate wasn't triggered) — CI's own e2e.yml run on `57e648b` is green
  regardless.

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
