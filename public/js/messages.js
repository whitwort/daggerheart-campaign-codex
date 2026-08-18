// messages.js -- Phase 14 S6. The Messages tray (phase-14-design.md §6.6)
// and the unlock-notification Campaign tab (§6.7/D9): GM<->player direct
// messaging over threads/{playerEmail} + its messages subcollection (the
// app's FIRST subcollection), plus the notifications digest.
//
// Layout (mockup approved by Gregg this session): a small tab strip docked
// bottom-RIGHT (not full-width) so the full-height Map/Timeline wells stay
// mostly unobscured on iPad; the expanded panel floats above the strip and
// over content -- it never reflows the wells (R3).
//
// Listener model:
//   - GM: full `threads` collection + full `notifications` collection
//     (rules: isGM read). The notifications listener doubles as the data
//     source for the Admin > Notifications cleanup card (§6.7's "GM gets
//     an Admin cleanup action"), rendered from this module into
//     #admin-notifications-body -- admin.js is deliberately untouched:
//     admin.js importing from this module would be harmless, but this
//     module imports codex.js, and codex.js -> admin.js already exists,
//     so an admin.js -> messages.js edge would close a NEW import cycle
//     (codex -> admin -> messages -> codex). Rendering from here avoids
//     it entirely.
//   - Player: own threads/{email} doc + notifications where
//     recipientEmail==self (both query shapes are exactly what rules
//     allow -- a broader listener would be permission-denied and die
//     permanently, the standing listener gotcha).
//   - Open thread's messages subcollection: ONE dynamic listener, manual
//     lifecycle keyed by state.openThreadKey (pattern precedent: the
//     per-entity images listener, entityImagesUnsub). Attached on first
//     open of a thread tab, re-pointed when a different thread tab is
//     opened, kept attached across collapse/expand (cheap, and keeps the
//     reopen instant).
//
// Unread: thread.lastMessageAt > my own read stamp (gmLastReadAt /
// playerLastReadAt). Sending a message stamps the sender's own read field
// in the same write, so unread only ever reflects the OTHER side's
// messages. Campaign unread (player): count of own notifications with
// seenAt == null. GM Campaign unread (Aug 2026 addition, join requests):
// count of joinRequest-kind notifications (GM is recipientEmail on those,
// unlike entity fan-out notifications which the GM only ever sends).
//
// No orderBy in any query here: messages sort client-side on createdAt
// (a just-sent message's local snapshot echo has a null pending
// serverTimestamp, which orderBy handles poorly; client-side sort puts
// null last = newest, which is exactly right for one's own echo), and
// notifications sort client-side too (a where + orderBy combo would need
// a composite index for no real gain at table scale).

import {
  getFirestore, collection, doc, onSnapshot, query, where,
  setDoc, writeBatch, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import { firebaseApp } from './firebase.js';
import { state } from './state.js';
import { attachListener, detachListener, safeSnapshotHandler } from './listeners.js';
import { trackWrite } from './connectivity.js';
import { viewerContext, canSee } from './visibility.js';
import { buildCharacterBadge } from './visibility-ui.js';
import { switchToCodexTabForEntity, applyWikiLinks } from './codex.js';
import { generateDefaultBadgeColor } from './badge-color.js';
import { renderMarkdownInto } from './markdown.js';

const db = getFirestore(firebaseApp);

const trayEl = document.getElementById('msg-tray');
const adminNotificationsBodyEl = document.getElementById('admin-notifications-body');

// Panel resize (Gregg's ask): drag handles on the left edge (width) and
// top edge (height) -- the panel is anchored bottom-right (#msg-tray),
// so growing it means growing LEFT/UP, i.e. width = startWidth - dx and
// height = startHeight - dy, the mirror image of a normal bottom-right
// resize handle. Same pointerdown/pointermove/pointerup + setPointerCapture
// convention as character-deck.js's buildSplitRow drag handle. Floors
// keep the panel from being dragged into uselessness; the width ceiling
// leaves the 0.75rem right-edge gap and a little breathing room, the
// height ceiling leaves room above for the page's own header/nav.
const MSG_PANEL_MIN_WIDTH = 320;
const MSG_PANEL_MIN_HEIGHT = 200;
function msgPanelMaxWidth() { return window.innerWidth - 32; }
function msgPanelMaxHeight() { return window.innerHeight - 96; }

function attachPanelResizeHandles(panel) {
  const leftHandle = document.createElement('div');
  leftHandle.className = 'msg-resize-handle msg-resize-handle-left';
  leftHandle.setAttribute('role', 'separator');
  leftHandle.setAttribute('aria-orientation', 'vertical');
  leftHandle.tabIndex = 0;

  let draggingW = false, startX = 0, startWidth = 0;
  leftHandle.addEventListener('pointerdown', function (ev) {
    draggingW = true;
    startX = ev.clientX;
    startWidth = panel.getBoundingClientRect().width;
    try { leftHandle.setPointerCapture(ev.pointerId); } catch (e) { /* unsupported, drag still works via document fallback */ }
    leftHandle.classList.add('dragging');
    ev.preventDefault();
  });
  leftHandle.addEventListener('pointermove', function (ev) {
    if (!draggingW) return;
    const dx = ev.clientX - startX;
    const next = Math.max(MSG_PANEL_MIN_WIDTH, Math.min(startWidth - dx, msgPanelMaxWidth()));
    panel.style.width = next + 'px';
  });
  function endW(ev) {
    if (!draggingW) return;
    draggingW = false;
    leftHandle.classList.remove('dragging');
    state.msgPanelWidthPx = panel.getBoundingClientRect().width;
    if (ev && ev.pointerId !== undefined) {
      try { leftHandle.releasePointerCapture(ev.pointerId); } catch (e) { /* already released */ }
    }
  }
  leftHandle.addEventListener('pointerup', endW);
  leftHandle.addEventListener('pointercancel', endW);
  panel.appendChild(leftHandle);

  const topHandle = document.createElement('div');
  topHandle.className = 'msg-resize-handle msg-resize-handle-top';
  topHandle.setAttribute('role', 'separator');
  topHandle.setAttribute('aria-orientation', 'horizontal');
  topHandle.tabIndex = 0;

  let draggingH = false, startY = 0, startHeight = 0;
  topHandle.addEventListener('pointerdown', function (ev) {
    draggingH = true;
    startY = ev.clientY;
    startHeight = panel.getBoundingClientRect().height;
    try { topHandle.setPointerCapture(ev.pointerId); } catch (e) { /* unsupported, drag still works via document fallback */ }
    topHandle.classList.add('dragging');
    ev.preventDefault();
  });
  topHandle.addEventListener('pointermove', function (ev) {
    if (!draggingH) return;
    const dy = ev.clientY - startY;
    const next = Math.max(MSG_PANEL_MIN_HEIGHT, Math.min(startHeight - dy, msgPanelMaxHeight()));
    panel.style.height = next + 'px';
  });
  function endH(ev) {
    if (!draggingH) return;
    draggingH = false;
    topHandle.classList.remove('dragging');
    state.msgPanelHeightPx = panel.getBoundingClientRect().height;
    if (ev && ev.pointerId !== undefined) {
      try { topHandle.releasePointerCapture(ev.pointerId); } catch (e) { /* already released */ }
    }
  }
  topHandle.addEventListener('pointerup', endH);
  topHandle.addEventListener('pointercancel', endH);
  panel.appendChild(topHandle);
}

// Initial/default width responsive to the tab strip (Gregg's ask: GM
// view with many players was cramped against the fixed 24rem default).
// tabsRow.scrollWidth reports its natural unclipped content width even
// though the row itself has overflow-x:auto (i.e. it's already able to
// scroll if narrower) -- exactly the "how wide would this ideally be"
// number. Only used while the player hasn't manually resized (state.
// msgPanelWidthPx null); once they drag, their explicit choice always
// wins, still re-clamped to the current viewport every render in case
// the window itself shrank since.
function applyPanelSizing(panel, head, tabsRow, collapseBtn) {
  let width;
  if (typeof state.msgPanelWidthPx === 'number') {
    width = state.msgPanelWidthPx;
  } else {
    const headStyle = getComputedStyle(head);
    const padding = parseFloat(headStyle.paddingLeft) + parseFloat(headStyle.paddingRight);
    const gap = parseFloat(headStyle.columnGap || headStyle.gap) || 0;
    const collapseWidth = collapseBtn.getBoundingClientRect().width;
    width = tabsRow.scrollWidth + collapseWidth + padding + gap + 2; // +2 for #msg-panel's 1px border each side
  }
  panel.style.width = Math.max(MSG_PANEL_MIN_WIDTH, Math.min(width, msgPanelMaxWidth())) + 'px';

  if (typeof state.msgPanelHeightPx === 'number') {
    panel.style.height = Math.max(MSG_PANEL_MIN_HEIGHT, Math.min(state.msgPanelHeightPx, msgPanelMaxHeight())) + 'px';
  }
  // else: leave the CSS default (min(24rem, 60vh)) alone.
}

// Auto-expand bookkeeping (module-local, not state: purely presentational,
// reset on detach). prevUnreadTotal starts at 0, so unread that already
// exists at listener-attach time (messages/notifications that arrived
// while this user was away) also pops the tray open once on load --
// "incoming since you last looked" counts as incoming.
let prevUnreadTotal = 0;
// Notification ids that were unseen at the moment the Campaign tab was
// opened: marked seen in Firestore immediately (so the strip's unread
// glow clears), but still styled as new in the digest until the tab is
// left, so the user actually gets to see WHICH entries were new.
let campaignNewIds = {};
let markReadInFlight = {};
// Composer draft, per thread key: the tray re-renders wholesale on every
// snapshot (thread doc, messages, notifications, the visibility-change
// fan), which would clobber an in-progress input value mid-typing --
// exactly the full-re-render draft-loss class Phase 13 flagged. The draft
// (and focus) is restored after each render instead.
let composeDrafts = {};
let composeHadFocus = false;

// --- small helpers ---------------------------------------------------------

function tsMs(v) {
  return (v && typeof v.toMillis === 'function') ? v.toMillis() : null;
}

function myReadField() {
  return state.currentRole === 'gm' ? 'gmLastReadAt' : 'playerLastReadAt';
}

function threadFor(email) {
  return state.allThreads.find(function (t) { return t.id === email; }) || null;
}

function threadUnread(t) {
  if (!t) return false;
  const last = tsMs(t.lastMessageAt);
  if (last == null) return false;
  const read = tsMs(t[myReadField()]);
  return read == null || last > read;
}

// Thread tabs: GM gets one per whitelisted player (whether or not a
// thread doc exists yet -- the doc is created lazily on first message/
// read), sorted by display name; a player gets exactly one, labeled "GM",
// keyed by their own email (threads are keyed by the PLAYER's email).
function threadTabDefs() {
  if (state.currentRole === 'gm') {
    return (state.allPlayers || []).slice()
      .sort(function (a, b) {
        return (a.displayName || a.id).localeCompare(b.displayName || b.id);
      })
      .map(function (p) { return { key: p.id, label: p.displayName || p.id, badgeColor: activeCharacterBadgeColor(p) }; });
  }
  const email = state.currentUser && state.currentUser.email;
  return email ? [{ key: email, label: 'GM', badgeColor: null }] : [];
}

// Phase 14 S7 (§11.8): color a GM-side player tab by that player's
// CURRENT active character's badgeColor (falls back to a deterministic
// per-name generated color, S8, when unset -- or null when the player
// has no active character at all, which still leaves the existing
// default tab styling with no color cue, since there's no character to
// generate one from). Threads are keyed by player email, not character
// -- a player can own several PCs, so this is inherently "whichever one
// they're playing right now", which can shift the tab color mid-session
// on a character switch. Confirmed as the right tradeoff (Phase 14 S7
// design review).
function activeCharacterBadgeColor(player) {
  if (!player || !player.activeCharacterId) return null;
  const char = state.allEntities.find(function (e) { return e.id === player.activeCharacterId; });
  return char ? (char.badgeColor || generateDefaultBadgeColor(char.name)) : null;
}

function campaignUnreadCount() {
  if (state.currentRole === 'player') {
    return state.allNotifications.filter(function (n) { return !n.seenAt; }).length;
  }
  if (state.currentRole === 'gm') {
    // GM is the recipient only for joinRequest notifications (§ Aug 2026
    // addition) -- everything else in allNotifications is fan-out the GM
    // sent, not received, so only joinRequest counts toward GM unread.
    return state.allNotifications.filter(function (n) { return n.kind === 'joinRequest' && !n.seenAt; }).length;
  }
  return 0;
}

function formatRelative(ms) {
  if (ms == null) return '';
  const days = Math.floor((Date.now() - ms) / 86400000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  return days + ' days ago';
}

function formatClock(ms) {
  if (ms == null) return 'sending\u2026';
  const d = new Date(ms);
  return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

// --- listeners --------------------------------------------------------------

function collectSnapshot(snap) {
  const arr = [];
  snap.forEach(function (d) { arr.push(Object.assign({ id: d.id }, d.data())); });
  return arr;
}

function attachMessagesListeners() {
  const email = state.currentUser && state.currentUser.email;
  const role = state.currentRole;
  if (!email || (role !== 'gm' && role !== 'player')) return;

  if (role === 'gm') {
    attachListener('threadsUnsub', function () {
      return onSnapshot(collection(db, 'threads'),
        safeSnapshotHandler('threads', function (snap) {
          state.allThreads = collectSnapshot(snap);
          onMessagesData();
        }),
        function (err) { console.error('threads listener failed:', err.message); });
    });
    attachListener('notificationsUnsub', function () {
      return onSnapshot(collection(db, 'notifications'),
        safeSnapshotHandler('notifications', function (snap) {
          state.allNotifications = collectSnapshot(snap);
          onMessagesData();
          renderAdminNotificationsCard();
        }),
        function (err) { console.error('notifications listener failed:', err.message); });
    });
  } else {
    attachListener('threadsUnsub', function () {
      return onSnapshot(doc(db, 'threads', email),
        safeSnapshotHandler('threads', function (snap) {
          state.allThreads = snap.exists() ? [Object.assign({ id: snap.id }, snap.data())] : [];
          onMessagesData();
        }),
        function (err) { console.error('thread doc listener failed:', err.message); });
    });
    attachListener('notificationsUnsub', function () {
      return onSnapshot(query(collection(db, 'notifications'), where('recipientEmail', '==', email)),
        safeSnapshotHandler('notifications', function (snap) {
          state.allNotifications = collectSnapshot(snap);
          onMessagesData();
        }),
        function (err) { console.error('notifications listener failed:', err.message); });
    });
  }
}

function detachMessagesListeners() {
  detachListener('threadsUnsub');
  detachListener('notificationsUnsub');
  detachListener('threadMessagesUnsub');
  state.allThreads = [];
  state.allNotifications = [];
  state.threadMessages = [];
  state.openThreadKey = null;
  state.trayExpanded = false;
  state.trayTab = null;
  prevUnreadTotal = 0;
  campaignNewIds = {};
  markReadInFlight = {};
  renderMessagesTray();
  renderAdminNotificationsCard();
}

function onMessagesData() {
  maybeAutoExpand();
  renderMessagesTray();
}

function ensureThreadMessagesListener(key) {
  if (state.openThreadKey === key && state.threadMessagesUnsub) return;
  detachListener('threadMessagesUnsub');
  state.threadMessages = [];
  state.openThreadKey = key;
  attachListener('threadMessagesUnsub', function () {
    return onSnapshot(collection(db, 'threads', key, 'messages'),
      safeSnapshotHandler('threadMessages', function (snap) {
        const arr = collectSnapshot(snap);
        arr.sort(function (a, b) {
          const am = tsMs(a.createdAt); const bm = tsMs(b.createdAt);
          return (am == null ? Infinity : am) - (bm == null ? Infinity : bm);
        });
        state.threadMessages = arr;
        // New message arriving while this thread is open on screen: it's
        // being read right now -- keep the read stamp current so the tab
        // doesn't light unread for a conversation the user is looking at.
        if (state.trayExpanded && state.trayTab === key) markThreadRead(key);
        renderMessagesTray();
      }),
      function (err) { console.error('thread messages listener failed:', err.message); });
  });
}

// --- writes -----------------------------------------------------------------

function markThreadRead(key) {
  const t = threadFor(key);
  if (!t || !threadUnread(t)) return;
  if (markReadInFlight[key]) return;
  markReadInFlight[key] = true;
  const patch = {};
  patch[myReadField()] = serverTimestamp();
  setDoc(doc(db, 'threads', key), patch, { merge: true })
    .then(function () { markReadInFlight[key] = false; },
          function (err) {
            markReadInFlight[key] = false;
            console.error('mark-read failed:', err.message);
          });
}

function markCampaignSeen() {
  if (state.currentRole !== 'player' && state.currentRole !== 'gm') return;
  const unseen = state.currentRole === 'gm'
    ? state.allNotifications.filter(function (n) { return n.kind === 'joinRequest' && !n.seenAt; })
    : state.allNotifications.filter(function (n) { return !n.seenAt; });
  if (!unseen.length) return;
  campaignNewIds = {};
  const batch = writeBatch(db);
  unseen.forEach(function (n) {
    campaignNewIds[n.id] = true;
    batch.update(doc(db, 'notifications', n.id), { seenAt: serverTimestamp() });
  });
  batch.commit().catch(function (err) { console.error('mark-seen failed:', err.message); });
}

function sendMessage(key, text) {
  const trimmed = text.trim();
  if (!trimmed) return;
  const batch = writeBatch(db);
  const patch = {
    lastMessageAt: serverTimestamp(),
    lastMessagePreview: trimmed.slice(0, 80)
  };
  // Stamp own read field in the same write: you've read your own message,
  // and this is what keeps unread meaning "the OTHER side wrote".
  patch[myReadField()] = serverTimestamp();
  batch.set(doc(db, 'threads', key), patch, { merge: true });
  batch.set(doc(collection(db, 'threads', key, 'messages')), {
    authorRole: state.currentRole === 'gm' ? 'gm' : 'player',
    text: trimmed,
    createdAt: serverTimestamp()
  });
  trackWrite(batch.commit(), 'Sending message').catch(function (err) {
    window.alert('Send failed: ' + err.message);
  });
}

// --- tray open/close --------------------------------------------------------

function openTab(key) {
  state.trayExpanded = true;
  state.trayTab = key;
  if (key === 'campaign') {
    markCampaignSeen();
  } else {
    ensureThreadMessagesListener(key);
    markThreadRead(key);
  }
  renderMessagesTray();
}

function collapseTray() {
  state.trayExpanded = false;
  // Leaving the Campaign tab: the just-marked-seen entries stop being
  // styled as new on the next open.
  if (state.trayTab === 'campaign') campaignNewIds = {};
  renderMessagesTray();
}

function maybeAutoExpand() {
  const defs = threadTabDefs();
  let total = 0;
  let firstUnreadKey = null;
  defs.forEach(function (d) {
    if (threadUnread(threadFor(d.key))) {
      total += 1;
      if (!firstUnreadKey) firstUnreadKey = d.key;
    }
  });
  if (campaignUnreadCount() > 0) {
    total += 1;
    if (!firstUnreadKey) firstUnreadKey = 'campaign';
  }
  if (!state.trayExpanded && total > prevUnreadTotal && firstUnreadKey) {
    openTab(firstUnreadKey);
  }
  prevUnreadTotal = total;
}

// --- Campaign digest --------------------------------------------------------

// Player digest: own notifications grouped per entity (the presentational
// dedupe from §6.7 -- GM toggle-flapping produces many docs, one group).
// The entity gate is render-time canSee: a notification about an entity
// the GM has since re-hidden shows nothing (not even the name).
function buildPlayerDigest(container) {
  const ctx = viewerContext();
  const groups = {};
  state.allNotifications.forEach(function (n) {
    if (!groups[n.entityId]) groups[n.entityId] = { entityId: n.entityId, items: [], newestMs: 0 };
    const g = groups[n.entityId];
    g.items.push(n);
    const ms = tsMs(n.createdAt);
    if (ms != null && ms > g.newestMs) g.newestMs = ms;
  });
  const list = Object.keys(groups).map(function (k) { return groups[k]; })
    .filter(function (g) {
      const entity = state.allEntities.find(function (e) { return e.id === g.entityId; });
      g.entity = entity || null;
      return !!entity && canSee(entity, ctx);
    })
    .sort(function (a, b) { return b.newestMs - a.newestMs; })
    .slice(0, 30);

  if (!list.length) {
    const empty = document.createElement('p');
    empty.className = 'msg-empty';
    empty.textContent = 'Nothing new from the campaign yet.';
    container.appendChild(empty);
    return;
  }

  list.forEach(function (g) {
    const card = document.createElement('div');
    card.className = 'digest-group';
    const isNew = g.items.some(function (n) { return !n.seenAt || campaignNewIds[n.id]; });
    if (isNew) card.classList.add('unseen');

    function entityLink() {
      const a = document.createElement('span');
      a.className = 'digest-entity';
      a.textContent = g.entity.name || '(unnamed)';
      a.addEventListener('click', function () { switchToCodexTabForEntity(g.entityId); });
      return a;
    }

    const discovered = g.items.filter(function (n) { return n.kind === 'discovered'; });
    const learned = g.items.filter(function (n) { return n.kind === 'learned'; });
    const sharedActors = {};
    g.items.forEach(function (n) {
      if (n.kind === 'shared' && n.actorCharacterId) sharedActors[n.actorCharacterId] = true;
    });

    if (discovered.length) {
      const line = document.createElement('div');
      line.className = 'digest-line';
      line.appendChild(document.createTextNode('You have discovered '));
      line.appendChild(entityLink());
      line.appendChild(document.createTextNode('.'));
      card.appendChild(line);
    }
    if (learned.length) {
      const line = document.createElement('div');
      line.className = 'digest-line';
      line.appendChild(document.createTextNode('You have learned more about '));
      line.appendChild(entityLink());
      line.appendChild(document.createTextNode('.'));
      card.appendChild(line);
    }
    Object.keys(sharedActors).forEach(function (charId) {
      const line = document.createElement('div');
      line.className = 'digest-line';
      line.appendChild(buildCharacterBadge(charId));
      line.appendChild(document.createTextNode(' shared lore about '));
      line.appendChild(entityLink());
      line.appendChild(document.createTextNode('.'));
      card.appendChild(line);
    });

    const meta = document.createElement('div');
    meta.className = 'digest-meta';
    const updates = learned.length + g.items.filter(function (n) { return n.kind === 'shared'; }).length;
    meta.textContent = (updates > 1 ? updates + ' updates \u00B7 ' : '') + formatRelative(g.newestMs);
    card.appendChild(meta);

    container.appendChild(card);
  });
}

// GM digest: fan-out visibility -- everything written, grouped per entity,
// with kind and recipient counts. Read-only (the GM is never a recipient,
// so there's no seenAt to flip and no unread state).
function buildGmDigest(container) {
  // Separate join requests from entity notifications
  const joinRequests = state.allNotifications.filter(function (n) { return n.kind === 'joinRequest'; })
    .sort(function (a, b) { return tsMs(b.createdAt) - tsMs(a.createdAt); });
  
  const entityNotifications = state.allNotifications.filter(function (n) { return n.kind !== 'joinRequest'; });
  const groups = {};
  entityNotifications.forEach(function (n) {
    if (!groups[n.entityId]) groups[n.entityId] = { entityId: n.entityId, items: [], newestMs: 0 };
    const g = groups[n.entityId];
    g.items.push(n);
    const ms = tsMs(n.createdAt);
    if (ms != null && ms > g.newestMs) g.newestMs = ms;
  });
  const list = Object.keys(groups).map(function (k) { return groups[k]; })
    .sort(function (a, b) { return b.newestMs - a.newestMs; })
    .slice(0, 30);

  // Show join requests first
  joinRequests.forEach(function (req) {
    const card = document.createElement('div');
    card.className = 'digest-group';
    const line = document.createElement('div');
    line.className = 'digest-line';
    line.appendChild(document.createTextNode(req.requestEmail + ' (' + (req.provider || 'unknown') + ') '));
    const link = document.createElement('span');
    link.textContent = 'requested to join';
    link.style.cursor = 'pointer';
    link.style.textDecoration = 'underline';
    link.style.color = 'var(--color-link, #0066cc)';
    link.addEventListener('click', function () {
      const adminBtn = document.getElementById('tab-btn-admin');
      if (adminBtn) adminBtn.click();
    });
    line.appendChild(link);
    card.appendChild(line);
    const meta = document.createElement('div');
    meta.className = 'digest-meta';
    meta.textContent = formatRelative(tsMs(req.createdAt));
    card.appendChild(meta);
    container.appendChild(card);
  });

  if (!list.length && !joinRequests.length) {
    const empty = document.createElement('p');
    empty.className = 'msg-empty';
    empty.textContent = 'No notifications have been sent yet.';
    container.appendChild(empty);
    return;
  }

  list.forEach(function (g) {
    const entity = state.allEntities.find(function (e) { return e.id === g.entityId; });
    const card = document.createElement('div');
    card.className = 'digest-group';

    const line = document.createElement('div');
    line.className = 'digest-line';
    const name = document.createElement('span');
    name.className = 'digest-entity';
    name.textContent = entity ? (entity.name || '(unnamed)') : '(deleted entry)';
    if (entity) {
      name.addEventListener('click', function () { switchToCodexTabForEntity(g.entityId); });
    }
    line.appendChild(name);
    card.appendChild(line);

    const kinds = {};
    const recipients = {};
    g.items.forEach(function (n) {
      kinds[n.kind] = (kinds[n.kind] || 0) + 1;
      recipients[n.recipientEmail] = true;
    });
    const meta = document.createElement('div');
    meta.className = 'digest-meta';
    meta.textContent = Object.keys(kinds).map(function (k) { return kinds[k] + ' ' + k; }).join(', ')
      + ' \u00B7 ' + Object.keys(recipients).length + ' recipient(s) \u00B7 ' + formatRelative(g.newestMs);
    card.appendChild(meta);

    container.appendChild(card);
  });
}

// --- render -----------------------------------------------------------------

function renderMessagesTray() {
  if (!trayEl) return;
  const role = state.currentRole;
  const email = state.currentUser && state.currentUser.email;
  if (!email || (role !== 'gm' && role !== 'player')) {
    trayEl.style.display = 'none';
    trayEl.innerHTML = '';
    return;
  }
  trayEl.style.display = 'block';
  trayEl.innerHTML = '';
  const ctx = viewerContext();

  const defs = threadTabDefs();
  const campUnread = campaignUnreadCount() > 0;

  if (!state.trayExpanded) {
    const strip = document.createElement('div');
    strip.id = 'msg-strip';
    defs.forEach(function (d) {
      strip.appendChild(buildStripTab(d.label, threadUnread(threadFor(d.key)), function () { openTab(d.key); }, d.badgeColor));
    });
    strip.appendChild(buildStripTab('Campaign', campUnread, function () { openTab('campaign'); }));
    trayEl.appendChild(strip);
    return;
  }

  // Expanded: default the tab if none chosen yet.
  if (!state.trayTab) state.trayTab = defs.length ? defs[0].key : 'campaign';

  const panel = document.createElement('div');
  panel.id = 'msg-panel';

  const head = document.createElement('div');
  head.id = 'msg-panel-head';
  const tabsRow = document.createElement('div');
  tabsRow.id = 'msg-panel-tabs';
  defs.forEach(function (d) {
    tabsRow.appendChild(buildPanelTab(d.label,
      state.trayTab === d.key,
      threadUnread(threadFor(d.key)),
      function () { openTab(d.key); },
      d.badgeColor));
  });
  tabsRow.appendChild(buildPanelTab('Campaign', state.trayTab === 'campaign', campUnread,
    function () { openTab('campaign'); }));
  head.appendChild(tabsRow);
  const collapseBtn = document.createElement('button');
  collapseBtn.type = 'button';
  collapseBtn.id = 'msg-collapse';
  collapseBtn.setAttribute('aria-label', 'Collapse messages');
  collapseBtn.textContent = '\u25BE';
  collapseBtn.addEventListener('click', collapseTray);
  head.appendChild(collapseBtn);
  panel.appendChild(head);

  const body = document.createElement('div');
  body.id = 'msg-body';

  if (state.trayTab === 'campaign') {
    if (role === 'gm') buildGmDigest(body); else buildPlayerDigest(body);
    panel.appendChild(body);
    trayEl.appendChild(panel);
    attachPanelResizeHandles(panel);
    applyPanelSizing(panel, head, tabsRow, collapseBtn);
    // Campaign digest sorts newest-first (buildPlayerDigest/buildGmDigest),
    // unlike the thread-chat panel below (oldest-first, pinned to
    // scrollHeight/bottom) -- so "most recent" here means the TOP, not
    // the bottom. Every re-render rebuilds `body` from scratch (a new
    // element each time), so this isn't preserving a prior scroll
    // position, it's actively pinning to the top on every notification/
    // message-triggered re-render, same as the thread panel actively
    // pins to the bottom.
    body.scrollTop = 0;
    return;
  } else {
    const key = state.trayTab;
    // Re-point the messages listener if a re-render landed on a thread
    // tab without going through openTab (e.g. default tab on expand).
    ensureThreadMessagesListener(key);
    if (!state.threadMessages.length) {
      const empty = document.createElement('p');
      empty.className = 'msg-empty';
      empty.textContent = 'No messages yet.';
      body.appendChild(empty);
    }
    const myRole = role === 'gm' ? 'gm' : 'player';
    state.threadMessages.forEach(function (m) {
      const bubble = document.createElement('div');
      bubble.className = 'msg-bubble ' + (m.authorRole === myRole ? 'mine' : 'theirs');
      const text = document.createElement('div');
      text.className = 'msg-text';
      // Markdown + auto wiki-links (Phase 14 S8), same rendering pair
      // every other markdown-carrying surface uses. currentEntityId is
      // null here -- a chat message isn't scoped to any one entity, so
      // nothing needs excluding from candidate name-matching the way
      // applyWikiLinks' other callers exclude "this entity itself".
      renderMarkdownInto(text, m.text || '').then(function () {
        applyWikiLinks(text, null, ctx);
      });
      bubble.appendChild(text);
      const time = document.createElement('div');
      time.className = 'msg-time';
      time.textContent = formatClock(tsMs(m.createdAt));
      bubble.appendChild(time);
      body.appendChild(bubble);
    });
    // Delegated: one handler for every wiki-link a message might contain
    // -- same click-to-open-Codex pattern as the digest's own entity
    // links just above (switchToCodexTabForEntity), not a per-message
    // listener.
    body.addEventListener('click', function (ev) {
      const a = ev.target.closest ? ev.target.closest('a.wiki-link') : null;
      if (!a) return;
      ev.preventDefault();
      switchToCodexTabForEntity(a.dataset.entityId);
    });
    panel.appendChild(body);

    const compose = document.createElement('div');
    compose.id = 'msg-compose';
    const input = document.createElement('input');
    input.type = 'text';
    input.placeholder = 'Message\u2026';
    input.value = composeDrafts[key] || '';
    const sendBtn = document.createElement('button');
    sendBtn.type = 'button';
    sendBtn.textContent = 'Send';
    function doSend() {
      const v = input.value;
      if (!v.trim()) return;
      input.value = '';
      composeDrafts[key] = '';
      sendMessage(key, v);
    }
    sendBtn.addEventListener('click', doSend);
    input.addEventListener('input', function () { composeDrafts[key] = input.value; });
    input.addEventListener('focus', function () { composeHadFocus = true; });
    input.addEventListener('blur', function () { composeHadFocus = false; });
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); doSend(); }
    });
    compose.appendChild(input);
    compose.appendChild(sendBtn);
    panel.appendChild(compose);

    trayEl.appendChild(panel);
    attachPanelResizeHandles(panel);
    applyPanelSizing(panel, head, tabsRow, collapseBtn);
    // Pin the message list to the newest entry, and restore focus if the
    // composer had it before this re-render clobbered the old input node.
    body.scrollTop = body.scrollHeight;
    if (composeHadFocus) input.focus();
    return;
  }
}

function buildStripTab(label, unread, onClick, badgeColor) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'msg-strip-tab' + (unread ? ' unread' : '');
  btn.textContent = label;
  if (badgeColor) {
    btn.style.setProperty('--badge-color', badgeColor);
    btn.classList.add('has-badge-color');
  }
  if (unread) {
    const dot = document.createElement('span');
    dot.className = 'msg-dot';
    btn.appendChild(dot);
  }
  btn.addEventListener('click', onClick);
  return btn;
}

function buildPanelTab(label, active, unread, onClick, badgeColor) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'msg-panel-tab' + (active ? ' active' : '') + (unread && !active ? ' unread' : '');
  btn.textContent = label;
  if (badgeColor) {
    btn.style.setProperty('--badge-color', badgeColor);
    btn.classList.add('has-badge-color');
  }
  btn.addEventListener('click', onClick);
  return btn;
}

// --- Admin > Notifications cleanup card (GM only, §6.7) ---------------------

const CLEANUP_AGE_DAYS = 30;

function renderAdminNotificationsCard() {
  if (!adminNotificationsBodyEl) return;
  adminNotificationsBodyEl.innerHTML = '';
  if (state.currentRole !== 'gm') return;

  const cutoffMs = Date.now() - CLEANUP_AGE_DAYS * 86400000;
  const old = state.allNotifications.filter(function (n) {
    const ms = tsMs(n.createdAt);
    return ms != null && ms < cutoffMs;
  });

  const summary = document.createElement('p');
  summary.className = 'admin-hint';
  summary.textContent = state.allNotifications.length + ' notification doc(s) total; '
    + old.length + ' older than ' + CLEANUP_AGE_DAYS + ' days.';
  adminNotificationsBodyEl.appendChild(summary);

  const row = document.createElement('div');
  row.className = 'actions-row';
  const right = document.createElement('div');
  right.className = 'actions-row-right';
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.textContent = 'Delete old notifications';
  btn.disabled = !old.length;
  btn.addEventListener('click', function () {
    if (!window.confirm('Delete ' + old.length + ' notification doc(s) older than '
      + CLEANUP_AGE_DAYS + ' days? Players will no longer see them in their Campaign tab.')) return;
    // Chunked at well under the 500-op batch ceiling.
    const chunks = [];
    for (let i = 0; i < old.length; i += 400) chunks.push(old.slice(i, i + 400));
    let p = Promise.resolve();
    chunks.forEach(function (chunk) {
      p = p.then(function () {
        const batch = writeBatch(db);
        chunk.forEach(function (n) { batch.delete(doc(db, 'notifications', n.id)); });
        return batch.commit();
      });
    });
    p.catch(function (err) { window.alert('Cleanup failed: ' + err.message); });
  });
  right.appendChild(btn);
  row.appendChild(right);
  adminNotificationsBodyEl.appendChild(row);
}

export { attachMessagesListeners, detachMessagesListeners, renderMessagesTray };
