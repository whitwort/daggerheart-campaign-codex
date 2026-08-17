// badge-color.js — Phase 14 S8. Deterministic "no color picked yet"
// badge color, generated from the character's name so two characters
// without a badgeColor set still read as visually distinct in a list,
// instead of every unset badge rendering the same flat grey. Hue is
// hashed from the name; saturation/lightness are fixed within the same
// band the curated BADGE_COLORS palette (characters.js) already sits in
// (S~0.10-0.49, L~0.38-0.53, measured off the existing 12 swatches) --
// picked S 0.26 / L 0.48 as a representative midpoint, so a generated
// color still "belongs" to the app's palette rather than looking
// arbitrary. Zero imports/dependencies on purpose -- this needs to be
// callable from characters.js, visibility-ui.js, and messages.js
// without adding any new cross-module edges to the existing import
// graph (characters.js/messages.js already sit in a real cycle with
// codex.js/admin.js -- see characters.js's own header comment).

function hashString(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = (h * 31 + str.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

function hslToHex(h, s, l) {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs((h / 60) % 2 - 1));
  const m = l - c / 2;
  let r, g, b;
  if (h < 60) { r = c; g = x; b = 0; }
  else if (h < 120) { r = x; g = c; b = 0; }
  else if (h < 180) { r = 0; g = c; b = x; }
  else if (h < 240) { r = 0; g = x; b = c; }
  else if (h < 300) { r = x; g = 0; b = c; }
  else { r = c; g = 0; b = x; }
  function toHex(v) {
    const n = Math.max(0, Math.min(255, Math.round((v + m) * 255)));
    return n.toString(16).padStart(2, '0');
  }
  return '#' + toHex(r) + toHex(g) + toHex(b);
}

// name: falls back to hue 0 (still deterministic) if empty/missing,
// rather than throwing -- a character mid-rename with a blank draft
// name is a real transient state, not worth guarding against upstream.
function generateDefaultBadgeColor(name) {
  const hue = hashString(name || '') % 360;
  return hslToHex(hue, 0.26, 0.48);
}

export { generateDefaultBadgeColor };
