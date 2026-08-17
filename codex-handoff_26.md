# Codex handoff 26 — Phase 14 S6 complete (Messages tray + notification fan-out)

**HEAD after this session: `4db4947`** ("Phase 14 S6: Messages tray, notification fan-out, Campaign digest"). CI green, deployed to dev. Verify HEAD matches on clone before doing anything.

## What landed (S6, per phase-14-design.md §6.6/§6.7/D9)

- **`public/js/messages.js` (new, ~680 lines)** — the Messages tray:
  - Docked **bottom-right** (mockup approved this session, both proposals): collapsed strip is only as wide as its tab chips (Map/Timeline wells stay unobscured on iPad); expanded panel floats `min(24rem, vw-1.5rem) × min(24rem, 60vh)` over content, never reflows wells (R3). z-index 600 (above map well 20, below pin panel 900 / lightbox 2000).
  - Listeners, role-aware (attached from `auth.js` `attachDataListeners`; `state.currentRole` is set before it runs): GM = full `threads` + full `notifications` collections; player = own `threads/{email}` doc + `notifications where recipientEmail==self`. These are exactly the rules-allowed shapes — anything broader would permission-deny and kill the listener.
  - Open thread's `messages` subcollection = ONE manual-lifecycle listener keyed by `state.openThreadKey` (pattern: `entityImagesUnsub`). **The app's first subcollection listener.**
  - No `orderBy` anywhere: messages and notifications sort client-side (own just-sent message has a null pending serverTimestamp → sorts newest; avoids a composite index for the player notifications query).
  - Unread = `lastMessageAt` > own read stamp (`gmLastReadAt`/`playerLastReadAt`); sending stamps the sender's own read field in the same batch. Auto-expand on unread transition while collapsed, **including unread existing at sign-in** (prevUnreadTotal starts 0).
  - Campaign tab (D9): player digest grouped per entity (presentational dedupe of GM toggle-flapping), entity names render-time `canSee`-gated (re-hidden entity → group hidden entirely), click-through via `switchToCodexTabForEntity`. Opening marks unseen seen (batch `seenAt`) but `campaignNewIds` keeps them styled new until the tab is left. GM Campaign = read-only fan-out view (kind counts + recipient counts per entity; GM can't flip `seenAt` per rules → no GM unread state).
  - Composer drafts + focus survive wholesale snapshot re-renders (the Phase 13 draft-loss class).
- **`sharing.js` rewritten** — §6.7 fan-out, write-at-share-time in the SAME batch as the share:
  - `exposedEmailSet()` mirrors canSee's truth table set-wise; newly-exposed = after − before − actor.
  - GM actor → `discovered` (entity) / `learned` (child, gated per-recipient on `canSee(parentEntity)`); player actor → `shared` + `actorCharacterId` (note authorId > characterId > owned parent PC > active char).
  - **New `createLoreItemShared(fields)`**: lore/note edit boxes can set visibility before first save, so creation is a share transition — codex.js's two `isNew` addDoc paths now route through it (`addDoc` import dropped from codex.js).
  - Bulk imports (import.js / srd-import.js) and ownership changes stay exempt — documented in sharing.js's header. Fan-out is try/catch-wrapped: a fan-out bug can never block the share write itself.
- **Admin > Notifications card** (new `#admin-section-notifications` in index.html) — doc counts + "Delete old notifications" (>30 days, chunked 400/batch). Rendered **from messages.js**, not admin.js: an admin.js→messages.js import would close a NEW cycle (codex→admin→messages→codex) since messages.js imports codex.js.
- state.js +9 keys; auth.js attach/detach wiring; main.js `registerVisibilityChangeHandler(renderMessagesTray)`; styles.css +80 lines; QOL-BACKLOG button-width **exception 13** (tray tabs, collapse chevron, Send).
- **firestore.rules: zero changes** — threads/messages/notifications rules all landed in S1; every S6 write path was hand-verified against them (thread setDoc-merge affectedKeys, message authorRole match, notification create shape, seenAt-only recipient update).

## Verification run

ESLint clean; `node --check` all files; CSS braces 529/529; rules untouched (63/63, 254/254); design-doc grep-gate clean. **New this session: a named-import cross-check script** (every `import {x} from './y.js'` verified against the target's actual exports) — this is the S5 deploy-break class (`humanizeKey`), invisible to eslint/node --check. Worth adding to the standing gate; it's ~25 lines of Python, reproduce from handoff or the S6 transcript.

## Known limitations (deliberate, flag before "fixing")

1. **Characterless players miss player-initiated `shared` notifications** — a player client can't read the players whitelist, so player-actor fan-out derives recipients from distinct Character owners. GM-initiated shares use the real whitelist and reach everyone.
2. **Conservative parent-entity gating on player clients** — recipient `activeCharacterId` unknown there, so a parent entity visible to the recipient only via their active character skips the notification rather than risk a name leak.
3. **Auto-expand marks the popped thread read immediately** — tray is a fixed overlay visible on every tab, so on-screen = read. If Gregg wants "expand but stay unread until interaction", that's a small change in `openTab`.
4. **Auto-expand fires for at-load unread** (messages that arrived while away pop the tray once at sign-in). Intentional.
5. **iOS programmatic focus restore** after re-render may flicker the keyboard; watch for it in testing.

## Manual smoke test (next session or Gregg directly, on dev)

1. Message round-trip both directions (GM↔player), unread glow, auto-pop on the receiving side, read clearing.
2. Every §6.7 transition writes the expected docs: GM entity gm-only→all-players (`discovered` to all), GM lore item →character (`learned` to owner only), player characterShared flip (`shared` to party minus actor), note "Make it cannon!" (`shared`, actor = note author), **share-at-create** (new lore item born at all-players).
3. Digest dedupe: flap an entity's visibility off/on several times → one group, not N.
4. Re-hide a notified entity → group disappears from player digest.
5. Admin cleanup counts + delete.
6. iPad layout: strip vs Map attribution corner, panel over Timeline, keyboard behavior in composer.

## ⚠️ S1 rules test matrix (§7) — SIX SESSIONS OLD, NOW LOAD-BEARING FOR S6

Still not run (handoffs 21→26). S6 just shipped the first real **write traffic** against the S1 threads/messages/notifications rules, plus player-authored notification creates inside share batches. If any rule is wrong, shares will start failing for players in live play (batch = all-or-nothing: a bad notification rule blocks the share itself — the try/catch protects against JS bugs, not rules denials). **Run the §7 allowed/denied matrix with a real GM + player session on dev before S7.** This is the actual security surface and it is now blocking.

## Next

- S7 (integration polish + two-browser walkthrough) — Sonnet per plan, after the rules matrix.
- Prod persistence rollout (Phase 13) still pending; Phase 15 = prod concerns.

Session ritual unchanged: fresh clone, verify HEAD `4db4947`, git identity, read QOL-BACKLOG.md + phase-14-design.md + this doc.
