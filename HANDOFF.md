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

HEAD: `c3e8b63` = tag **v0.10b**, deployed to and confirmed working on
**BOTH dev and prod**. Everything below is DONE, not pending.

**1. Offline copy-editing pass tooling + first real pass: DONE, applied to prod, confirmed working.**
`scripts/copyedit-extract.js` / `-review.html` / `-apply.js` (commit
`fdae174`, searchIndex-recompute fix `30fd603`) — offline JSON-dump →
copyedit → JSON-restore pipeline. Scope confirmed with Gregg:
loreItems.content + entities.details string values only (not names,
not feature text), explicitly EXCLUDING the 1,287 `kind:'imported'`
lore items (bulk SRD/Lawbrand-Worldbook/Homebrew-Kit reference text —
Gregg's call: "restrict to the first category, not automatically
imported text"). Ran a full manual pass against the Sep 2 prod
export: all 135 gm-note lore items + all 6,475 entity-details values.
Result: 44 approved changes (43 loreItems typo/grammar/clarity fixes,
1 entities.details fix — a beastform's `attack` field had trait/range
word order reversed vs. every sibling entry).

**Delivery mechanism — NOT the Admin > Import Lore feature** (that's
slug-matched and APPENDS/dedupes lore items rather than editing in
place — wrong tool for a field-level patch). `copyedit-apply.js`'s
output is byte-compatible with the app's own **Admin > Database >
Backup > Restore, Update mode**. Applied to dev first (confirmed
good), then — critically — the patch was REBUILT against a fresh prod
export (not the stale Sep 2 one) before applying to prod, specifically
to avoid silently reverting any prod edits that might have landed on
those same 44 docs in the interim (`copyedit-apply.js` writes back the
FULL original doc, not a partial update, so replaying a stale export
would clobber anything changed since). A drift check confirmed all 44
target fields still matched their Sep 2 values exactly before the prod
apply — zero risk in this instance, but that check is worth repeating
any time this pipeline runs again after a delay.

**Applied to prod, Gregg confirmed: "Tested and worked."**

Remaining copyedit scope, NOT done: the 1,287 `imported`-kind lore
items (deliberately excluded). If Gregg wants those covered later:
treat as licensed/official text (SRD, Lawbrand Worldbook, Homebrew
Kit) where wording changes for "impact" risk altering rules meaning —
typo/OCR-artifact fixes only, no rewrites.

**2. Global op-status broadcast: DONE, deployed to prod, live.**
`public/js/op-status.js` (`997e872`): while a Restore/Import/SRD-
Update is running, EVERY connected client (GM and players) sees a
non-dismissable modal ("The app isn't usable until this finishes")
with live progress text + a bar — determinate % where computable
(Restore's collection-step count, Import's committed/total writes),
indeterminate stripe for SRD Update (17 heterogeneous content types,
not worth modeling as one percent). Backed by `opStatus/current` (GM
write, any-signed-in-user read — new firestore.rules match,
deliberately kept OUT of `_meta`, whose whole contract is "CI/Admin-
SDK write only"). Listener attached in auth.js alongside the existing
`_meta/version` deploy-check listener. Self-heals: a stale
`active:true` doc (>5 min, GM tab crashed mid-op) clears on the GM's
own next session.

Wired into: full Restore (exercised live during this session's prod
backup/deploy work — worked), bulk Import, SRD "Update entries"
(neither of the latter two exercised live yet). **Deliberately NOT
wired**: single-entry Restore, Purge-legacy-image-docs (smaller blast
radius). The indeterminate-bar path (SRD Update) and the stale-doc
self-heal path are still UNTESTED live — worth exercising next time
either comes up naturally, not worth a dedicated session for.

`npm run test:rules`: 15/15 pass. Needs `npm install --no-save
firebase-tools@15 @firebase/rules-unit-testing@3` first in a fresh
clone (not committed, ~2 min install).

**3. Removed "Purge legacy image docs" from Admin UI: DONE, deployed.**
(`c3e8b63`) No longer needed on dev or prod — Gregg's call, the two
legacy docs it existed to clean up were already purged in dev back on
Aug 27. Button/status line/handler removed;
`isRestorableImage()`/`filterRestorable()` in backup.js are UNTOUCHED
and still load-bearing for Restore (skips any legacy doc that can
never pass `isValidEntity()`/`isValidImage()` again, so one bad doc
in a batch doesn't fail the whole batch).

**4. Prod GCP project needed a one-time free-trial activation, not
just a Blaze billing upgrade — worth remembering if this ever bites
again.** Mid-session, the pre-deploy backup step (and a manual retry)
started failing with `RESOURCE_EXHAUSTED` / Firestore's Spark-tier
50,000-reads/day system limit — triggered by this session's own heavy
prod-read activity (multiple full prod exports + the automated cron
backup, same day). Gregg had already added a Blaze billing account,
but the IAM Quotas page still showed the hard 50K "System limit" row
(Adjustable: No) rather than a normal Blaze quota. Root cause: the
underlying Google Cloud PROJECT was still in Google's separate
90-day/$300-credit **free-trial** status (a project-level flag,
distinct from the Firebase Spark/Blaze billing-plan toggle) — trial
projects keep the hard 50K cap regardless of what billing plan is
attached. Fix was the "Activate" button on the trial banner (Firebase
Console, top of any page for the project) — NOT the same as Billing
account's "Upgrade" button, and clicking it briefly detoured through
an unrelated "Foundation Builder" org-setup wizard that Gregg
correctly did NOT proceed into. Once actually activated (confirmed via
Billing > Overview showing "Paid account" with no blue Upgrade button
— the IAM Quotas page itself stayed stale/uncached and was NOT a
reliable signal), the manual backup went through immediately. No code
or config change in the repo from this — pure GCP account state,
flagging here only so a future session recognizes the symptom faster.

## Open items

- Remaining 1,287 `imported`-kind lore items — copyedit scope not yet extended there (see above); typo/OCR-only if it ever happens.
- Exercise op-status's indeterminate-bar path (SRD Update) and stale-doc self-heal path live, whenever either comes up naturally.
- Post-launch optimizations: dynamic-import GM-only modules (~3k lines), codex.js split (4.8k lines).
- Single-entry restore "delete orphans" mode — deferred, needs concrete use case.
- Purge-legacy-image-docs scan (backup.js's own image-purge logic, distinct from the removed UI button) has no watchdog on its `getDocs` read — low priority, only matters if it starts failing. (Note: the UI entry point for this is gone per item 3 above; this line is about a latent characteristic of the underlying code, not something currently reachable.)
- Playwright player-role smoke test — floated during Aug 28 focus-loss retro, not built.

## Prior session: "Current scene" configuration feature (Sep 2 2026)

HEAD at that point: `44f2812`. Deployed to dev only at the time; this
session's v0.10b Release (above) is what finally shipped it to prod
alongside the copyedit/op-status/purge-removal work.

**"Current scene" configuration feature: COMPLETE & TESTED.**
Built commit `4450d32`, confirmed functional by Gregg:
- New `currentSceneId` field in `config/campaign` doc + state.js.
- Admin > Configuration > "Current scene" selector: filters Scene entities, GM-editable, merge-saved like rootEntityId/campaignType.
- Codex opening message: if currentSceneId set & visible, appends line "Or start with the party's latest scene: [NAME]" with clickable link. Link click selects scene entity and displays detail.
- Render: codex.js entities listener (Scene list changes) + map.js config listener (currentSceneId changes).
- No firestore.rules changes needed — already handled by existing `config/campaign` access rules.

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
then poll Actions API with PAT header. Prod deploys are Release-
triggered (tag push + GitHub Release, e.g. v0.10b this session) — the
prod job's pre-deploy backup step is a real Firestore dependency, not
just CI plumbing, so a project stuck in GCP free-trial status (see
item 4 above) can block it. End every session by rewriting THIS file.
