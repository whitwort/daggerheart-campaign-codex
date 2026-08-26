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

## Current state (end of Phase-14-features session, Aug 24 2026)

HEAD: `48d09bf` (dev deploy green). Prod is LIVE (v0.2b released from
b67e0d2) and fully populated from the dev dump; nothing in this
session's commit has been released to prod yet (dev-only until Gregg
cuts the next tag).

**This session added (design doc: none written — scoped inline in
chat, sign-off given, single commit `48d09bf`):**
- **Party presence**: `players/{email}.lastOnline`, written by new
  `presence.js` heartbeat (stamp on attach/tab-foreground + 4 min
  interval while a player's tab is open; GM has no `players/` doc, so
  player-only). Rules: `players/{email}` update whitelist now allows
  `lastOnline` alongside `activeCharacterId`. Admin > Manage Party has
  a new **Status** column — "Online" (stamp <5 min old), "Last online
  \<local date/time\>", or "Never online" — computed at render time,
  no refresh timer (same staleness tradeoff the Messages digest's
  relative-time already carries; consistent with existing precedent,
  not a new pattern).
- **GM notifications for player-initiated activity** (previously
  invisible to the GM):
  - Owned-Character content edits (sheet/deck/level/gold/main edit
    form) → coalesced ONE notification per entity, refreshed in place
    on every edit (`sharing.js: notifyCharacterEdited`, doc id
    `charedit-{entityId}`, upserted via `setDoc(..., {merge:true})`).
    New `kind: 'character-edited'`; new rules clause lets the OWNING
    player (not the recipient GM) touch just `createdAt`/`seenAt` on
    that specific kind — the general recipient-updates-seenAt clause
    didn't cover this since recipientEmail is the GM, not the writer.
  - Notes/secrets a player shares further into the party → reuses the
    existing `appendShareNotifications` exposure fan-out; GM added as
    an extra `kind:'shared'` recipient ONLY when the share genuinely
    exposes a party member who didn't already have access (Gregg's
    explicit call — a share that exposes nobody new, e.g. a private
    note aimed only at the GM, or re-sharing something already
    party-visible, does NOT notify). No rules change needed (`shared`
    kind/shape was already valid).
  - `campaignUnreadCount`/`markCampaignSeen` (messages.js) generalized
    from a hardcoded `kind === 'joinRequest'` check to
    `recipientEmail === self`, so both old (joinRequest) and new
    (character-edited, GM-directed shared) kinds count toward GM
    unread without another special case later.
- `index.html` modulepreload list updated (`presence.js` inserted
  alphabetically). All 5 owned-entity write sites hooked:
  `character-sheet.js` ×2, `character-deck.js`, `characters.js`,
  `codex.js`'s `saveEntityEdit`.

**NOT yet done from this feature set:** no manual QA pass in the dev
UI (session moved straight to SRD ingest per Gregg) — worth a quick
click-through of Admin > Manage Party Status and a player-side
edit/share before the next Release tag.

## Prior session: prod launch (Aug 21 2026)

Latest main from that session additionally carries: merge-mode
notifications fix, tag-derived versioning (below), full-repo cleanup.

**Versioning (changed!):** the `VERSION` file is GONE. The Release tag
is the single source of truth: prod job derives `version = tag minus
leading "v"`. Publishing a Release IS the versioning act — bump
nothing beforehand. Dev deploys still label as `build <hash> (dev)`.
Next release: tag `v0.2c` (or whatever's next) — footer and
`_meta/version` will match automatically.

**Prod launch facts:**
- IAM (done): `codex-hosting-deploy` SA on prod has Cloud Datastore
  Index Admin + Cloud Datastore User (prod deploy 403s without them).
- `BACKUP_REPO_PAT` fixed; daily prod→private-repo backup operational.
- Prod data complete except: 2 orphaned legacy image docs
  (deliberately skipped, see below) and thread message subcollections
  (client restore can't create them; Admin-SDK script only).

## Backup/restore: hard-won rules (backup.js)

The first prod restore failed four distinct ways; the fixes are load-
bearing — do not "simplify" them away:
1. Batches capped by BOTH count and ~1.5 MiB payload
   (`writeEntriesBatched`): a batched-write REQUEST caps ~10 MiB, and
   the forced long-polling transport (iOS fix, firebase.js) WEDGES on
   repeated multi-MiB commits — the promise never settles (no throw).
2. 45 s watchdog per commit + one rebuild-and-retry (WriteBatch is
   single-use). Steady state: a few timeouts per full restore, all
   recovering on first retry.
3. "restore engine rN" is the FIRST log line — bump it on any behavior
   change; it's how a stale-cached module is detected (iOS Safari has
   served stale JS despite a fresh footer hash — force-quit Safari or
   use a Private tab).
4. `isRestorableImage` skips docs that can't pass isValidImage():
   currently 2 relics of the retired maps/ scheme
   (map_A0351uUdz3yGyoJUqrdA_primary, map_ETX4fFFoCTcRLyvhCNFD_primary
   — ownerType:'map', role:'primary', no visibility). QOL: purge from
   dev someday (no UI path; Admin-SDK script).
5. Merge (non-wipe) mode wipes-and-recreates `notifications` first:
   notification UPDATES are recipient-locked (seenAt only), so set()
   on existing docs is denied even for GM.
Debugging heuristics that cracked it: wipe-phase counts reveal what
earlier runs actually wrote; replaying the chunking algorithm against
the dump's JSON sizes pinpoints which batch a run died in; a log that
just STOPS (no FAILED line) = hung promise, not a throw.

## Recent fixes also in main

- Timeline cluster tap: `scale = min(sepScale, fitScale)` (70%
  viewport) — tight pair inside a wide span no longer zooms to an
  empty window. Verified desktop + iPad.
- Full-repo review pass (6 commits, was handoffs 43): dead code
  removed, picker-panel.js extraction, README rewrite, Leaflet
  self-hosted in public/vendor/leaflet/, modulepreload for all local
  modules + gstatic SDK (KEEP THE LIST IN SYNC when adding modules —
  comment in index.html), hidden-panel render guards
  (characters/encounters/stables), 120 ms codex search debounce,
  debug banner is dev-only by design (projectId -dev or unstamped).

## Next session: SRD data ingest (version mismatch)

**The standing topic for the next session.** A new Daggerheart SRD
version has dropped, but `seansbox/daggerheart-srd` — the upstream
repo `srd-import.js` pulls pre-parsed JSON from (see that file's
header comment) — has NOT been updated to parse it yet. Need to
figure out, with Gregg, one of:
- Wait for upstream to catch up (check repo activity/issues first).
- Fork/patch the parse ourselves against the new PDF (scope unknown —
  haven't looked at what changed in the new version vs. what
  `srd-import.js` currently expects the JSON shape to be).
- Hand-patch just the delta into the existing SRD source content
  without touching the automated import path at all.
Start by diffing what's new/changed in the SRD version bump against
current `SRD_SOURCE_ID`-attributed content, then bring options back
to Gregg — this needs a design decision, not a unilateral call.
Project files include `DH-SRD-1_0-June-26-2025.pdf` and
`DaggerheartErrata5202025.pdf` — check whether either is already the
new version or still the one `daggerheart-srd` parses.

## Open items

- Purge the 2 legacy image docs from dev (Admin-SDK script).
- Deploy-workflow hardening: approval gate, rules unit tests,
  pre-deploy backup, post-deploy smoke test — decide priority.
- Post-launch optimizations: dynamic-import GM-only modules (~3k
  lines), codex.js split (4.8k lines, 5-module cycle), vendor/**
  long-cache header.
- `setEntityImagesTarget` stuck-listener gap (pre-launch review era).
- Encounter-builder integration exploration; single-entry restore
  "delete orphans" mode — both deferred.
- Manual QA pass on this session's presence/GM-notification features
  (see above) before the next Release tag.

## Session ritual

Fresh clone to /tmp with PAT-embedded URL; git identity
(whitwort@gmail.com / "Gregg Whitworth"); verify HEAD against this
doc's era; read QOL-BACKLOG.md + this file before code. Gates before
EVERY commit: /tmp/import-check.py (named-import cross-check), `npx
eslint@8 --no-eslintrc -c .eslintrc.check.json public/js/*.js`,
`node --check` per file, CSS + firestore.rules brace balance. Push via
PAT URL; rebase FETCH_HEAD if remote moved. CI: sleep ~74 s then poll
Actions API with PAT header, json.loads(strict=False). End every
session by rewriting THIS file.
