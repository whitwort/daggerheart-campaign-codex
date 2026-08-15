// --- Campaign date/time notation -----------------------------------------
// Spec locked with Gregg in handoff-13 planning. Full explanation lives in
// the "Dates and Time" lore entry (Game Mechanics > Aether's Children) —
// this module is just the parser/sort-key half.
//
// Format: comma-separated tokens, largest unit first, each token
// "<int><unit>[a]" where unit is one of y/d/h/m (no seconds, no months
// in user-facing dates). Whitespace is allowed and ignored between the
// number, unit, and trailing "a" (e.g. "250 ya" and "250ya" parse
// identically) -- GMs naturally type it either way, and a silently
// unparseable date is worse than being lenient here. Epoch (offset 0)
// is 1y,1d,1h,1m — the sunset ending the Prologue's last day. Counting is 1-indexed ("1y" = within
// the first year), so a token WITHOUT the trailing "a" contributes
// (value - 1) units, added toward the present. A token WITH "a" ("ago")
// contributes its literal value, subtracted toward the past — no -1,
// per Gregg's explicit call: "1ya" means exactly one year before epoch,
// not "within the year before." This makes forward and backward tokens
// asymmetric by design, confirmed intentional.
//
// Internal-only sort ratios (never shown to players, exist purely so
// mixed-precision dates land in a sane relative order on the Timeline):
// 1y = 256d, 1d = 16h, 1h = 64m, 1m = 64s.
const UNIT_ORDER = ['y', 'd', 'h', 'm'];
const UNIT_SECONDS = {
  m: 64,
  h: 64 * 64,
  d: 64 * 64 * 16,
  y: 64 * 64 * 16 * 256
};

// Parses a date string into a signed integer offset (in the internal
// sort-key seconds above) relative to epoch. Returns { ok:true,
// offsetSeconds } or { ok:false, error } — error is a short, user-facing
// string suitable for an alert().
function parseDateSpec(raw) {
  const str = (raw || '').trim();
  if (!str) return { ok: false, error: 'Date is empty.' };

  const tokens = str.split(',').map(function (t) { return t.trim(); }).filter(Boolean);
  if (!tokens.length) return { ok: false, error: 'Date has no valid tokens.' };

  let lastUnitIndex = -1;
  let offsetSeconds = 0;
  let coarsestHasA = null;

  for (let i = 0; i < tokens.length; i++) {
    const m = tokens[i].match(/^(\d+)\s*(y|d|h|m)\s*(a)?$/i);
    if (!m) {
      return { ok: false, error: 'Bad token "' + tokens[i] + '" — expected e.g. "12d" or "45ya".' };
    }
    const value = parseInt(m[1], 10);
    const unit = m[2].toLowerCase();
    const hasA = !!m[3];
    if (value < 1) {
      return { ok: false, error: 'Token "' + tokens[i] + '" must be 1 or greater (1-indexed).' };
    }
    const unitIndex = UNIT_ORDER.indexOf(unit);
    if (unitIndex <= lastUnitIndex) {
      return { ok: false, error: 'Units must appear largest-to-smallest with no repeats (y, d, h, m).' };
    }
    lastUnitIndex = unitIndex;
    if (coarsestHasA === null) coarsestHasA = hasA;

    const magnitude = hasA ? value : (value - 1);
    const sign = hasA ? -1 : 1;
    offsetSeconds += sign * magnitude * UNIT_SECONDS[unit];
  }

  // Sign-consistency check: the coarsest token's a/no-a flag declares
  // whether this date is meant to read as before or at-or-after epoch;
  // reject if finer offsets actually flip it the other way (e.g.
  // "364da, 1y" reads as forward but nets negative) — confusing at a
  // glance, so we validate it away rather than allow it.
  const before = offsetSeconds < 0;
  if (coarsestHasA !== before) {
    return {
      ok: false,
      error: 'Date is inconsistent: the largest unit says ' +
        (coarsestHasA ? 'before' : 'at-or-after') + ' epoch, but the full date computes to ' +
        (before ? 'before' : 'at-or-after') + ' epoch. Adjust the finer units.'
    };
  }

  return { ok: true, offsetSeconds: offsetSeconds };
}

export { parseDateSpec };
