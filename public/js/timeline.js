import { state } from './state.js';
import {
  registerVisibilityChangeHandler, isEntityPlayerVisible,
  renderList, renderDetailForSelected, clearCodexSearchInput,
  renderEntityViewCard, buildEntityPreviewCard
} from './codex.js';

const panelEl = document.getElementById('timeline-panel');
let built = false;

// Mirrors dates.js's internal sort-key ratio (1y = 256d = 256*16h =
// 256*16*64m = 256*16*64*64s -- see dates.js UNIT_SECONDS). Not imported
// directly since dates.js doesn't export it; duplicated here purely for
// converting entity.dateSort into an approximate "years" float for axis
// tick spacing/labels. Entity node labels always use the real stored
// entity.date string, never this approximation.
const YEAR_SECONDS = 64 * 64 * 16 * 256;

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

function tOf(entity) { return entity.dateSort / YEAR_SECONDS; }

function fmtYears(t) {
  if (Math.abs(t) < 1 / 365) {
    const days = Math.round(t * 365);
    return days === 0 ? 'epoch' : (days > 0 ? days + 'd' : Math.abs(days) + 'd ago');
  }
  const y = Math.round(t);
  return y === 0 ? 'epoch' : (y > 0 ? y + 'y' : Math.abs(y) + 'ya');
}

// --- Build the static shell once (toolbar, well+svg+zoom controls+
// popup, card pane, list drawer). Data-dependent content is (re)rendered
// into it by refresh() on every visibility/data change. ---
function buildShell() {
  panelEl.innerHTML = '';

  const toolbar = document.createElement('div');
  toolbar.className = 'timeline-toolbar';

  const listToggleBtn = document.createElement('button');
  listToggleBtn.type = 'button';
  listToggleBtn.className = 'action-btn-compact';
  listToggleBtn.textContent = 'Event / Scene list';
  listToggleBtn.addEventListener('click', function () {
    listPanel.classList.toggle('open');
  });
  toolbar.appendChild(listToggleBtn);

  const fitBtn = document.createElement('button');
  fitBtn.type = 'button';
  fitBtn.className = 'action-btn-compact';
  fitBtn.textContent = 'Fit all';
  fitBtn.addEventListener('click', function () { fitToView(); render(); });
  toolbar.appendChild(fitBtn);

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

  panelEl.appendChild(toolbar);
  panelEl.appendChild(introP);

  const layout = document.createElement('div');
  layout.className = 'timeline-layout';

  const wellWrap = document.createElement('div');
  wellWrap.className = 'timeline-well-wrap';

  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'timeline-svg');
  wellWrap.appendChild(svg);

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

  layout.appendChild(wellWrap);

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

  dom = { svg: svg, wellWrap: wellWrap, preview: preview, cardPane: cardPane, listPanel: listPanel, listBody: listBody };
  attachStageInteraction();
}

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
  renderEntityViewCard(card, entity, gmView, {
    allowEdit: false,
    activeTab: activeTab,
    onTabChange: function (tabKey) { activeTab = tabKey; renderCardPane(); },
    onRelatedClick: function (id) { openEntityInPanel(id); }
  });
}

// --- Data refresh (visibility changes, entity edits) -----------------
function refresh() {
  const gmView = isGmView();
  dated = state.allEntities
    .filter(function (e) { return (e.category === 'Scene' || e.category === 'Event') && e.dateSort !== null && e.dateSort !== undefined; })
    .filter(function (e) { return gmView || isEntityPlayerVisible(e.id); })
    .sort(function (a, b) { return a.dateSort - b.dateSort; });

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
    dateSpan.textContent = entity.date || '';
    row.appendChild(dateSpan);

    const nameSpan = document.createElement('span');
    nameSpan.className = 'timeline-row-name';
    nameSpan.textContent = entity.name;
    row.appendChild(nameSpan);

    const catSpan = document.createElement('span');
    catSpan.className = 'timeline-row-cat';
    catSpan.textContent = entity.category;
    row.appendChild(catSpan);

    dom.listBody.appendChild(row);
  });
}

function fitToView() {
  const rect = dom.svg.getBoundingClientRect();
  const dim = rect.height || 400;
  if (!dated.length) return;
  const tMin = tOf(dated[0]);
  const tMax = tOf(dated[dated.length - 1]);
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
  dom.wellWrap.style.background =
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

function render() {
  const rect = dom.svg.getBoundingClientRect();
  const dim = rect.height || 400;
  const crossDim = rect.width || 200;
  const spineCross = Math.min(70, crossDim * 0.22);

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
  const startTick = Math.floor(offset / step) * step;
  for (let t = startTick; (t - offset) * scale < dim + step * scale; t += step) {
    const px = (t - offset) * scale;
    if (px < -20 || px > dim + 20) continue;
    const g = mk('g', { class: 'timeline-axis-tick' });
    g.appendChild(mk('line', { x1: spineCross - 5, y1: px, x2: spineCross + 5, y2: px }));
    const txt = mk('text', { x: spineCross - 10, y: px + 3, 'text-anchor': 'end' });
    txt.textContent = fmtYears(t);
    g.appendChild(txt);
    dom.svg.appendChild(g);
  }

  const clusters = computeLayout(dim);
  clusters.forEach(function (cl) {
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

      const label = mk('text', { class: 'timeline-node-label', x: spineCross + 14, y: cy - 2 });
      label.textContent = d.entity.name.length > 26 ? d.entity.name.slice(0, 25) + '\u2026' : d.entity.name;
      dom.svg.appendChild(label);
      const dateLbl = mk('text', { class: 'timeline-node-date', x: spineCross + 14, y: cy + 12 });
      dateLbl.textContent = d.entity.date || '';
      dom.svg.appendChild(dateLbl);
    } else {
      const cx = spineCross, cy = px;
      const g = mk('g', { class: 'timeline-cluster-dot' });
      g.setAttribute('data-role', 'cluster');
      g.dataset.tMin = cl.items[0].t;
      g.dataset.tMax = cl.items[cl.items.length - 1].t;
      g.dataset.cy = cy;
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
    if (!el) return;
    if (el.dataset.role === 'node') {
      openEntityInPanel(el.dataset.entityId);
    } else if (el.dataset.role === 'cluster') {
      const tMin = parseFloat(el.dataset.tMin), tMax = parseFloat(el.dataset.tMax);
      const targetT = tMin + (tMax - tMin) / 2;
      const cy = parseFloat(el.dataset.cy);
      scale *= 4;
      offset = targetT - (cy / scale);
      render();
    }
  }

  window.addEventListener('resize', function () { if (built) render(); });
}

function renderTimeline() {
  if (!built) return; // lazy: don't build DOM until the tab is first opened
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
