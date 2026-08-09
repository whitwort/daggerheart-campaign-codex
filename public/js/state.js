// Shared mutable application state. Plain object (not `export let`) so
// any module can read AND write a property without import-cycle issues.
export const state = {
  currentRole: 'viewer',
  currentUser: null,
  playerDocUnsub: null,
  joinRequestDocUnsub: null,
  dataListenersAttached: false,
  entriesUnsub: null,
  pinsUnsub: null,
  mapsUnsub: null,
  configUnsub: null,
  adminRootMapUpdating: false,  // guards select re-render fighting the user's own in-flight change
  adminListenersAttached: false,
  joinRequestsUnsub: null,
  playersUnsub: null,
  allJoinRequests: [],
  allPlayers: [],
  allEntries: [],
  selectedId: null,
  gmPreviewAsPlayer: false,
  editingEntryId: null,
  formRelatedIds: [],
  leafletMap: null,
  loadedMapId: null,
  mapImgHeight: 0,
  pinLayer: null,
  allPins: [],
  allMaps: [],
  currentMapId: null,
  rootMapId: null,  // from config/campaign doc, GM-selected (Phase 7b)
  mapMode: null,  // null | 'add' | 'remove'
  pendingPinCoords: null,
  mapNavStack: [],  // stack of parent mapIds, for the "back to parent map" control
  mapImageUploadTargetMapId: null,  // set by loadMap() on each load, decoupled from currentMapId to avoid races if the user navigates mid-upload
  webpEncoderModulePromise: null,
  mapImageUnsub: null,  // detach/reattach per map load (Phase 7b-3)
  currentMapImageDims: null,  // {width,height} of currently-loaded map's image, for replace-dimension-change warning
  imageCacheDbPromise: null,
};
