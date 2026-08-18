# Codex Handoff 35: S17 wrap-up — icon/layout follow-ups, phase renumbering

**Session**: Continuation of S17 (Character Sheet). All work this session was
follow-up refinement on the Sheet tab already shipped in prior S17 commits —
no new features, several bug fixes, one UX rework, and end-of-session
planning/renumbering. Multiple small commits, all CI-green.
**HEAD**: `7435dd9` (includes Gregg's own direct commit `f670580`,
footnote wording tweak, merged clean).

---

## What changed this session (chronological)

- Popup positioning for the (i) suggestion icons: anchored to the icon's
  own small wrapper (bottom-right corner), not the enclosing field box —
  matches `.vis-kebab-btn`/`.vis-kebab-popover`'s convention elsewhere.
- Suggestion icon "disappearing" bug: Match state had near-zero contrast
  against the dark field background. Both Match/Updated now render as
  filled circular badges.
- Trait tier-up mark tracking **removed entirely** (was a whole-card click,
  then a small mark button) — Gregg's call: which traits to bump at
  tier-up is a player decision at the table, out of scope for this app
  to track. `cards.sheet.traits[key].marked` stays in the stored schema,
  unread, for characters that already have marks set.
- HP/Stress/Hope rebuilt from scratch as true three-state boxes (no number
  input at all) per Gregg's exact spec: single click/tap toggles
  Unlocked↔Checked, double click/tap toggles Locked↔Unlocked (Hope never
  has a Locked state). Double-tap detected manually (click + timeout
  window), not the native `dblclick` event — unreliable on iOS Safari.
- Fixed a real bug: Hope boxes were permanently un-clickable for any
  character whose `cards.sheet.hope.max` was already saved as `0` from
  before this session's default change (Hope had no way to raise `max`
  back up). Fix: Active is now hardcoded to the ceiling whenever
  `allowLocked` is false (Hope only) — never read from stored data.
- Suggestion icon is now **never hidden** — the old "deliberate override,
  don't nag" case that omitted the icon entirely was removed per Gregg;
  always one of unavailable/match/updated.
- Suggestion icon also **never hidden when not-yet-calculable** (no
  Class/Armor selected) — new `unavailable` (dashed, muted) 4th state,
  popup explains what's missing instead of a value.
- Proficiency suggestion added (6th suggestible field): `tierForCharacterLevel(cards.level)`.
- Suggested damage roll caption under Proficiency, split into separate
  Primary/Secondary lines (`weaponDamageRoll`, Primary always shown,
  Secondary only when equipped).
- Explicit 4-row Sheet tab layout locked in: (1) traits, (2) HP/Stress/Hope,
  (3) Evasion/Armor Score/Major+Severe Threshold, (4) Equipped/Proficiency/
  Gold sharing one row — Proficiency is the one allowed to shrink
  (`.character-sheet-proficiency-field`, floor 70px); Equipped and Gold
  hold their natural content width and never shrink below it.
- Gold UI redesigned: one panel, three rows of checked/unchecked icon
  "boxes" (Handfuls×9, Bags×9, Chest×1) replacing the old three number
  fields. Icons are **from game-icons.net, not Lucide** — Lucide has no
  coin-sack/treasure-chest equivalent. Gregg's picks: Receive Money
  (Delapouite) for Handfuls, Swap Bag + Locked Chest (Lorc) for Bags/
  Chest. CC BY 3.0 — first attribution-requiring asset in this codebase;
  credit line lives in `index.html`'s footer (`#icon-credits`), not just
  in source comments. Exact SVG source pulled from `game-icons/icons` on
  GitHub, not approximated.
  - Follow-up fix: icons must be their own clickable element, not nested
    inside a `.character-sheet-track-box` (wrong proportions, pushed the
    row too wide). `.character-sheet-gold-icon-box` is now fully
    standalone.
  - **Real bug caught late**: that new class never overrode the app's
    global `button { width: 12rem; min-width: 12rem; }` rule (missing
    `min-width: 0`) — every icon button was silently 12rem wide
    regardless of content. This was the actual cause of both "huge gaps
    between icons" AND "Gold can't share row 4" — a pure CSS oversight,
    now fixed. Worth remembering: **any new custom button-styled element
    in this app needs an explicit `width`/`min-width` override check
    against QOL-BACKLOG's standing button-width rule**, or it silently
    inherits 12rem. This bit us here even with the exception list
    otherwise being followed correctly.
- Filtered Primary/Secondary weapon dropdowns by `details.primary_or_secondary`
  (SRD: every weapon is one or the other, never both).
- Messages panel: drag-to-resize (left edge = width, top edge = height,
  mirror of a normal handle since the panel is anchored bottom-right).
  Also fixed the reported "too narrow for GM view with many players" —
  initial width now auto-sizes to the tab strip's real content width.
- Fixed a real bug in `connectivity.js`: the "Saving…" badge could get
  stuck visible after overlapping writes (each `flashPendingWrite` call
  independently snapshotted/restored pill state, racing when writes
  overlapped within the ~1.2s window). Now driven by the existing
  `pendingWriteCount` as single source of truth, one shared hide-timer.
- Number-input spinner arrows hidden app-wide (Firefox always showed
  them, Chrome reserved blank space for them) — global `input[type=number]`
  rule, not Sheet-tab-scoped.

## Standing decisions this session

- **Multi-image gallery upload edge case — CLOSED, marked passed by
  Gregg.** Do not re-list this in future handoffs. It had been carried
  as an open test item since handoff 27/28 without ever being explicitly
  re-confirmed, resurfacing in every status recap since — that was the
  bug, not the feature. Gregg has tested it multiple times.
- **Phase renumbering.** Prod persistence rollout (previously "Phase 15"
  throughout the handoff chain, referenced in `phase-14-design.md` line
  11) is now **Phase 16**. **Phase 15** is reassigned: explore
  integration options with `daggerheart-encounter-builder` (Gregg said
  "campaign-builder" — confirm the exact sibling repo name/scope at the
  start of that session, since this project already has a documented
  sibling-repo precedent under that name from the Phase 12b SRD-import
  work; don't assume it's a different project without checking). No
  design work done yet — this is purely a renumbering + placeholder for
  a future exploration session, scope TBD.
- Still explicitly deferred, untouched, no change in status:
  - Player self-release rules clause (`ownerId → null`) — not yet
    live-tested, flagged since handoff 28.
  - Player-facing JSON subset export — deferred since handoff 32.
    Ambiguous whether still wanted; confirm with Gregg next time it
    comes up rather than continuing to carry it silently.
  - Phase 16 (prod persistence rollout, renumbered from 15) — still
    pending Gregg's explicit go/no-go.

## Session ritual reminder

Fresh clone, verify HEAD `7435dd9`, git identity, read `QOL-BACKLOG.md`
(note the phase renumbering at the top of "Future phases") +
`phase-14-design.md` §12 + §12.5 addendum before starting any further
Sheet-tab work. No specific next-session plan handed down this session —
Gregg said no more minor fixes; next steps are his call (more Sheet tab
polish, live-testing the two still-open deferred items, or kicking off
the new Phase 15 exploration).
