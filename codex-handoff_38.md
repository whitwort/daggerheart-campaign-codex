# Codex Handoff 38: Phase 15 Encounter Workflow — designed, implemented, iterated

**Session**: Second Phase 15 implementation session. Encounter workflow
design doc written + locked + amended twice, full implementation landed
and iterated on live iPad feedback. Also closed the backup coverage gap
completely.
**HEAD**: `f8f5d81` (12 commits this session). CI green throughout
(spot-polled at 0fd29a0, 06c17d1, 2c81be5, 075b563, d19850c).

---

## What happened this session

1. **Design doc** `phase-15-encounter-workflow-design.md` — scoped in
   chat, drafted, signed off, committed LOCKED (`ab9c3bc`). Core
   decisions E1–E8: GM-only Encounters tab; new `encounters` collection
   (GM-only rules, no player-write-matrix implications); per-instance
   model with live entity reads (no denormalization,
   `fallbackName` for deletions); calculator constants hardcoded;
   derived defeated state; stable never-renumbering instance labels;
   picker with an extended matcher. OI1–OI4 resolved at sign-off.
2. **Implementation** (5 commits `0fd29a0`..`184c57c`): tab shell +
   rules + listener + list pane; calculator + config row + difficulty
   panel (**offline-verified against 5 hand-computed cases** — standard
   scoring, minion ceil-grouping, solos+high-damage stacking, compound
   Horde types, deleted-entity fallback); instances section with
   track boxes; picker panel + environment block; `encounters` added to
   both backup COLLECTIONS lists.
3. **Backup gap closed fully** (`2c81be5`, Gregg: "include
   everything"): both tools now cover all 12 live collections
   (added notifications, sources, threads, transferRequests) plus
   explicit `threads/*/messages` subcollection handling (export nests;
   Admin script restores AND wipes them — flat gets/doc deletes never
   see subcollections). Client tool stays rules-constrained: restore
   skips joinRequests + transferRequests (creates locked to requesting
   user) and thread messages (create author-role-locked, delete
   `if false` — immutable-chat-log design); wipe can't clear messages
   (orphans re-attach if same-email thread recreated). All logged in
   the restore summary. **Full fidelity = the Admin-SDK script.**
   Legacy `entries`/`maps` rule blocks have no live writers, left
   uncovered.
4. **Amendment A1 — Build/Run tabs** (`075b563`): Gregg flagged that
   adversary features had no display surface (the design's one-view
   premise had silently dropped the generated Sheet's role). Detail
   pane split into Build (header/config/difficulty/group management +
   picker) and Run (full stat blocks incl. features, instance tracks,
   +/− kept for reinforcements, environment block last).
   `state.encountersDetailTab` persists across selections
   (charactersDetailTab precedent). **Future, recorded unscoped**:
   Run-tab start/end-of-combat actions triggering visibility changes on
   a connected scene entity (ties to the §7 AAR lore item idea).
5. **Run density pass** (`e14d9f2`): markdown Details bullet list
   replaced by a wrap-flow stat strip (schema-ordered label-value
   segments, composed ATK segment, dot separators); `### Details`
   section and `### Features` heading regex-stripped from the markdown
   before render. Entry Card / Build / env block untouched.
6. **Amendment A2 — condition selects** (`d19850c`): per-instance
   `note` replaced by `conditions: [string]` (0–3 names). One select
   per applied condition + one "+ condition" add select under the cap;
   reselect swaps, empty option clears, duplicates hidden per instance.
   Options from `Game Mechanics/conditions` entities, core-three
   fallback (Hidden/Restrained/Vulnerable); a stored name missing from
   live options still renders selected. Names stored, not ids.
7. **iPad screenshot feedback round** (`73df6b8`, `f8f5d81`): all
   condition selects fixed at 9.5rem, conditions block right-aligned
   (add select holds a constant rightmost slot, applied grow leftward);
   tracks stopped flexing (fixed 1.1rem boxes) and the HP column
   reserves the SRD-max 12 boxes so Stress starts at one x everywhere;
   list pane collapses on Run (guarded on a selection) and restores on
   Build.

## Data points established this session

- SRD adversary census (129): **max HP 12** (Adult Flickerfly, T3
  Solo), **max Stress 10** (Oracle of Doom). The 12-box HP reserve in
  `.encounter-instance-track-hp` is sized to this.
- Source data type strings are compound (`Horde (2/HP)`) — the
  calculator and picker filters match on the **first word**
  (`normalizeAdvType`). Encounter-builder never needed this because its
  mapper pre-truncated.
- Encounter-builder's threshold display had an Easy-boundary off-by-one
  (printed `≤ base−1`, compared strictly-less-than); our display
  matches the logic (`≤ base−2`).

## Key learnings (this session)

- **Python heredoc quoting bit twice**: a malformed `"""..\"\"\".."""`
  and a re-used long triple-quoted replacement both threw SyntaxError,
  which aborts the WHOLE script pre-execution — paired with a second
  script in the same bash call that DID run, this left CSS edited while
  JS wasn't. Keep multi-file edit scripts separate per file, or at
  least verify each script's own "ok" print before trusting state.
- GitHub Actions API responses can contain control characters —
  `json.loads(..., strict=False)` for CI polling.
- `resolveEntityStatBlockMarkdown(entity, ctx, tierFilter)` needs a
  real `viewerContext()` — its lore-item chain calls `canSee(item, ctx)`.
- The picker must read the encounter fresh from state at Add-click time
  — a closure over the render-time doc clobbers instances a previous
  Add just wrote (multi-add panel survives re-renders on document.body).

## Open items carried forward

- **Dev verification of the full Encounters feature by Gregg**:
  partially done live (Run view screenshot-verified, condition selects
  working). Not yet explicitly confirmed: Build-tab group management,
  picker filters + "resistant" search, minus-button undamaged-first
  policy, difficulty math vs. hand calc, environment block, deleted
  -entry degradation, updatedAt list ordering, the two layout commits
  (`73df6b8`, `f8f5d81`) on iPad.
- **Run-tab combat lifecycle** (unscoped, recorded in doc): start/end
  of combat → scene visibility changes; AAR-style lore item onto the
  concluded scene (§7).
- Standing deferred, unchanged: Firestore rules test matrix (§7 of its
  doc — NOTE: the new `encounters` block is GM-only two-liner,
  hand-verifiable, same reasoning as prior small rules additions),
  player self-release clause, player-facing JSON export, Phase 16
  (prod persistence rollout) go/no-go.
- Optional, flagged not requested: rules relaxation to let the CLIENT
  restore thread messages (GM create-any-author + delete) would weaken
  the immutable-chat-log decision — Gregg's call if in-app dev↔prod
  migration should carry chat history; the Admin script already does.

## Session ritual reminder

Fresh clone, verify HEAD `f8f5d81`, git identity, read
`QOL-BACKLOG.md` + `phase-15-encounter-workflow-design.md` (LOCKED,
amendments A1/A2 recorded in place) before any work. Import-check
script before every commit. CI poll ~72s after push;
`json.loads(strict=False)`.
