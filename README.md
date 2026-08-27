# Daggerheart Campaign Codex

A web app for a Daggerheart GM to share maps, images, and lore with
players — live at the table and between sessions. Built for the
"Aether's Children" campaign; configurable for others via
`public/config.js`.

## What it does

- **Codex**: campaign lore entities (characters, factions, locations,
  items, events, adversaries, and more) with per-element GM/player/
  character visibility, secrets discoverability, tags, aliases, search
  (including SRD template fields), wiki-style cross-links, related-entry
  suggestions, image galleries with portrait framing, and per-entity
  lore items with sources and player-authored notes.
- **Map**: nested zoomable maps (Leaflet) with pins linking to codex
  entities or child maps. Map images are uploaded through the app
  (client-side resize + libwebp WASM compression) and stored in
  Firestore.
- **Timeline**: zoomable well of dated Scenes/Events with an inline
  entry card.
- **Characters**: player-facing character management — Daggerheart card
  deck (ancestry/community/class/subclass/abilities), character sheet
  (HP/Stress/Hope tracks, gold, experiences), claim/transfer flow, and
  active-character selection.
- **Encounters** (GM): native encounter builder/runner — adversary
  picker, difficulty calculator, per-instance HP/Stress tracking,
  Build/Run tabs.
- **Stables** (GM): lore-drop batches — record a set of visibility
  changes with the drop recorder, then Run/Undo/Delete them as a unit,
  with notification fan-out to newly-exposed players.
- **Messages**: per-player and campaign threads with unread tracking,
  plus share/discovery notifications.
- **Access control**: every user signs in (Google or GitHub). The GM is
  a single configured email; players are a GM-managed whitelist with an
  in-app join-request flow. No anonymous access.
- **Admin tab** (GM only): join requests, player whitelist, campaign
  config (root map, sources), SRD import (`seansbox/daggerheart-srd`),
  bulk lore import/export, and in-app Firestore backup/restore. A daily
  CI workflow also exports prod Firestore to a private data repo.

## Stack

Vanilla JS ES modules (no build step), Firestore, Firebase Auth,
Firebase Hosting, Leaflet. Everything lives in `public/`; `index.html`
loads `js/main.js` as the module entry point.

```
public/
  config.js        campaign name, categories, subtypes, icons, GM email
  firebase-env.js  Firebase project identity (prod; dev CI swaps in firebase-env.dev.js)
  index.html       all markup; build hash stamped by CI
  css/styles.css
  js/
    main.js          module entry point: tab wiring, handler registration
    state.js         shared mutable app state (single exported object)
    listeners.js     onSnapshot attach/detach lifecycle helper
    firebase.js      Firebase app init (long-polling + persistent cache)
    auth.js          sign-in, role resolution, listener orchestration
    codex.js         entity list/detail/authoring, lore items, galleries
    visibility.js    canSee() — the single read-side visibility seam
    visibility-ui.js GM visibility controls (3-state, shared toggle)
    sharing.js       visibility writes + notification fan-out (single write seam)
    map.js           Leaflet maps, pins, navigation
    timeline.js      dated Scene/Event well
    characters.js    Characters tab (GM + player views)
    character-cards.js / character-deck.js / character-sheet.js
    encounters.js    GM encounter builder/runner
    stables.js       GM lore-drop batches
    messages.js      threads, notifications tray
    images.js        upload pipeline (resize + WebP)
    entity-images-cache.js  per-surface images watcher
    import.js / srd-import.js  bulk lore + SRD imports
    backup.js        in-app Firestore export/restore (Admin tab)
    admin.js         GM admin tab
    sources.js       lore sources
    picker-panel.js  shared floating picker-panel machinery
    templates.js     SRD template schemas + search index
    connectivity.js / version.js / dates.js / markdown.js /
    badge-color.js / transfer-requests.js
firestore.rules    security rules (writes GM-only except scoped player
                   paths; reads require GM/Player auth)
scripts/firestore-backup.js  Node/Admin-SDK export/import (CI backup +
                   local restore tooling)
.eslintrc.check.json  no-undef lint gate config (also run in CI)
HANDOFF.md         rolling session-transfer doc (rewritten each session)
```

## Deploys

GitHub Actions (`.github/workflows/deploy.yml`), direct pushes to
`main`, no PRs:

- **Push to `main`** → lint gate → swap in `firebase-env.dev.js` → deploy
  hosting + rules to the **dev** project (`daggerheart-campaign-codex-dev`).
- **Publish a GitHub Release** → lint gate → deploy to **prod**
  (`daggerheart-campaign-codex`).

The footer shows the deployed commit hash (`__COMMIT_HASH__`, stamped at
CI time) for distinguishing stale-deploy from caching issues; Hosting is
configured `Cache-Control: no-cache`.

Before pushing, run the same gate CI runs:

```
npx eslint@8 --no-eslintrc -c .eslintrc.check.json public/js/*.js
```

`node --check` alone is not sufficient — it can't see cross-module
reference errors, which this codebase's module split has produced.

## Configuration

Campaign-specific values live in `public/config.js`. The GM email there
must match the hardcoded email in `firestore.rules` (`isGM()`); rules
can't read config files, so keep them in sync by hand. The Firebase
config block is not a secret — access control is entirely rules + auth.

## Credits & Licenses

- **Daggerheart**: this app can import and display content from the
  [Daggerheart System Reference Document](https://www.daggerheart.com/srd/)
  (v2.0), which is Public Game Content under the
  [Darrington Press Community Gaming License](https://www.darringtonpress.com/license).
  Daggerheart and its SRD are © 2025 Critical Role LLC; all Daggerheart
  game content and mechanics are the property of Darrington Press.
  This is an unofficial fan-made tool, not affiliated with or endorsed
  by Darrington Press or Critical Role.
- **Icons**: the character sheet's gold-panel icons (Handfuls, Bags,
  Chest) are by [Delapouite](https://delapouite.com/) and
  [Lorc](https://lorcblog.blogspot.com/) from
  [game-icons.net](https://game-icons.net/), used under
  [CC BY 3.0](https://creativecommons.org/licenses/by/3.0/). All other
  UI icons are [Lucide](https://lucide.dev/) (ISC).
- **Map rendering**: [Leaflet](https://leafletjs.com/) (BSD-2-Clause).
