# Lore import JSON standard and workflow

Verified against `public/config.js` and `public/js/import.js`. If they
disagree with this doc, the code wins — update this doc.

## Shape
Always `{ "entities": [ {...}, ... ] }`. Bare arrays fail.

### Required per entity
- `name` (string)
- `category` — exact match to `CONFIG.categories` in `public/config.js`
  (check the file; don't trust memory). Currently: Character, Faction,
  Location, World Facts, Organization, Event, Scene, Ancestry,
  Community, Game Mechanics, Equipment, Adversary, Environment.
- `parentSlug` — key always present; string slug or explicit `null`.

### Optional
- `lore` — array of strings (one per paragraph), never a bare string.
  Must be pasteable in-world declarative text, not meta-commentary.
- `relatedSlugs[]`, `tags[]`, `aliases[]`
- `ancestry` (Character), `date` (Scene/Event),
  `subtype` (Game Mechanics/Equipment; see `CONFIG.subtypesByCategory`)
- `details{}`, `features[{name, text, type?}]` — only for
  template categories (Adversary/Environment). For other categories
  omit `features` entirely; don't send `[]`.

### Not accepted
- `source` — not read by the importer. Attribution is `sourceId`, set
  after import via Admin UI (entity Source + each lore item's sourceId).
  Note in delivery that a manual source pass is needed.

## Slugs
`slugify(name) = name.toLowerCase().trim().replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'')`
- Leading "The" is kept: "The Talisande River" → `the-talisande-river`.
- Accents do not fold: "Féileacán Darach" → `f-ileac-n-darach`.
  Compute by the regex or grep the live data; never hand-guess.
- `parentSlug`/`relatedSlugs` must resolve to an entity that exists
  (live DB or earlier in the same batch). Concepts mentioned only in
  prose have no slug — don't reference them.

## Cross-referencing batches
New entities that reference each other → two files:
1. step1: pure creates, same-batch forward refs stripped.
2. step2: updates adding the now-resolvable cross-refs.

## Lore-pass workflow
- Work one entity at a time from `all-lore.json` (supplied by Gregg).
- Search first: `json.dumps(x).lower()` for cross-field keyword search;
  exact lookup via `next(x for x in ents if x['name']=='Name')`. Check
  `parentSlug`/`relatedSlugs` across entities sharing a keyword to find
  missing load-bearing entities.
- New scenes: gather context → draft in chat for approval → iterate →
  JSON only once the shape is locked.
- Every Location entity gets a Midjourney prompt by default, framed as
  geology/geography/atmosphere, not a footprint or schematic.

## Before delivering import JSON
1. Categories checked against `public/config.js`.
2. Every entity has a `parentSlug` key.
3. Slugs for accented/punctuated names computed, not guessed.
4. No `relatedSlugs` to non-entities; no `source` key.
5. Validate JSON syntax (no trailing commas, escaped quotes).

## Common errors
| Error | Cause |
|---|---|
| `Expected an object with an "entities" array` | missing wrapper / bare array |
| `parentSlug must be a string or null` | key omitted |
| `bad category "X"` | invented category (e.g. History, Item) |
| `unresolvable parentSlug/relatedSlug` | guessed slug or non-entity ref |
