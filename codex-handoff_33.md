# Codex Handoff 33: GitHub OAuth, Join Request Notifications, Lore Item V-Scroll, Source Default Fix (next: S17)

**Session**: GitHub OAuth reenablement, join request notification system, lore item display rework, source-default bugfix.
**HEAD**: `6bc5c1a`
**Status**: All commits individually verification-gated and pushed to main. CI should be green (verify on GitHub Actions tab — API was rate-limited during this session, polling was unreliable).

**Note on sprint numbering**: this session's work is post-S16 (per handoff 31/32); next session's character-sheet feasibility work is **S17**.

---

## Session Summary

### 1. GitHub OAuth Reenablement
- Enabled GitHub provider on the **dev** Firebase project (`daggerheart-campaign-codex-dev`) — previously only configured on prod.
- GitHub OAuth app (github.com/settings/developers/apps) now has both callback URLs registered:
  - `https://daggerheart-campaign-codex.firebaseapp.com/__/auth/handler` (prod)
  - `https://daggerheart-campaign-codex-dev.firebaseapp.com/__/auth/handler` (dev)
- Same Client ID/Secret used for both Firebase projects' GitHub provider config.
- `public/js/auth.js` already had the GitHub sign-in wiring from before (button + `GithubAuthProvider`) — no code changes needed, this was purely a Firebase/GitHub console config gap.
- Tested and working.

### 2. Join Request Notifications to GM (new feature, not originally scoped)
**Final design**: when an authenticated-but-not-whitelisted user clicks "Request to join," a `notifications` doc (`kind: 'joinRequest'`) is written with the GM as `recipientEmail`. This surfaces in the GM's Messages tray → Campaign tab, with a clickable link that switches to the Admin tab. When the GM accepts or rejects the join request, the notification is deleted.

**Went through several wrong turns before landing here** — worth reading if this area needs touching again:
- First attempt (`85d1499`) wrote to `threads/{gmEmail}/messages/{email}` as a chat message — wrong data model; the Campaign tab renders from `notifications`, not `messages`. Should have grepped `messages.js`'s `buildGmDigest` before writing any code.
- `de3315e` patched a permission error on that wrong model instead of stepping back.
- `c4121ab` correctly pivoted to `notifications`, added `joinRequest` as a new `kind`, and rendering in `buildGmDigest`.
- `32de539` fixed a second permission bug: `isPlayer()` gates fail by definition for someone who isn't whitelisted yet (that's the whole reason they're requesting to join) — rules now allow any authenticated user to create `joinRequest`-kind notifications specifically.
- `a43aa0e` fixed the link (`href="#tab-btn-admin"` doesn't do anything in this app — no hash routing; replaced with a real click handler that calls `document.getElementById('tab-btn-admin').click()`).
- `ae5a36e` cleaned up the dead `isSystemMessage`/`referenceEmail` rule additions from the abandoned messages-based approach, and added GM-side auto-popup: `campaignUnreadCount()` and `markCampaignSeen()` now also cover GM's unseen `joinRequest` notifications (previously hardcoded to always return 0 for non-players, since the GM was never a notification recipient before this feature existed). The existing rules already permitted this — `recipientEmail == GM email` on `joinRequest` docs meant the standard "recipient can flip their own `seenAt`" rule already covered it, no rules change needed for the auto-popup part.

**Current state (all tested live by Gregg)**:
- Player requests to join → GM's tray auto-pops to Campaign tab, shows requester email + provider + clickable "requested to join" link → Admin tab.
- GM accepts/rejects → notification clears.

### 3. Lore Item Long-Content Display: Collapse+Popout → In-Place V-Scroll
Per Gregg's direction, replaced the S7/S8 "Show…"/pop-out-window chrome with simple in-place vertical scrolling.

- `codex.js`: `attachLoreItemExpand(bodyDiv)` reduced to a single responsibility — if `bodyDiv.scrollHeight > 640px`, add `.lore-item-body-scrollable` and set an inline `max-height` in px. `openLoreItemPopout` (the floating draggable panel) removed entirely (~35 lines).
- `styles.css`: removed the collapse/fade/`show-bar`/`popout-*` CSS block (~46 lines), replaced with a single `.lore-item-body-scrollable { overflow-y: auto; }` — no fixed `max-height` in CSS.
- **Double-scroll bug found during testing and fixed in two passes**:
  - First pass (`91781fc`) capped the item's scroll at `min(40rem, 60vh)` in CSS — still caused the outer page to also scroll, because `vh` is unreliable (especially iOS Safari's collapsing toolbar), and `#codex-detail-pane`'s own height is deliberately measured live in JS (`fitCodexTabHeight`) for exactly this reason — CSS `vh` bypassed that established pattern.
  - Second pass (`e986b27`, final): `attachLoreItemExpand` now measures `#codex-detail-pane`'s live `clientHeight` and sets the lore item's inline `max-height` to 60% of that (min 200px, falls back to the old 640px constant if the pane isn't found). This is the same "measure live, don't trust CSS viewport units" pattern the codebase already uses elsewhere — kept consistent rather than introducing a second competing approach.
- `CONFIG.icons.popout` (SVG string in `public/config.js`) is now unused dead config — left in place, low-risk, flagged here rather than touched.

### 4. New-Entity Default Source Not Reflected in Post-Create Edit Form
Pre-existing default-source logic (`sourceId: sortedSources()[0].id`, set on the actual Firestore write in `saveNewEntity`) was correct, but the edit-form draft that opens immediately after Save didn't carry that value forward — `buildEntityDraft`'s seed object omitted `sourceId` entirely, so it fell back to `null` and the just-created entity's edit form showed "no source" despite the saved doc being correct. Fixed (`6bc5c1a`) by passing `entityData.sourceId` into the draft seed.

---

## Testing Sign-Off (per Gregg, this session)

Gregg tested all Player↔GM codex view/share workflows live. Status of the standing "not yet manually tested" list (carried since handoff 27):

1. Mixed ancestry picker + meta ancestry — **good** (no changes this session; confirmed still fine)
2. Lore item long-content display — **now uses v-scroll, tested, no double-scroll** (was: collapse/popout, item #3 on the old list — renumbered here to match this session's new plan enumeration)
3. Long lore item pop-out on iPad — **superseded**; pop-out no longer exists (v-scroll replaces it), item is moot
4. New-entity default source — **fixed and confirmed working** this session (see §4 above)
5. Class-scoped subclass/ability filtering — **good** (no changes this session; confirmed still fine)
6. Ad hoc character card button visibility — **closed**, confirmed moot/superseded by S10's removal of the Characters-tab card viewer (per handoff 29/30's suspicion, now confirmed)

**Remaining from the original handoff-27/28 list, still not explicitly re-confirmed**:
- Multi-image gallery upload edge case (batch mixing large/small files + one deliberately-bad file)
- Player self-release rules clause (`ownerId → null`) — flagged handoff 28 as "not yet live-tested"

---

## Next Session Plan (per Gregg)

1. **Character sheet implementation feasibility exploration** — **S17**. This is exploratory/design-phase, not a committed build yet. No existing design doc section covers this — the "character deck" feature mentioned in handoff 29 (Characters-tab detail panes sitting empty, reserved for something Gregg would describe later) may be the same thing or a related concept; worth confirming with Gregg whether this is that feature or something distinct.
2. **Then Phase 15**: prod persistence rollout. Still needs Gregg's explicit go/no-go (flagged as a standing open item since handoff 28) — promoting means publishing a GitHub Release (pushes Hosting + `firestore.rules` to prod together; doesn't touch prod's existing Firestore documents, new collections just start empty).

---

## Verification Run (this session)

Every commit individually gated: ESLint (`eslint@8 --no-eslintrc`), `node --check` per touched file, CSS brace balance, `firestore.rules` brace/paren balance. No named-import cross-check issues encountered (no import statements touched this session, only local function bodies and CSS). CI push-and-poll was unreliable this session (GitHub API rate-limited on the anonymous polling calls) — recommend checking the Actions tab directly on github.com next session to confirm all pushes since `0d3dd91` are green, rather than assuming from local verification alone.

Session ritual unchanged: fresh clone, verify HEAD `6bc5c1a`, git identity, read `QOL-BACKLOG.md` + `phase-14-design.md` + this doc.
