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

## Current state (end of session, Sep 2 2026 — second session this date)

HEAD: `a070d7c`, CI green, **deployed to dev only — NOT yet released
to prod.** Prod remains at tag v0.12b (`5c9f5e7`). Next prod Release
should pick this up after Gregg confirms the presence redesign behaves
on dev (or directly on prod if dev's quota state is still murky — see
the still-standing dev-quota note from the prior session below).

**Presence redesign: DONE (write side "option A" + read-side tick),
deployed to dev, NOT yet verified live.**

Context: the prior session (same date, item 5 of that handoff — full
saga preserved in git history at `b676d96`) ended with the presence
feature flagged as "extremely brittle" after two silent-failure
patches (`4d0f2a9`, `5c9f5e7`) whose necessity was never cleanly
isolated from a stale-JS-in-an-open-tab testing confound. This
session opened with a design discussion (three options presented;
Gregg chose A) and implemented:

1. **Write side — de-lifecycled the heartbeat** (`presence.js`
   rewritten): the 4-min interval and the `visibilitychange` listener
   now register ONCE at module load and are never torn down.
   `stampOnline()` self-guards (no-op unless signed-in player), so the
   permanent timer is correct by construction — signed out or GM it
   does nothing; the moment state says "player" the next
   tick/foreground stamp works. This removes the entire
   auth → attach → snapshot dependency chain that made every stamp
   hinge on listener lifecycle ordering and fail SILENTLY (no write
   attempted → nothing for `.catch()` to see). The rationale is now a
   long comment in presence.js: the "tear down every listener on auth
   change" convention exists because Firestore permanently kills an
   onSnapshot READ on a permission error — a fire-and-forget WRITE has
   no such failure mode, so the convention never applied here.
   - `attachPresenceHeartbeat`/`detachPresenceHeartbeat` are GONE
     (exports, auth.js call sites, the detachDataListeners entry).
   - One export remains: `stampPresenceNow()`, called from auth.js's
     `playerDocUnsub` handler on every player-role snapshot, so the GM
     sees "Online" seconds after a player signs in instead of up to
     one heartbeat period later. Unconditional per player snapshot;
     redundant stamps are harmless.
   - The two prior auth.js patches (`4d0f2a9` uid-compare skip,
     `5c9f5e7`) remain in place — independently reasonable (less
     listener churn), just no longer load-bearing for presence.

2. **Read side — 60s staleness tick** (admin.js, right after
   `renderAdminPlayersList`): the Status column is a time-relative
   computation and previously only recomputed on a `presence` snapshot
   event — so "Online" could sit stale FOREVER once a player's
   heartbeats stopped (nothing re-fires a snapshot when writes STOP
   arriving). New `setInterval` re-renders the players table every
   60s. Purely local (renders from `state.allPresence` in memory, zero
   network). Guards, in order: `currentRole === 'gm'`,
   `document.visibilityState === 'visible'`, and
   `state.adminPlayerEditId === null` — the last so the tick can't
   wipe an in-progress displayName edit (same hazard class as the Aug
   2026 heartbeat-rerender bug). Chose full-table re-render over
   surgical status-cell patching deliberately: reuses the
   already-exercised render path rather than adding new
   DOM-bookkeeping code (Gregg's stated criterion: least likely to
   introduce new bugs, kind to network — this is both).

Unchanged: 4-min heartbeat period, 5-min ONLINE_WINDOW_MS,
firestore.rules (presence match untouched), index.html modulepreload
(presence.js was already listed). Net diff: 3 files, +71/−50.

**Verification NOT yet done (do next session or when Gregg tests):**
1. Fresh private-window player sign-in → GM sees "Online" within
   seconds. (Use a private window — the entire prior saga's lesson was
   that Sign Out/In inside an already-open tab never re-fetches ES
   modules and produces unfalsifiable results. firebase.json's
   no-cache headers only apply to new navigations.)
2. Player closes tab → GM's Status flips to "Last online …" within
   ~6 min with NO GM interaction (this is the read-tick proving
   itself; before this change it required a manual re-render trigger).
3. A GM-side player row left in edit mode survives >60s untouched
   (tick's edit guard).

If "Never online" EVER resurfaces after this redesign, the remaining
suspects are (in prior-probability order): stale JS in an open tab
(test in a private window first, always), manual doc deletion in the
Firestore Console, or a genuinely new bug — the auth-churn theory is
retired; don't re-litigate it.

## Open items

- **Release to prod** (this session's `a070d7c` presence redesign) —
  pending Gregg's dev verification. Standard Release flow (tag +
  GitHub Release; prod job's pre-deploy backup is a real Firestore
  dependency).
- Remaining 1,287 `imported`-kind lore items — copyedit scope not
  extended there (prior session's call); typo/OCR-only if ever done.
- Exercise op-status's indeterminate-bar path (SRD Update) and
  stale-doc self-heal path live, whenever either comes up naturally.
- Post-launch optimizations: dynamic-import GM-only modules (~3k
  lines), codex.js split (4.8k lines).
- Single-entry restore "delete orphans" mode — deferred, needs a
  concrete use case.
- Purge-legacy-image-docs scan (backup.js internal logic; UI button
  removed prior session) has no watchdog on its `getDocs` read — low
  priority, only matters if it starts failing.
- Playwright player-role smoke test — floated during the Aug 28
  focus-loss retro, not built. Note: the presence redesign just
  removed one of the bug classes it would have guarded, but a player-
  role CI smoke test would still be the only thing exercising the app
  as a player pre-deploy.

## Carried context from prior session (same date — full detail at `b676d96`'s HANDOFF)

- **Dev project quota**: dev was Spark-quota-throttled
  (RESOURCE_EXHAUSTED, 50K reads/day) at prior session end, not yet
  upgraded; its deployed state was unverified then. This session's
  dev deploy succeeded via CI, but if dev misbehaves during presence
  testing, remember the quota state before suspecting the code —
  or just test on prod after release, as Gregg preferred last time.
- **Prod GCP free-trial trap**: a project still in Google's 90-day
  free-trial status keeps a hard 50K reads/day cap regardless of
  Blaze billing. Fix is the trial banner's "Activate" button (NOT
  Billing's "Upgrade"); confirm via Billing > Overview showing "Paid
  account". Prod was fixed this way Sep 2; dev has NOT had this
  treatment.
- **Copyedit pipeline** (scripts/copyedit-*.js): offline
  export→review→apply flow, byte-compatible with Admin > Backup >
  Restore Update mode. If ever re-run after a delay: REBUILD the
  patch against a fresh export first (apply writes back FULL docs —
  a stale export silently clobbers interim edits).
- **op-status broadcast** (`op-status.js`): live in prod; Restore
  path exercised, bulk Import / SRD Update paths and stale-doc
  self-heal untested live.
- `npm run test:rules`: 15/15; needs one-time `npm install --no-save
  firebase-tools@15 @firebase/rules-unit-testing@3` in a fresh clone.

## Session ritual

Fresh clone (never reuse a prior working tree); git identity
(whitwort@gmail.com / "Gregg Whitworth"); verify HEAD against this
doc's era; read QOL-BACKLOG.md + this file before code. Gates before
EVERY commit: `npx eslint@8 --no-eslintrc -c .eslintrc.check.json
public/js/*.js`, `node --check` per touched file, CSS + firestore.rules
brace balance, `npm run test:rules` if firestore.rules or its own test
file touched (needs the one-time install above). Push via PAT URL;
rebase FETCH_HEAD if remote moved. CI: sleep ~74s then poll Actions
API with PAT header. Prod deploys are Release-triggered (tag push +
GitHub Release) — the prod job's pre-deploy backup step is a real
Firestore dependency, so GCP quota/trial state can block it. End
every session by rewriting THIS file.
