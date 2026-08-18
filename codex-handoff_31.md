# Codex Handoff 31: Phase 14.S16 Shared-with-Specific-Character UI Refinement

**Session**: GitHub OAuth reenablement planned for next session.  
**HEAD**: `b5ebe0f` (Phase 14.S16 complete)  
**Status**: All tests passing, deployed to dev.

---

## Phase 14.S16 Summary

Completed UI/UX refinement for player ↔ GM interactions around character-shared lore elements.

### Six Commits

1. **`933c5dd`** — Player share toggle green/blue UI + immediate commit
   - Label text: "Keep to myself" / "Share with party"
   - Toggle color: green/blue (state-character/state-visible) instead of yellow/blue
   - Removed confirmation popup (was in first iteration, then removed)

2. **`eb68567`** — Toggle color fix
   - Added `mode-character` class to toggle slider for green color matching label

3. **`29624da`** — Secret badge in entry browser
   - New `.entity-secret-badge` CSS (seafoam styling)
   - Shows on player-view entries where `visibility='character'` and `characterId === activeCharacterId` and `!characterShared`
   - Right-justified like hidden badge

4. **`8424d88`** — Deferred-commit flow (reverted in #6)
   - Initially attempted visual show-then-confirm, but had permissions issues

5. **`b55ffe2`** — Fixed permissions
   - Share toggle now writes only `{ characterShared: true }`, not `visibility` (player doesn't have write access)
   - Visibility='character' is already set by GM; `characterShared=true` makes element visible to all players

6. **`4227eb9`** — Visual state updates for characterShared
   - `visibilityStateClass()` now returns `'vis-visible'` (blue) when `visibility='character'` AND `characterShared=true`
   - `buildVisibilityControl()` enhanced with `getCharacterShared()` to detect and display player-shared state
   - GM view: toggle stays left-positioned, text/slider show blue when element is player-shared
   - Player view: border/highlight turns blue when shared
   - Updated all four `buildVisibilityControl` call sites

7. **`b5ebe0f`** — Remove confirmation popup
   - Share toggle commits immediately on click

### Resulting Behavior

**Player View**
- Character-shared entry in browser: displays green "secret" badge
- Click toggle: "Keep to myself" → "Share with party" (commits immediately)
- Once shared: badge vanishes, border turns blue, toggle shows ON/blue

**GM View**
- Lore element border: green (vis-character, not shared) or blue (vis-visible, shared)
- Toggle: green (character-mode) with text "Specific character" or blue text "Visible to party" + toggle ON
  - **Key**: Toggle stays in character-mode position (left), but text/slider colors change to blue when `characterShared=true`

---

## Next: GitHub OAuth Reenablement

**File references**:
- `public/index.html` — landing page with GitHub login button (currently non-functional)
- `public/js/auth.js` — Firebase Auth setup (Google OAuth working, GitHub OAuth broken)
- Firebase console: Authentication → Sign-in method → GitHub provider config
- `firestore.rules` — user-creation rules that may need adjustment

**Known state**:
- App previously had GitHub login working
- Button exists and renders
- OAuth flow is partially broken (likely Firebase config or provider credentials expired/misconfigured)

**Approach for next session**:
1. Read existing auth setup in `auth.js`
2. Check Firebase console GitHub provider status and credentials
3. Walk through GitHub OAuth app setup (or verify existing app)
4. Test login flow end-to-end

---

## Phase 14 Status

Phase 14 (dev-only work targeting Phase 15 prod rollout) is complete through S16. All UI refinements merged to main, CI green.

Next phase: Phase 15 (prod persistence rollout) is deferred as planned.
