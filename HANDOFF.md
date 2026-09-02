# HANDOFF — single rolling session-transfer doc

**Convention (established at repo cleanup, Aug 2026): this is the ONLY
session-transfer file.** Each session ends by REWRITING this file with
current state — do not create codex-handoff_N.md files. Old handoffs
(20–44) and the phase design docs (phase-14/15/17) were deleted from
the tree in the same cleanup; all remain retrievable from git history
(`git log --all --oneline -- 'codex-handoff_*.md' 'phase-*.md'`,
last present at the commit tagged v0.2b's successor). Code comments
citing e.g. "phase-14-design.md §5.1" are historical pointers into
those deleted docs — resolve via git history, don't "fix" the comments.

## Current state (end of session, Sep 2 2026)

HEAD: `44f2812`. Deployed to **dev only**, CI green throughout. Prod remains v0.7b/`1a08007`.

**"Current scene" configuration feature: COMPLETE & TESTED, prod Release deferred.**
Built commit `4450d32`, confirmed functional by Gregg:
- New `currentSceneId` field in `config/campaign` doc + state.js.
- Admin > Configuration > "Current scene" selector: filters Scene entities, GM-editable, merge-saved like rootEntityId/campaignType.
- Codex opening message: if currentSceneId set & visible, appends line "Or start with the party's latest scene: [NAME]" with clickable link. Link click selects scene entity and displays detail.
- Render: codex.js entities listener (Scene list changes) + map.js config listener (currentSceneId changes).
- No firestore.rules changes needed — already handled by existing `config/campaign` access rules.
- All pre-commit gates passed: ESLint, node --check, CSS/rules brace balance.
- Prod Release deferred per Gregg — other sessions have pending work to finish first.

## Open items

- **Prod Release:** current-scene feature at `44f2812` ready to ship; defer until other work finishes.
- Post-launch optimizations: dynamic-import GM-only modules (~3k lines), codex.js split (4.8k lines).
- Single-entry restore "delete orphans" mode — deferred, needs concrete use case.
- Purge-legacy-image-docs scan has no watchdog on `getDocs` read — low priority, only matters if it starts failing.
- Playwright player-role smoke test — floated during Aug 28 focus-loss retro, not built.

## Session ritual

Fresh clone (never reuse a prior working tree); git identity
(whitwort@gmail.com / "Gregg Whitworth"); verify HEAD against this
doc's era; read QOL-BACKLOG.md + this file before code. Gates before
EVERY commit: `npx eslint@8 --no-eslintrc -c .eslintrc.check.json
public/js/*.js`, `node --check` per touched file, CSS + firestore.rules
brace balance. Push via PAT URL; rebase FETCH_HEAD if remote moved. CI:
sleep ~74s then poll Actions API with PAT header. End every session by
rewriting THIS file.
