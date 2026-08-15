import { state } from './state.js';
import {
  registerVisibilityChangeHandler, isEntityPlayerVisible,
  renderList, renderDetailForSelected, clearCodexSearchInput,
  renderEntityViewCard, buildEntityPreviewCard, enterEntityEditMode,
  appendDateSegments
} from './codex.js';
import { formatDateSegments } from './dates.js';

const panelEl = document.getElementById('timeline-panel');
let built = false;

// Mirrors dates.js's internal sort-key ratio (1y = 256d = 256*16h =
// 256*16*64m = 256*16*64*64s -- see dates.js UNIT_SECONDS). Not imported
// directly since dates.js doesn't export it; duplicated here purely for
// converting entity.dateSort into an approximate "years" float for axis
// tick spacing/labels. Entity node labels always use the real stored
// entity.date string, never this approximation.
const YEAR_SECONDS = 64 * 64 * 16 * 256;
const DAY_SECONDS = 64 * 64 * 16;
const HOUR_SECONDS = 64 * 64;

// Same "jump to this entity in the Codex tab" pattern as map.js's
// switchToCodexEntity — duplicated locally rather than shared, since
// codex.js doesn't export selectEntity itself (only the inverted-dependency
// registration hooks), matching the existing map.js precedent. Only used
// for the "Dates and Times" explainer link now -- node/list taps open the
// entry-card panel in place instead (see openEntityInPanel).
function switchToCodexEntity(entityId) {
  state.selectedId = entityId;
  clearCodexSearchInput();
  renderList();
  renderDetailForSelected();

  document.querySelectorAll('nav#tabs button').forEach(function (b) { b.classList.remove('active'); });
  document.querySelectorAll('.tab-panel').forEach(function (p) { p.classList.remove('active'); });
  document.getElementById('tab-btn-codex').classList.add('active');
  document.getElementById('codex-panel').classList.add('active');
}

function isGmView() {
  return state.currentRole === 'gm' && !state.gmPreviewAsPlayer;
}

// --- Module state (own selection/tab state, deliberately NOT shared with
// state.selectedId/state.detailActiveTab -- those belong to the Codex tab's
// own singleton detail pane; Timeline renders its own simultaneous card) --
let dom = null; // populated once by buildShell()
let dated = [];  // current gmView-filtered, dateSort-sorted Scene/Event entities
let selectedId = null;
let activeTab = 'lore';
let scale = 1;
let offset = 0; // in "years" (dateSort / YEAR_SECONDS)
let fitted = false;
let lastClusters = []; // populated by render(), read by handleTap for the tap-vs-zoom decision

function tOf(entity) { return entity.dateSort / YEAR_SECONDS; }

// Zoom-adaptive tick labels: coarsest granularity (years only) when
// zoomed out, adding day then hour precision as ticks get closer
// together, per Gregg's "y -> y,d -> y,d,h" spec -- rather than a
// single fixed-precision label at every zoom level (the old fmtYears,
// which either wasted space at wide zoom or lost precision when
// zoomed in close). granularity: 1=years, 2=years+days, 3=+hours.
// Works from the entity's real internal-seconds offset (not the
// "years" float used for pixel math) to avoid compounding float
// rounding across three unit conversions.
function tickGranularity(stepYears) {
  const DAY_IN_YEARS = DAY_SECONDS / YEAR_SECONDS;
  if (stepYears >= 1) return 1;
  if (stepYears >= DAY_IN_YEARS) return 2;
  return 3;
}
function fmtTick(offsetSeconds, granularity) {
  if (offsetSeconds === 0) return 'Epoch';
  const isPast = offsetSeconds < 0;
  const suffix = isPast ? 'a' : '';
  let rem = Math.round(Math.abs(offsetSeconds));
  const y = Math.floor(rem / YEAR_SECONDS); rem -= y * YEAR_SECONDS;
  const d = Math.floor(rem / DAY_SECONDS); rem -= d * DAY_SECONDS;
  const h = Math.floor(rem / HOUR_SECONDS);
  const tokens = [['y', y]];
  if (granularity >= 2) tokens.push(['d', d]);
  if (granularity >= 3) tokens.push(['h', h]);
  // Only non-zero units are shown -- matches the campaign's own
  // shorthand convention (e.g. entity dates like "1da, 8ha" never show
  // a leading "0y"). If every unit at this granularity rounds to zero
  // (a nonzero-but-sub-granularity offset, e.g. a few minutes while
  // zoomed out to year-level ticks), fall back to a distinct "<1"
  // label rather than "Epoch" -- reusing "Epoch" here would reproduce
  // the exact duplicate-Epoch bug fixed earlier this session.
  const parts = tokens.filter(function (t) { return t[1] !== 0; }).map(function (t) { return t[1] + ' ' + t[0] + suffix; });
  if (!parts.length) return isPast ? '<1 ya' : '<1 y';
  return parts.join(', ');
}

// --- Build the static shell once (toolbar, well+svg+zoom controls+
// popup, card pane, list drawer). Data-dependent content is (re)rendered
// into it by refresh() on every visibility/data change. ---
function buildShell() {
  panelEl.innerHTML = '';

  const introP = document.createElement('p');
  introP.className = 'admin-hint timeline-intro';
  introP.appendChild(document.createTextNode('Dates use the campaign\u2019s shorthand notation \u2014 see '));
  const explainerEntity = state.allEntities.find(function (e) {
    return (e.name || '').trim().toLowerCase() === 'dates and times';
  });
  if (explainerEntity && (isGmView() || isEntityPlayerVisible(explainerEntity.id))) {
    const link = document.createElement('a');
    link.href = '#';
    link.textContent = '\u201cDates and Times\u201d (' + explainerEntity.category + ')';
    link.addEventListener('click', function (ev) {
      ev.preventDefault();
      switchToCodexEntity(explainerEntity.id);
    });
    introP.appendChild(link);
  } else {
    introP.appendChild(document.createTextNode('\u201cDates and Times\u201d (Game Mechanics)'));
  }
  introP.appendChild(document.createTextNode(' for the full explanation.'));
  panelEl.appendChild(introP);

  const layout = document.createElement('div');
  layout.className = 'timeline-layout';

  const wellCol = document.createElement('div');
  wellCol.className = 'timeline-well-col';

  // Outer wrap has NO overflow:hidden -- that's what was clipping the
  // hover preview popup (and its title, the first thing to go since the
  // popup grows upward from the hovered node). Clipping to rounded
  // corners now happens on an inner div instead; the popup and zoom
  // controls are positioned relative to the outer (unclipped) wrap.
  const wellWrap = document.createElement('div');
  wellWrap.className = 'timeline-well-wrap';

  const wellInner = document.createElement('div');
  wellInner.className = 'timeline-well-inner';
  wellWrap.appendChild(wellInner);

  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'timeline-svg');
  wellInner.appendChild(svg);

  const zoomControls = document.createElement('div');
  zoomControls.className = 'timeline-zoom-controls';
  const zoomInBtn = document.createElement('button');
  zoomInBtn.type = 'button';
  zoomInBtn.textContent = '+';
  zoomInBtn.addEventListener('click', function () { scale *= 1.5; render(); });
  const zoomOutBtn = document.createElement('button');
  zoomOutBtn.type = 'button';
  zoomOutBtn.textContent = '\u2212';
  zoomOutBtn.addEventListener('click', function () { scale /= 1.5; render(); });
  zoomControls.appendChild(zoomInBtn);
  zoomControls.appendChild(zoomOutBtn);
  wellWrap.appendChild(zoomControls);

  const preview = document.createElement('div');
  preview.className = 'timeline-preview-popup';
  wellWrap.appendChild(preview);

  const clusterPicker = document.createElement('div');
  clusterPicker.className = 'timeline-cluster-picker';
  wellWrap.appendChild(clusterPicker);

  wellCol.appendChild(wellWrap);

  const wellActions = document.createElement('div');
  wellActions.className = 'timeline-well-actions';
  const listToggleBtn = document.createElement('button');
  listToggleBtn.type = 'button';
  listToggleBtn.className = 'timeline-well-action-btn';
  listToggleBtn.textContent = 'List all';
  listToggleBtn.addEventListener('click', function () {
    listPanel.classList.toggle('open');
  });
  wellActions.appendChild(listToggleBtn);
  const fitBtn = document.createElement('button');
  fitBtn.type = 'button';
  fitBtn.className = 'timeline-well-action-btn';
  fitBtn.textContent = 'Fit all';
  fitBtn.addEventListener('click', function () { fitToView(); render(); });
  wellActions.appendChild(fitBtn);
  wellCol.appendChild(wellActions);

  layout.appendChild(wellCol);

  const cardPane = document.createElement('div');
  cardPane.className = 'timeline-card-pane';
  const cardEmpty = document.createElement('p');
  cardEmpty.className = 'lore-empty timeline-card-empty';
  cardEmpty.textContent = 'Tap a moment to read more.';
  cardPane.appendChild(cardEmpty);
  layout.appendChild(cardPane);

  panelEl.appendChild(layout);

  const listPanel = document.createElement('div');
  listPanel.id = 'timeline-list-panel';
  const listHeader = document.createElement('div');
  listHeader.className = 'timeline-list-panel-header';
  const listTitle = document.createElement('h3');
  listTitle.textContent = 'Events & Scenes';
  listHeader.appendChild(listTitle);
  const listCloseBtn = document.createElement('button');
  listCloseBtn.type = 'button';
  listCloseBtn.className = 'timeline-list-panel-close';
  listCloseBtn.textContent = '\u00d7';
  listCloseBtn.addEventListener('click', function () { listPanel.classList.remove('open'); });
  listHeader.appendChild(listCloseBtn);
  listPanel.appendChild(listHeader);
  const listBody = document.createElement('div');
  listBody.id = 'timeline-list';
  listPanel.appendChild(listBody);
  panelEl.appendChild(listPanel);

  // Delegated wiki-link handler for the card pane: opens the linked
  // entity in the SAME panel (stays in Timeline context) rather than
  // switching to the Codex tab, per Gregg's explicit design goal.
  cardPane.addEventListener('click', function (ev) {
    const a = ev.target.closest ? ev.target.closest('a.wiki-link') : null;
    if (!a) return;
    ev.preventDefault();
    openEntityInPanel(a.dataset.entityId);
  });

  dom = { layout: layout, svg: svg, wellWrap: wellWrap, wellInner: wellInner, preview: preview, clusterPicker: clusterPicker, cardPane: cardPane, listPanel: listPanel, listBody: listBody };
  attachStageInteraction();
  fitLayoutHeight();

  // Dismiss the cluster picker on any outside tap/click.
  document.addEventListener('pointerdown', function (e) {
    if (!dom.clusterPicker.classList.contains('show')) return;
    if (dom.clusterPicker.contains(e.target)) return;
    hideClusterPicker();
  });
}

function showClusterPicker(items, anchorEl) {
  const rect = anchorEl.getBoundingClientRect();
  const wrapRect = dom.wellWrap.getBoundingClientRect();
  dom.clusterPicker.innerHTML = '';
  const title = document.createElement('div');
  title.className = 'timeline-cluster-picker-title';
  title.textContent = items.length + ' moments at this instant';
  dom.clusterPicker.appendChild(title);
  items.slice().sort(function (a, b) { return a.t - b.t; }).forEach(function (d) {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'timeline-row';
    row.addEventListener('click', function () { hideClusterPicker(); openEntityInPanel(d.entity.id); });
    const dateSpan = document.createElement('span');
    dateSpan.className = 'timeline-row-date';
    appendDateSegments(dateSpan, d.entity.date || '');
    const nameSpan = document.createElement('span');
    nameSpan.className = 'timeline-row-name';
    nameSpan.textContent = d.entity.name;
    const catSpan = document.createElement('span');
    catSpan.className = 'timeline-row-cat ' + catClass(d.entity.category);
    catSpan.textContent = d.entity.category;
    row.appendChild(dateSpan); row.appendChild(nameSpan); row.appendChild(catSpan);
    dom.clusterPicker.appendChild(row);
  });
  let left = rect.left - wrapRect.left + 16;
  const top = rect.top - wrapRect.top - 10;
  if (left > wrapRect.width - 280) left = rect.left - wrapRect.left - 296;
  dom.clusterPicker.style.left = Math.max(8, left) + 'px';
  dom.clusterPicker.style.top = Math.max(8, top) + 'px';
  dom.clusterPicker.classList.add('show');
}
function hideClusterPicker() { dom.clusterPicker.classList.remove('show'); }

function openEntityInPanel(entityId) {
  const entity = dated.find(function (e) { return e.id === entityId; });
  if (!entity) return;
  selectedId = entityId;
  activeTab = 'lore';
  renderCardPane();
  centerOnIfOffscreen(entity);
  render();
}

function renderCardPane() {
  const gmView = isGmView();
  dom.cardPane.innerHTML = '';
  const entity = selectedId ? dated.find(function (e) { return e.id === selectedId; }) : null;
  if (!entity) {
    const emptyP = document.createElement('p');
    emptyP.className = 'lore-empty timeline-card-empty';
    emptyP.textContent = 'Tap a moment to read more.';
    dom.cardPane.appendChild(emptyP);
    return;
  }
  const card = document.createElement('div');
  card.className = 'codex-entity-card';
  dom.cardPane.appendChild(card);
  let headingRightExtra = null;
  if (gmView) {
    headingRightExtra = document.createElement('button');
    headingRightExtra.type = 'button';
    headingRightExtra.className = 'entity-map-link timeline-edit-in-codex-link';
    headingRightExtra.title = 'Edit in Codex';
    headingRightExtra.textContent = 'Edit in Codex';
    headingRightExtra.addEventListener('click', function () {
      switchToCodexEntity(entity.id);
      enterEntityEditMode(entity);
    });
  }
  renderEntityViewCard(card, entity, gmView, {
    allowEdit: false,
    activeTab: activeTab,
    onTabChange: function (tabKey) { activeTab = tabKey; renderCardPane(); },
    onRelatedClick: function (id) { openEntityInPanel(id); },
    headingRightExtra: headingRightExtra
  });
}

// --- Data refresh (visibility changes, entity edits) -----------------
function fitLayoutHeight() {
  if (!dom || !dom.layout) return;
  const rect = dom.layout.getBoundingClientRect();
  const h = window.innerHeight - rect.top - 16; // small bottom breathing room
  dom.layout.style.height = Math.max(320, h) + 'px';
}

function refresh() {
  const gmView = isGmView();
  dated = state.allEntities
    .filter(function (e) {
      return (e.category === 'Scene' || e.category === 'Event')
        && typeof e.dateSort === 'number' && isFinite(e.dateSort);
    })
    .filter(function (e) { return gmView || isEntityPlayerVisible(e.id); })
    .sort(function (a, b) { return a.dateSort - b.dateSort; });

  fitLayoutHeight();
  renderListPanel();
  if (selectedId && !dated.find(function (e) { return e.id === selectedId; })) {
    selectedId = null; // e.g. visibility toggled off out from under a player
  }
  renderCardPane();

  if (!dated.length) {
    dom.wellWrap.classList.add('timeline-well-empty');
    while (dom.svg.firstChild) dom.svg.removeChild(dom.svg.firstChild);
    return;
  }
  dom.wellWrap.classList.remove('timeline-well-empty');
  if (!fitted) { fitToView(); fitted = true; }
  render();
}

function renderListPanel() {
  dom.listBody.innerHTML = '';
  if (!dated.length) {
    const emptyP = document.createElement('p');
    emptyP.className = 'lore-empty';
    emptyP.textContent = '(no dated Scenes or Events yet)';
    dom.listBody.appendChild(emptyP);
    return;
  }
  dated.forEach(function (entity) {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'timeline-row';
    if (entity.id === selectedId) row.classList.add('active');
    row.addEventListener('click', function () { openEntityInPanel(entity.id); });

    const dateSpan = document.createElement('span');
    dateSpan.className = 'timeline-row-date';
    appendDateSegments(dateSpan, entity.date || '');
    row.appendChild(dateSpan);

    const nameSpan = document.createElement('span');
    nameSpan.className = 'timeline-row-name';
    nameSpan.textContent = entity.name;
    row.appendChild(nameSpan);

    const catSpan = document.createElement('span');
    catSpan.className = 'timeline-row-cat ' + catClass(entity.category);
    catSpan.textContent = entity.category;
    row.appendChild(catSpan);

    dom.listBody.appendChild(row);
  });
}

function fitToView() {
  const rect = dom.svg.getBoundingClientRect();
  const dim = rect.height || 400;
  if (!dated.length) return;
  // Explicit min/max over every dated entity's t, rather than trusting
  // dated[0]/dated[last] from the sort -- Array.prototype.sort treats
  // a NaN-producing comparator result as "equal" (leaves those
  // elements in their original relative position instead of moving
  // them to an extreme), so if any entity's dateSort were ever
  // non-numeric this would silently produce a wrong span. Combined
  // with refresh()'s isFinite(dateSort) filter, this should be
  // airtight regardless -- but airtight framing math is cheap
  // insurance either way.
  const ts = dated.map(tOf);
  const tMin = Math.min.apply(null, ts);
  const tMax = Math.max.apply(null, ts);
  const span = (tMax - tMin) || 1;
  scale = (dim - 80) / span;
  offset = tMin - (40 / scale);
}

function centerOnIfOffscreen(entity) {
  const rect = dom.svg.getBoundingClientRect();
  const dim = rect.height || 400;
  const px = (tOf(entity) - offset) * scale;
  if (px >= 0 && px <= dim) return; // already visible, don't yank the view
  offset = tOf(entity) - (dim / 2) / scale;
}

// --- Gradient background: fear (past) <-> hope (future), the 50/50
// blend point tracking the Reference Point's current on-screen fraction
// rather than sitting fixed at the well's midpoint. Colors read from the
// real CSS custom properties (single source of truth with styles.css,
// no drift if the palette changes) via getComputedStyle. ---
function mixHex(hexA, hexB, t) {
  const a = hexA.replace('#', ''), b = hexB.replace('#', '');
  const ar = parseInt(a.slice(0, 2), 16), ag = parseInt(a.slice(2, 4), 16), ab = parseInt(a.slice(4, 6), 16);
  const br = parseInt(b.slice(0, 2), 16), bg = parseInt(b.slice(2, 4), 16), bb = parseInt(b.slice(4, 6), 16);
  const r = Math.round(ar + (br - ar) * t), g = Math.round(ag + (bg - ag) * t), bch = Math.round(ab + (bb - ab) * t);
  return '#' + [r, g, bch].map(function (v) { return v.toString(16).padStart(2, '0'); }).join('');
}
function updateWellGradient() {
  const cs = getComputedStyle(document.documentElement);
  const fear = cs.getPropertyValue('--fear').trim() || '#5B6FA8';
  const hope = cs.getPropertyValue('--hope').trim() || '#D9A441';
  const rect = dom.svg.getBoundingClientRect();
  const dim = rect.height || 400;
  const epochPx = (0 - offset) * scale;
  const epochFrac = Math.max(0, Math.min(1, epochPx / dim));
  const blend = mixHex(fear, hope, 0.5);
  // The gradient must be set on the INNER div, not the outer wrap --
  // .timeline-well-inner carries its own opaque background (needed as
  // a pre-first-render fallback) that fully covers whatever's behind
  // it, so setting this on wellWrap (the outer, unclipped div added
  // for the popup-clipping fix) silently obscured the gradient
  // entirely behind the inner div's solid color.
  dom.wellInner.style.background =
    'linear-gradient(to bottom, ' +
    fear + ' 0%, ' + blend + ' ' + (epochFrac * 100).toFixed(1) + '%, ' + hope + ' 100%)';
}

// --- Clustering: bucket nodes whose screen distance < threshold ------
function computeLayout(dim) {
  const threshold = 34; // px
  const positioned = dated.map(function (d) { return { entity: d, t: tOf(d), px: (tOf(d) - offset) * scale }; })
    .filter(function (d) { return d.px > -60 && d.px < dim + 60; })
    .sort(function (a, b) { return a.px - b.px; });

  const clusters = [];
  positioned.forEach(function (d) {
    const last = clusters[clusters.length - 1];
    if (last && (d.px - last.items[last.items.length - 1].px) < threshold) {
      last.items.push(d);
      last.px = last.items.reduce(function (s, i) { return s + i.px; }, 0) / last.items.length;
    } else {
      clusters.push({ items: [d], px: d.px });
    }
  });
  return clusters;
}

function niceTicks() {
  const targetPxGap = 90;
  const yearsPerTick = targetPxGap / scale;
  const magnitude = Math.pow(10, Math.floor(Math.log10(Math.max(yearsPerTick, 1e-6))));
  const norm = yearsPerTick / magnitude;
  let step;
  if (norm < 1.5) step = 1 * magnitude;
  else if (norm < 3.5) step = 2 * magnitude;
  else if (norm < 7.5) step = 5 * magnitude;
  else step = 10 * magnitude;
  return step;
}

function catClass(category) { return 'cat-' + (category || '').toLowerCase(); }

// SVG analog of codex.js's appendDateSegments: builds <tspan> children
// instead of HTML text nodes/<b> elements, since SVG <text> can't hold
// arbitrary HTML. Bold segments get the .timeline-date-bold class
// (font-weight, set in CSS) rather than a <b> tag, which SVG doesn't
// have.
function appendDateTspans(textEl, raw) {
  const svgns = 'http://www.w3.org/2000/svg';
  formatDateSegments(raw).forEach(function (seg) {
    const tspan = document.createElementNS(svgns, 'tspan');
    if (seg.bold) tspan.setAttribute('class', 'timeline-date-bold');
    tspan.textContent = seg.text;
    textEl.appendChild(tspan);
  });
}

function render() {
  hideClusterPicker();
  const rect = dom.svg.getBoundingClientRect();
  const dim = rect.height || 400;
  const crossDim = rect.width || 200;
  // Generous share of the width for the spine's left column (zoom
  // control + axis tick labels, which can now run to 3 units wide
  // e.g. "3500ya, 45da, 8ha") -- previously a tight 70px/22% left very
  // little room for node titles on the right and truncated them well
  // before actually running out of space.
  const spineCross = Math.min(160, crossDim * 0.32);
  const rightMargin = 16;

  updateWellGradient();

  const svgns = 'http://www.w3.org/2000/svg';
  while (dom.svg.firstChild) dom.svg.removeChild(dom.svg.firstChild);
  const mk = function (tag, attrs) {
    const el = document.createElementNS(svgns, tag);
    for (const k in attrs) el.setAttribute(k, attrs[k]);
    return el;
  };

  dom.svg.appendChild(mk('line', { class: 'timeline-spine', x1: spineCross, y1: 0, x2: spineCross, y2: dim }));

  const step = niceTicks();
  const granularity = tickGranularity(step);
  // Integer multiples of step, not accumulated t += step -- floating
  // point drift from repeated addition meant t was rarely EXACTLY 0
  // even when a tick should land precisely on epoch, and combined with
  // fmtYears' old rounding-based "epoch" check, produced multiple
  // mislabeled ticks near epoch. n * step is exact at n=0.
  const nStart = Math.ceil((offset - step) / step);
  const nEnd = Math.floor((offset + dim / scale + step) / step);
  for (let n = nStart; n <= nEnd; n++) {
    const t = n * step;
    const px = (t - offset) * scale;
    if (px < -20 || px > dim + 20) continue;
    const g = mk('g', { class: 'timeline-axis-tick' });
    g.appendChild(mk('line', { x1: spineCross - 5, y1: px, x2: spineCross + 5, y2: px }));
    const txt = mk('text', { x: spineCross - 10, y: px + 3, 'text-anchor': 'end' });
    appendDateTspans(txt, fmtTick(Math.round(t * YEAR_SECONDS), granularity));
    g.appendChild(txt);
    dom.svg.appendChild(g);
  }

  const clusters = computeLayout(dim);
  lastClusters = clusters;
  clusters.forEach(function (cl, idx) {
    const px = cl.px;
    if (cl.items.length === 1) {
      const d = cl.items[0];
      const cx = spineCross, cy = px;
      const dot = mk('circle', { class: 'timeline-node-dot ' + catClass(d.entity.category), cx: cx, cy: cy, r: 6 });
      dot.setAttribute('data-role', 'node');
      dot.dataset.entityId = d.entity.id;
      if (d.entity.id === selectedId) dot.classList.add('selected');
      dot.addEventListener('pointerenter', function (e) { if (e.pointerType === 'mouse') showPreview(d.entity, dot); });
      dot.addEventListener('pointerleave', function (e) { if (e.pointerType === 'mouse') hidePreview(); });
      dom.svg.appendChild(dot);

      // Truncate against the ACTUAL available width (measured via
      // getComputedTextLength, not a flat character-count guess) --
      // the well is often much wider than 26 characters' worth of
      // text, especially now that the spine sits further right, so a
      // fixed cutoff was truncating titles well before they needed it.
      const label = mk('text', { class: 'timeline-node-label', x: spineCross + 14, y: cy - 2 });
      label.textContent = d.entity.name;
      dom.svg.appendChild(label);
      const availableWidth = Math.max(40, crossDim - (spineCross + 14) - rightMargin);
      if (label.getComputedTextLength() > availableWidth) {
        let lo = 0, hi = d.entity.name.length;
        while (lo < hi) {
          const mid = Math.ceil((lo + hi) / 2);
          label.textContent = d.entity.name.slice(0, mid) + '\u2026';
          if (label.getComputedTextLength() <= availableWidth) lo = mid; else hi = mid - 1;
        }
        label.textContent = lo > 0 ? d.entity.name.slice(0, lo) + '\u2026' : '\u2026';
      }

      const dateLbl = mk('text', { class: 'timeline-node-date', x: spineCross + 14, y: cy + 12 });
      appendDateTspans(dateLbl, d.entity.date || '');
      dom.svg.appendChild(dateLbl);
    } else {
      const cx = spineCross, cy = px;
      const g = mk('g', { class: 'timeline-cluster-dot' });
      g.setAttribute('data-role', 'cluster');
      g.dataset.clusterIndex = idx;
      g.appendChild(mk('circle', { cx: cx, cy: cy, r: 12 }));
      const t = mk('text', { x: cx, y: cy });
      t.textContent = cl.items.length;
      g.appendChild(t);
      dom.svg.appendChild(g);
    }
  });
}

function showPreview(entity, el) {
  const gmView = isGmView();
  const rect = el.getBoundingClientRect();
  const wrapRect = dom.wellWrap.getBoundingClientRect();
  dom.preview.innerHTML = '';
  dom.preview.appendChild(buildEntityPreviewCard(entity, gmView));
  let left = rect.left - wrapRect.left + 16;
  const top = rect.top - wrapRect.top - 10;
  if (left > wrapRect.width - 260) left = rect.left - wrapRect.left - 276;
  dom.preview.style.left = Math.max(8, left) + 'px';
  dom.preview.style.top = Math.max(8, top) + 'px';
  dom.preview.classList.add('show');
}
function hidePreview() { dom.preview.classList.remove('show'); }

// --- Interaction: wheel zoom, drag pan, pinch, tap. See mockup-session
// notes -- calling render() on any pointermove (even sub-pixel tap
// jitter) rebuilds the whole SVG and destroys the element under the
// finger/cursor before pointerup can fire, silently eating every tap.
// Fix: don't touch the DOM until movement crosses a small threshold; a
// tap that never crosses it is resolved by hit-testing the still-intact
// original element on pointerup instead of relying on the browser's
// 'click' (which pointer-capture would re-target away from the dot). ---
function attachStageInteraction() {
  const svg = dom.svg;
  const TAP_THRESHOLD = 6;
  let panPointerId = null;
  let isPanning = false;
  let downX = 0, downY = 0, dragStartY = 0, offsetStart = 0;

  svg.addEventListener('wheel', function (e) {
    e.preventDefault();
    const rect = svg.getBoundingClientRect();
    const pos = e.clientY - rect.top;
    const tAtPointer = offset + pos / scale;
    const factor = Math.pow(1.0016, -e.deltaY);
    scale *= factor;
    offset = tAtPointer - pos / scale;
    render();
  }, { passive: false });

  svg.addEventListener('pointerdown', function (e) {
    if (e.pointerType === 'touch' && e.isPrimary === false) return;
    panPointerId = e.pointerId;
    isPanning = false;
    downX = e.clientX; downY = e.clientY;
    dragStartY = e.clientY;
    offsetStart = offset;
  });

  svg.addEventListener('pointermove', function (e) {
    if (e.pointerId !== panPointerId) return;
    const dist = Math.hypot(e.clientX - downX, e.clientY - downY);
    if (!isPanning) {
      if (dist < TAP_THRESHOLD) return;
      isPanning = true;
      svg.classList.add('grabbing');
      hidePreview();
      hideClusterPicker();
      try { svg.setPointerCapture(e.pointerId); } catch (err) { /* no-op */ }
    }
    offset = offsetStart - (e.clientY - dragStartY) / scale;
    render();
  });

  svg.addEventListener('pointerup', function (e) {
    if (e.pointerId !== panPointerId) return;
    if (!isPanning) handleTap(e.target);
    panPointerId = null;
    isPanning = false;
    svg.classList.remove('grabbing');
  });
  ['pointercancel', 'pointerleave'].forEach(function (ev) {
    svg.addEventListener(ev, function (e) {
      if (e.pointerId !== panPointerId) return;
      panPointerId = null;
      isPanning = false;
      svg.classList.remove('grabbing');
    });
  });

  let pinchStartDist = null;
  let pinchStartScale = 1;
  svg.addEventListener('touchstart', function (e) {
    if (e.touches.length === 2) {
      panPointerId = null;
      isPanning = false;
      svg.classList.remove('grabbing');
      const dx = e.touches[0].clientX - e.touches[1].clientX;
      const dy = e.touches[0].clientY - e.touches[1].clientY;
      pinchStartDist = Math.hypot(dx, dy);
      pinchStartScale = scale;
    }
  }, { passive: true });
  svg.addEventListener('touchmove', function (e) {
    if (e.touches.length === 2 && pinchStartDist) {
      const dx = e.touches[0].clientX - e.touches[1].clientX;
      const dy = e.touches[0].clientY - e.touches[1].clientY;
      const dist = Math.hypot(dx, dy);
      scale = pinchStartScale * (dist / pinchStartDist);
      render();
    }
  }, { passive: true });
  svg.addEventListener('touchend', function (e) { if (e.touches.length < 2) pinchStartDist = null; });

  function handleTap(target) {
    const el = target.closest && target.closest('[data-role]');
    if (!el) {
      hideClusterPicker();
      return;
    }
    if (el.dataset.role === 'node') {
      hideClusterPicker();
      openEntityInPanel(el.dataset.entityId);
    } else if (el.dataset.role === 'cluster') {
      const cl = lastClusters[parseInt(el.dataset.clusterIndex, 10)];
      if (!cl) return;
      const ts = cl.items.map(function (d) { return d.t; });
      const tMin = Math.min.apply(null, ts), tMax = Math.max.apply(null, ts);
      const span = tMax - tMin;
      if (span <= 0) {
        // Members share the exact same instant -- no amount of zoom
        // will ever spatially separate them (this was the actual bug:
        // a flat scale multiplier can't resolve a true tie). Show a
        // small picker instead, same idea as a map-cluster spiderfy.
        showClusterPicker(cl.items, el);
        return;
      }
      hideClusterPicker();
      // "Zoom to bounds": stretch the cluster's own t-span to occupy a
      // generous portion of the viewport, same idea as Leaflet marker
      // clusters zooming to fit their members. Re-clusters and can be
      // tapped again for dense sub-clusters, same as Leaflet's.
      const rect = svg.getBoundingClientRect();
      const dim = rect.height || 400;
      const targetT = tMin + span / 2;
      const targetScale = (dim * 0.6) / span;
      scale = Math.max(targetScale, scale * 1.5); // always zoom in, never out
      offset = targetT - (dim / 2) / scale;
      render();
    }
  }

  window.addEventListener('resize', function () {
    if (!built || !panelEl.classList.contains('active')) return;
    fitLayoutHeight();
    render();
  });
}

function renderTimeline() {
  if (!built) return; // lazy: don't build DOM until the tab is first opened
  // notifyVisibilityChange() fires on every Firestore entity update
  // regardless of which tab is active -- e.g. saving from the "Edit in
  // Codex" flow fires it while #timeline-panel is display:none. A
  // hidden element's getBoundingClientRect() is all zeros, so
  // fitLayoutHeight() would compute a garbage height from that and
  // write it as inline style while hidden. Skipping entirely while not
  // the active tab avoids that; ensureTimelineTabReady() already does
  // a full refresh() on every re-open, so nothing is lost by not
  // keeping hidden-tab data live.
  if (!panelEl.classList.contains('active')) return;
  refresh();
}

function ensureTimelineTabReady() {
  const firstBuild = !built;
  built = true;
  if (firstBuild) buildShell();
  refresh();
}

registerVisibilityChangeHandler(renderTimeline);

export { ensureTimelineTabReady };
