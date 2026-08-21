# Codex handoff 44 — first prod release + restore debugging saga

HEAD at session end: see git log (last commit: merge-mode notifications
fix). Prod is LIVE and fully populated. This handoff documents the prod
launch and the four-layer backup-restore debugging chain — read it
before touching backup.js or trusting any restore log.

## Prod launch state

- Releases published: v0.1b (first prod deploy; failed on IAM, fixed,
  re-run), v0.1c, v0.1d, v0.1e. VERSION file currently `0.1e`.
  Convention holds: bump VERSION, publish Release tagged `v<VERSION>`;
  a Release (not a bare tag) triggers deploy-hosting-prod.
- IAM fix (done, GCP console): `codex-hosting-deploy@...` SA on prod
  needed **Cloud Datastore Index Admin** (indexes deploy) + **Cloud
  Datastore User** (_meta/version writes). Without them the prod deploy
  403s at `firestore:indexes`.
- `BACKUP_REPO_PAT` fixed by Gregg (fine-grained PAT, Contents R/W on
  the private data repo only). Daily prod backup workflow operational.
- Prod data: seeded from the dev dump (2026-08-21). Complete except
  (a) 2 orphaned legacy image docs deliberately skipped, (b) thread
  message subcollections (client restore can't create them —
  author-role-locked; Admin-SDK script only).

## The restore saga (4 distinct root causes, in order)

1. **Count-only batching blew the ~10 MiB batched-write REQUEST cap.**
   111 image docs (57.6 MiB total) in one 500-doc batch → throw →
   sequential loop aborted → every collection ordered after images
   silently never restored. Fix: size-aware batching
   (`writeEntriesBatched`) + per-collection catch/continue + end-of-run
   failure summary.
2. **Long-polling transport hang.** With an 8 MiB budget, repeated
   multi-MiB commit POSTs over the forced long-polling transport (iOS
   fix in firebase.js) wedged — the commit PROMISE NEVER SETTLED (no
   throw), freezing the loop after images batches 1–4. Diagnosed by
   diffing the prod dump against dev: prod held exactly dump-order
   images 0–55 = the first four computed batch boundaries. Fix: budget
   down to **1.5 MiB**, **45 s watchdog** per commit (Promise.race),
   one rebuild-and-retry (WriteBatch is single-use), per-chunk progress
   logging, and a **"restore engine rN" marker** as the first log line.
   Observed steady-state: ~3–5 timeouts per full restore, all recover
   on first retry.
3. **Legacy docs that can never pass rules validation.** Two relics of
   the retired maps/ scheme (`map_A0351uUdz3yGyoJUqrdA_primary`,
   `map_ETX4fFFoCTcRLyvhCNFD_primary`: ownerType:'map', role:'primary',
   NO visibility field) predate isValidImage() on dev. Prod's rules
   rejected their batch wholesale (batches are atomic), stranding 29
   docs. Fix: `isRestorableImage`/`filterRestorable` skip-with-log.
   QOL item: purge the two docs from dev via Admin-SDK script someday.
4. **Merge-mode notifications false-failure.** set() on an existing
   notification doc = UPDATE, and rules lock notification updates to
   the recipient flipping seenAt — GM denied. Benign in practice (docs
   were already identical from the prior run) but reported FAILED. Fix
   (this session's last commit, NOT yet deployed to prod — rides with
   the next release): merge mode wipes notifications first (GM deletes
   allowed) and recreates from the dump.

## Debugging lessons (recorded, some also in QOL-BACKLOG)

- **iOS Safari can serve stale JS modules across reloads even with a
  fresh footer hash** (index.html revalidated, module map didn't).
  Force-quit Safari or use a Private tab. The engine marker in the
  restore log now settles "which code ran" instantly — prefer adding
  such markers to any long-running client operation.
- **Wipe counts are evidence**: the wipe phase logs how many docs each
  collection HAD, which reconstructed what earlier partial restores
  actually wrote. The batch-boundary simulation against the dump
  (JSON.stringify sizes, replay the chunking algorithm) pinpointed the
  hang location exactly.
- A restore log that just stops (no FAILED line) = a hung promise, not
  a throw. Watchdog everything that awaits network in a loop.
- Restore order is alphabetical-ish (RESTORABLE_COLLECTIONS); anything
  after a stalled collection is missing entirely — symptom clusters by
  restore order, not by feature.

## Timeline cluster-zoom fix (earlier this session)

Cluster tap: separation scale clamped by fit-whole-cluster scale
(`min(sepScale, fitScale)`, 70% viewport) — tight pair inside a wide
span no longer zooms to an empty window. Verified on desktop + iPad
(iPad initially appeared broken due to the stale-module issue above).

## Open items

- **Next release** (v0.1f or roll into next feature release) carries
  the merge-mode notifications fix — nothing urgent, prod data is
  complete.
- Purge the 2 legacy image docs from dev (Admin-SDK script; no UI path).
- Phase 17 remainder (secrets discoverability + Lore Drops shipped;
  check phase doc for any unimplemented follow-ups), Phase 16 prod
  persistence rollout status, deploy-workflow hardening
  (approval gate, rules tests, pre-deploy backup, smoke test).
- Post-launch optimizations from the review: dynamic-import GM-only
  modules, codex.js split, vendor/** cache header.
- `setEntityImagesTarget` stuck-listener gap (handoff 41).

## Session ritual

Unchanged: fresh clone, verify HEAD vs this doc, git identity, gates
before every commit (import-check, eslint, node --check, brace
balances), CI poll ~74 s with json.loads(strict=False).
