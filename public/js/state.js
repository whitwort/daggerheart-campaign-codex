// Shared mutable application state. Plain object (not `export let`) so
// any module can read AND write a property without import-cycle issues.
export const state = {
  currentRole: 'viewer',
  currentUser: null,
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
  allJoinRequests: [],
  allPlayers: [],
  adminPlayerEditId: null,
  adminPlayerEditDraft: '',
  allEntities: [],
  allLoreItems: [],
  selectedId: null,
  gmPreviewAsPlayer: false,
  categoryCollapse: {},  // Entry Browser accordion: category -> collapsed(bool); default COLLAPSED (only explicit `false` expands)
  detailActiveTab: 'lore',  // Entry Card tab box: 'lore' | 'notes'; resets to 'lore' on selection change
  detailEditMode: false,   // true = the open Entry Card is showing inline edit fields for the entity itself
  detailEditDraft: null,   // { name, category, ancestry, aliases, date, parentId, tags, relatedIds } — in-progress entity edit; re-populates edit inputs across re-renders so unrelated snapshot updates don't clobber typing
  loreEdit: null,          // { entityId, id: existingLoreId|null, content, visibility } — in-progress lore item edit/create; id===null means a brand-new (unsaved) item
  galleryUpload: null,     // { entityId } — Gallery tab's "+ New image" form is open for this entity
  leafletMap: null,
  loadedMapId: null,
  mapImgHeight: 0,
  pinLayer: null,
  allPins: [],
  currentMapEntityId: null,  // Location entity whose map image is shown
  rootEntityId: null,  // from config/campaign doc, GM-selected root Location entity
  mapMode: null,  // null | 'add' | 'edit' | 'remove'
  pinDraft: null,  // { id: existingPinId|null, entityId, x, y, radius, moveMode } — open pin panel's in-progress state
  pinPickerCollapse: {},  // pin panel's entity picker accordion collapse state (category -> collapsed bool), mirrors categoryCollapse
  webpEncoderModulePromise: null,
  sortableModulePromise: null, // lazy-loaded SortableJS for Gallery tab drag-reorder (iOS touch support; native HTML5 DnD doesn't work there)
  mapImageUnsub: null,  // detach/reattach per map load (Phase 7b-3)
  currentMapImageDims: null,  // {width,height} of currently-loaded map's image, for replace-dimension-change warning
  loadingMapId: null,  // guards against two near-simultaneous loadMap(mapId) calls (e.g. the entities-change handler and attachConfigListener both firing) racing to tear down each other's in-flight image listener before it ever gets its first snapshot
  imageCacheDbPromise: null,
};
