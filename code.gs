// Daggerheart Campaign Codex - v0.1
// __COMMIT_HASH__

const APP_VERSION = '0.1';
const BUILD_COMMIT = '__COMMIT_HASH__';

function doGet(e) {
  const template = HtmlService.createTemplateFromFile('index');
  template.config = CONFIG;
  template.appVersion = APP_VERSION;
  template.buildCommit = BUILD_COMMIT;

  return template.evaluate()
    .setTitle(CONFIG.campaignName)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

// Server-side include, for splitting index.html into partials (Apps Script
// HtmlService has no native import/bundler — this is the standard pattern).
function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}
