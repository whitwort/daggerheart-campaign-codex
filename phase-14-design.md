# Phase 14 Design — Player/Character-Facing Features

Status: **DESIGN LOCKED** (all decision points resolved with Gregg). This doc is
the implementation contract for sessions S1–S7. It supersedes all earlier
Phase 14 notes in QOL-BACKLOG.md and handoff docs. Read this WHOLE doc before
any Phase 14 session; each session also re-reads its own section + §Schema +
§canSee + §Rules.

All work targets the **dev** Firebase project only. Prod rollout (including
the still-pending Phase 13 persistence rollout) is deferred wholesale to
Phase 15.

---

## 1. Definitions (canonical — supersede all prior usage)

- **gm** — the Game Master; one user, pre-determined by config (`CONFIG.gmEmail`).
  Can create/edit/delete anything.
- **player** — the actual person playing, authorized by login, whitelisted in
  `players/{email}`. UI copy fix: the Manage Party table's "Party ID" /
  "Party name" headings become **"Player ID"** / **"Player Name"**.
- **character** — any entity with category `Character`. NPCs are owned by the
  GM (`ownerId: null`); PCs are owned by players (`ownerId: <email>`). A
  player may own several characters (past, current, future).
- **party** — the set of characters CURRENTLY being played. Each player has
  exactly one **active character** at a time, chosen in the nav dropdown or
  Characters tab. Different characters "know" different things; the app
  tracks and reinforces this (see §canSee).
- **lore element** — anything with a visibility control: entities, lore
  items, gallery images, and (new) notes.

## 2. Locked decisions

| # | Decision |
|---|---|
| D1 | Deselecting the specific character in the "..." menu lands the element on `gm-only` (safe default; deselect never accidentally publishes). |
| D2 | `character`-visibility filters by the player's **active character only**, not all owned characters. Switching active character in the nav dropdown re-filters the UI live. Own-character *entities* remain always visible to their owner regardless. |
| D3 | The character badge appears **only** when visibility flows through a player's share (`characterShared` / cannon note) — never for GM-set states. Badge hover/tooltip text: *"What your character would share with the party in casual conversation."* |
| D4 | Players **can delete** characters they own (full gm-control over owned characters). |
| D5 | Unshared notes are private to their author **at the render layer in both directions**: GM cannot see players' `author-only` notes; players cannot see the GM's. (Rules still allow reads — trust-the-table model — this is a render contract, same class as gm-only lore.) |
| D6 | Notes visibility is **binary** (`author-only` / `all-players`). No 3-state on notes in Phase 14. |
| D7 | Subclass tier is tracked from day one: `cards.subclassTier`, default `'foundation'`, player-editable (level-up happens live at the table). `featureGroups[]` schema for subclasses lands in S1 so tier-scoped rendering works. |
| D8 | Character transfer requests get a dedicated `transferRequests` collection, but the GM UI consolidates them with join requests into **one high-visibility "Requests" queue**. |
| D9 | Unlock notifications are delivered as a **"Campaign" tab in the Messages tray** — one notification primitive, not a separate toast/bell. |
| UI | The "..." menu is a lightweight **anchored popover** (not a floating panel) with a **radio list + explicit "None" row** (radios natively model the 0–1 rule). |
| GM Characters view | Rapid character flipper = **left-rail quick-select list** (consistent with Entry Browser's list-on-left pattern; scales better than tabs on iPad). NOT squeezed into the existing Preview-as-player toggle. |

## 3. Schema deltas

### 3.1 entities
New/changed keys (add to `isValidEntity()` whitelist):

```
visibility: 'gm-only' | 'all-players' | 'character'   // 'character' is NEW
characterId: string|null      // NEW — the 0–1 selected character (visibility=='character')
characterShared: bool         // NEW — player's onward-share flag; only meaningful while visibility=='character'
badgeColor: string|null       // NEW — Character entities only; owner-picked badge color (CSS color string)
cards: {                      // NEW — Character entities only
  ancestryId: string|null,
  communityId: string|null,
  classId: string|null,
  subclassId: string|null,
  subclassTier: 'foundation'|'mastery'|'specialization',   // default 'foundation'
  abilityIds: string[]        // >= 2 for a "complete" character; UI nudges, rules don't enforce
}
```

`mapImageVisibleToPlayers` semantics extend: still means "the current map
image is visible to *the whole party*" (i.e. image `visibility=='all-players'`
OR (`=='character' && characterShared`)). A map image shared with one
character only does NOT set this flag — per-character map icon gating goes
through `canSee()` client-side (see §5 item map.js:1164 for the pixel-level
gate, which becomes canSee-based).

### 3.2 loreItems
```
kind: 'imported' | 'gm-note' | 'character-lore' | 'note'      // 'note' is NEW (player+GM notes); 'character-lore' added in S3 (not in original design -- see below); 'player-note' enum value RETIRED (never used in data)
visibility: 'gm-only' | 'all-players' | 'character' | 'author-only'
             // 'character' NEW (lore items); 'author-only' reserved for kind=='note'
characterId, characterShared               // NEW, same semantics as entities
authorType: 'gm' | 'character'             // existing on-record model; rules updated to match (old 'player' path removed)
authorId: null | <character entity doc id>
```

**S3 addition (post-lock, Gregg's call):** `kind:'character-lore'` -- the
same shape/visibility semantics as `gm-note` (regular 3-state-visibility
lore content, not a Note), but authored by a player under their own
owned Character rather than the GM. Split out as its own enum value
instead of reusing `gm-note` for both, since that name is actively
misleading once a player can author these too. Existing `gm-note` docs
are untouched/unmigrated and now unambiguously mean GM-authored.

Notes are loreItems with `kind:'note'`. "Make it cannon!" = flipping the
note's visibility to `all-players` — it then renders among lore items on the
Lore tab (pure render-time projection, no data movement, no duplication).

### 3.3 images
Same visibility triple as entities (`visibility`/`characterId`/`characterShared`).
**Images currently have NO shape-validation function in rules — S1 must add
`isValidImage()` before any player write path opens.** Existing keys per the
rules comment: `{ownerType, ownerId, role, data, contentType, width, height,
sizeBytes, uploadedAt}` plus later additions (`isMap`, `isPortrait`,
`visibility`, `order`, `sourceId`, portrait crop fields — S1 inventories the
real live shape from `images.js` before writing the whitelist).

### 3.4 players/{email}
```
activeCharacterId: string|null   // NEW — player-writable (ONLY this field), survives devices;
                                 // existing live player-doc listener in auth.js delivers it for free
```

### 3.5 New collections
```
transferRequests/{id}: { characterId, toEmail, requestedAt }
  // player creates for self (toEmail == own email); GM approves (sets entity
  // ownerId, deletes request) or rejects (deletes request). Mirrors joinRequests.

threads/{playerEmail}: { lastMessageAt, lastMessagePreview, gmLastReadAt, playerLastReadAt }
threads/{playerEmail}/messages/{msgId}: { authorRole: 'gm'|'player', text, createdAt }
  // one thread per player, GM<->player only. Unread = lastMessageAt > myLastReadAt.
  // FIRST subcollection in the app — listeners.js gets per-thread dynamic
  // listeners (pattern precedent: per-entity images listener).

notifications/{id}: { recipientEmail, kind: 'discovered'|'learned'|'shared',
                      entityId, loreItemId|null, actorCharacterId|null,
                      createdAt, seenAt|null }
```

### 3.6 templates.js
Subclass template gains `featureGroups: [{key:'foundation',label:'Foundation'},
{key:'mastery',label:'Mastery'},{key:'specialization',label:'Specialization'}]`
and subclass `features[]` entries carry `group`. SRD import maps tiers into
groups. `buildFeaturesMarkdown` already supports `featureGroups` — verify SRD
subclass data actually populates `group` (S1 audit item).

## 4. canSee() — the single effective-visibility function

S1 creates `public/js/visibility.js` exporting `canSee(element, ctx)` and
`viewerContext()`. **Every** visibility read check in the app routes through
it — no surface-local `visibility === 'all-players'` comparisons survive S1
(the map-leak bug class came from exactly one missed surface-local check).

```
ctx = viewerContext() = {
  role: 'gm'|'player'|'viewer',
  gmView: bool,                  // role=='gm' && !previewing
  email: string|null,
  activeCharacterId: string|null,   // player: from players/{email} doc;
                                    // GM preview: the preview target's active character
  ownedCharacterIds: string[]       // derived from state.allEntities ownerId==email
}
```

Truth table (element = any lore element; `V` = element.visibility):

| V | condition | GM (gmView) | Player |
|---|---|---|---|
| all-players | — | see | see |
| gm-only | element belongs to a character entity in ctx.ownedCharacterIds (the entity itself, or a loreItem/image whose parent entity is that character) | see | **see** (full authority over own PCs) |
| gm-only | otherwise | see | hidden |
| character | characterId == ctx.activeCharacterId | see | see |
| character | characterShared == true | see | see (+ **badge**) |
| character | otherwise | see | hidden |
| author-only (notes) | author character's ownerId == ctx.email, OR (authorType=='gm' && role=='gm' && gmView) | see own only (D5) | see own only |

Notes render-privacy (D5): GM in gmView does **not** render players'
`author-only` notes and vice versa — canSee returns false for both, unlike
every other gm-only-ish case. This is the one row where gmView ≠ see-everything.

Badge rule (D3): badge renders iff the *reason* the viewer can see the
element is `characterShared` (or a cannon note, kind=='note' &&
visibility=='all-players' && authorType=='character') — implement as a second
export `visibilityBadge(element, ctx) -> {characterId}|null` so render sites
don't re-derive it.

Live re-filter (D2): switching active character updates
`players/{email}.activeCharacterId`; the existing player-doc onSnapshot in
auth.js fires; handler updates ctx source-of-truth and calls the same
re-render fan (`renderList()`, `renderDetailForSelected()`, map/timeline
re-render via the existing `registerVisibilityChangeHandler` hook).

## 5. Call-site inventories (verified against HEAD 47800a0)

### 5.1 Visibility READ checks to migrate to canSee()/visibilityBadge()
Every one of these must be touched in S1; grep-verify none remain after:
`grep -n "=== 'all-players'\|!== 'all-players'" public/js/*.js` should return
only write-site value literals and CSS-class ternaries that S1 has converted.

- codex.js:244 (`galleryImagesFor` image filter)
- codex.js:548–553 (`loreItemVisibleToPlayer` — absorbed into canSee)
- codex.js:558 (`loreItemsForEntity` filter)
- codex.js:630 (`isEntityPlayerVisible` — absorbed; keep exported shim delegating to canSee, map.js/timeline.js import it)
- codex.js:641 (`entityMapIconVisible`)
- codex.js:743, 3291, 3352 (Entry Browser / related-chips / picker filters)
- codex.js:826, 981 (hidden-badge / GM hidden styling — these become 3-state-aware *displays*, not binary)
- codex.js:1717, 1727, 1845, 1887, 1911, 1919 (lore item + edit-state toggle rendering — become 3-state control, §6)
- codex.js:2586, 2637 (gallery item toggle rendering — 3-state control)
- codex.js:2862, 2901, 3127 (vis-visible/vis-hidden CSS classes — gain a third class `vis-character`)
- map.js:269, 278, 810 (pin/breadcrumb/navigation gating)
- map.js:1164 (**the pixel-level map image gate** — the Phase 13 security fix; becomes canSee-based so character-shared maps work; treat with the same care as the original fix)
- timeline.js:112, 351 (explainer link + row filter)
- images.js:174 (`mapImageVisibleToPlayers` sync — recompute per §3.1 semantics)

### 5.2 Visibility WRITE sites to centralize into sharing.js
S1 creates `public/js/sharing.js`: **every** mutation of
`visibility`/`characterId`/`characterShared` on any element goes through it.
This is the single seam S6's notification fan-out hooks into — a write site
that bypasses sharing.js is a silent missing notification (Risk R4).

- codex.js:996 (entity toggle)
- codex.js:1634/1646 (entity edit save)
- codex.js:1926 (lore item toggle)
- codex.js:1955/2012 + save path (lore edit)
- images.js:172/178 (`setGalleryImageVisibility`)
- New sites Phase 14 itself adds: "..." menu selection, player characterShared
  toggle, note cannon toggle.
- Import paths (import.js:479/503/526, srd-import.js:359/389/408/444) and
  create-time defaults (codex.js:1512, images.js:131/264) write literal
  defaults, never *share* — they may stay direct writes but must be listed in
  sharing.js's header comment as known-exempt so the inventory stays auditable.

### 5.3 Existing helpers repurposed
- `loreItemVisibleToPlayer` (codex.js:548) — its author-resolution logic
  (authorId -> character entity -> ownerId) moves into visibility.js.
- `state.gmPreviewAsPlayer` — becomes `state.gmPreview = null | {playerEmail,
  activeCharacterId}` (preview needs a character identity now). The
  role-namespaced map image cache key (`-gm`/`-player`) gains the character
  dimension **or** player-preview simply bypasses the cache (simpler, GM-only
  cost — recommended).

## 6. Feature specs

### 6.1 Three-state visibility control (GM, all lore elements)
- Existing toggle stays; a thin vertical **"..." kebab** sits immediately right
  of every toggle. Click -> anchored popover: radio list of current-party PCs
  (players' characters where `ownerId != null`; ordering: player name then
  character name) + a "None" radio.
- State machine:
  - `characterId == null`: toggle flips `gm-only` <-> `all-players`; labels
    "Hidden from party" / "Visible to party"; existing colors.
  - `characterId != null`: toggle flips `character` <-> `all-players`; labels
    **"Specific player"** / "Visible to party"; `character` state uses the new
    seafoam/green theme. `gm-only` unreachable until "None" selected.
  - Selecting a character while in `gm-only` or `all-players` -> state becomes
    `character`. Selecting "None" -> `gm-only` (D1) and clears
    `characterShared`.
- New CSS custom properties for the seafoam family (locations-green adjacent),
  reading as "between Visible/Hidden, warm/cold, hope/fear". Third CSS state
  class `vis-character` alongside `vis-visible`/`vis-hidden`.
- All flips route through sharing.js.

### 6.2 Player authority
- **Owned characters**: full control — edit entity, full lore/gallery CRUD
  under it, delete character (D4). UI: the same GM edit affordances render for
  players on owned-character entries (Edit/Delete entity, +New lore, gallery
  upload, Set portrait/map). `ownerId` and `category` are NOT player-editable
  (omit from player edit form; rules enforce).
- **Elements shared with their active character** (`visibility=='character'`,
  `characterId==active`): player gets Edit (content / replace image / sourceId)
  but NOT Delete, and gets a visibility toggle "Visible to party"/"Hidden from
  party" (same styling as GM's) that writes **`characterShared` only** — never
  `visibility`. If the GM moves the element off `character` state, the
  player's toggle disappears on the next snapshot (no action needed; render
  is state-derived).
- Rationale on record: `characterShared` as a separate flag prevents the
  one-way-door where a player flip would exit the GM's chosen state.

### 6.3 Notes
- Notes tab (existing shell) lists the viewer's own notes for the selected
  entity (canSee author-only row) plus — for context — nothing else; cannon
  notes live on the Lore tab.
- "+ New Note" button: `.action-btn-compact` (closes the QOL-BACKLOG item).
- Toggle labels: **"Just for me"** (author-only) / **"Make it cannon!"**
  (all-players). Same toggle styling.
- Author = active character for players (`authorType:'character'`,
  `authorId:activeCharacterId`); GM notes are `authorType:'gm'`.
- Cannon notes on the Lore tab carry the character badge (right of / in place
  of source label) in the character's `badgeColor`. Owner keeps full CRUD
  after canonization.

### 6.4 Characters tab
- **GM view**: left-rail quick-select of all PCs (grouped by player). Selecting
  one shows that character's player-perspective card view (renders with a
  synthesized ctx: that player's email + that character active). Also here:
  assignment management (assign/unassign `ownerId`), absorbing the Admin
  party-table's character column. Heading copy per §1 ("Player ID"/"Player
  Name").
- **Player view**: own-character list; set-active control (intentionally
  redundant with nav dropdown — both write `players/{email}.activeCharacterId`);
  "+ New character"; "Request transfer" on unowned PCs (creates
  transferRequests doc); card-slot editor on the selected character:
  - Slots: ancestry (1), community (1), class (1), subclass (1) + tier
    selector (D7), abilities (>=2, picker grouped by Domain).
  - Pickers filter `state.allEntities` by category/subtype (all
    SRD-populated). Rendered card = linked entity's existing template display,
    tier-scoped for subclass via `featureGroups`; click-through to Codex entry.
- Nav dropdown (existing placeholder `#nav-character-switcher`) becomes
  functional: lists owned characters, writes `activeCharacterId`. The old
  character-select JS error is gone; rebuild fresh regardless.

### 6.5 Requests queue (GM)
One surface consolidating joinRequests + transferRequests (D8). High-visibility
badge/count in the GM UI (location: Admin tab header or nav — S5 decides
with a mockup). Approve on transfer = set character `ownerId`, delete request.

### 6.6 Messages
- Docked bottom tab strip, collapsed by default; expands on click or on
  incoming message. Tabs: GM sees one per player (+ Campaign); player sees
  "GM" + "Campaign". Unread highlight (hope-color accent) via
  `lastMessageAt > myLastReadAt`.
- Sending: appends to `threads/{email}/messages`, updates thread doc's
  `lastMessageAt`/`lastMessagePreview`. Opening a tab writes own read
  timestamp.
- Layout risk: must coexist with full-height Map/Timeline wells on iPad —
  mockup before styles.css work (established mockup-then-implement pattern).
- Party chat / Discord integration: explicitly OUT OF SCOPE for Phase 14.

### 6.7 Unlock notifications (Campaign tab)
- **Write-at-share-time** inside sharing.js (never diff-detection): any
  transition that newly exposes an element to a recipient writes notification
  docs in the same action.
  - GM -> `all-players`: fan out to all whitelisted players.
  - GM -> `character`: one doc, recipient = character's `ownerId`.
  - Player `characterShared` on / note canonized: fan out to other players,
    `kind:'shared'`, `actorCharacterId` set.
- kind mapping: entity newly visible -> `discovered` ("You have discovered
  X."); new element under an already-visible entity -> `learned` ("You have
  learned more about Y." where Y = parent entity name). X/Y are wiki-links
  (render-time, existing `applyWikiLinks`).
- Batching/throttling is presentational only: Campaign tab groups unseen
  notifications per entity into a digest; dedupe unseen (entityId, recipient)
  pairs so GM toggle-flapping doesn't spam. Recipient may update only own
  `seenAt`. GM gets an Admin cleanup action for old docs.

## 7. Security rules rewrite (S1)

The existing player-note write path (`isOwnPlayerNoteWrite`,
`authorType:'player'`, `authorId==uid`) contradicts the character-authorship
model and has never been exercised by any UI. **Remove it wholesale.**

Core helper (costs 1 get() per player write — fine at table scale, well
under the 10-call limit):

```
function ownsCharacter(charId) {
  let c = get(/databases/$(database)/documents/entities/$(charId)).data;
  return c.category == 'Character' && c.ownerId == request.auth.token.email;
}
```

Player write paths (GM keeps blanket write on everything, shape-validated):

| Collection | Player may | Enforcement sketch |
|---|---|---|
| entities | create Character | `data.category=='Character' && data.ownerId==token.email` + isValidEntity |
| entities | update owned Character | `ownsCharacter(entityId)` + `request.resource.data.diff(resource.data).affectedKeys()` excludes `ownerId`,`category` |
| entities | delete owned Character | `ownsCharacter(entityId)` (D4) |
| entities | update shared-with-active-char elements' `characterShared` | `resource.data.visibility=='character' && ownsCharacter(resource.data.characterId)` + affectedKeys ⊆ {characterShared, updatedAt} |
| loreItems | full CRUD under owned Character | `ownsCharacter(data.entityId)` + isValidLoreItem |
| loreItems | update shared items (content/sourceId/characterShared) | `resource.data.visibility=='character' && ownsCharacter(resource.data.characterId)` + affectedKeys ⊆ {content, sourceId, characterShared, updatedAt}; **no delete** |
| loreItems | full CRUD own notes | `data.kind=='note' && data.authorType=='character' && ownsCharacter(data.authorId)`; visibility in ['author-only','all-players'] |
| images | CRUD under owned Character; replace shared images | new `isValidImage()` REQUIRED first; mirrors loreItems patterns |
| players/{email} | update own doc | affectedKeys().hasOnly(['activeCharacterId']) |
| transferRequests | create own (`toEmail==token.email`), read/delete own | mirrors joinRequests |
| threads/{email} + messages | own thread only; messages `authorRole:'player'`; thread update affectedKeys ⊆ {playerLastReadAt, lastMessageAt, lastMessagePreview} | GM: all threads |
| notifications | read own (`recipientEmail==token.email`); update own, affectedKeys ⊆ {seenAt} | creates come from GM client OR sharing players — create rule: `isGM() || isPlayer()` with shape validation (trust-the-table) |

isValidEntity/isValidLoreItem whitelists gain the §3 keys. Manual rules test
matrix (S1 deliverable): for each row above, one allowed + one denied case
exercised against the dev project from both a GM and a player session.

## 8. Session plan + model recommendations

Each session: standard ritual (fresh clone, verify HEAD vs latest handoff,
git identity, read QOL-BACKLOG.md **and this doc**), verification gate before
every commit, handoff doc at end.

| Session | Scope | Model | Why |
|---|---|---|---|
| **S1** | Schema deltas + full rules rewrite + `visibility.js` (canSee/viewerContext/visibilityBadge) + `sharing.js` write seam + migrate ALL §5.1 read sites + subclass `featureGroups` + rules test matrix | **Fable** | Security surface + exhaustive call-site hunting; the map-leak bug class lives here. Deep analysis, not chunking. |
| **S2** | GM 3-state UI: kebab popover, state machine, seafoam CSS vars, `vis-character` class, badge rendering primitive | **Sonnet** | UI against locked schema + existing canSee. Chunk-able. |
| **S3** | Player authority: owned-character edit affordances, shared-element edit + characterShared toggle, activeCharacterId + nav dropdown, live re-filter on switch, preview-as-(player,character) | **Sonnet** | Wiring against S1 primitives. Escalate to Fable only if preview/cache interactions get hairy. |
| **S4** | Notes: kind:'note', Notes tab build-out, +New Note, cannon flow, Lore-tab projection + badge | **Sonnet** | Mirrors existing lore-item patterns. |
| **S5** | Characters tab (GM flipper + assignment; player list/create/cards/tier), transferRequests + unified Requests queue | **Sonnet** | Largest UI session but pattern-following; card pickers reuse template rendering. |
| **S6** | Messages tray + threads/notifications collections + fan-out hooks in sharing.js + Campaign tab digest | **Sonnet first**; escalate to **Fable** if fan-out edge cases or the first-subcollection listener plumbing bite | If S1's sharing.js seam is clean, this is chunk-able; the risk was pre-paid in S1. |
| **S7** | New feature injection (§11): mixed/meta ancestry, ad hoc character cards, lore-item expand/collapse+pop-out, Narrative Backstory meta tag, PC-tagged claiming, class-scoped subclass/ability filtering, badge-color propagation | **Sonnet** — design pre-scoped in §11; most items need no schema/rules work (verified against live SRD data before scoping) | |
| **S8** | Integration polish, copy fixes (Player ID/Name — already landed in S5), QOL sweep, cross-feature testing as player+GM | **Sonnet** | |

Rough dependency graph: S1 -> S2 -> S3 -> {S4, S5} (parallel-safe) -> S6 -> S7 -> S8.

## 9. Acceptance criteria (per session, testable on dev)

- **S1**: grep per §5.1 shows zero surviving surface-local visibility
  comparisons; rules test matrix all-green; app behavior UNCHANGED for
  existing binary data (pure refactor — no UI change lands in S1); gate
  passes; `firestore.rules` brace/paren balance checked.
- **S2**: GM can put any lore element in all three states; deselect lands
  gm-only; player sees character-shared elements only as their active
  character; seafoam state visually distinct on iPad.
- **S3**: player can fully manage an owned character incl. delete; can edit
  but not delete a shared element; characterShared toggle round-trips and
  GM state change revokes it live; switching active character re-filters
  list/detail/map/timeline without reload.
- **S4**: note lifecycle create->edit->cannon->uncannon->delete as player and
  GM; GM cannot see player's private note in any render surface (incl.
  preview cards, search); badge shows on cannon notes.
- **S5**: GM can flip through PC views rapidly; assignment changes land live
  in the player's session; player builds a full card set incl. subclass tier;
  transfer request round-trip; Requests queue shows both request types.
- **S6**: message round-trip both directions with unread highlight + auto-pop;
  every §5.2 share transition produces exactly the expected notification docs
  (test matrix: GM->party, GM->character, player-share, cannon note); digest
  dedupes toggle-flapping; iPad layout coexists with Map/Timeline.
- **S7**: full two-browser (GM + player) walkthrough of every feature above.

## 10. Risk register

- **R1 Rules rewrite** — first real player write paths. Mitigation: S1 test
  matrix, immutable-field checks via affectedKeys, isValidImage before any
  image write path.
- **R2 Missed visibility read site** — recurrence of the map-leak class.
  Mitigation: §5.1 exhaustive inventory + post-migration grep gate + S1
  acceptance criterion.
- **R3 Messages tray vs. full-height wells (iPad)** — mockup-first.
- **R4 Notification fan-out misses** — all shares through sharing.js;
  known-exempt writes documented in its header; S6 test matrix.
- **R5 Preview-as-(player,character) cache staleness** — player-preview
  bypasses the map image cache (accepted GM-only cost).

## 11. S7 — New feature injection (design, post-S6)

Scoped mid-Phase-14 (after S6, before the original integration-polish S7,
which becomes S8). Seven items; verified against live SRD JSON before
finalizing so scope reflects what actually needs to change vs. what
already works.

### 11.1 Mixed ancestry (1 or 2 ancestries per character)

**`templates.js`**: `'Ancestry/'` schema gains
`featureGroups: [{key:'first',label:'First'},{key:'second',label:'Second'}]`
(mirrors the subclass tier pattern). The generic Features editor
(`codex.js`, already built for subclass tiers off `schema.featureGroups`)
picks this up automatically — homebrew ancestries get a First/Second
editor with zero new UI code.

**`srd-import.js`**: SRD ancestry records carry a flat `feature[]` of
exactly 2 items (verified all 18 current SRD ancestries), not per-tier
keyed arrays like subclasses use. `buildTemplateData` needs a new branch:
when `schema.featureGroups` is set AND the source uses a flat array (not
per-key arrays), map by position — `feature[0]` -> `group:'first'`,
`feature[1]` -> `group:'second'`. Running "Update entries" (existing
idempotent reimport) then backfills `group` on every ancestry with no
manual edit or separate migration script. Guard: if a source record's
`feature` array isn't length 2, leave `group` unset on the overflow/
missing rather than throwing (defensive, shouldn't occur in practice).

**`entities.cards` (Character docs)**:
- `ancestryIds: string[]` (1 or 2) — replaces `ancestryId`. Read-compat
  everywhere `cards.ancestryId` is read: normalize via
  `cards.ancestryIds || (cards.ancestryId ? [cards.ancestryId] : [])`.
- `ancestryFeaturePicks: { [ancestryId]: 'first'|'second' }` — populated
  only when 2 ancestries are selected (after meta-resolution, see 11.2).

**Rules**: none. `cards` stays an opaque whitelisted key on `entities`
(no structural validation inside it) — same as every other `cards`
sub-field.

**UI (`characters.js`)**: Ancestry picker becomes a 1-2 slot add/remove
list (same UX as the existing Abilities picker). When 2 are selected,
each gets a First/Second radio; picks must differ (UI-enforced, not
rules-enforced — consistent with Phase 14's write-integrity model).
`buildCardSlot`/`slotStatMarkdown` already take a generic group filter
param (`opts.tier` for subclass) — reuse it for the ancestry pick instead
of adding a new param name.

### 11.2 Meta ancestries

**Schema**: Ancestry entities gain optional
`metaAncestryTargetIds: string[]` (0, 1, or 2). Empty/absent = normal
ancestry. When set: display name/lore stay this entity's own; mechanical
features/details resolve through the target ancestries instead of this
entity's own `features`/`details`.

**Resolution**: at card-render/feature-computation time, each entry in
`cards.ancestryIds[]` is expanded — non-meta ancestry -> itself; meta
ancestry -> its `metaAncestryTargetIds`. **Chaining disallowed** (a meta
ancestry's targets must themselves be non-meta) — enforced by excluding
already-meta ancestries from the "Functional ancestry" picker's options.
This also means "meta can be mixed": a single meta pick whose target list
has 2 entries (e.g. "Goat" -> [Faun, Merfolk]) automatically produces the
2-ancestry First/Second-pick flow keyed on the *target* ids, without the
player having picked "mixed" explicitly.

**Rules**: add `metaAncestryTargetIds` to `isValidEntity()`'s
`keys().hasOnly([...])` whitelist. One line.

**UI**: Ancestry entity's edit form (`codex.js`) gains a 0-2-slot
"Functional ancestry" picker, category-filtered to `Ancestry` and
excluding any ancestry that itself has `metaAncestryTargetIds` set.
Character card's ancestry slot still displays the flavor entity's name;
feature text is pulled from the resolved target(s).

### 11.3 Ad hoc character cards

No new schema, no new rules — this is the existing `visibility:'character'`
mechanism applied to `Game Mechanics/abilities` entities. Workflow: GM
creates a normal ability entity, sets `visibility:'character'` +
`characterId` via the existing kebab control; it surfaces in that PC's
ability picker (Characters tab) automatically once `canSee` passes,
exactly like any other character-scoped element.

**New convenience UI**: "+ New card for this character" button in the
Characters tab detail pane (GM's flipper and the player's own-character
view), pre-filling category `Game Mechanics`, subtype `abilities`,
`visibility:'character'`, and `characterId` to the current PC — skips the
GM having to leave the tab and use the general Codex "+ New entity" flow
+ kebab manually. Scoped to abilities only (not a general any-category
card system) — confirmed no "max abilities" cap exists to work around, so
no exemption/counting logic needed either.

### 11.4 Lore item expand/collapse + pop-out edit

Pure UI, no schema/rules changes.
- **Collapse**: `.lore-item-body` gets a height cap; when rendered content
  `scrollHeight` exceeds a threshold, apply a fade mask + "Show more" /
  "Show less" toggle.
- **Pop-out**: new "Expand" affordance opens a draggable floating panel
  (reusing the existing `gallery-picker-panel` pattern — same touchstone
  cited elsewhere in this doc) showing the full item, with the existing
  edit box rendered inside the panel instead of inline when the viewer has
  edit authority.

### 11.5 New meta tag: "Narrative Backstory"

Add `'meta-narrative-backstory'` to the meta enum: `metaBadgeLabel`,
`normalizeMetaForEdit`, the edit dropdown options list (`codex.js`), and
`isValidLoreItem()`'s meta enum in `firestore.rules`. Plain badge, same
treatment as generic `'meta'` — no auto-synthesis behavior (that's
specific to `meta-details`/`meta-features`, unchanged).

**Rules**: one enum-value addition.

### 11.6 Claiming filtered to `PC`-tagged characters

`characters.js`'s "available characters" list (unowned, GM-shared
Character entities eligible for transfer-request claiming) adds a tag
filter: `.filter(e => (e.tags||[]).some(t => t.toLowerCase() === 'pc'))`.
Case-insensitive match on the existing free-text `tags` array — no
schema/rules change, just a tagging convention going forward (GM tags
claimable PCs with "PC").

### 11.7 Class-scoped subclass/ability filtering

**No schema/rules changes** — verified `class.details.subclass_1`/
`subclass_2` and `ability.details.domain` are already plain strings that
exact-match Subclass/Domain entity names (e.g. Bard's `subclass_1` ==
`"Troubadour"`, matching the Subclass entity named "Troubadour").

**UI (`characters.js`, `buildCardSlotEditor`)**: once `cards.classId` is
set —
- Subclass picker filters to
  `subclasses.filter(s => s.name === cls.details.subclass_1 || s.name === cls.details.subclass_2)`.
- Abilities picker filters to
  `abilities.filter(a => [cls.details.domain_1, cls.details.domain_2].includes(a.details.domain))`.
  Character-scoped ad hoc cards (11.3) bypass this filter always (already
  gated by ownership, not meant to compete with domain access).

Before a class is chosen: both pickers show empty (Gregg's call — "don't
populate until class is chosen"), rather than unfiltered. Refining the
picker UI further (e.g. visual grouping) is deferred to a later UI-focused
pass, not this session.

### 11.8 Badge color propagation

**Share popup (`visibility-ui.js`)**: `partyCharacterOptions()` already
builds the party-PC list for the kebab popover — add `badgeColor` to each
returned option and render a small dot before the name in
`buildOptionRow`, same CSS-var pattern `buildCharacterBadge` already uses
elsewhere. UI-only.

**Messages tray tab underline**: threads are keyed by player email, not
character (a player can own multiple PCs) — color a player's tab using
their **active character's** `badgeColor` (fallback to the current
default when unset or no active character). Confirmed as the right
tradeoff despite the tab color shifting if the player switches active
character mid-session. UI-only.

### Net schema/rules delta for S7

- New entity fields: `metaAncestryTargetIds` (Ancestry only),
  `cards.ancestryIds`, `cards.ancestryFeaturePicks` (Character `cards`
  sub-object, unvalidated).
- Rules changes: 2 one-line additions —
  `isValidEntity()` key whitelist gains `metaAncestryTargetIds`;
  `isValidLoreItem()`'s meta enum gains `'meta-narrative-backstory'`.
- Everything else (11.3, 11.4, 11.6, 11.7, 11.8) is UI/filter logic
  against fields that already exist — no schema or rules touched.

## 12. S17 — Character sheet (design)

Scope locked with Gregg: **passive tracking form** (option 2) **+ inline
per-field suggestion indicator** (option 3, cheap route — no live
recompute, no effects engine). Fields and grouping cross-checked against
the official
Daggerheart character sheet PDF (Darrington Press, May 2025 printing) — the
front-page field set is identical across all 9 class sheets + the generic
blank sheet, confirming one schema covers every class. Layout/art is
Darrington Press's own IP; only the field set and grouping informed this
design, not their visual template.

Out of scope for S17 (explicitly deferred, not forgotten):
- Live/dynamic recompute of derived stats (option 4) — no structured
  modifier data exists on subclass/ancestry/community features or most
  items to drive it (see prior message's viability writeup).
- Tier-up progression text, background questions, description prompts —
  static rules reference / one-time chargen flavor, not per-character
  tracked state. Not modeled here.
- Druid Beastform / Ranger Companion supplemental tracking — subclass-
  specific bolt-on mechanics with their own state; future session.
- Parsing the PDF's "Suggested Traits" prose per class into structured
  data — currently unstructured leftover markdown on the Class entity
  (`detailsLeftoverMd`, per §3.6/templates.js), would need its own SRD
  schema addition. Not needed for S17's suggested-defaults scope, which
  only touches HP/Evasion/Armor Score/Thresholds (see 12.2).

### 12.1 New schema: `cards.sheet`

Character `cards`-only, unvalidated blob (same pattern as `equipment`/
`conditions`/`experiences` — no `firestore.rules` change needed).

```
cards.sheet: {
  traits: {
    agility:  { value: number, marked: bool },
    strength: { value: number, marked: bool },
    finesse:  { value: number, marked: bool },
    instinct: { value: number, marked: bool },
    presence: { value: number, marked: bool },
    knowledge:{ value: number, marked: bool }
  },
  evasion: number,
  armorScore: number,
  proficiency: number,
  hp:      { max: number, marked: number },
  stress:  { max: number, marked: number },
  hope:    { max: number, marked: number },
  thresholds: { major: number, severe: number },
  gold: { handfuls: number, bags: number, chest: number }
}
```

All fields default to `0`/`false`/empty on first read (no migration —
absent `cards.sheet` renders as a blank sheet, same "tolerant of missing
keys" convention `cards.equipment`/`cards.experiences` already use).
`traits.*.marked` mirrors the PDF's tier-up mechanic ("gain +1 to two
unmarked traits and mark them" / "clear all marks") — display-only
checkbox, no rules enforcement of the 2-per-tier-up limit (same
"UI nudges, don't enforce" philosophy as `cards.abilityIds`' 2-ability
minimum, §3.1).

### 12.2 Equipment slot model (extends existing `cards.equipment`)

PDF distinguishes Primary weapon / Secondary weapon / 2 generic inventory
weapon slots / 1 active armor slot, vs. today's flat undifferentiated
`cards.equipment` list (§ handoff 30 — `{id, entityId|null, label, qty}`,
no slot concept). Add one field to each item, no new array:

```
cards.equipment[i].slot: 'primary' | 'secondary' | 'armor' | null
```

`null` = unassigned / general inventory (covers the PDF's 2 generic
weapon slots and any non-weapon item — potions, tools, etc., unchanged
from today). UI enforces at most one item with `slot:'primary'`, one
`'secondary'`, one `'armor'` (same non-enforced-by-rules convention as
12.1's trait-marking cap) — picking a new item for an occupied slot
prompts to swap, doesn't silently duplicate.

### 12.3 Suggested-value indicator (inline, per-field — not a global button)

Per Gregg's direction: no bulk "Reset to suggested" action. Instead, every
field with a computable suggestion gets a small **(i) icon** beside its
input, in one of two states:

- **Match** — the field's current value equals the live-computed
  suggestion right now. Calm/settled treatment (e.g. muted, low-contrast
  dot/icon — exact color TBD at implementation, app's existing amber/
  parchment accent palette is the likely fit).
- **Updated** — the live-computed suggestion has changed since this field
  was last set (by hand or by clicking the icon), and the field's current
  value no longer matches it. "Calm but noticeable" per Gregg — a
  distinct accent color, not an alert/error treatment.

If the field's current value differs from the live suggestion **but the
suggestion hasn't changed since the value was last set**, no icon shows
at all — this is a deliberate player override, not staleness, and
shouldn't nag. This is a 3-way render outcome from 2 stored booleans-
worth of state (below), not a 3rd persisted state.

**Storage** — one snapshot object recording what the suggestion *was* at
the time each suggestible field was last written (whether via manual
edit or via clicking the icon to apply it):

```
cards.sheet.suggestedSnapshot: {
  hpMax: number|null, evasion: number|null, armorScore: number|null,
  thresholdMajor: number|null, thresholdSevere: number|null
}
```

Render logic per field, comparing `liveSuggestion` (computed fresh every
render, same sources as below) against `field.value` and
`suggestedSnapshot[key]`:
- `field.value === liveSuggestion` → **Match**.
- `field.value !== liveSuggestion && liveSuggestion !== suggestedSnapshot[key]` → **Updated**.
- otherwise (value diverges, but suggestion hasn't moved since) → no icon.

A brand-new character (no `cards.sheet` yet, `suggestedSnapshot[key]`
`undefined`) naturally renders **Updated** wherever a suggestion exists —
correct behavior, surfaces "there's a suggestion here" on first view
without a special-cased empty state.

**Click behavior**: clicking the icon applies `liveSuggestion` to that
one field only (writes both the field and `suggestedSnapshot[key]` in
the same `patchCards` call) and flips it to Match. No field is ever
overwritten without the player/GM clicking its own icon.

**Live-suggestion sources** (same as before, unchanged — data already
structured today, §3.6/templates.js, no new SRD schema needed):
- `hpMax` ← linked Class entity's `details.hp`
- `evasion` ← linked Class entity's `details.evasion`
- `armorScore` ← the `equipment` item with `slot:'armor'`'s linked Armor
  entity's `details.base_score` (no suggestion — icon omitted — if no
  armor equipped)
- `thresholdMajor`/`thresholdSevere` ← that same Armor entity's
  `details.base_thresholds` **plus the character's current level** (PDF:
  "Add your current level to your damage thresholds"), recomputed live
  on every render (cheap — no write until clicked).

Traits, hope, gold, stress have no structured source (per
12's "out of scope" list) — no icon on those fields, pure manual same as
today's Conditions/Experience tabs. Proficiency was added as a 6th
suggestible field in a post-S17 addendum: campaign tier at the
character's current level (T1=1, T2=2, T3=3, T4=4), derived from
cards.level (see the Level addendum below), not from SRD data.

### 12.4 UI placement — Cards / Sheet tabs

Per Gregg's direction: the character detail panel (both
`#characters-detail-pane` GM view and `#characters-player-selected`
player view) becomes a **two-tab layout**, mirroring the in-fiction
"look at your cards" vs. "look at your sheet" context switch at the
table:
- **Cards** tab — exactly today's `character-deck.js` render, unchanged
  (Heritage+Conditions, Class, Abilities, Equipment). Default/first tab.
- **Sheet** tab — new content from this section: traits row (6 small
  toggleable cards) → HP/Stress/Hope/Thresholds/Evasion/Armor
  Score/Proficiency block, each suggestible field carrying its (i) icon
  → Gold counter.

Tab strip follows the existing flat tab-button convention (QOL-BACKLOG
exception 2 — no border/background/box-shadow, same as Entry Card tabs/
Admin DB tabs); new selector added to that exception list rather than a
new one-off pattern. Weapon/Armor slot ASSIGNMENT moved to the Sheet
tab post-launch (see §12.5) — the Cards tab's Equipment section stays
read-only display of what's carried, same as Conditions/Experience.

### Net schema/rules delta for S17

- New field: `cards.sheet` (Character `cards` sub-object, unvalidated —
  no `firestore.rules` change).
- Changed field: `cards.equipment[i]` gains optional `slot` key
  (unvalidated, no rules change).
- No SRD import/schema changes required — 12.3's suggested-defaults
  button reads fields already present since S15 (`class.details.hp`/
  `evasion`) and the armor schema pilot (`armor.details.base_score`/
  `base_thresholds`).

### 12.5 Post-launch addendum (live-tested with Gregg, same session)

Several gaps and UX issues surfaced once S17 was live-tested that
weren't caught in the original design pass. Captured here rather than
retroactively rewriting 12.1–12.4 above, since those sections still
correctly describe what shipped at the time.

- **`cards.level` (new field, Character `cards`, unvalidated, 1-10,
  default 1)**: §12.3's threshold suggestion needs "base thresholds +
  current level" but no level field existed anywhere. Added to
  `DEFAULT_CARDS` (character-cards.js) alongside a `tierForCharacterLevel`
  mapping (T1=level 1, T2=levels 2-4, T3=levels 5-7, T4=levels 8-10) and
  `CHARACTER_LEVEL_OPTIONS` (1-10 dropdown). Editable from both the
  Codex build-time entity editor (draft-based) and the Characters tab
  detail pane (direct write) — the latter positioned below the badge/
  name/View-Edit-in-Codex row, right-aligned, above the Cards/Sheet tab
  strip.
- **Add Ability / Add Item filtering**: candidates are hidden if their
  `details.level` (abilities) or `details.tier` (items, via
  `tierForCharacterLevel`) exceeds the character's current level/tier.
  Candidates with no level/tier of their own stay unfiltered.
- **Proficiency suggestion (6th suggestible field)**: `proficiency =
  tierForCharacterLevel(cards.level)` — not SRD-sourced like the other
  five, but same suggestion-icon mechanics apply.
- **Equipment slot assignment moved from Cards to Sheet tab**: the
  per-item `<select>` on Equipment mini-cards (12.2 as originally
  shipped) didn't have room on those cards and wasn't legible in
  practice. Replaced with an "Equipped" panel on the Sheet tab, to the
  right of the stats row — one row per slot (Primary/Secondary/Armor)
  rather than per item. `cards.equipment[i].slot` data model unchanged.
- **Suggestion icon UX rework**: first hover (desktop) or tap (touch)
  opens a small popup showing the suggested value and its source,
  without writing anything; a second click/tap with the popup already
  open applies it. Popup anchors to the icon's own small position:
  relative wrapper (bottom-right corner), not the enclosing field box —
  same convention as `.vis-kebab-btn`/`.vis-kebab-popover` elsewhere.
  Both Match and Updated render as filled circular badges now (not a
  transparent/bordered-only Match state) — the original low-contrast
  Match styling against the dark field background was likely reading as
  the icon "disappearing."
- **Trait mark control reworked**: the original whole-card click-to-
  mark (still §12.1's design) read as an unexplained clickable box with
  no visible affordance. Replaced with one small explicit checkbox-
  style button in the card header, with a tooltip spelling out the
  tier-up mechanic. The rest of the card carries no click handler.
- **HP/Stress/Hope: three-state box UI**, replacing the Max/Marked
  number-input pair `cards.sheet.hp/stress/hope` still use as their
  storage shape (unchanged: `{max, marked}`). Boxes render per fixed
  ceiling constants — HP 12, Stress 12, Hope 6 (game-rule constants,
  NOT stored) — as solid-empty (available/unmarked), solid-filled
  (available/marked), or dotted-empty (not-yet-unlocked, beyond the
  track's own `max`/Active count). Hope never renders the dotted state
  (its Active is always its own ceiling in practice). `max` (renamed
  "Active" in the UI) stays a small number input above the boxes;
  clicking a box fills-through-to-that-box, clicking the last marked
  box again unmarks it. Starting defaults changed accordingly: HP
  0 active/0 marked (class-defined via suggestion), Stress 6 active/0
  marked, Hope 6 active/2 marked — previously all three defaulted to
  0/0.
