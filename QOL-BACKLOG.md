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
