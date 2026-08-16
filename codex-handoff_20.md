# Codex Handoff 20

HEAD at end of session: the commit containing this doc (verify against `git log -1` on
fresh clone). Supersedes `codex-handoff_19.md`.

## Session summary

**Phase 14 planning session — design only, zero implementation.** Produced
`phase-14-design.md` (committed to repo root): the locked implementation
contract for all player/character-facing features. Every design decision
point was resolved with Gregg (D1–D9 + UI mechanics + GM-flipper layout);
see that doc's §2 for the full table. This handoff intentionally does NOT
duplicate the design — **read `phase-14-design.md` in full before any
Phase 14 work.**

Also this session: reconciled Gregg's direct commit `47800a0` (Lore-only
sub-tabs on Map/Timeline entity cards) — display-only, no schema impact.

## Standing decisions made this session

- **All prod concerns deferred to Phase 15** — dev Firebase project only for
  all of Phase 14, including the still-pending Phase 13 persistence rollout.
- The old character-select dropdown JS error is confirmed gone (side effect
  of an earlier fix); the nav dropdown gets rebuilt fresh in S3 regardless.
- Terminology in phase-14-design.md §1 supersedes prior usage everywhere
  (gm/player/character/party/lore element; "Player ID"/"Player Name" copy fix).

## Session breakdown + model plan (reminder for Gregg)

Dependency order: **S1 → S2 → S3 → {S4, S5} → S6 → S7.** Full scope table in
design doc §8; acceptance criteria §9.

| Next up | Scope (short) | Model to use |
|---|---|---|
| **S1** | Schema + full firestore.rules rewrite + visibility.js (canSee) + sharing.js write seam + migrate all read sites + rules test matrix | **Fable** — security surface + exhaustive call-site hunting |
| S2 | GM 3-state visibility UI (kebab, seafoam, badges) | Sonnet |
| S3 | Player authority + active-character switching + preview-as-(player,character) | Sonnet (escalate if cache/preview gets hairy) |
| S4 | Notes | Sonnet |
| S5 | Characters tab + transfer/Requests queue | Sonnet |
| S6 | Messages + notifications | Sonnet first; escalate to Fable if fan-out or subcollection listener plumbing bites |
| S7 | Integration polish + copy fixes | Sonnet |

**S1 must not be skipped or merged into S2** — it's a pure refactor with an
"app behavior unchanged" acceptance bar, and everything downstream leans on
its two seams (visibility.js reads, sharing.js writes).

## Remaining work (unchanged from handoff 19 unless noted)

- Phase 14 S1 is the next session.
- Prod persistence rollout: now formally Phase 15 (was "pending go/no-go").
- Timeline clustering/culling still keys off start point only; bulk/SRD
  import sourceId gaps; map-pin preview-card source label — all unchanged,
  non-blocking.

## Session ritual reminder

`rm -rf /home/claude/daggerheart-campaign-codex && git clone
https://<PAT>@github.com/whitwort/daggerheart-campaign-codex.git` → verify
HEAD matches this doc → set git identity → read `QOL-BACKLOG.md` **and
`phase-14-design.md`** before any work.
