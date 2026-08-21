// picker-panel.js — shared floating picker-panel machinery. Extracted
// from four near-identical copies (codex.js buildGalleryPickerPanel,
// encounters.js openAdversaryPicker's inline builder, character-cards.js
// buildFloatingPickerPanel, plus the outside-click/Escape dismissal
// block repeated in every pattern-A picker). This module deliberately
// imports NOTHING, so any module can use it without creating an import
// cycle — the original reason character-cards.js carried its own copy
// (avoiding codex.js <-> character-cards.js) no longer applies.

// Creates a floating panel on document.body:
//   { panel, header, body }
// opts (all optional):
//   className — extra class(es) on .gallery-picker-panel
//   title     — header text
//   draggable — drag-to-move the panel via its header (pointer events)
// Callers own the panel's lifetime: either wire attachPickerDismiss
// below, or remove the panel themselves (e.g. Escape/Close-button-only
// panels that must survive outside clicks, like the adversary picker's
// multi-add and the Set-portrait flow's click-through to the gallery).
function buildPickerPanel(opts) {
  opts = opts || {};
  const panel = document.createElement('div');
  panel.className = 'gallery-picker-panel' + (opts.className ? ' ' + opts.className : '');
  const header = document.createElement('div');
  header.className = 'gallery-picker-header';
  if (opts.title) header.textContent = opts.title;
  panel.appendChild(header);
  const body = document.createElement('div');
  body.className = 'gallery-picker-body';
  panel.appendChild(body);
  document.body.appendChild(panel);
  if (opts.draggable) makePanelDraggable(panel, header);
  return { panel: panel, header: header, body: body };
}

// Drag-to-move via the header. On first drag the panel's computed
// position is frozen into explicit left/top (right unset) so subsequent
// deltas apply from where it actually is.
function makePanelDraggable(panel, header) {
  let panelDrag = null;
  header.addEventListener('pointerdown', function (ev) {
    const rect = panel.getBoundingClientRect();
    panel.style.left = rect.left + 'px';
    panel.style.top = rect.top + 'px';
    panel.style.right = 'auto';
    header.setPointerCapture(ev.pointerId);
    panelDrag = { startX: ev.clientX, startY: ev.clientY, origLeft: rect.left, origTop: rect.top };
  });
  header.addEventListener('pointermove', function (ev) {
    if (!panelDrag) return;
    panel.style.left = (panelDrag.origLeft + (ev.clientX - panelDrag.startX)) + 'px';
    panel.style.top = (panelDrag.origTop + (ev.clientY - panelDrag.startY)) + 'px';
  });
  function endPanelDrag() { panelDrag = null; }
  header.addEventListener('pointerup', endPanelDrag);
  header.addEventListener('pointercancel', endPanelDrag);
}

// Standard dismissal: click outside the panel, or Escape, closes it.
// Returns close() for the caller's own Cancel/select paths. The
// document click listener is deferred by a tick because the SAME click
// that opened the panel (the triggering button's own event) is still
// bubbling up to document when this would otherwise attach
// synchronously — it would close the panel the instant it opens.
// close() is idempotent; optional onClose runs once, after listener
// removal and panel removal.
function attachPickerDismiss(panel, onClose) {
  function onDocClick(ev) { if (!panel.contains(ev.target)) close(); }
  function onKeydown(ev) { if (ev.key === 'Escape') close(); }
  setTimeout(function () { document.addEventListener('click', onDocClick); }, 0);
  document.addEventListener('keydown', onKeydown);
  let closed = false;
  function close() {
    if (closed) return;
    closed = true;
    document.removeEventListener('click', onDocClick);
    document.removeEventListener('keydown', onKeydown);
    panel.remove();
    if (onClose) onClose();
  }
  return close;
}

export { buildPickerPanel, attachPickerDismiss };
