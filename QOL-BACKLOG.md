# QOL Backlog

Future quality-of-life improvements, not currently scheduled into a phase.
Carry this file forward in context-handoff docs.

(none currently unscheduled — see Phase 10 below for the map-improvements
batch)

## Deferred phases

- **Phase 10 (map improvements)** — scheduled next session. Bundles:
  - **Map image compression too aggressive (flagged Aug 2026, import
    pilot).** Text on map images renders blurry at the current pipeline
    settings (4000px max dimension, WebP q0.85, 750KB ceiling). For
    map-role images specifically, consider: higher max dimension and/or
    quality with the Firestore ~1MiB doc limit as the real ceiling, or
    revisiting tiling (below) for text-heavy maps.
  - **Pin-safety on Location map image change.** The old
    alert-on-dimension-change warning was dropped when map images moved
    to the entity form (entity-based maps rework, Aug 2026); currently a
    changed map image silently leaves existing pins (raw pixel coords in
    the old image's coordinate space) possibly misaligned. When a
    Location entity's map image is uploaded/replaced AND pins exist with
    `mapEntityId` pointing at that entity, either (first pass) warn the
    GM that pin locations may be wrong, or (better) show a guided UI to
    walk through checking/relocating each existing pin on that map.
  - **Map icon inconsistency (reported, unresolved).** Gregg reported the
    map-open icon doesn't always show for Locations that do have a map.
    Code condition (`entity.category==='Location' && entity.hasMapImage`)
    is identical and verified correct in both the Entry Browser and Codex
    page. Most likely cause: a specific entity's `hasMapImage` flag is
    stale `false` in Firestore from before the flag was reliably
    maintained — re-uploading (or re-saving) that entity's map image
    should force it to `true`. Need a specific entity name from Gregg to
    confirm/fix; if it recurs on entities created after the flag became
    reliable, that's a different, real bug worth investigating instead.
  - **Map tiling (Phase 7d, folded in as a sub-item)** — shelved as of
    the 7c-1 handoff. The real fix for the original load-time problem
    turned out to be the libwebp WASM encoder (7b-2 fix): once map images
    actually compress properly (matching the old ~175KB ImageMagick
    result instead of an unencoded multi-MB PNG fallback), tiling's
    complexity (image pyramid generation, `L.GridLayer` subclass,
    per-tile Firestore docs) isn't justified. Only revisit if a specific
    map still has real load-time/size problems after proper compression
    — i.e. if the need is proven in practice, not pre-built
    speculatively.
