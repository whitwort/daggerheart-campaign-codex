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

## Current state (end of SRD-2.0-extraction session 2, Aug 26 2026)

HEAD: `f935056` (dev deploy green). Prod still at v0.2b; everything since
is dev-only.

**This session (two commits `9e82211`, `f935056`):** bulk of SRD 2.0
extraction landed. `public/data/srd/` now has: abilities (210), domains
(10), ancestries (24), communities (15), classes (13), subclasses (26),
beastforms (24), stances (16, NEW type), transformations (6, NEW type),
conditions (3). Tooling in `scripts/srd-extract/` (README there):
`cols.py` splits two-column pages via per-page gutter detection
(`pdftotext -bbox`; fixed-width crops bleed glyphs), then regex parsers
per section. All 1.0-overlapping text was diffed against the old
upstream JSON — remaining diffs are genuine 2.0 wording changes.

Code: `srd-import.js` SRD_TYPES + `templates.js` schemas for
`Game Mechanics/stances` (tier) and `Game Mechanics/transformations`
(features + question array); `config.js` subtypesByCategory updated;
`character-deck.js` beastforms tab generalized into
`buildTierGroupedPanel()` and Brawlers get a **Stances** sub-tab (gated
on class name 'Brawler', mirroring the Druid gate — not on the Martial
Artist subclass). No rules changes (no new entity fields).

**Gregg's decisions this session (recorded in
`docs/srd-update-process.md`):** `suggested_*` class keys stay in schema
but are empty (2.0 dropped them; GM fills manually). Transformations
separate from beastforms. Combat Wheelchair skipped. Witherwild +
Supplemental Campaign Mechanics ARE imported: **one Game Mechanics
entity per section** — proposed subtype `campaign-mechanics`
(Witherwild as a single entity; Faction Tracking, Everyday Hero
Starting Equipment, Feasts, Grimdark, Tech-Based, Western, Colossal
Adversaries, Floating Magic School, Fairy Tale, Monster Hunting, Hex
Crawl as one each = 12). Record shape `{name, description}` markdown
via the legacy `formatSrdRecord` path (like conditions); needs a new
SRD_TYPES entry + config.js subtype, no schema.

**NOT yet run:** Gregg hasn't done Admin > Import from SRD > Update
entries in dev against the new data — do that + spot-check (a Brawler
character's Stances tab, a transformation entity, Dread domain cards)
before the next Release tag.

## Next session: finish SRD 2.0

1. **Supplemental content (p.184–205)** — `python3 scripts/srd-extract/cols.py 184 205 /tmp/SRD2.pdf`
   (page 184 begins with the tail of "Additional GM Guidance"; the
   Witherwild frame starts at the "CAMPAIGN FRAMES" heading). This is
   prose + cross-column tables (Faction Tracking, Feast ingredient
   generator, Tech scrap tables, Hex crawl) — write the markdown by
   hand per section, don't regex it. Budget a full session.
2. **Equipment (p.55–84)**: weapons, armor, items, consumables — check
   `templates.js` schemas (`Equipment/weapons`, `Equipment/armor`) for
   field names before parsing; these are table-heavy, expect to use
   `-bbox` coordinates rather than `-layout` text.
3. **Adversaries/Environments (p.93–183)** — dedicated session;
   `normalizeAdversaryRecord`/`normalizeEnvironmentRecord` in
   srd-import.js define the expected raw shape.
4. Update the status table in `docs/srd-update-process.md` each step.

PDF: `https://www.daggerheart.com/wp-content/uploads/2026/08/DH_SRD_2_2026_08_25.pdf`
→ `/tmp/SRD2.pdf` (scripts default to that path). Old upstream JSON for
shape/diff reference: `https://raw.githubusercontent.com/seansbox/daggerheart-srd/main/.build/03_json/{type}.json`
(has a UTF-8 BOM).

**Prior session's item still open:** manual QA pass on the
presence/GM-notification feature set (Aug 24) before the next Release.

## Prior session: Phase-14 features (Aug 24 2026)

Party presence (`presence.js` heartbeat, Admin > Manage Party Status
column) + GM notifications for player-initiated activity (character
edits, shares that expose new party members) — single commit `48d09bf`.
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

## Next session: continue SRD 2.0 extraction

Read `docs/srd-update-process.md` in full before starting — it has the
architecture, the page map, and the 4 open design decisions. Short
version: start with `domains`/`ancestries`/`communities` (small,
unblocked), surface the 4 flagged design decisions to Gregg before
extracting anything that depends on them, save the ~90pp
adversaries/environments section for last (or a dedicated session).
`DH_SRD_2_2026_08_25.pdf` isn't in project files as of this session —
fetch fresh from `https://www.daggerheart.com/wp-content/uploads/2026/08/DH_SRD_2_2026_08_25.pdf`
and extract locally with `pdftotext -layout` (don't rely on web_fetch
for a 224-page document — it truncates).

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
