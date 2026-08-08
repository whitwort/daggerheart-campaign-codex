# daggerheart-campaign-codex
A web app designed to make it easy for a GM to share maps, images, and lore information with players live at the table. Uses Google App Script and Firebase to avoid complicated hosting requirements.

## Adding your own map

1. Save your map image (JPG/PNG) somewhere convenient.
2. Copy it into `public/maps/`, e.g. `public/maps/my-map.jpg`.
3. In `public/config.js`, set `mapImage` to that path: `mapImage: 'maps/my-map.jpg'`.
4. Commit and push to `main` — the map goes live on the next deploy.

No Firebase/Google Cloud console setup is needed for this — the map image is served as a static file alongside the rest of the app.
