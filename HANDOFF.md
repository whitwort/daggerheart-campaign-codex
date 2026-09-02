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

HEAD: `5c9f5e7` = tag **v0.12b**, deployed to prod. Dev is currently
quota-throttled (Spark plan, not yet upgraded — see item 4 below and
item 5's note) so its exact deployed state is unverified as of
writing, but should match main.

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

**5. Presence/"who's online" bug hunt: patched twice, root cause still not
fully confirmed, flagged for a possible redesign rather than a third patch.**

Player-reported (well, GM-observed): prod's Manage Party "Status"
column showed "Never online" for every player except one, despite
players having genuinely signed in before. Investigation and fixes,
in the order they actually happened (worth reading in order — several
hypotheses were chased and abandoned, and the final state is more
"stopped finding new evidence" than "confirmed root cause"):

1. Ruled out: nothing in this session's Restore/backup tooling touches
   `presence` (never has — excluded from both backup tools' collection
   lists, same as `_meta`). Ruled out a TTL policy (none configured
   anywhere in the repo). Most likely explanation for the ORIGINAL
   missing docs: manual deletion in the Firestore Console, possibly
   inadvertent, while Gregg was in there investigating the GCP-quota
   saga (item 4) around the same time. Never confirmed either way.
2. `4d0f2a9`: found that `presence.js`'s heartbeat attach was gated
   behind `auth.js`'s `roleChanged` check — if `onAuthStateChanged`
   fired more than once for the same already-signed-in user (plausible
   on Firefox specifically; console showed third-party-cookie/iframe
   partitioning warnings around the Auth popup), a redundant firing's
   blanket `detachDataListeners()` would tear the heartbeat down with
   nothing to re-attach it (roleChanged now false). Fix: evaluate
   heartbeat attach/detach on every `playerDocUnsub` snapshot,
   independent of roleChanged. Verified against dev, appeared to work.
3. Reproduced AGAIN on prod (v0.11b) immediately after that fix — a
   fresh Firefox sign-in for `sonora.kirintor@gmail.com` still got no
   presence doc, no console error at all (not even a permission
   denial — `presence.js`'s own `.catch()` never fired, meaning the
   write was never attempted). `5c9f5e7`: reasoned that fix #2 only
   helps if AT LEAST ONE `playerDocUnsub` snapshot survives long enough
   to fire — if `onAuthStateChanged` fires faster than one Firestore
   round-trip, every listener could get torn down before ever
   delivering its first snapshot, so nothing downstream (role
   resolution, heartbeat, anything) ever runs at all. Fix: compare
   `user.uid` against the previously-seen uid at the very top of
   `onAuthStateChanged`; a redundant firing for the same identity now
   skips the full listener teardown/rebuild entirely rather than
   racing to rebuild it.
4. Gregg pushed back hard on the whole auth-churn theory ("extremely
   skeptical") and asked to test directly on prod rather than
   dev — reasonable, since dev was ALSO mid-investigation into being
   Spark-quota-throttled at that point (item 4), which threatened to
   confound any dev-side test result. Deployed `5c9f5e7` to prod as
   v0.12b (full CI green, pre-deploy backup succeeded — prod's GCP
   quota fix from item 4 held up under real use).
5. **Still reproduced on v0.12b prod** — same symptom, no console
   error, footer correctly showing `version 0.12b (5c9f5e7 prod)`.
   This is the point where the auth-churn theory should have been
   treated as either wrong or insufficient, not patched a third time.
6. **Actual resolution: testing methodology, not (necessarily) a code
   bug.** The prior "still reproduced" tests were all done by clicking
   Sign Out then Sign In *within the same already-open Firefox tab* —
   which never re-fetches any JS module regardless of server-side
   `Cache-Control` headers (firebase.json already sets
   `no-cache, max-age=0, must-revalidate` correctly on everything;
   that only matters on a NEW navigation, not for already-loaded ES
   modules sitting in an open tab's memory). The footer's build-hash
   text lives in `index.html`, which may have been fetched fresh at
   some point in the session WITHOUT that implying every `.js` module
   was also freshly re-fetched — same failure class already documented
   elsewhere in this file for iOS Safari ("served stale JS despite a
   fresh footer hash"), apparently also reproducible on Firefox.
   **A brand-new Private Browsing window (guaranteed zero cache/
   in-memory state) on v0.12b prod worked correctly on the first try.**

**What's NOT resolved:** whether fixes #2/#3 (`4d0f2a9`, `5c9f5e7`)
were ever actually necessary, or whether the ENTIRE saga — including
the original "Never online" report — was stale-JS artifacts the whole
way through and the underlying pre-session code was already fine. No
clean test isolates this (every failed reproduction after fix #1 could
have been contaminated by the same in-tab-caching confound as the
final one). Both fixes are kept — they're defensively reasonable
regardless (less listener churn, heartbeat correctly decoupled from an
unrelated optimization) — but this file should not claim they're
"the fix" if the bug resurfaces. See the redesign discussion in Open
items below before reaching for a third patch on this feature.

## Open items

- **Reconsider the presence/"who's online" feature's whole implementation — see item 5 above.** Not urgent (cosmetic GM convenience, not gameplay-blocking), but flagged explicitly by Gregg after today's saga: "our implementation for user status is extremely brittle and subject to browser-specific idiosyncrasies and caching issues." Two real angles to weigh:
  - **Client-side heartbeat + manual JS timer** (current design) is inherently fragile to auth-state lifecycle edge cases and stale-module caching, as demonstrated today. Firebase Realtime Database's built-in presence pattern (`onDisconnect()` + `.info/connected`) is the standard, battle-tested solution for exactly this problem — server-managed, doesn't depend on a JS `setInterval` surviving tab/auth churn. Adding RTDB to a Firestore-only app is a real architectural addition, not a small change — worth weighing against the feature's actual value (GM convenience only) before committing to it.
  - Independent of the write-side fragility: the **read/render side has its own staleness bug** (discovered mid-session) — Admin's Manage Party table only re-renders on a `presence` collection snapshot event, so a status can sit showing stale "Online" indefinitely with no live-updating timer. Worth fixing regardless of what happens to the write side (e.g. a periodic re-render tick, or just accept it and document the "reload to refresh" behavior explicitly in the UI).
  - If a redesign happens, also fold in: the two `auth.js` fixes from this session (`4d0f2a9`, `5c9f5e7`) decouple heartbeat attach from `roleChanged` and skip listener teardown on redundant same-uid auth firings — both are defensively reasonable and should stay regardless of what happens to presence, but their necessity for TODAY's specific bug was never cleanly isolated from the stale-JS-in-an-already-open-tab confound (see item 5) — don't assume they're "the fix" if this resurfaces, and don't be surprised if a from-scratch presence implementation renders them moot.
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
