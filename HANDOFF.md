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

## Current state (end of session, Sep 21 2026)

HEAD: `16bae33`, CI green (Deploy + E2E + the new Author check).
Prod is at **`v1.0.2` = `db80d18`** (Gregg tagged 1.0 → 1.0.1 → 1.0.2
across Sep 10–16; everything through the gallery-lightbox fix is
live). Only `16bae33` (a CI workflow, not app code) is on dev ahead
of prod.

**READ THIS FIRST — every commit hash in this repo changed on Sep 21.**
A full-history rewrite (`git filter-repo --mailmap`, 685/685 commits
re-hashed, all 25 tags retargeted) fixed 61 commits authored as
`Gregg <gregg@example.com>` (54 from the repo's first days, Aug 8–10,
plus 7 from the Sep 14 session). A prior, smaller rewrite (~Sep 11)
had already fixed 2 commits mis-attributed to `whitworth@gmail.com`
(a one-letter typo GitHub linked to a stranger's account,
"DarrylWhitworth"). Consequences:
- Any SHA cited in an older HANDOFF, commit message, memory note, or
  chat transcript that predates Sep 21 no longer resolves. Find
  commits by message/date (`git log --grep`), never by remembered hash.
- Any pre-Sep-21 clone must be re-cloned or `git fetch && git reset
  --hard origin/main && git fetch --tags --force` — a plain pull shows
  as diverged. (Local tags don't auto-update on fetch; `--force` them.)
- GitHub's /contributors graph lags hours after a force-push; the
  commits API is authoritative (verified: 685 scanned, 0 placeholder).
- **New guard: `.github/workflows/author-check.yml`** (`16bae33`)
  fails the push if any commit's author OR committer email is outside
  `whitwort@gmail.com` / `claude@anthropic.com` / the actions bot.
  Can't block a push to main (no branch protection) but goes red
  within ~1 min. Adding a legitimate identity = one line in its
  `ALLOWED` block. Both incidents were an agent session running `git
  config user.email` wrong despite this file's ritual line being
  correct every time — the guard exists because the ritual alone
  wasn't enough twice.

### Gallery lightbox click on iPad, multi-image galleries only (Sep 16, `997c29b`→`db80d18`) — FIXED, Gregg-confirmed on device

Four commits, three wrong-but-real fixes, one right one. Full
reasoning is in the code comments at `codex.js` `renderGalleryTab`
(the `imgEl` click listener and the `new Sortable(galleryDiv, …)`
config). Short version for the next person who touches Sortable:
- Symptom: tap worked, trackpad-click "just highlighted" the card.
  Only on galleries with >1 image — exactly when `Sortable`
  initializes (`galleryImages.length > 1`). That length>1 fingerprint
  was the one clue that held up throughout.
- Root cause (confirmed by a WebKit MutationObserver probe, invisible
  in Chromium): SortableJS `forceFallback` toggles `draggable` onto
  the `<img>` and adds `sortable-chosen` on every mousedown, even a
  zero-movement click. `<img>` is natively draggable already; two
  drag systems claiming one element reads as a drag-select highlight
  on iPadOS trackpad.
- Fix: `filter: 'img', preventOnFilter: false` on the gallery's
  Sortable — the image is never a drag candidate, its plain `click`
  listener is untouched, drag-reorder still works from the card's
  padding/edge (verified: real swap persists to Firestore under
  WebKit). The three intermediate fixes (delay/delayOnTouchOnly on
  all four Sortable sites; touchend+preventDefault; manual
  mousedown/mouseup) were each verified in automation and each
  still broken on the real iPad. `delay:150, delayOnTouchOnly:true`
  stays on all four Sortable instances — harmless, reasonable touch
  ergonomics, just not the fix.
- **Tooling ceiling learned the hard way:** iPadOS trackpad input is
  translated by a proprietary UIKit layer. Neither Chromium nor
  Playwright's WebKit reproduced the broken click, even on the exact
  shipped code. "Passes in every automated browser" and "broken on
  Gregg's iPad" were both true for three commits. For anything
  touch/trackpad-specific, treat automation as a regression net and
  a mechanism probe, not as proof of fix — Gregg's device is the
  oracle.

### Other app changes since the Sep 14 handoff
- **Export Lore > Character dropdown** (`a04e97e`): now PC-tagged OR
  owner-assigned (reuses `visibility-ui.js`'s `partyCharacterOptions`,
  newly exported), was ownerId-only. Labels show owner or
  "(unassigned)". Probe-verified with a 3-entity matrix.
- **Party tab auto-opening on reload** (`3b7bc9b`, Sep 10): the party
  read-stamp lives in a separate doc from the thread doc, so the two
  listeners raced on cold load; `partyReadStateLoaded` flag gates
  unread until the reader's own stamp has arrived once.
- **SRD watch** (`9758464`, `8135429`): another session's weekly
  Action comparing daggerheart.com's SRD link/PDF hash to
  `scripts/srd-extract/SOURCE.json`; opens a labeled issue on drift.
  Not this session's work; noted so it isn't mistaken for a stray.

### Sep 14 session (another session — carried verbatim in substance)

**Import Lore — sourceId dropdown** (`285f5c9`→`5f5ca60`). Confirmed
working on dev by Gregg. Feature + three fixes: (1) first pass
queried `sources` directly instead of `sources.js`'s
`buildSourceSelect()` → empty; (2) that swap stripped
`query`/`where`/`getDocs` imports that `fetchLoreFor()` still uses →
lint fail, restored; (3) dropdown built once at Admin-tab activation,
before `attachSourcesListener`'s first snapshot → empty forever. Fixed
by registering `buildImportSourceSelect` via
`registerSourcesChangeHandler` (same pattern as codex.js/admin.js),
dropping the one-shot guard, preserving selection in a module-level
`importSelectedSourceId`.
**Lesson:** any UI reading a Firestore-backed `state.*` collection
must subscribe to that collection's `registerXChangeHandler` and
rebuild on change — the listener being attached earlier does not mean
`state` is populated; the snapshot is async.

**Characters > Cards tab display fixes** (`f136757`) — **NOT yet
Gregg-verified in the app**; ask. (a) Abilities tab label
"Experience"→"Experiences". (b) Transformation cards strip their
`### Question` prompt section via `cleanCardMd({stripSections:
['Question']})`, gated on `linked.subtype === 'transformations'`;
Codex Lore tab still shows it. (c) Item/Consumable cards truncate at
20 lines via new `truncateCardMd(md, maxLines)` (character-deck.js,
beside `cleanCardMd`), Items/Consumables branch of
`equipmentCardOptsForLinked` only.

## Pre-1.0 open-items sweep (Sep 10 — unchanged, not re-verified since)

- **Export Lore prod verification — CONFIRMED LIVE** (v0.17b, and
  now v1.0.2). Not interactively click-tested by an agent.
- **Op-status indeterminate-bar — DONE, exercised** (`admin.js`
  `updateOp(line, null)`). Drop from future lists.
- **Dynamic-import GM-only modules — NOT STARTED.** Zero `import()`
  in `public/js/`.
- **codex.js split — NOT DONE.** ~5,200 lines, ~4.5x the next file.
- **Single-entry restore delete-orphans mode — NOT BUILT** (backup.js
  comment: deliberately additive-only).
- **Player-facing Export Lore reuse — NOT BUILT.** UI mounted only
  under `admin-db-tabs`; logic already viewer-ctx-driven, needs a
  player mount point, not a rewrite.
- **Remaining imported-kind lore items — UNVERIFIABLE FROM AN AGENT
  SANDBOX** (live-data question). Gregg checks.

All deliberate deferrals with in-code "not yet" comments; none is
broken behavior.

## Open items

- **Cards tab fixes** (Sep 14, `f136757`): CI-green, in prod via
  v1.0.2, but never confirmed by Gregg in the app. Verify.
- **Author-check workflow** (`16bae33`): passed on its own commit.
  Not yet seen catching a real bad email (by design, hopefully never).
- Six Sep 10 sweep items carry forward as confirmed-status above.
- **HANDOFF hash hygiene going forward:** prefer citing commits by
  subject + date; if citing a hash, it's only good until the next
  rewrite, which the author-check guard is meant to make unnecessary.

## Carried context

- **firebaseapp.com vs web.app**: different origins, same files.
  Always `.web.app` — see decisions-and-learnings memory.
- **Dev/prod GCP trial-quota trap**: free-trial status caps 50K
  reads/day regardless of Blaze. Fix = trial banner "Activate", NOT
  Billing "Upgrade". Prod activated Sep 2; dev still not (Gregg's
  call). Resource-exhausted on dev → check this before code.
- **Google Chrome apt source flakiness**: `scripts/e2e-run.sh` uses
  `playwright install chromium` (no `--with-deps`) to avoid it.
- **Source dropdowns depend on async `state.allSources`** — register
  via `registerSourcesChangeHandler` (see Sep 14 lesson).
- **Cards-tab compact-view cleanup** (`character-deck.js`):
  `cleanCardMd(md, opts)` (`stripHeadingLines`/`stripSections`/
  `stripBulletLabels`) and `truncateCardMd(md, maxLines)`. Cards tab
  only; Codex Lore tab always shows full content. Reach for these
  before writing a new one-off.
- **Sortable + clickable children:** if a draggable card contains
  something with its own click behavior, `filter` that element out
  with `preventOnFilter: false` rather than racing Sortable's
  mousedown/touchstart handling. `forceFallback` stays on all four
  sites (trackpad-vs-native-DnD, see each site's comment).
- **Playwright WebKit is available and worth it for Safari-family
  bugs:** `npx --package=@playwright/test playwright install webkit`
  (must match the project's pinned playwright — plain `npx playwright
  install webkit` fetched the wrong build), then `npx playwright test
  … --browser=webkit`. Chromium never showed the Sortable `draggable`
  churn; WebKit did. Not a substitute for a real iPad (see tooling
  ceiling above), but strictly more revealing than Chromium alone.
  The `devices['iPad …']` presets force WebKit; if you only have
  Chromium, set `viewport`/`hasTouch: true`/`isMobile: true` manually.
- **Throwaway-probe discipline that paid off this session:** seed
  data via firebase-admin inside the spec, sign in with
  `window.__e2eSignIn`, navigate `#tab-btn-codex` → expand category →
  click entity → click "Gallery" tab (detail defaults to Lore), then
  assert. Watch DOM with a MutationObserver from `page.evaluate` to
  see what a library does on a click; log document-level clicks in
  capture phase to catch ghost clicks. A drag simulation needs
  multi-step `mouse.move` with pauses and a dwell on the target —
  a single jump gave a false "reorder broken" the first time.
- The bash_tool sandbox shell is **dash, not bash**: `$'…'` and `<<<`
  don't work there. Wrap shell logic in `bash -c` or a script file
  before trusting a dry-run result (cost two false alarms this
  session).
- `npm run test:rules`: 19/19 (party chat's 4 cases included). Fresh
  clone needs `npm install` first (`@firebase/rules-unit-testing`).
- `npm run test:e2e`: 3/3 green on Chromium and WebKit as of
  `db80d18`; green on every push since.

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
