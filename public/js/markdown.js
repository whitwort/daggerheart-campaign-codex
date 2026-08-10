// Markdown rendering with sanitization.
//
// marked (parser) + DOMPurify (sanitizer) are loaded lazily via dynamic
// import from CDN — same pattern as the WebP encoder in images.js — so a
// CDN hiccup degrades this feature (content falls back to plain text)
// rather than breaking the whole app at module-eval time.
//
// All UI-visible content fields in the Phase 8 schema are Markdown, so
// this module is the single render path for entity/loreItem content.

let markdownModulesPromise = null;
// Set once the modules resolve; enables a synchronous render path so
// re-renders don't flash plain text before the rich HTML lands (visible
// as content "flipping" on every Firestore snapshot re-render).
let loadedModules = null;

function loadMarkdownModules() {
  if (!markdownModulesPromise) {
    markdownModulesPromise = Promise.all([
      import('https://esm.sh/marked@15'),
      import('https://esm.sh/dompurify@3')
    ]).then(function (mods) {
      const marked = mods[0];
      const dompurifyMod = mods[1];
      // esm.sh wraps DOMPurify's default export; unwrap defensively.
      const DOMPurify = dompurifyMod.default || dompurifyMod;
      loadedModules = { marked: marked, DOMPurify: DOMPurify };
      return loadedModules;
    }).catch(function (err) {
      // Reset so a later call retries rather than caching the failure
      // forever (e.g. transient network loss at the table).
      markdownModulesPromise = null;
      throw err;
    });
  }
  return markdownModulesPromise;
}

// Render markdown into el. Async; safe to call fire-and-forget from
// synchronous render code. If el has been disconnected from the DOM by
// the time the modules load (user switched entries), the stale fill is
// dropped. On any failure the raw text is shown as plain text instead.
export function renderMarkdownInto(el, mdText) {
  const text = mdText || '';

  // Fast path: modules already cached — render rich HTML synchronously,
  // no intermediate plain-text paint at all.
  if (loadedModules && text) {
    try {
      el.innerHTML = loadedModules.DOMPurify.sanitize(loadedModules.marked.parse(text));
      return Promise.resolve();
    } catch (e) {
      // fall through to plain text below
    }
  }

  // Slow path (first render only): plain-text paint so there's never a
  // blank flash while the CDN modules load; replaced with rich HTML when
  // ready.
  el.textContent = text;
  if (!text) return Promise.resolve();

  return loadMarkdownModules().then(function (mods) {
    if (!el.isConnected) return;
    const rawHtml = mods.marked.parse(text);
    el.innerHTML = mods.DOMPurify.sanitize(rawHtml);
  }).catch(function () {
    // Plain text already painted; nothing to do.
  });
}
