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

HEAD: `4450d32`. Deployed to **dev only**, CI green. Prod still on v0.7b/`1a08007`.

**Current scene configuration: DONE, confirmed by Gregg (Sep 2).**
- New `currentSceneId` field in `config/campaign` doc, state.js, and Admin > Configuration UI.
- Admin selector filters to Scene entities, GM-editable, same merge-save pattern as other config fields.
- Codex opening message: appends "Or start with the party's latest scene: [NAME]" link if currentSceneId is set and visible to player. Link click selects the scene and displays its detail.
- Render triggers: codex.js entities listener (on Scene list change), map.js config listener (on currentSceneId change).
- No rules changes — already in play via `config/campaign` access.

## Prior session (Sep 1 2026): Loot section, reveal-timing toggles, Run state machine

Full details in git history — search backwards in this file for the entry, it's preserved at the end.

## Session ritual

Fresh clone (never reuse a prior working tree); git identity
(whitwort@gmail.com / "Gregg Whitworth"); verify HEAD against this
doc's era; read QOL-BACKLOG.md + this file before code. Gates before
EVERY commit: `npx eslint@8 --no-eslintrc -c .eslintrc.check.json
public/js/*.js`, `node --check` per touched file, CSS + firestore.rules
brace balance. Push via PAT URL; rebase FETCH_HEAD if remote moved. CI:
sleep ~74s then poll Actions API with PAT header. End every session by
rewriting THIS file.

## Open items

- Deploy to prod (tag Release, watch CI, check smoke test).
- Post-launch optimizations: dynamic-import GM-only modules (~3k lines), codex.js split (4.8k lines).
- Single-entry restore "delete orphans" mode — deferred, needs concrete use case.
- Purge-legacy-image-docs scan has no watchdog on `getDocs` read — low priority.
- Playwright player-role smoke test — just an idea, not built.

---

## Preserved history (for reference)

[Earlier content from prior sessions preserved here for genealogy; grep backwards to find specific session notes]
