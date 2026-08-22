// Plain (i) info popup -- hover (desktop) or tap (touch) to show a
// small parchment popup anchored off the icon's own corner. Same
// "hover opens, click-while-open applies" interaction as character-
// sheet.js's buildSuggestionControl -- optional opts.onApply is
// called once, on the click that closes an already-open popup (never
// on the hover/first-tap that opens it). Unlike that control, this
// one carries no notion of "match"/"updated" state -- callers decide
// internally whether applying does anything (e.g. only if the current
// value is still untouched), so the icon always looks the same
// regardless of whether a click would actually change anything.
// Deliberately a standalone leaf module (no shared state, no
// Firestore) rather than folded into character-sheet.js or
// character-deck.js, since BOTH need it and neither currently imports
// the other (see those files' own header comments on staying separate
// editing surfaces).
//
// Single-open-popup tracker, same convention as
// character-sheet.js's closeOpenSuggestionPopup / character-deck.js's
// openCardPickerPopup -- opening one closes any other info popup
// already open (including ones from the OTHER caller module, since
// this tracker is shared across every buildInfoPopup instance).
let closeOpenInfoPopup = null;

// title: icon label, defaults to 'i'. lines: array of strings, each
// rendered as its own popup line (falsy entries skipped) -- callers
// pass e.g. ['Suggested Armor: Chain'] or ['Suggested Traits: Agility, Presence'].
// An empty/all-falsy lines array still gets an icon (never hidden, same
// "there's a hook here even with nothing to show yet" reasoning as the
// suggestion indicator) with a single "Not available" line.
function buildInfoPopup(lines, opts) {
  const options = opts || {};
  const wrap = document.createElement('span');
  wrap.className = 'character-info-wrap' + (options.wrapClass ? ' ' + options.wrapClass : '');

  const icon = document.createElement('button');
  icon.type = 'button';
  icon.className = 'character-info-icon';
  icon.textContent = options.iconText || 'i';
  if (options.title) icon.title = options.title;
  wrap.appendChild(icon);

  const content = (lines || []).filter(Boolean);

  let popup = null;
  function onDocClick(ev) {
    if (popup && !wrap.contains(ev.target)) closePopup();
  }
  function closePopup() {
    if (!popup) return;
    document.removeEventListener('click', onDocClick);
    if (popup.parentNode) popup.parentNode.removeChild(popup);
    popup = null;
    if (closeOpenInfoPopup === closePopup) closeOpenInfoPopup = null;
  }
  function openPopup() {
    if (popup) return;
    if (closeOpenInfoPopup) closeOpenInfoPopup();
    popup = document.createElement('div');
    popup.className = 'character-info-popup';
    if (content.length) {
      content.forEach(function (line) {
        const lineEl = document.createElement('div');
        lineEl.className = 'character-info-popup-line';
        lineEl.textContent = line;
        popup.appendChild(lineEl);
      });
    } else {
      const lineEl = document.createElement('div');
      lineEl.className = 'character-info-popup-line';
      lineEl.textContent = 'Not available.';
      popup.appendChild(lineEl);
    }
    wrap.appendChild(popup);
    closeOpenInfoPopup = closePopup;
    setTimeout(function () { document.addEventListener('click', onDocClick); }, 0);
  }

  icon.addEventListener('mouseenter', openPopup);
  icon.addEventListener('click', function (e) {
    e.stopPropagation();
    if (popup) {
      if (options.onApply) options.onApply();
      closePopup();
    } else {
      openPopup();
    }
  });

  return wrap;
}

export { buildInfoPopup };
