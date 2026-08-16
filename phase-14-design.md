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
kind: 'imported' | 'gm-note' | 'note'      // 'note' is NEW (player+GM notes); 'player-note' enum value RETIRED (never used in data)
visibility: 'gm-only' | 'all-players' | 'character' | 'author-only'
             // 'character' NEW (lore items); 'author-only' reserved for kind=='note'
characterId, characterShared               // NEW, same semantics as entities
authorType: 'gm' | 'character'             // existing on-record model; rules updated to match (old 'player' path removed)
authorId: null | <character entity doc id>
```

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
| **S7** | Integration polish, copy fixes (Player ID/Name), QOL sweep, cross-feature testing as player+GM | **Sonnet** | |

Rough dependency graph: S1 -> S2 -> S3 -> {S4, S5} (parallel-safe) -> S6 -> S7.

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
