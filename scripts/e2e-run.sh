#!/usr/bin/env bash
# Wrapper for `npm run test:e2e`.
#
# public/firebase-env.js is the live env file (index.html loads it
# directly, no build step -- see config.js). Dev/prod CI jobs swap it via
# `cp` per-job in an ephemeral checkout; this script does the same thing
# locally but MUST restore the developer's real file afterward, since a
# local clone is reused across sessions. trap covers both normal exit and
# Ctrl-C.
set -euo pipefail
cd "$(dirname "$0")/.."

# firebase-admin is a script-only dependency here (same --no-save
# convention as scripts/firestore-backup.js / deploy.yml), not a
# package.json devDependency -- only global-setup.mjs and the specs'
# direct writes need it. Chromium install is idempotent/cached by
# Playwright after the first run.
npm install --no-save firebase-admin@12
npx playwright install --with-deps chromium

cp public/firebase-env.js /tmp/dcc-e2e-firebase-env.backup.js
restore() { cp /tmp/dcc-e2e-firebase-env.backup.js public/firebase-env.js; }
trap restore EXIT

cp public/firebase-env.emulator.js public/firebase-env.js

firebase emulators:exec --only firestore,auth,hosting --project demo-dcc-e2e \
  "npx playwright test"
