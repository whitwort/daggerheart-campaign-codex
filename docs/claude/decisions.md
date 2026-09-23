# Locked decisions and learnings

Durable; change only with Gregg's explicit direction.

## Naming and schema
- "Entity/Entities" is canonical in code, schema, and UI. Do not rename
  to Entry/Entries (needs a live-data migration plus rules changes).
  When Gregg says "Entries" he means Entities.
- Authorship: `loreItems.authorType` is `'gm' | 'character'`;
  `authorId` is `null` for GM, else the authoring PC's `entities/` doc
  id — never a Firebase Auth uid or email. Tracks in-fiction knowledge,
  not who's at the table.

## Architecture
- Import cycle: `encounters.js` imports from `codex.js`; `codex.js`
  cannot import back. Cross-module nav = dispatch a real click event on
  the tab button.
- Presence: `presence/{email}` docs are deliberately separate from
  `players/{email}` so heartbeat writes don't trigger app-wide
  re-renders.
- CSS transforms: `scaleX(-1)` must be rightmost in the transform
  string (applies first — flip about own center) so translate geometry
  is unaffected.
- Sortable + click handling on iPad (multi-image galleries): see code
  comments in `codex.js` `renderGalleryTab` before touching.

## Data and environments
- Prod is source of truth. Backup/restore runs prod → dev only; no
  dev → prod data route.
- Copy between projects: download from one app → upload into the other
  → "Wipe and replace".
- `joinRequests` is excluded from the restore write step (Security Rule
  restriction).
- Backup data only in private `whitwort/aethers-children-data`, never
  this repo. CI backup uses secret `BACKUP_REPO_PAT`.
- Secrets: `FIRESTORE_ADMIN_SERVICE_ACCOUNT_KEY` (codex-firestore-admin,
  Cloud Datastore User on prod) is for Firestore admin;
  `FIREBASE_SERVICE_ACCOUNT_KEY` is hosting-deploy only, no Datastore.
- GCP free-trial quota caps reads at 50K/day regardless of Blaze
  billing. Fix = trial banner's "Activate", not Billing > Upgrade. Prod
  activated; dev not. `resource-exhausted` on dev → check trial first.
- Firebase Hosting serves both `.web.app` and `.firebaseapp.com`, but
  they're different origins (IndexedDB/localStorage/Auth don't carry).
  `index.html`'s first `<head>` script redirects to `.web.app`.

## CI
- `scripts/e2e-run.sh` uses `npx playwright install chromium`, never
  `--with-deps` (apt-get update hits a recurring upstream Chrome apt
  hash-mismatch on ubuntu-latest; deps are preinstalled there).
- Test infra: `@firebase/rules-unit-testing` for rules; Playwright for
  e2e; emulator project IDs use the `demo-dcc-e2e` prefix.

## Environment notes
- iOS: no devtools — Safari remote debugging via a Mac, or in-page
  `console.log`/`alert`.
- Firebase console nav: Product categories → subcategory (Firestore
  under "Database & Storage", Hosting under "Hosting & Serverless").
  No top-level "Build". Confirm names with Gregg before giving click
  paths.
