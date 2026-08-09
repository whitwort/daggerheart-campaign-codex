# QOL Backlog

Future quality-of-life improvements, not currently scheduled into a phase.
Carry this file forward in context-handoff docs.

- **Guided pin re-fixup on map image replace.** When a GM replaces a
  map's image with one of different dimensions, existing pins (stored as
  raw pixel coords in the old image's coordinate space) may end up
  misaligned. Currently (Phase 7b) this just pops an `alert()` warning
  after upload. Replace with actual UI: after a dimension-changing
  replace, walk the GM through each existing pin on that map (e.g.
  overlay old positions as a percentage-of-image reference, or drop them
  into a "needs review" list) so they can be relocated one by one instead
  of manually guessing / re-eyeballing every pin.

## Deferred phases

- **Phase 7d (map tiling)** — shelved as of the 7c-1 handoff. The real
  fix for the original load-time problem turned out to be the libwebp
  WASM encoder (7b-2 fix): once map images actually compress properly
  (matching the old ~175KB ImageMagick result instead of an unencoded
  multi-MB PNG fallback), tiling's complexity (image pyramid generation,
  `L.GridLayer` subclass, per-tile Firestore docs) isn't justified. Only
  revisit if a specific map still has real load-time/size problems after
  proper compression — i.e. if the need is proven in practice, not
  pre-built speculatively.
