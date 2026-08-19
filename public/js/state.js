// Shared mutable application state. Plain object (not `export let`) so
// any module can read AND write a property without import-cycle issues.
export const state = {
  currentRole: 'viewer',
  currentUser: null,
  activeCharacterId: null,  // players/{email}.activeCharacterId, delivered live via the existing player-doc listener in auth.js (Phase 14 S1 schema; wired UI lands in S3). Null for GM/viewer and for a player with none set yet.
  playerDocUnsub: null,
  joinRequestDocUnsub: null,
  entitiesUnsub: null,
  loreItemsUnsub: null,
  entityImagesUnsub: null,   // per-entity images query listener — manual lifecycle (target changes with selection/form), like mapImageUnsub
  entityImagesTargetId: null,
  currentEntityImages: [],   // image docs for entityImagesTargetId
  pinsUnsub: null,
  configUnsub: null,
  adminRootSelectUpdating: false,  // guards select re-render fighting the user's own in-flight change
  joinRequestsUnsub: null,
  playersUnsub: null,
  versionUnsub: null,  // _meta/version deploy-detection listener (version.js)
  allJoinRequests: [],
  allPlayers: [],
  adminPlayerEditId: null,
  adminPlayerEditDraft: '',
  allSources: [],
  sourcesUnsub: null,
  allTransferRequests: [],   // Phase 14 S5 -- GM-only full transferRequests collection (admin.js listener), feeds the unified Admin > Requests queue (join + transfer)
  transferRequestsUnsub: null,
  myTransferRequests: [],    // Phase 14 S5 -- any signed-in player's OWN pending transferRequests (where toEmail==self, characters.js listener), used to gray out "Request transfer" once already filed for a character
  myTransferRequestsUnsub: null,
  charactersSelectedId: null,     // Phase 14 S5 -- Characters tab's own selection, independent of the Codex tab's state.selectedId: the GM flipper's chosen PC, or a player's chosen own-character for the card-slot editor
  charactersSelectedAutoPicked: false, // Phase 14 S13 -- true when charactersSelectedId was set by the player-view default-select guard (not a real click); lets a later-arriving activeCharacterId correct an interim own[0] pick without ever overriding a deliberate user selection
  charactersDetailTab: 'cards',   // Phase 14 S17 -- Cards/Sheet tab shell wrapping buildCharacterDeck in both GM and player detail panes; shared since only one pane is visible at a time, doesn't reset on selection change (unlike detailActiveTab)
  charactersAssignOpenPlayerEmail: null, // Phase 14 S8 -- GM view: which player's inline "+" assign row is expanded, if any
  charactersClaimPopupOpen: false,       // Phase 14 S8 -- player view: whether the "Claim Character" popup is open
  charactersPickingActive: false,        // Phase 14 S8 -- player view: "Set active" picking mode -- next character clicked becomes activeCharacterId
  charactersAncestryAddOpen: false,      // Phase 14 S8 -- character edit panel: whether the second-ancestry picker is expanded (progressive-reveal ancestry UI)
  characterDeckAbilityTab: 'active',     // Phase 14 S15 -- character deck viewer: which Abilities sub-tab is showing ('active' | 'vault' | 'beastforms'); shared across GM/player views since only one deck is ever open at a time
  characterDeckHeritageConditionsSplit: 0.6, // Phase 14 S18 -- character deck viewer: Heritage/Conditions shared-row drag-split fraction (0-1, Heritage's share). Session-only, not persisted.
  characterDeckClassSplit: 0.4,              // Phase 14 S18 -- character deck viewer: Class/Subclass shared-row drag-split fraction (0-1, Class's share). Session-only, not persisted.
  threadsUnsub: null,        // Phase 14 S6 -- GM: full threads collection; player: own threads/{email} doc (messages.js)
  allThreads: [],            // thread docs (GM: all; player: at most own), {id: playerEmail, lastMessageAt, lastMessagePreview, gmLastReadAt, playerLastReadAt}
  threadMessagesUnsub: null, // per-open-thread messages subcollection listener -- manual lifecycle (target changes with the open tab), like entityImagesUnsub; the app's first subcollection listener
  threadMessages: [],        // message docs for openThreadKey, sorted oldest-first client-side
  openThreadKey: null,       // playerEmail of the thread the messages listener currently points at
  notificationsUnsub: null,  // GM: full notifications collection; player: where recipientEmail==self (messages.js)
  allNotifications: [],      // notification docs per the listener scope above
  trayExpanded: false,       // Messages tray collapsed strip vs expanded panel
  trayTab: null,             // open tab: a playerEmail (thread) or 'campaign'
  msgPanelWidthPx: null,     // Messages panel manual width (px) once the player drags the left-edge handle; null = auto-size to fit the tab strip (see messages.js applyPanelSizing). Session-only, not persisted.
  msgPanelHeightPx: null,    // Messages panel manual height (px) once the player drags the top-edge handle; null = CSS default (min(24rem, 60vh)). Session-only, not persisted.
  adminSourceEditId: null,
  adminSourceEditDraft: '',
  adminSourceNewDraft: '',
  allEntities: [],
  allLoreItems: [],
  selectedId: null,
  gmPreview: null,  // null | {playerEmail: string|null, activeCharacterId: string|null} -- Phase 14 S3, replaces the old bare-bool gmPreviewAsPlayer (see phase-14-design.md §5.3). S3 only ever sets {playerEmail:null, activeCharacterId:null} (no specific-player picker yet -- Characters tab flipper is S5).
  categoryCollapse: {},  // Entry Browser accordion: category -> collapsed(bool); default COLLAPSED (only explicit `false` expands)
  mapLegendHiddenCategories: new Set(),  // Map tab legend click-to-toggle: category names currently hidden from pin rendering. In-memory only (resets on reload), persists across map navigation within a session.
  subtypeCollapse: {},   // Entry Browser accordion, nested level: 'category|subtype' -> collapsed(bool); same default-collapsed convention
  detailActiveTab: 'lore',  // Entry Card tab box: 'lore' | 'notes'; resets to 'lore' on selection change
  detailEditMode: false,   // true = the open Entry Card is showing inline edit fields for the entity itself
  detailEditDraft: null,   // { name, category, ancestry, aliases, date, parentId, tags, relatedIds } — in-progress entity edit; re-populates edit inputs across re-renders so unrelated snapshot updates don't clobber typing
  detailEditBaseUpdatedAtMs: null,  // entity.updatedAt (ms) captured when edit mode was entered; compared against the live entity on every snapshot to detect someone else saved underneath this edit (Phase 13 conflict warning)
  detailEditConflictDismissedAtMs: null,  // updatedAt (ms) the GM has already acknowledged via "Keep my edits" — suppresses re-showing the same conflict; a further external change (different ms) still re-triggers it
  loreEdit: null,          // { entityId, id: existingLoreId|null, content, visibility } — in-progress lore item edit/create; id===null means a brand-new (unsaved) item
  noteEdit: null,          // { entityId, id: existingNoteId|null, content, visibility, authorType, authorId } — in-progress note (kind:'note') edit/create, Phase 14 S4; separate from loreEdit so an in-progress note draft on the Notes tab survives a tab switch to Lore (and vice versa) without clobbering the other
  leafletMap: null,
  loadedMapId: null,
  loadedMapGmView: null,  // gmView the currently-loaded map's image was filtered/rendered for; a role/preview-toggle mismatch against a fresh gmView forces ensureMapTabReady to reload rather than shortcut
  mapImgHeight: 0,
  mapImgWidth: 0,
  mapBounds: null,
  pinLayer: null,
  allPins: [],
  currentMapEntityId: null,  // Location entity whose map image is shown
  rootEntityId: null,  // from config/campaign doc, GM-selected root Location entity
  campaignType: null,  // from config/campaign doc: 'daggerheart' | 'not-daggerheart' — gates Daggerheart-specific UI (e.g. Import from SRD)
  srdRepo: 'seansbox/daggerheart-srd',  // from config/campaign doc, editable GM setting for SRD Import tab
  mapMode: null,  // null | 'add' | 'edit' | 'remove'
  pinDraft: null,  // { id: existingPinId|null, entityId, x, y, radius, moveMode } — open pin panel's in-progress state
  pinPickerCollapse: {},  // pin panel's entity picker accordion collapse state (category -> collapsed bool), mirrors categoryCollapse
  webpEncoderModulePromise: null,
  sortableModulePromise: null, // lazy-loaded SortableJS for Gallery tab drag-reorder (iOS touch support; native HTML5 DnD doesn't work there)
  mapImageUnsub: null,  // detach/reattach per map load (Phase 7b-3)
  currentMapImageDims: null,  // {width,height} of currently-loaded map's image, for replace-dimension-change warning
  loadingMapId: null,  // guards against two near-simultaneous loadMap(mapId) calls (e.g. the entities-change handler and attachConfigListener both firing) racing to tear down each other's in-flight image listener before it ever gets its first snapshot
  imageCacheDbPromise: null,
  encountersUnsub: null,     // Phase 15 -- GM-only encounters collection listener (encounters.js)
  allEncounters: [],
  encountersSelectedId: null,
};
