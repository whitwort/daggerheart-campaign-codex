# Codex Handoff 32: GitHub OAuth + Join Request Notifications

**Session**: GitHub OAuth reenablement + join request notification system  
**HEAD**: `85d1499` (GitHub OAuth working, join request notifications to GM added)  
**Status**: Commit pushed to main. Manual CI verification required (rate-limited out of API polling).

---

## Session Summary

Reenabled GitHub OAuth on dev Firebase project and implemented join request notifications to GM.

### Single Commit: `85d1499`

**GitHub OAuth Reenablement**
- Added GitHub provider to dev Firebase project (`daggerheart-campaign-codex-dev`)
- GitHub OAuth app at github.com/settings/developers/apps configured with:
  - Callback URLs: both prod (`*.firebaseapp.com`) and dev (`*-dev.firebaseapp.com`)
  - Client ID and Secret synced to Firebase
- Button on landing page now functional; tested successfully

**Join Request Notification Flow**
- When player clicks "Request to join":
  1. Writes to `joinRequests/{email}` (existing behavior)
  2. **NEW**: Also writes system message to `threads/{gmEmail}/messages/{email}` with provider info and link to Admin tab
- Message schema updates in `firestore.rules`:
  - `isValidMessage()` now allows optional `isSystemMessage` and `referenceEmail` fields
  - Messages delete rule: `allow delete: if isGM() && resource.data.isSystemMessage == true` (was `allow update, delete: if false`)
- When GM accepts or rejects request:
  1. Existing joinRequests cleanup (unchanged)
  2. **NEW**: Also deletes the notification message from GM's thread

### File Changes
- `firestore.rules`: Message validation + delete rule
- `public/js/auth.js`: Message write on join request, import CONFIG for gmEmail
- `public/js/admin.js`: Message delete on accept/reject, import CONFIG

---

## Testing Notes

- GitHub login tested and working on dev
- Join request flow: need to test full end-to-end (player request → GM sees notification → GM accept/reject → message deletes)
- Message appears in "Campaign" tab of GM's Messages tray with clickable link to Admin tab

---

## Next Steps (Phase 15+)

- Prod persistence rollout remains deferred
- Player-facing JSON subset export (deferred)
- Continued Midjourney generation for world content
