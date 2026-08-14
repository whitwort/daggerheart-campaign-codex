import { state } from './state.js';
import {
  registerVisibilityChangeHandler, isEntityPlayerVisible,
  renderList, renderDetailForSelected, clearCodexSearchInput
} from './codex.js';

const panelEl = document.getElementById('timeline-panel');
let built = false;

// Same "jump to this entity in the Codex tab" pattern as map.js's
// switchToCodexEntity — duplicated locally rather than shared, since
// codex.js doesn't export selectEntity itself (only the inverted-dependency
// registration hooks), matching the existing map.js precedent.
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

function buildTimelinePanel() {
  panelEl.innerHTML = '';

  const introP = document.createElement('p');
  introP.className = 'admin-hint';
  introP.appendChild(document.createTextNode('Dates use the campaign\u2019s shorthand notation \u2014 see '));
  const explainerEntity = state.allEntities.find(function (e) {
    return (e.name || '').trim().toLowerCase() === 'dates and time';
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
    introP.appendChild(document.createTextNode('\u201cDates and Time\u201d (Game Mechanics)'));
  }
  introP.appendChild(document.createTextNode(' for the full explanation.'));
  panelEl.appendChild(introP);

  const gmView = isGmView();
  const dated = state.allEntities
    .filter(function (e) { return (e.category === 'Scene' || e.category === 'Event') && e.dateSort !== null && e.dateSort !== undefined; })
    .filter(function (e) { return gmView || isEntityPlayerVisible(e.id); })
    .sort(function (a, b) { return a.dateSort - b.dateSort; });

  if (!dated.length) {
    const emptyP = document.createElement('p');
    emptyP.className = 'lore-empty';
    emptyP.textContent = '(no dated Scenes or Events yet)';
    panelEl.appendChild(emptyP);
    return;
  }

  const listDiv = document.createElement('div');
  listDiv.id = 'timeline-list';
  dated.forEach(function (entity) {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'timeline-row';
    row.addEventListener('click', function () { switchToCodexEntity(entity.id); });

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

    listDiv.appendChild(row);
  });
  panelEl.appendChild(listDiv);
}

function isGmView() {
  return state.currentRole === 'gm' && !state.gmPreviewAsPlayer;
}

function renderTimeline() {
  if (!built) return; // lazy: don't build DOM until the tab is first opened
  buildTimelinePanel();
}

function ensureTimelineTabReady() {
  built = true;
  buildTimelinePanel();
}

registerVisibilityChangeHandler(renderTimeline);

export { ensureTimelineTabReady };
