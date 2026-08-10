# QOL Backlog

Future quality-of-life improvements, not currently scheduled into a phase.
Carry this file forward in context-handoff docs.

- **Map image compression too aggressive (flagged Aug 2026, import
  pilot).** Text on map images renders blurry at the current pipeline
  settings (4000px max dimension, WebP q0.85, 750KB ceiling). For
  map-role images specifically, consider: higher max dimension and/or
  quality with the Firestore ~1MiB doc limit as the real ceiling, or
  revisiting tiling (see Phase 7d note below) for text-heavy maps.

- **Pin-safety on Location map image change — scheduled: Phase 9.** The
  old alert-on-dimension-change warning was dropped when map images moved
  to the entity form (entity-based maps rework, Aug 2026); currently a
  changed map image silently leaves existing pins (raw pixel coords in
  the old image's coordinate space) possibly misaligned. Phase 9: when a
  Location entity's map image is uploaded/replaced AND pins exist with
  `mapEntityId` pointing at that entity, either (first pass) warn the GM
  that pin locations may be wrong, or (better) show a guided UI to walk
  through checking/relocating each existing pin on that map.

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
