# QOL Backlog

Future quality-of-life improvements, not currently scheduled into a phase.
Carry this file forward in context-handoff docs.

## Phase 10 (map improvements) — in progress

- **10a. Map image compression too aggressive — DONE** (`b14a299`).
  Quality-search encode ([95,92,88,85,80,75], keep first fit under
  750KB) replaced fixed q85. Applies to map + gallery uploads (shared
  `processImageFile`). Confirmed sharper text on a real trade-map test
  image (q85→379KB vs q95→700KB, same source).
- **10a-bonus. Map legend scoped to categories present — DONE**
  (`b414066`, empty-state fix `ff14f18`). Legend rebuilds every
  `renderPins()` from the same filtered (gm/player-visibility) pin set,
  hides entirely when nothing to show.
- **10b. Pin-safety on Location map image change — still open.** Old
  alert-on-dimension-change warning was dropped when map images moved to
  the entity form. Changed map image can silently leave existing pins
  (raw pixel coords in the old image's coordinate space) misaligned.
  First pass: warn GM pin locations may be wrong. Better: guided
  re-check/relocate UI. Not started.
- **10c. Map tiling — explored, shelved.** Rabbit-hole scope worked out:
  client-side pyramid generation, new `tiles` sub-schema (50-150+ docs
  per map upload, writeBatch chunking + orphan-on-interrupt risk),
  `L.GridLayer` subclass with tile fetch/cache, and it collides with the
  still-open 10b pin-coordinate-space question. Multi-session feature,
  not a session extension of 10a. Quality-search (10a) already fixed the
  test case that prompted this; remaining fuzziness on some maps at
  zoom is accepted as a known limitation for now. Revisit only if a
  specific map still has a real legibility problem 10a can't reach —
  proven in practice, not pre-built speculatively.
- **10d. Map icon inconsistency — reported, unresolved, blocked on
  repro.** Gregg reported the map-open icon doesn't always show for
  Locations that do have a map. Code condition
  (`entity.category==='Location' && entity.hasMapImage`) verified
  identical/correct in both Entry Browser and Codex page. Likely a
  stale `false` `hasMapImage` flag on a specific pre-existing entity;
  re-upload/re-save should force it true. Need a specific entity name
  from Gregg to confirm/fix.

## Dev ergonomics

- **Dev-only test Player login (2FA friction fix).** Root cause:
  private-browsing windows don't persist session cookies, so the
  `sonora.kirintor` test account re-triggers 2FA on every refresh.
  Fix in progress: separate non-private browser app (Firefox/Edge/etc.)
  for the second Google account — separate cookie jar, no code change.
  If that doesn't hold: Option B is an Email/Password provider enabled
  **only** on `daggerheart-campaign-codex-dev` Auth (console toggle +
  one whitelisted test user), with the sign-in button gated in code on
  `projectId === 'daggerheart-campaign-codex-dev'` so it can't surface
  on prod. Not started — holding on Option A's result.

## Phase 11 (visual styling) — polish follow-ups

- **Codex TOC entry-row layout stability — good enough, not perfect.**
  Fixed the hidden-badge-toggle vertical "jump" via a fixed
  `min-height` on `.entity-group-list li` (see Phase 11 commits). This
  is a reasonable approximation but not a fully-principled fix — worth
  a closer look later if other row-content combinations (map-link icon
  + hidden badge together, longer names wrapping, etc.) turn out to
  still shift layout on state changes.

## Future phases (scoped, not started)

- **Phase 11 — Visual styling.** Move from structural/functional CSS to
  an intentional visual design system (color, type, spacing) that
  communicates information (categories, roles, states) as well as
  aesthetic. Gregg has no design background; session will include
  establishing a Claude-assisted design workflow (prompting patterns,
  reference/moodboard artifacts, model choice) alongside the actual
  CSS work.
- **Phase 12 — SRD data import.** Ingest Daggerheart SRD content into
  the codex, reusing critical-path parsing/structuring work already
  done in the separate `daggerheart-encounter-builder` repo rather than
  starting from scratch.
- **Phase 13 — Offline / degraded connectivity.** Missed opportunities
  for offline experience and handling intermittent connectivity at the
  table. Prod database backup/snapshot/export strategy folds in here.
- **Phase 14 — Player-facing contribution features.** Character
  management, in-app GM messaging at the table, codex-unlock
  notifications, and other ways players contribute directly rather than
  read-only.

