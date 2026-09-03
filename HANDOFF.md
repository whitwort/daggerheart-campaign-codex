# HANDOFF — single rolling session-transfer doc

**Convention (established at repo cleanup, Aug 2026): this is the ONLY
session-transfer file.** Each session ends by REWRITING this file with
current state — do not create codex-handoff_N.md files. Old handoffs
(20–44) and the phase design docs (phase-14/15/17) were deleted from
the tree in the same cleanup; all remain retrievable from git history
(`git log --all --oneline -- 'codex-handoff_*.md' 'phase-*.md'`,
last present at the commit tagged v0.2b's successor). Code comments
citing e.g. "phase-14-design.md §5.1" are historical pointers into
those deleted docs — resolve via git history, don't "fix" the comments.

## Current state (end of session, Sep 3 2026)

HEAD: `501ae39`, CI green, deployed to dev. Not yet promoted to prod.

**Minor fix, start of session:** "Restore a single entry" admin panel
— Restore button moved onto the same row as Upload, mirroring the
"Restore from backup" section above it (`6af4f1a`). Cosmetic only.

**Main work: Export Lore redesign (Admin > Data > Export Lore),
DONE.** Full rebuild from a single-entity JSON-only exporter into a
3-mode × 4-format matrix:

- **Modes:** Selected Entries (multi-select entry browser — reuses
  codex.js's own renderList DOM shape verbatim: category/subtype
  headers, color dots, collapse state shared with the Codex tab;
  clicking a row toggles `.active`, no checkboxes), Character (PC-only
  dropdown; pool is JUST that character's own entity plus, if
  "include secrets" is on, any other entity that IS a secret for them
  or contains one — `entityHasSecretsFor` from visibility.js, not
  "everything they can see"), All Party Visible (pure
  `visibility:'all-players'` via `canSee`).
- **Formats:** JSON (import.js round-trip shape, unchanged; images
  opt-in via checkbox, default off), Markdown, Word (.docx via `docx`
  package), PDF (via `jsPDF`) — both lazy-loaded from esm.sh, same
  pattern as `marked`/DOMPurify in markdown.js.
- **Structure per entity (MD/DOCX/PDF):** Details/Features (template
  entities only) → Lore → Gallery → Notes, each heading only emitted
  when non-empty. Multiple Lore/Note items render as an unordered
  list. Secret items/entities/images get a `[Secret – Name]` tag
  (bold, teal `#2E86AB`) — no border/box (see below, removed after
  repeated rendering bugs). Word gets a real ToC field
  (`TableOfContents`, auto-updates on open); PDF gets a hand-built
  two-pass ToC (page 1 reserved, body renders from page 2 recording
  page numbers, ToC drawn last) plus footer page numbers on every
  page.
- New file `public/js/export-render.js` holds all format-building
  logic (image fetch/normalize-to-PNG, markdown→block parsing,
  docx/PDF builders); `export-lore.js` holds UI + ctx/pool resolution
  only. `codex.js` exports several previously-private list-rendering
  helpers (`categoryPinClassLocal`, `isCategoryCollapsed`,
  `isSubtypeCollapsed`, `subtypeCollapseKey`, `subtypeLabel`) so the
  browser reuse is exact, not reimplemented. `visibility.js` now also
  exports `isSecretFor` (see incident below).

**Bug-fix arc, all against real user-reported screenshots/exports —
none of these were speculative, each was iterated against actual
output:**

- Word images landing all at the end / PDF missing images entirely —
  fixed (docx: build children sequentially with `await`, not a
  promise chain appended after the sync loop; PDF: pass the decoded
  `<canvas>` straight to `addImage`, not a hand-built base64 data URL,
  which threw silently on anything but tiny images).
- `styles.default.heading1/2/3/title` in docx — **replaces** the
  whole run definition rather than merging into it; only setting a
  document-level default font wiped out built-in bold/size, making
  every heading look like body text. Fixed by only setting
  `styles.default.document.run.font`.
- `blocksFromMarkdown` (shared markdown→block-list parser used by
  both docx and PDF) silently **dropped entire blocks** for several
  marked token types it didn't explicitly handle: nested sub-lists
  inside a Lore item, blockquotes, fenced code blocks. Root cause
  each time was relying on a token's `.text` field instead of walking
  its `.tokens` (list/blockquote items only carry parsed content in
  `.tokens`). Now has an explicit case for every token type this app
  can plausibly produce (`heading`, `paragraph`, `list`, `blockquote`,
  `hr`, `code`, `space`) **plus a catch-all** for anything else that
  walks `.tokens` or falls back to `.text` — no token type can
  silently vanish content again.
- Secret-item bordered "boxes" (docx: matching-border-on-consecutive-
  paragraphs trick; PDF: hand-measured `roundedRect`) went through
  several rounds of fixes (mis-measured height across page breaks,
  over-indented continuation paragraphs, box not covering
  multi-paragraph items) and were **ultimately removed entirely** per
  Gregg's call after still looking wrong — secrets are marked by the
  colored/bold tag text alone now, everywhere (entity headers, Lore/
  Note items, image captions).

**Incident, mid-session: `65a6bcf` fixed a real production outage.**
`80a186e` added `import { isSecretFor } from './visibility.js'` in
export-lore.js, but `isSecretFor` was never added to visibility.js's
own `export {}` list. A missing named ES module export is a
**link-time failure for the entire module graph** — not a runtime
error scoped to the importing file — so this broke page load for
*every* role, not just Export Lore users (confirmed: e2e player-role
suite failed identically on all 3 tests at the sign-in step, since
nothing evaluates past the graph's link phase). Root-caused by
running the e2e suite locally against the emulator with a Playwright
probe capturing `pageerror` events (see Session ritual below) rather
than re-reading CI logs or guessing from lint output — ESLint's
`no-undef` and `node --check` do NOT catch a missing named export.
Fixed same session, verified via a fresh local e2e run before
re-push, deploy confirmed green ~10 min after the break was
introduced.

**Lesson baked into the ritual below:** any commit touching a shared
module's imports/exports (not just auth.js/firebase.js/tests/e2e/* —
the old trigger list would have missed this exact incident) should
run `npm run test:e2e` locally before push, not just lint/syntax
gates. Did this for every commit after the incident; all green.

## Open items

- **Export Lore not yet verified in prod** — dev-only so far, tested
  live by Gregg through this whole arc but only on dev. Promote via
  normal Release-tag flow when ready.
- **Word docx ToC / `keepNext` / jsPDF `addImage(canvas,...)`
  overload** were unverified-live claims at various points this
  session and are now behaviorally confirmed via Gregg's actual
  exports — no known open questions on these specifically, just
  noting they were real risk points that panned out fine.
- Remaining 1,287 `imported`-kind lore items — **not in scope.**
- Exercise op-status's indeterminate-bar path (SRD Update) and
  stale-doc self-heal path live — **not in scope.**
- Post-launch optimizations: dynamic-import GM-only modules (~3k
  lines), codex.js split (5,079 lines now, grew slightly this
  session from the new exports) — **not in scope.**
- Single-entry restore "delete orphans" mode — **not in scope,**
  deferred, needs a concrete use case.
- Purge-legacy-image-docs scan (backup.js internal logic) — **not in
  scope,** low priority.
- Player-facing reuse of the Export Lore mode/format UI — explicitly
  the *next* step per the original design discussion, not started
  this session. `export-lore.js`'s ctx resolution already generalizes
  via `viewerContext()` for the Selected Entries mode, so this should
  mostly be a new entry point rather than a rewrite.

## Carried context

- **Dev/prod GCP trial-quota trap**: a project still in Google's
  90-day free-trial status has a hard 50K reads/day cap regardless of
  Blaze billing. Fix is the trial banner's "Activate" button (NOT
  Billing's "Upgrade"). Prod was fixed this way Sep 2 2026; dev's
  status as of this session unknown — if dev misbehaves with
  resource-exhausted errors, check this before suspecting code.
- **Copyedit pipeline** (scripts/copyedit-*.js): offline
  export→review→apply flow, byte-compatible with Admin > Backup >
  Restore Update mode. Rebuild the patch against a fresh export if
  ever re-run after a delay.
- `npm run test:rules`: 15/15 as of last run; needs one-time `npm
  install --no-save firebase-tools@15 @firebase/rules-unit-testing@3`
  in a fresh clone.
- Presence redesign (write-side de-lifecycled heartbeat + read-side
  60s staleness tick) — verified live in prod last session, no open
  issues.

## Session ritual

Fresh clone (never reuse a prior working tree); git identity
(whitwort@gmail.com / "Gregg Whitworth"); verify HEAD against this
doc's era; read QOL-BACKLOG.md + this file before code. Gates before
EVERY commit: `npx eslint@8 --no-eslintrc -c .eslintrc.check.json
public/js/*.js`, `node --check` per touched file, CSS + firestore.rules
brace balance, `npm run test:rules` if firestore.rules or its own test
file touched (needs the one-time install above).

**`npm run test:e2e` (or `bash scripts/e2e-run.sh`) before EVERY push,
not just when auth.js/firebase.js/tests/e2e/* are touched** — widened
this session after a missing named export in visibility.js (imported
by export-lore.js) broke page load for every role, which only lint/
syntax gates don't catch (a missing export is a link-time failure, not
a runtime error). Needs `npm install` once for `@playwright/test` +
one-time `npx playwright install --with-deps chromium` (the script
does this itself, just slower on a cold cache). To debug a page that
won't load at all rather than re-reading CI logs: run the emulators
(`firebase emulators:start --only firestore,auth,hosting --project
demo-dcc-e2e`, with `public/firebase-env.js` temporarily swapped for
`public/firebase-env.emulator.js` — restore the real one before
committing) and hit it with a small Playwright script capturing
`pageerror`/`requestfailed` events; far faster than reasoning from
symptoms. Note: this sandbox's own egress proxy MITMs `gstatic.com`
with a self-signed cert, so a naive probe reports
`ERR_CERT_AUTHORITY_INVALID` on every Firebase SDK fetch — a red
herring, not a real bug; launch chromium with
`--ignore-certificate-errors` and `newPage({ ignoreHTTPSErrors: true
})` to get past it to the actual signal.

When verifying a markdown-rendering bug fix against `marked`, test
against the ACTUAL esm.sh-served bundle
(`curl https://esm.sh/marked@15` → follow the redirect it prints →
fetch that real module file), not `npm install marked` — version/build
resolution can differ between the two and it's cheap to just fetch the
real thing.

Push via PAT URL; rebase FETCH_HEAD if remote moved. CI: sleep ~74s
then poll Actions API with PAT header — both `deploy.yml` and
`e2e.yml` fire on push to main independently (e2e.yml is deliberately
separate so a flaky Playwright run doesn't block hosting deploy, but
still watch it — see incident above for why). Prod deploys are
Release-triggered (tag push + GitHub Release) — the prod job's
pre-deploy backup step is a real Firestore dependency, so GCP quota/
trial state can block it. End every session by rewriting THIS file.
