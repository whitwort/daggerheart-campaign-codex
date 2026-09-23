// Cache-busts every first-party asset URL in public/index.html with the
// deploy's build hash, so a reload after a new deploy (version.js's
// auto-reload on dev, the "reload to update" banner on prod, or a plain
// refresh) can never pair fresh HTML with a stale module from the
// browser's cache or a CDN edge. Run by deploy.yml right after the
// BUILD_HASH stamp: `node scripts/stamp-asset-versions.mjs <hash>`.
//
// Mechanism:
//   - An import map (injected at the __IMPORT_MAP__ placeholder, before
//     any module fetch starts) maps every /js/<file>.js to
//     /js/<file>.js?v=<hash>. That covers ALL static and dynamic
//     imports between our own modules with zero source rewriting, and
//     -- because every importer resolves through the same map -- no
//     module can load twice under two URLs (which would split
//     singletons like state.js).
//   - Import maps don't apply to HTML attributes, so the entry
//     <script src>, the modulepreload hrefs (must match the mapped URLs
//     exactly or the preload is wasted) and the other local
//     scripts/stylesheets get ?v=<hash> appended directly.
// vendor/ (pinned third-party copies) and CDN URLs are left alone.
//
// Unstamped local/emulator builds never run this: the placeholder stays
// an inert comment and everything loads by its plain URL.
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';

const hash = process.argv[2];
if (!hash || !/^[0-9a-f]{7,40}$/.test(hash)) {
  console.error('usage: node scripts/stamp-asset-versions.mjs <git short hash>');
  process.exit(1);
}

const HTML = 'public/index.html';
const PLACEHOLDER = '<!-- __IMPORT_MAP__ -->';
let html = readFileSync(HTML, 'utf8');

if (html.split(PLACEHOLDER).length !== 2) {
  console.error(`${HTML}: expected exactly one ${PLACEHOLDER} placeholder`);
  process.exit(1);
}

const v = '?v=' + hash;
const modules = readdirSync('public/js').filter((f) => f.endsWith('.js')).sort();
const imports = {};
modules.forEach((f) => { imports['/js/' + f] = '/js/' + f + v; });
html = html.replace(PLACEHOLDER,
  '<script type="importmap">' + JSON.stringify({ imports }) + '</script>');

// Local (non-vendor, non-CDN) script/stylesheet/preload references.
let attrCount = 0;
html = html.replace(/(\s(?:src|href)=")((?:js\/[\w.-]+\.js)|(?:css\/[\w.-]+\.css)|(?:[\w.-]+\.js))"/g,
  function (_, pre, url) { attrCount += 1; return pre + url + v + '"'; });

// Sanity: nothing local left unversioned.
const leftover = html.match(/\s(?:src|href)="(?:js\/|css\/)[^"?]+"/g);
if (leftover) {
  console.error('unversioned asset references remain:\n  ' + leftover.join('\n  '));
  process.exit(1);
}

writeFileSync(HTML, html);
console.log(`stamped ${modules.length} import-map entries and ${attrCount} asset URLs with ${v}`);
