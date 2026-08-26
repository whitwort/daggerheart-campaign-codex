# SRD update process

How SRD content gets into the codex, and how to update it when Darrington
Press revises the SRD. Read this before touching anything under
`public/data/srd/` or `srd-import.js`'s `SRD_TYPES`.

## Why this exists (Phase 16, Aug 2026)

Through SRD 1.0, `srd-import.js` fetched pre-parsed JSON at runtime from
`seansbox/daggerheart-srd` (GitHub), which parsed the official PDF via its
own pipeline. When SRD 2.0 dropped (Aug 25 2026), that project showed no
activity and had months of unmerged PRs — no ETA. We pulled the upstream
repo's `.build/` pipeline apart to evaluate forking it (see
`daggerheart-srd-main.zip` if it's still around, or re-clone
`github.com/seansbox/daggerheart-srd`) and found:

- **Stage 1** (PDF → clean markdown) uses `marker-pdf` (Python, LLM-assisted
  via OpenAI) followed by **manual markdown cleanup by hand** — this is the
  real bottleneck, not something either forking or reimplementing in JS
  would avoid.
- **Stage 2** (markdown → CSV, `.build/02_csv/extract_from_md.go`) is
  structural — header-boundary + regex driven, no hardcoded class/domain
  name lists. Adding classes/domains to an existing category is nearly free
  *once the input markdown is clean*.
- **Stage 3** (CSV → JSON, `.build/03_json/extract_from_csv.go`) is fully
  generic column-name pattern matching, zero per-type logic.
- Some types were **never covered at all**, even in 1.0 — `conditions` has
  no extractor upstream ever wrote (encounters.js's hardcoded
  `CORE_CONDITIONS` fallback was the result).

Conclusion: stage 1 (the actual bottleneck) is something an LLM can do
directly against the PDF — no `marker-pdf`, no OpenAI key, no Python/Go
toolchain, no external repo dependency, no manual-cleanup pass separate
from the extraction itself. So: **extraction is now a one-time-per-revision
task done by Claude reading the PDF directly**, and the *output* — JSON
files in the same per-type shape upstream used — is committed straight into
this repo instead of fetched from GitHub at runtime.

## Architecture

- `public/data/srd/{key}.json` — one JSON array per `SRD_TYPES` entry in
  `srd-import.js` (e.g. `classes.json`, `domains.json`, `conditions.json`).
  Served as static files by Firebase Hosting (`public/` is the hosting
  root) — no build step, no new dependency.
- `srd-import.js`'s `fetchSrdType(repo, key)`: `repo === 'local'` (the
  default) reads `/data/srd/{key}.json`. Anything else is treated as a
  GitHub `owner/repo` and fetched the original way — kept only in case an
  upstream project is ever worth pointing at again. Admin > Import from SRD
  still has the repo field for this; it defaults to `local`.
- Record shape per type is unchanged from the upstream convention:
  snake_case field names, arrays-of-objects for repeated structures
  (features, domain cards, etc.). `srd-import.js`'s `buildTemplateData` /
  `formatSrdRecord` and `templates.js`'s `TEMPLATE_SCHEMAS` are what actually
  consume these records — **check the relevant schema entry (or confirm
  there isn't one, meaning the legacy free-form markdown path applies)
  before extracting a type**, so field names match what the app expects.
  `srd-import.js`'s own `normalizeAdversaryRecord`/`normalizeEnvironmentRecord`
  are worked examples of a raw-record-to-expected-shape pass.
- Import itself (`runSrdImport`, Admin-triggered) is unchanged — idempotent
  by `(category, subtype, slug)`, same as always.

## Doing a MAJOR revision (new PDF, structural changes — e.g. 1.0 → 2.0)

1. Download the PDF, extract text locally — don't rely on `web_fetch` for
   a 200+ page document, it truncates:
   ```
   curl -sL -o SRD.pdf "<url>"
   pdftotext -layout SRD.pdf SRD.txt
   ```
   `pdfinfo`/`pdftotext -f N -l N` for spot-checking specific page ranges.
2. Read the table of contents (page 1-2 of output) for the current page
   map — **don't assume it matches the last revision's page numbers.**
3. Per type: extract the section into the shape `templates.js`/
   `srd-import.js` expects (see Architecture above). Cross-check against
   any existing committed JSON for that type (if unchanged in shape) as a
   format reference.
4. Write `public/data/srd/{key}.json`. Validate: `node --check` won't catch
   JSON syntax errors — `python3 -c "import json; json.load(open('public/data/srd/X.json'))"`
   per file, or `node -e "JSON.parse(require('fs').readFileSync(...))"`.
5. Add any genuinely new `SRD_TYPES` entries to `srd-import.js` (with a
   comment explaining what's new and why). Add a `templates.js` schema
   entry ONLY if the type benefits from structured `details`/`features` —
   the legacy `formatSrdRecord` markdown-blob path is fine for simple types
   (see `conditions`, `domains`).
6. Gregg runs Admin > Import from SRD > Update entries in dev, spot-checks
   a few entities of each newly-added/changed type, then decides when to
   promote to prod (normal Release-tag flow, unrelated to this process).
7. Update this doc's "Current SRD version" section below.

## Doing a MINOR revision (errata, single new subclass, wording fix)

Do **not** re-run the full extraction. Identify just the changed
section(s) in the errata PDF (Darrington Press publishes these
separately — see `DaggerheartErrata5202025.pdf` in project knowledge for
precedent), hand-patch only the affected record(s) directly in the
relevant `public/data/srd/{key}.json`, then Gregg re-runs Admin > Import
from SRD > Update entries — idempotent, only touches matched entities.

## Current SRD version: 2.0 (Aug 25 2026) — extraction status

Source: `https://www.daggerheart.com/wp-content/uploads/2026/08/DH_SRD_2_2026_08_25.pdf`
(224 pages). TOC page map for reference (re-verify against the actual PDF —
this is 2.0's map, not guaranteed stable for future revisions):

| Section | Pages | `SRD_TYPES` key(s) | Status |
|---|---|---|---|
| Domains | 7 | `domains` | **done** (10 records; `card` per-level lists derived from abilities.json) |
| Classes | 8–31 | `classes` | not started |
| (Subclasses are embedded within Classes, not a separate page range) | 8–31 | `subclasses` | not started |
| Ancestries | 32–38 | `ancestries` | **done** (24 records: 1.0's 18 + Aetheris, Gnome, Earthkin/Emberkin/Skykin/Tidekin; "Elemental Kin" parent intro and "Mixed Ancestry" rules are NOT records) |
| Communities | 38–42 | `communities` | **done** (15 records; adjective sentence → `note`) |
| Transformations | 42–45 | `beastforms`? | **design decision needed** — see below |
| Conditions | 52 | `conditions` | **done** (`public/data/srd/conditions.json`, 3 records) |
| Weapons | 55–69 | `weapons` | not started |
| Combat Wheelchair | 70–71 | none yet | **design decision needed** |
| Armor | 72–74 | `armor` | not started |
| Loot & Items | 75–79 | `items` | not started |
| Consumables | 80–84 | `consumables` | not started |
| Adversaries and Environments | 93–183 | `adversaries`, `environments` | not started — largest section, ~90pp |
| Witherwild Campaign Frame | 184–189 | none | **design decision needed** — narrative/setting content, not a stat-block type |
| Supplemental Campaign Mechanics | 190–205 | none | **design decision needed** — GM-guidance variants (Feasts, Grimdark, Western, Hex Crawl, etc.), not naturally SRD_TYPES entities |
| Domain Card Reference (Appendix) | 206–224 | `abilities` | **done** (210 records = 10 domains × 21; confirmed this IS the card feature-text source; 1.0 card names all present, 3 text changes vs 1.0: Earthquake typo fix, Notorious lost its loadout-exemption sentence, Divination quote marks) |

**Open design decisions before continuing extraction (flag to Gregg, don't
guess):**
- **Transformations (42–45) vs. Beastforms**: is this a rename/restructure
  of the existing `Game Mechanics/beastforms` category, a superset, or a
  genuinely new adjacent mechanic? Read the section before assuming either.
- **Combat Wheelchair**: new equipment subtype under `Equipment`, or a
  special-cased weapon/armor variant? Small section (2pp), low risk either
  way, but pick one convention.
- **Witherwild Campaign Frame / Supplemental Campaign Mechanics**: this is
  GM advice and an optional setting, not stat blocks — forcing it into the
  entity/lore-item model may not fit. Options: skip entirely (stays
  reference-only in the source PDF, not imported), import as plain lore
  items under a new category, or something else. This needs Gregg's call,
  same as any other "design decisions require Gregg's input" case.

Extraction tooling lives in `scripts/srd-extract/` (column-split via
per-page gutter detection + regex parsers; see its README). TOC page
numbers were off by one at section ends (ancestries actually run to 38,
communities to 42) — always confirm boundaries in the text.

Next: `classes`/`subclasses` (8–31, largest remaining non-adversary
section), then equipment types, then Adversaries/Environments; the
flagged design-decision items need Gregg's call first.
