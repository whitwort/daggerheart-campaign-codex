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
  allEntities: [],
  allLoreItems: [],
  selectedId: null,
  gmPreviewAsPlayer: false,
  categoryCollapse: {},  // Entry Browser accordion: category -> collapsed(bool); default expanded
  detailActiveTab: 'lore',  // Entry Card tab box: 'lore' | 'notes'; resets to 'lore' on selection change
  editingEntityId: null,
  entityFormDocId: null,     // doc id the open entity form writes to — pre-generated for New so images can attach before first save
  entityFormIsNew: false,
  entityFormUploadedImageIds: [],  // image docs uploaded during this form session (cleanup on New+Cancel)
  entityFormHasMapImage: false,    // tracked locally for New (entity doc doesn't exist yet for the flag update)
  editingLoreItemId: null,  // null = creating; loreItem doc id when editing
  loreFormEntityId: null,   // which entity the open lore form belongs to
  formRelatedIds: [],
  leafletMap: null,
  loadedMapId: null,
  mapImgHeight: 0,
  pinLayer: null,
  allPins: [],
  currentMapEntityId: null,  // Location entity whose map image is shown
  rootEntityId: null,  // from config/campaign doc, GM-selected root Location entity
  mapMode: null,  // null | 'add' | 'remove'
  pendingPinCoords: null,
  mapNavStack: [],  // stack of parent mapIds, for the "back to parent map" control
  webpEncoderModulePromise: null,
  mapImageUnsub: null,  // detach/reattach per map load (Phase 7b-3)
  currentMapImageDims: null,  // {width,height} of currently-loaded map's image, for replace-dimension-change warning
  loadingMapId: null,  // guards against two near-simultaneous loadMap(mapId) calls (e.g. the entities-change handler and attachConfigListener both firing) racing to tear down each other's in-flight image listener before it ever gets its first snapshot
  imageCacheDbPromise: null,
};
