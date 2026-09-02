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

## Current state (end of session, Sep 2 2026)

HEAD: `997e872`. Nothing from this session deployed yet — dev/prod
still sit wherever the prior session (`44f2812`, "Current scene"
feature, below) left them. Two unrelated pieces of work landed:

**1. Offline copy-editing pass tooling + a real first pass (44 changes, not yet applied).**
`scripts/copyedit-extract.js` / `-review.html` / `-apply.js` (commit
`fdae174`) — offline JSON-dump → copyedit → JSON-restore pipeline.
Scope confirmed with Gregg: loreItems.content + entities.details
string values only (not names, not feature text). Ran a full manual
pass against a fresh prod export (uploaded Sep 2 2026): all 135
gm-note lore items (Gregg's own campaign prose) + all 6,475
entity-details values, explicitly EXCLUDING the 1,287
`kind:'imported'` lore items (bulk SRD/Lawbrand-Worldbook/Homebrew-Kit
reference text — Gregg's call: "restrict to the first category, not
automatically imported text"). Result: 44 approved changes (43
loreItems typo/grammar/clarity fixes, 1 entities.details fix — a
beastform's `attack` field had trait/range word order reversed vs.
every sibling entry). `copyedit-apply.js` also recomputes
`searchIndex` for any patched templated entity (`30fd603` — found
this bug building the first real patch: without it, a stale
searchIndex would keep indexing the OLD field order after the fix;
the script now loads `getTemplateSchema`/`computeSearchIndex` straight
from the real `public/js/templates.js` rather than duplicating its
~190-line schema table, so it can't drift).

**Delivery mechanism, confirmed with Gregg — NOT the Admin > Import
Lore feature** (that's slug-matched and APPENDS/dedupes lore items
rather than editing in place — wrong tool for a field-level patch).
`copyedit-apply.js`'s output (`{collections: {entities:[...],
loreItems:[...]}}`, full-doc-preserving, doc-id-keyed) is byte-
compatible with the app's own **Admin > Database > Backup > Restore,
Update mode** (public/js/backup.js) — same dump shape, same
timestamp-marker format, same doc-id-preserving set(). Gregg has the
patch file (`copyedit-restore-update.json`, 44 docs) but has NOT yet
run it against dev or prod. **Next step: apply to dev first, verify,
then prod** — confirmed as the plan before the patch was even built.

Remaining copyedit scope, NOT done: the 1,287 `imported`-kind lore
items (deliberately excluded this session). If Gregg wants those
covered later: treat as licensed/official text (SRD, Lawbrand
Worldbook, Homebrew Kit) where wording changes for "impact" risk
altering rules meaning — typo/OCR-artifact fixes only, no rewrites.

**2. Global op-status broadcast (`997e872`), NOT YET DEPLOYED OR TESTED LIVE.**
New `public/js/op-status.js`: while a Restore/Import/SRD-Update is
running, EVERY connected client (GM and players) sees a non-
dismissable modal ("The app isn't usable until this finishes") with
live progress text + a bar — determinate % where computable
(Restore's collection-step count, Import's committed/total writes),
indeterminate stripe for SRD Update (spans 17 heterogeneous content
types, not worth modeling as one percent). Backed by a single
well-known doc `opStatus/current` (GM write, any-signed-in-user read
— new firestore.rules match, deliberately kept OUT of `_meta` since
that collection's whole contract is "CI/Admin-SDK write only, no
client write path"). Listener attached in auth.js right alongside the
existing `_meta/version` deploy-check listener (same "any signed-in
user, including not-yet-whitelisted" scope). Self-heals: a stale
`active:true` doc (>5 min old — GM's tab crashed mid-op) gets cleared
by the GM's OWN next session; other clients just stop showing the
dialog once it clears — no manual "force clear" control exists or is
planned.

Wired into: full Restore, bulk Import (Admin's structured JSON
importer), SRD "Update entries". **Deliberately NOT wired** (Gregg
hasn't been asked to confirm this scoping call — flag if it should be
revisited): single-entry Restore and Purge-legacy-image-docs, smaller
blast radius, don't make the whole app unusable the way a full
Restore/Import does.

`npm run test:rules`: 15/15 pass (opStatus rule doesn't touch any
existing collection's rules; ran as a regression check). Needed
`npm install --no-save firebase-tools@15 @firebase/rules-unit-testing@3`
first — not committed to the repo, ~2 min install, do this in any
fresh clone before running the test. **Not yet smoke-tested against a
live deploy** — next session should deploy to dev, trigger a Restore
from one browser tab, and confirm a second (player-role) tab actually
shows the dialog and it clears correctly, including the
indeterminate-bar path (SRD Update) and the stale-doc self-heal path
(harder to test — would need to kill the GM tab mid-restore and
confirm the NEXT GM session clears it).

## Open items

- **Apply the 44-change copyedit patch** — dev first (`copyedit-restore-update.json` via Restore/Update mode), then prod.
- **Smoke-test op-status** on a dev deploy (see above) before it ships to prod — two-tab test, both the determinate and indeterminate bar paths, and ideally the stale-doc self-heal path.
- **Prod Release:** the prior session's "Current scene" feature (`44f2812`) is still ready to ship and still deferred; this session's two pieces of work add to that backlog rather than replacing it.
- Post-launch optimizations: dynamic-import GM-only modules (~3k lines), codex.js split (4.8k lines).
- Single-entry restore "delete orphans" mode — deferred, needs concrete use case.
- Purge-legacy-image-docs scan has no watchdog on `getDocs` read — low priority, only matters if it starts failing.
- Playwright player-role smoke test — floated during Aug 28 focus-loss retro, not built.
- Remaining 1,287 `imported`-kind lore items — copyedit scope not yet extended there (see above).

## Prior session: "Current scene" configuration feature (Sep 2 2026)

HEAD at that point: `44f2812`. Deployed to **dev only**, CI green throughout. Prod remains v0.7b/`1a08007`.

**"Current scene" configuration feature: COMPLETE & TESTED, prod Release deferred.**
Built commit `4450d32`, confirmed functional by Gregg:
- New `currentSceneId` field in `config/campaign` doc + state.js.
- Admin > Configuration > "Current scene" selector: filters Scene entities, GM-editable, merge-saved like rootEntityId/campaignType.
- Codex opening message: if currentSceneId set & visible, appends line "Or start with the party's latest scene: [NAME]" with clickable link. Link click selects scene entity and displays detail.
- Render: codex.js entities listener (Scene list changes) + map.js config listener (currentSceneId changes).
- No firestore.rules changes needed — already handled by existing `config/campaign` access rules.
- All pre-commit gates passed: ESLint, node --check, CSS/rules brace balance.
- Prod Release deferred per Gregg — other sessions have pending work to finish first.

## Session ritual

Fresh clone (never reuse a prior working tree); git identity
(whitwort@gmail.com / "Gregg Whitworth"); verify HEAD against this
doc's era; read QOL-BACKLOG.md + this file before code. Gates before
EVERY commit: `npx eslint@8 --no-eslintrc -c .eslintrc.check.json
public/js/*.js`, `node --check` per touched file, CSS + firestore.rules
brace balance, `npm run test:rules` if firestore.rules or its own test
file touched (needs the one-time `npm install --no-save
firebase-tools@15 @firebase/rules-unit-testing@3` in a fresh clone).
Push via PAT URL; rebase FETCH_HEAD if remote moved. CI: sleep ~74s
then poll Actions API with PAT header. End every session by rewriting
THIS file.
