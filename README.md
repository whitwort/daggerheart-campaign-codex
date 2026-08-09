# Daggerheart Campaign Codex

A web app for a Daggerheart GM to share maps, images, and lore with
players — live at the table and between sessions. Built for the
"Aether's Children" campaign; configurable for others via
`public/config.js`.

## What it does

- **Codex**: campaign lore entries (NPCs, factions, locations, items,
  history, events) with GM-only vs. player-visible content, tags,
  search, and cross-links between entries.
- **Map**: nested zoomable maps (Leaflet) with pins linking to codex
  entries or child maps. Map images are uploaded through the app
  (client-side resize + libwebp WASM compression) and stored in
  Firestore.
- **Access control**: every user signs in (Google or GitHub). The GM is
  a single configured email; players are a GM-managed whitelist with an
  in-app join-request flow. No anonymous access.
- **Admin tab** (GM only): approve/reject join requests, manage the
  player whitelist, select the root map.

## Stack

Vanilla JS ES modules (no build step), Firestore, Firebase Auth,
Firebase Hosting, Leaflet. Everything lives in `public/`; `index.html`
loads `js/main.js` as the module entry point.

```
public/
  config.js        campaign name, categories, GM email
  firebase-env.js  Firebase project identity (prod; dev CI swaps in firebase-env.dev.js)
  index.html       all markup; build hash stamped by CI
  css/styles.css
  js/
    state.js       shared mutable app state (single exported object)
    listeners.js   onSnapshot attach/detach lifecycle helper
    firebase.js    Firebase app init
    auth.js        sign-in, role resolution, listener orchestration
    codex.js       entries list/detail/authoring
    map.js         Leaflet maps, pins, navigation
    images.js      upload pipeline (resize + WebP), IndexedDB image cache
    admin.js       GM admin tab
firestore.rules    security rules (writes GM-only; reads require GM/Player auth)
.eslintrc.check.json  no-undef lint gate config (also run in CI)
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

## Important: never commit map/campaign images to this repo

All map and campaign artwork goes through the in-app upload (stored in
Firestore), **never** into the repo. This repo is public; committed
artwork caused a copyrighted-content leak that required rewriting
history — twice, the second time from a stale local clone pushing
pre-purge history back. Always work from a fresh clone.

## Configuration

Campaign-specific values live in `public/config.js`. The GM email there
must match the hardcoded email in `firestore.rules` (`isGM()`); rules
can't read config files, so keep them in sync by hand. The Firebase
config block is not a secret — access control is entirely rules + auth.
