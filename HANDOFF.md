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

## Current state (end of session, Sep 14 2026)

HEAD: `ed64176`, CI green (Deploy + E2E). Two pieces of work this
session, both dev-verified pending; not yet in a tagged prod release.

### Import Lore — sourceId dropdown (`6fb4ee6` → `2eed5bb`)

Confirmed working on **dev** by Gregg (dropdown populates and applies
correctly).

1. **Feature** (`6fb4ee6`): Admin > Import Lore previously had no way
   to set `sourceId` on bulk-imported entities/lore — Gregg was hand-
   correcting every imported item's source via the per-item dropdowns
   after the fact. Added a "Source for imported items" dropdown above
   the Import button; selected value is applied to every created/
   replaced/updated entity doc and every lore item (including template
   `meta-details`/`meta-features` anchors) in that batch.
2. **Bug 1 — dropdown always empty** (`e82c3b5`): first pass queried
   `sources` directly via `getDocs` instead of reusing `sources.js`'s
   `buildSourceSelect()` (which reads from `state.allSources`, the
   real-time-synced source of truth every other source dropdown in the
   app uses). Switched to `buildSourceSelect()`.
3. **Lint failure** (`c8f5517`): swapping to `buildSourceSelect()` made
   `query`/`where`/`getDocs` look unused, so they got stripped from the
   import line — but `fetchLoreFor()` (replace/update lore fetching)
   still calls them directly. Restored the imports.
4. **Bug 2 — dropdown still empty after bug 1 fix** (`2eed5bb`): even
   with `buildSourceSelect()`, the dropdown was built exactly once,
   gated by a one-shot flag, at whatever moment the Admin tab first
   activated. If that happened before Firestore's `onSnapshot` (in
   `attachSourcesListener`) delivered its first batch, `state.
   allSources` was empty at build time and nothing ever rebuilt it —
   unlike `codex.js`/`admin.js`, import.js never registered a
   `registerSourcesChangeHandler`. Fixed by registering
   `buildImportSourceSelect` as a sources-change handler (same pattern
   as the other dropdowns); dropped the one-shot guard; selection is
   preserved across rebuilds via a module-level `importSelectedSourceId`.

**Lesson for future dropdown/listener work in this codebase:** any UI
that reads from a Firestore-backed `state.*` collection needs to
either (a) already run after that collection's listener has populated
`state`, or (b) subscribe to that collection's own
`registerXChangeHandler` and rebuild on change — don't assume
`state.*` is populated just because the listener was attached earlier
in the session; the snapshot is async.

### Characters > Cards tab: three small display fixes (`ed64176`)

Not yet dev-verified by Gregg (pushed and CI-green same session; ask
next session if untested).

- **Abilities tab label**: "Experience" → "Experiences"
  (`character-deck.js`, `buildAbilitiesSection`'s tab list).
- **Transformation cards hide their Question prompts**: SRD 2.0
  transformation records (`public/data/srd/transformations.json`)
  carry a `question` array of roleplay prompts, which
  `srd-import.js`'s generic leftover-markdown path renders as a
  `### Question` heading + bullet list, folded into the entity's
  `meta-details` lore item. On the Conditions/Transformations tray's
  compact cards this doesn't belong (same reasoning as Class cards
  already hiding their Background/Connection question lists) — now
  stripped via the existing `cleanCardMd({stripSections: ['Question']})`
  mechanism, gated on `linked.subtype === 'transformations'` so plain
  Conditions are untouched. Scoped to the Cards-tab compact view only;
  the Codex tab's own Lore tab still shows the full Question list.
- **Item/Consumable cards truncate at 20 lines**: added a new
  `truncateCardMd(md, maxLines)` helper (character-deck.js, alongside
  `cleanCardMd`) — cuts body markdown to 20 lines with a trailing
  `*...*` marker when longer. Applied only to the Items/Consumables
  branch of `equipmentCardOptsForLinked` (no templates.js schema, so
  it's freeform prose with nothing else compacting it); weapons/armor
  already render compact structured bullets and are unaffected. Full
  text remains one click away via the card's own Codex link
  (`codexEntityId`).

## Pre-1.0 open-items sweep (Sep 10 2026 session — unchanged, not re-verified this session)

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
requirement for it.

## Open items

- **Cards tab fixes** (Experiences label, Transformation Question
  strip, Item card truncation): pushed this session (`ed64176`), CI
  green, not yet confirmed by Gregg in the app. Verify next session.
- **Import Lore sourceId feature**: dev-verified working as of last
  session (`2eed5bb`). Not yet in a tagged prod release — carry
  forward until confirmed live via prod tag/footer.
- Six items from the Sep 10 sweep (dynamic-import, codex.js split,
  delete-orphans restore mode, player Export Lore reuse, imported-
  lore-items count) carry forward as confirmed-status per that
  section — see above, don't re-derive from scratch next time.
- **Nav phase 2 + campaign-type gating**: per Sep 10 handoff this was
  expected to ride Gregg's 1.0 tag to prod. Re-verify against the live
  prod tag/footer rather than assuming.

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
  avoid this.
- **Source dropdowns depend on `state.allSources` being populated
  async** (see last session's Import Lore bug 2 above) — any new
  source-aware UI must register via `registerSourcesChangeHandler`
  from `sources.js`, not assume the listener attached earlier means
  data is already there.
- **Cards-tab compact-view cleanup mechanism** (`character-deck.js`):
  `cleanCardMd(md, opts)` — `stripHeadingLines`/`stripSections`/
  `stripBulletLabels` for hiding heading clutter, whole roleplay-prompt
  sections, or duplicated bullet lines; `truncateCardMd(md, maxLines)`
  (new this session) for capping freeform-prose card bodies. Both
  scoped to the Cards tab only — the Codex tab's own Lore tab always
  shows full, unmodified content via `resolveEntityStatBlockMarkdown`/
  `resolveLoreItemMarkdown`. Reach for these first before writing a
  new one-off truncation/strip for the next compact-card ask.
- `npm run test:rules`: 19/19 passing as of Sep 10 session (party chat
  added 4 new cases) — not touched this session.
- `npm run test:e2e`: green on every push this session
  (`6fb4ee6`→`ed64176`, all runs).

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
