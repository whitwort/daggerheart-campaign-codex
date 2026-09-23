# CLAUDE.md

Loaded automatically by Claude Code. Durable conventions only; current
state lives in `HANDOFF.md` (rolling) and `QOL-BACKLOG.md`.

**This repo is public.** Never commit campaign secrets, GM-only lore,
player data, or Firestore backups here. Backups/data belong only in the
private `whitwort/aethers-children-data` repo.

## Communication
- Maximally terse. No filler/affirmations ("Perfect!", "Good idea!").
- Debugging: one diagnostic step or question at a time; wait for reply.
- Design before implementation for new phases; mockup before
  implementation for UX unknowns.
- Warn when approaching context limits; offer to rewrite HANDOFF.md.

## Project
- Gregg (whitwort@gmail.com) is GM and sole developer. Campaign:
  "Aether's Children", homebrew world Genesis, Daggerheart system.
- Stack: vanilla ES modules (no bundler), Firestore, Firebase Auth
  (Google/GitHub), Firebase Hosting, Leaflet, SortableJS, docx@8 +
  jsPDF@2 via esm.sh. SRD bundled at `public/data/srd/*.json`.
- Firebase projects: `daggerheart-campaign-codex` (prod),
  `daggerheart-campaign-codex-dev` (dev). Always use `.web.app` URLs,
  never `.firebaseapp.com` (different origin; breaks auth/cache).

## Session ritual
1. `git fetch && git status` — confirm clean and at `origin/main`; the
   remote often moves (Gregg commits via GitHub web UI). History was
   rewritten Sep 21 2026: never trust a remembered SHA — find commits
   with `git log --grep`.
2. Git identity: `git config user.name "Gregg Whitworth"` and
   `git config user.email whitwort@gmail.com`. `author-check.yml` fails
   CI on any other author/committer email (except
   `claude@anthropic.com` and the actions bot).
3. Read `HANDOFF.md` + `QOL-BACKLOG.md`, then relevant source.
4. Implement → gate → commit → push → poll CI.
5. End of session: rewrite `HANDOFF.md` in place. Never create numbered
   handoff files.

## Pre-commit gate (every commit)
1. `npx eslint@8 --no-eslintrc -c .eslintrc.check.json public/js/*.js`
2. `node --check <file>` per touched JS file
3. Brace balance (`{` count == `}` count) in touched CSS and `firestore.rules`
4. `npm run test:rules` if `firestore.rules` or its test touched
   (one-time: `npm install --no-save firebase-tools@15 @firebase/rules-unit-testing@3`)
5. `npm run test:e2e` if `auth.js`, `firebase.js`, or `tests/e2e/*`
   touched. Run as `PATH="$PWD/node_modules/.bin:$PATH" bash scripts/e2e-run.sh`
   (firebase not found via plain npx inside the script).

Navigation/routing work: verify with a throwaway Playwright probe
(`tests/e2e/_*.spec.mjs`, delete before commit) against the e2e emulator.

## Git, CI, deploy
- Multi-line commits: `git commit -F - <<'MSG'` (backticks in `-m` get
  shell-expanded).
- Push to main → `deploy.yml` (dev) and `e2e.yml` fire independently.
  Wait ~74s, then check the Actions runs.
- **Prod deploy = creating a GitHub Release** (`target_commitish: main`).
  No other route. Publishing a Release is the sole versioning act (no
  VERSION file). Prod's pre-deploy backup needs Firestore, so GCP quota
  can block it.
- Verify what's live: `curl https://daggerheart-campaign-codex.web.app/js/<file>.js`.

## Reference docs
- `docs/claude/decisions.md` — locked architecture decisions and
  hard-won learnings. Read before architectural changes.
- `docs/claude/lore-import.md` — bulk lore import JSON standard and
  lore-pass workflow. Read before producing any import JSON.
- `srd-update-process.md` — SRD refresh procedure.
