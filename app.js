import * as THREE from "three";
import { OrbitControls } from "./vendor/addons/controls/OrbitControls.js";
import { FBXLoader } from "./vendor/addons/loaders/FBXLoader.js";
import { GLTFLoader } from "./vendor/addons/loaders/GLTFLoader.js";
import {
  DEFAULT_SYNONYMS,
  parseNameMap,
  detectPack,
  packBodyPreferredNames,
  uniqueTrackBones,
  exactNameCoverage,
  bindClipExact,
  retargetClipRestRelative,
} from "./retarget.js";
import { createTreeList } from "./tree.js";
import {
  checkHealth,
  startGenerate,
  getJob,
  cancelJob,
  existingResults,
  fetchResultBuffer,
  pairName,
  variantSuffix,
  resultUrl,
  helperBaseUrl,
  SETUP_STEPS,
} from "./helper.js";
import {
  supportsDirectoryPicker,
  supportsSaveFilePicker,
  ingestDirectoryHandle,
  ingestFileList,
  ingestRecords,
  getCurrentFolder,
  listFbxEntries,
  getArrayBuffer,
  registerVirtualFile,
  unregisterVirtualFile,
  isVirtualPath,
  resolveLocalResource,
  detectModels,
  downloadBlob,
  defaultPairsDoc,
  normalizePairsDoc,
  pairsToText,
  writePairsToHandle,
  readPairsFromHandle,
  loadDirectoryHandle,
  saveDirectoryHandle,
  loadPairsFileHandle,
  savePairsFileHandle,
  requestPermission,
  queryPermission,
} from "./files.js";

const DISPLAY_FPS = 30;
const STORE_KEY = "animlab-clip-favorites-v1";
const BODY_KEY = "animlab-body-v1";
const NAMEMAP_KEY = "animlab-name-map-v1";
const PAIRS_STORE_KEY = "animlab-pairs-v1";
const ROOT_NAME_RE = /(hips|pelvis|^root$|mixamorig[-_]?hips|hip)$/i;
const LARGE_FILE = 40 * 1024 * 1024;

const $ = (id) => document.getElementById(id);
const el = {
  rootPath: $("root-path"),
  clipCount: $("clip-count"),
  search: $("search"),
  starredToggle: $("starred-toggle"),
  clipList: $("clip-list"),
  treeCollapseAll: $("tree-collapse-all"),
  treeExpandAll: $("tree-expand-all"),
  showHiddenToggle: $("show-hidden-toggle"),
  overlay: $("overlay"),
  hud: $("hud"),
  playBtn: $("play-btn"),
  speed: $("speed"),
  speedReadout: $("speed-readout"),
  scrub: $("scrub"),
  frameReadout: $("frame-readout"),
  clipSelect: $("clip-select"),
  lockRootBtn: $("lock-root-btn"),
  gridBtn: $("grid-btn"),
  bonesBtn: $("bones-btn"),
  resetCamBtn: $("reset-cam-btn"),
  clipMeta: $("clip-meta"),
  clipTitle: $("clip-title"),
  note: $("note"),
  starBtn: $("star-btn"),
  exportBtn: $("export-btn"),
  viewport: $("viewport"),
  viewportWrap: $("viewport-wrap"),
  bodySelect: $("body-select"),
  nameMapBtn: $("name-map-btn"),
  nameMapModal: $("name-map-modal"),
  nameMapEditor: $("name-map-editor"),
  nameMapSave: $("name-map-save"),
  nameMapCancel: $("name-map-cancel"),
  nameMapReset: $("name-map-reset"),
  setStartBtn: $("set-start-btn"),
  setEndBtn: $("set-end-btn"),
  sendPairBtn: $("send-pair-btn"),
  variants: $("variants"),
  startReadout: $("start-readout"),
  endReadout: $("end-readout"),
  pairsList: $("pairs-list"),
  pairsCount: $("pairs-count"),
  detailsPanel: $("details-panel"),
  detailsStatus: $("details-status"),
  trackDebugMode: $("track-debug-mode"),
  trackDebugList: $("track-debug-list"),
  openFolderBtn: $("open-folder-btn"),
  reopenFolderBtn: $("reopen-folder-btn"),
  folderInput: $("folder-input"),
  overlayActions: $("overlay-actions"),
  savePairsBtn: $("save-pairs-btn"),
  loadPairsBtn: $("load-pairs-btn"),
  pairsInput: $("pairs-input"),
  helperPill: $("helper-pill"),
  helperModal: $("helper-modal"),
  helperModalBody: $("helper-modal-body"),
  helperRecheck: $("helper-recheck"),
  helperModalClose: $("helper-modal-close"),
  generateAllBtn: $("generate-all-btn"),
  optForward: $("opt-forward"),
  optRight: $("opt-right"),
  optTurn: $("opt-turn"),
  compareBar: $("compare-bar"),
  compareTitle: $("compare-title"),
  compareNote: $("compare-note"),
  cmpStart: $("cmp-start"),
  cmpGen: $("cmp-gen"),
  cmpEnd: $("cmp-end"),
  cmpVariant: $("cmp-variant"),
  cmpClose: $("cmp-close"),
};

let allClips = [];
let visibleClips = [];
let selectedPath = null;
let loadGen = 0;
let treeList = null;

let playing = false;
let isScrubbing = false;
let lockRoot = false;
let showGrid = true;
let showBones = true;
let speed = 1;
let currentDuration = 0;
let boneCount = 0;
let meshCount = 0;
let animClips = [];
let currentAnimIndex = 0;

let model = null;
let skeletonHelper = null;
let mixer = null;
let action = null;
let rootBone = null;
const lockedRootXZ = new THREE.Vector2();
let storedView = null;

const clock = new THREE.Clock();
const loader = new FBXLoader();
const gltfLoader = new GLTFLoader();

let previewObject = null;
let previewPath = null;
let usingPreview = false;
let mapInfo = null;
let currentSynonyms = { ...DEFAULT_SYNONYMS };
let defaultNameMapText = "";
let startPose = null;
let endPose = null;
let pairs = [];
let pairsPath = "";
let pairsHandle = null;
let pairsDirty = false;
let currentPack = "";
let previewLoad = null;
let fbxChain = Promise.resolve();
let bodyPresets = [];
let folderReady = false;
let autoResolvedBody = "";

// --- renderer / scene -------------------------------------------------------
const renderer = new THREE.WebGLRenderer({
  canvas: el.viewport,
  antialias: true,
  alpha: false,
});
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.setClearColor(0x0d0e13, 1);
renderer.outputColorSpace = THREE.SRGBColorSpace;

const scene = new THREE.Scene();
scene.fog = new THREE.Fog(0x0d0e13, 24, 80);

const camera = new THREE.PerspectiveCamera(45, 1, 0.05, 500);
camera.position.set(2.4, 1.7, 3.4);

const orbit = new OrbitControls(camera, el.viewport);
orbit.enableDamping = true;
orbit.dampingFactor = 0.08;
orbit.target.set(0, 1, 0);
orbit.update();

scene.add(new THREE.HemisphereLight(0xdde6ff, 0x2a241c, 1.15));
const key = new THREE.DirectionalLight(0xfff2d8, 1.35);
key.position.set(3.2, 8, 4);
scene.add(key);
const fill = new THREE.DirectionalLight(0x8aa0c8, 0.4);
fill.position.set(-5, 2, -3);
scene.add(fill);

const grid = new THREE.GridHelper(16, 16, 0x3d4154, 0x232633);
grid.position.y = 0;
scene.add(grid);

function resize() {
  const wrap = el.viewportWrap;
  const w = Math.max(1, wrap.clientWidth);
  const h = Math.max(1, wrap.clientHeight);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h, false);
}
new ResizeObserver(resize).observe(el.viewportWrap);
resize();

function tick() {
  requestAnimationFrame(tick);
  const dt = clock.getDelta();
  if (mixer && playing && !isScrubbing) {
    mixer.update(dt);
    applyRootLock();
    syncScrub(true);
  }
  orbit.update();
  renderer.render(scene, camera);
}
tick();

// --- storage ----------------------------------------------------------------
function loadStore() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}
function saveStore(store) {
  localStorage.setItem(STORE_KEY, JSON.stringify(store));
}
function isStarred(path, store = loadStore()) {
  return !!(store[path] && store[path].starred);
}
function getNote(path, store = loadStore()) {
  return (store[path] && store[path].note) || "";
}

// --- helpers ----------------------------------------------------------------
function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
function formatSize(n) {
  if (n < 1024) return n + " B";
  if (n < 1024 * 1024) return Math.round(n / 1024) + " KB";
  return (n / (1024 * 1024)).toFixed(1) + " MB";
}
function csvEscape(s) {
  const t = String(s ?? "");
  if (/[",\n\r]/.test(t)) return `"${t.replace(/"/g, '""')}"`;
  return t;
}

function showOverlay(kind, title, body) {
  el.overlay.className = kind || "";
  el.overlay.classList.remove("hidden");
  const h2 = el.overlay.querySelector("h2");
  const p = el.overlay.querySelector("p");
  if (h2) h2.textContent = title;
  if (p) p.textContent = body;
}
function hideOverlay() {
  el.overlay.classList.add("hidden");
  if (el.overlayActions) el.overlayActions.innerHTML = "";
}

function setOverlayActions(nodes) {
  if (!el.overlayActions) return;
  el.overlayActions.innerHTML = "";
  for (const n of nodes || []) el.overlayActions.appendChild(n);
}

function makeButton(label, className, onClick) {
  const b = document.createElement("button");
  b.type = "button";
  b.textContent = label;
  if (className) b.className = className;
  b.addEventListener("click", onClick);
  return b;
}

// --- list -------------------------------------------------------------------
function ensureTree() {
  if (treeList) return treeList;
  treeList = createTreeList({
    container: el.clipList,
    countEl: el.clipCount,
    getClips: () => allClips,
    getQuery: () => (el.search && el.search.value) || "",
    getStarredOnly: () => !!(el.starredToggle && el.starredToggle.checked),
    isStarred,
    getSelectedPath: () => selectedPath,
    getRootId: () => (el.rootPath && (el.rootPath.title || el.rootPath.textContent)) || "_",
    formatSize,
    escapeHtml,
    onSelect: (path, load) => setSelectedPath(path, load),
    onToggleStar: (path) => toggleStar(path),
  });
  if (el.showHiddenToggle) {
    el.showHiddenToggle.checked = treeList.getShowHidden();
  }
  window.__treeDebug = () => treeList && treeList.debug();
  return treeList;
}

function renderList(flags) {
  visibleClips = ensureTree().render(flags) || ensureTree().getVisibleClips();
}

function setSelectedPath(path, shouldLoad, flags) {
  selectedPath = path;
  renderList(flags && flags.scrollToPath ? { scrollToPath: path } : {});
  updateMetaPanel();
  if (shouldLoad && path) loadClip(path);
}

function stepSelection(dir) {
  const clips = (treeList && treeList.getVisibleClips()) || visibleClips;
  if (!clips.length) return;
  const idx = clips.findIndex((c) => c.path === selectedPath);
  let next = idx + dir;
  if (idx < 0) next = dir > 0 ? 0 : clips.length - 1;
  if (next < 0) next = 0;
  if (next >= clips.length) next = clips.length - 1;
  if (clips[next]) setSelectedPath(clips[next].path, true, { scrollToPath: true });
}

// --- favorites --------------------------------------------------------------
function toggleStar(path) {
  const store = loadStore();
  const rec = store[path] || { starred: false, note: "" };
  rec.starred = !rec.starred;
  if (!rec.starred && !rec.note) delete store[path];
  else store[path] = rec;
  saveStore(store);
  renderList();
  if (path === selectedPath) updateMetaPanel();
}

function saveNote(path, note) {
  const store = loadStore();
  const rec = store[path] || { starred: false, note: "" };
  rec.note = note;
  if (!rec.starred && !rec.note) delete store[path];
  else store[path] = rec;
  saveStore(store);
}

function updateMetaPanel() {
  const clip = allClips.find((c) => c.path === selectedPath);
  if (!clip) {
    el.clipTitle.textContent = "No clip selected";
    el.clipTitle.classList.add("empty");
    el.note.value = "";
    el.note.disabled = true;
    el.starBtn.disabled = true;
    el.starBtn.classList.remove("starred");
    el.starBtn.textContent = "☆ Star";
    return;
  }
  el.clipTitle.textContent = clip.path;
  el.clipTitle.classList.remove("empty");
  el.note.disabled = false;
  el.note.value = getNote(clip.path);
  el.starBtn.disabled = false;
  const starred = isStarred(clip.path);
  el.starBtn.classList.toggle("starred", starred);
  el.starBtn.textContent = starred ? "★ Starred" : "☆ Star";
}

function exportStarredCsv() {
  const store = loadStore();
  const rows = [["path", "note"]];
  const seen = new Set();
  for (const clip of allClips) {
    if (isStarred(clip.path, store)) {
      rows.push([clip.path, getNote(clip.path, store)]);
      seen.add(clip.path);
    }
  }
  for (const [path, rec] of Object.entries(store)) {
    if (rec && rec.starred && !seen.has(path)) rows.push([path, rec.note || ""]);
  }
  if (rows.length === 1) {
    showOverlay(
      "error",
      "Nothing starred yet",
      "Star clips you want as start/end candidates, add a note if you like, then export again."
    );
    setTimeout(() => {
      if (el.overlay.querySelector("h2")?.textContent === "Nothing starred yet") hideOverlay();
    }, 3200);
    return;
  }
  const text = rows.map((r) => r.map(csvEscape).join(",")).join("\r\n") + "\r\n";
  const blob = new Blob([text], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "starred-clips.csv";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// --- scene / clip loading ---------------------------------------------------
function disposeObject(root) {
  root.traverse((child) => {
    if (child.geometry) child.geometry.dispose();
    const mats = child.material
      ? Array.isArray(child.material)
        ? child.material
        : [child.material]
      : [];
    for (const m of mats) {
      if (!m) continue;
      for (const key of Object.keys(m)) {
        const v = m[key];
        if (v && v.isTexture) v.dispose();
      }
      m.dispose();
    }
  });
}

function disposeCurrent() {
  if (mixer) {
    mixer.stopAllAction();
    try {
      if (model) mixer.uncacheRoot(model);
    } catch {
      /* older three.js may not have uncacheRoot */
    }
    mixer = null;
  }
  action = null;
  animClips = [];
  rootBone = null;
  mapInfo = null;
  if (el.detailsPanel) el.detailsPanel.hidden = true;
  usingPreview = false;
  if (skeletonHelper) {
    scene.remove(skeletonHelper);
    if (skeletonHelper.geometry) skeletonHelper.geometry.dispose();
    if (skeletonHelper.material) skeletonHelper.material.dispose();
    skeletonHelper = null;
  }
  if (model && model !== previewObject) {
    scene.remove(model);
    disposeObject(model);
  }
  model = null;
}


function collectBindableNames(object) {
  const names = [];
  const seen = new Set();
  if (!object) return names;
  object.traverse((o) => {
    if (o.name && !seen.has(o.name)) {
      seen.add(o.name);
      names.push(o.name);
    }
  });
  return names;
}

function collectBones(object) {
  const bones = [];
  object.traverse((o) => {
    if (o.isBone) bones.push(o);
  });
  return bones;
}

function findRootBone(object) {
  const bones = collectBones(object);
  for (const b of bones) {
    const n = b.name.replace(/\s+/g, "");
    if (ROOT_NAME_RE.test(n) || ROOT_NAME_RE.test(b.name)) return b;
  }
  const clip = animClips[currentAnimIndex];
  if (clip) {
    for (const track of clip.tracks) {
      if (!track.name.endsWith(".position")) continue;
      const boneName = track.name.split(".")[0];
      const b = bones.find((x) => x.name === boneName);
      if (b) return b;
    }
  }
  return bones[0] || null;
}

function applyRootLock() {
  if (!lockRoot || !rootBone) return;
  rootBone.position.x = lockedRootXZ.x;
  rootBone.position.z = lockedRootXZ.y;
}

function captureRootLock() {
  rootBone = findRootBone(model);
  if (rootBone) lockedRootXZ.set(rootBone.position.x, rootBone.position.z);
  else lockedRootXZ.set(0, 0);
}

function computeBounds(object) {
  const box = new THREE.Box3();
  object.updateMatrixWorld(true);
  const bones = [];
  object.traverse((o) => {
    if (o.isBone) bones.push(o);
  });
  // Skinned-mesh geometry boxes are often in bind pose and can be huge or empty.
  // Prefer the live skeleton when one exists.
  if (bones.length) {
    const p = new THREE.Vector3();
    for (const b of bones) {
      b.getWorldPosition(p);
      box.expandByPoint(p);
    }
    return box;
  }
  object.traverse((o) => {
    if (o.isMesh || o.isSkinnedMesh) {
      const b = new THREE.Box3().setFromObject(o);
      if (!b.isEmpty()) box.union(b);
    }
  });
  return box;
}

function frameModel(object) {
  object.position.set(0, 0, 0);
  object.scale.set(1, 1, 1);
  object.updateMatrixWorld(true);

  let box = computeBounds(object);
  if (box.isEmpty()) {
    box.set(new THREE.Vector3(-0.5, 0, -0.5), new THREE.Vector3(0.5, 1.8, 0.5));
  }
  const rawHeight = Math.max(box.max.y - box.min.y, 0.001);
  const scale = 1.8 / rawHeight;
  object.scale.setScalar(scale);
  object.updateMatrixWorld(true);

  box = computeBounds(object);
  const minY = box.min.y;
  const cx = (box.min.x + box.max.x) / 2;
  const cz = (box.min.z + box.max.z) / 2;
  object.position.set(-cx, -minY, -cz);
  object.updateMatrixWorld(true);
  box = computeBounds(object);

  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const radius = Math.max(size.x, size.y, size.z, 0.5) * 0.6;
  const dist = radius / Math.tan(((camera.fov * Math.PI) / 180) / 2);
  const dir = new THREE.Vector3(0.75, 0.4, 1).normalize();
  const camDist = Math.max(dist * 1.5, 2.2);
  camera.near = Math.max(camDist / 200, 0.01);
  camera.far = Math.max(camDist * 20, 80);
  camera.updateProjectionMatrix();
  camera.position.copy(center).add(dir.multiplyScalar(camDist));
  orbit.target.copy(center);
  orbit.update();
  // Keep fog scaled to the view so unscaled / large FBX files do not vanish in it.
  scene.fog.near = camDist * 3;
  scene.fog.far = camDist * 10;
  storedView = {
    pos: camera.position.clone(),
    target: orbit.target.clone(),
    near: camera.near,
    far: camera.far,
  };
}

function resetCamera() {
  if (!storedView) return;
  camera.position.copy(storedView.pos);
  camera.near = storedView.near;
  camera.far = storedView.far;
  camera.updateProjectionMatrix();
  orbit.target.copy(storedView.target);
  orbit.update();
}

function prepareMaterials(object) {
  meshCount = 0;
  object.traverse((child) => {
    if (!(child.isMesh || child.isSkinnedMesh)) return;
    meshCount += 1;
    const mats = Array.isArray(child.material) ? child.material : [child.material];
    for (const m of mats) {
      if (!m) continue;
      if (m.map) m.map.colorSpace = THREE.SRGBColorSpace;
      // Preview fallback: untextured black Lambert/Phong reads as a hole in a dark viewport.
      if (m.color && !m.map && m.color.getHex() === 0) {
        m.color.setHex(0xc2c2c2);
      }
    }
  });
}

function setPlaying(on) {
  playing = !!on && !!action;
  el.playBtn.textContent = playing ? "Pause" : "Play";
  if (mixer) clock.getDelta();
}

function syncScrub(updateSlider) {
  if (!mixer || currentDuration <= 0) {
    el.frameReadout.textContent = "—";
    return;
  }
  let t = mixer.time;
  if (currentDuration) {
    t = t % currentDuration;
    if (t < 0) t += currentDuration;
  }
  const total = Math.max(1, Math.round(currentDuration * DISPLAY_FPS));
  const frame = Math.min(total, Math.max(0, Math.round(t * DISPLAY_FPS)));
  if (updateSlider && !isScrubbing) {
    el.scrub.max = String(total);
    el.scrub.value = String(frame);
  }
  el.frameReadout.textContent = `${frame} / ${total}  (${currentDuration.toFixed(2)}s @ ${DISPLAY_FPS}fps)`;
}


function bodyShortName(path) {
  if (!path) return "clip skeleton";
  let base = String(path).replace(/\\/g, "/").split("/").pop() || path;
  base = base.replace(/\.fbx$/i, "");
  base = base.replace(/_Model$/i, "");
  return base;
}

function updateTrackDebug(info, onPreview) {
  if (!el.trackDebugList || !el.trackDebugMode) return;
  const unmatched = (info && (info.unmatchedTracks || info.unmatched)) || [];
  const mode = !onPreview
    ? "Playing the clip's own skeleton, as authored."
    : info && info.mode === "exact"
      ? "Exact name bind — same skeleton, no retarget math."
      : info && info.mode === "delta"
        ? "Rest-relative retarget (cross-pack)."
        : "Bound to the selected body.";
  const counts = info
    ? `${info.mapped || 0} / ${info.source || 0} tracks bound`
    : "";
  el.trackDebugMode.textContent = counts ? mode + " " + counts + "." : mode;
  el.trackDebugList.innerHTML = "";
  if (onPreview && !unmatched.length) {
    const li = document.createElement("li");
    li.className = "ok";
    li.textContent = "All clip tracks bound to a bone or node on the body.";
    el.trackDebugList.appendChild(li);
  } else {
    for (const name of unmatched) {
      const li = document.createElement("li");
      li.textContent = name;
      el.trackDebugList.appendChild(li);
    }
  }
  if (el.detailsPanel) el.detailsPanel.hidden = false;
  if (el.detailsStatus) {
    const body = onPreview && previewPath ? bodyShortName(previewPath) : "clip skeleton";
    el.detailsStatus.textContent = "Body: " + body + (currentPack ? " · Pack: " + currentPack : "");
  }
}

function updateHud(clipName) {
  let line;
  if (usingPreview && previewPath) {
    const n = mapInfo && mapInfo.source ? `${mapInfo.mapped || 0}/${mapInfo.source}` : `${boneCount}/${boneCount}`;
    line = `Playing on ${bodyShortName(previewPath)} (${n} bones)`;
  } else {
    line = "Playing on clip skeleton";
    if (mapInfo && !mapInfo.ok && mapInfo.source) {
      line += ` — body bind was ${mapInfo.mapped || 0}/${mapInfo.source}`;
    }
  }
  if (lockRoot) line += " · root locked";
  el.hud.innerHTML = `<strong>${escapeHtml(clipName || "—")}</strong> · ${escapeHtml(line)}`;
  el.hud.hidden = false;
  el.clipMeta.textContent =
    currentDuration > 0
      ? `${boneCount} bones · ${currentDuration.toFixed(2)}s`
      : `${boneCount} bones · pose`;
}

function playTake(index) {
  currentAnimIndex = index;
  if (action) {
    action.stop();
    action = null;
  }
  if (!mixer || !animClips.length) {
    currentDuration = 0;
    el.scrub.disabled = true;
    el.playBtn.disabled = true;
    setPlaying(false);
    syncScrub(true);
    return;
  }
  const clip = animClips[index];
  action = mixer.clipAction(clip);
  action.reset();
  action.setLoop(THREE.LoopRepeat, Infinity);
  action.setEffectiveTimeScale(speed);
  action.play();
  currentDuration = clip.duration || 0;
  el.scrub.disabled = currentDuration <= 0;
  el.playBtn.disabled = currentDuration <= 0;
  el.scrub.max = String(Math.max(1, Math.round(currentDuration * DISPLAY_FPS)));
  setPlaying(true);
  mixer.update(0);
  applyRootLock();
  syncScrub(true);
}

function enableTransport(on) {
  el.playBtn.disabled = !on;
  el.speed.disabled = !on;
  el.lockRootBtn.disabled = !on;
  el.resetCamBtn.disabled = !on;
  if (el.setStartBtn) el.setStartBtn.disabled = !on;
  if (el.setEndBtn) el.setEndBtn.disabled = !on;
  if (!on) el.scrub.disabled = true;
  updateSendEnabled();
}

function collectClipsFrom(object) {
  let clips = Array.isArray(object.animations) ? object.animations.slice() : [];
  if (!clips.length) {
    object.traverse((o) => {
      if (o.animations && o.animations.length) clips = clips.concat(o.animations);
    });
  }
  return clips;
}

function loadFbxSerialized(path) {
  const run = async () => {
    const buf = await getArrayBuffer(path);
    const manager = new THREE.LoadingManager();
    manager.onError = (url) => {
      console.warn("Optional FBX resource failed:", url);
    };
    const slash = String(path).lastIndexOf("/");
    const folder = slash >= 0 ? path.slice(0, slash + 1) : "";
    manager.setURLModifier((url) => resolveLocalResource(url, folder) || url);
    const inst = new FBXLoader(manager);
    const parsed = inst.parse(buf, folder);
    if (isVirtualPath(path)) {
      // Blender's exporter writes constant scale tracks (B-root = 100) that would blow the rig up when bound.
      const lists = [parsed.animations || []];
      parsed.traverse((o) => {
        if (o !== parsed && o.animations && o.animations.length) lists.push(o.animations);
      });
      for (const list of lists) {
        for (const clip of list) clip.tracks = clip.tracks.filter((t) => !/\.scale$/.test(t.name));
      }
    }
    return parsed;
  };
  const p = fbxChain.then(run, run);
  fbxChain = p.then(
    () => {},
    () => {}
  );
  return p;
}

function loadFbxOrConverted(path) {
  return loadFbxSerialized(path).catch((fbxErr) => {
    const detail = fbxErr && fbxErr.message ? fbxErr.message : String(fbxErr || "Unknown error");
    throw new Error(
      detail +
        " This static build cannot convert unreadable FBX through Blender or FBX2glTF."
    );
  });
}

function presetForPack(pack, clipPath) {
  const hay = ((clipPath || "") + " " + (pack || "")).replace(/\\/g, "/");
  for (const preset of bodyPresets) {
    if (!preset || !preset.packPattern) continue;
    try {
      const re = new RegExp(preset.packPattern, "i");
      if (re.test(hay) || re.test(pack || "") || (preset.packName && preset.packName === pack)) {
        return preset;
      }
    } catch {
      /* bad pattern */
    }
  }
  return null;
}

function detectPackResolved(clipPath, boneNames) {
  const preset = presetForPack("", clipPath);
  if (preset && preset.packName) return preset.packName;
  return detectPack(clipPath, boneNames);
}

function preferredNamePatterns(pack) {
  const preset = bodyPresets.find((pr) => pr && pr.packName === pack) || presetForPack(pack, pack);
  if (preset && Array.isArray(preset.bodyNames) && preset.bodyNames.length) {
    return preset.bodyNames.map((n) => {
      const stem = String(n || "").replace(/\.fbx$/i, "");
      const esc = stem.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return new RegExp("^" + esc + "(\\.fbx)?$", "i");
    });
  }
  return packBodyPreferredNames(pack);
}

function modelsInPack(pack) {
  return listMeshModels().filter((c) => c.pack === pack || detectPackResolved(c.path) === pack);
}

function listMeshModels() {
  return allClips.filter((c) => c.isModel);
}

function defaultBodyPathForPack(pack, excludePath) {
  if (!pack) return "";
  const skip = excludePath || selectedPath || "";
  const candidates = listMeshModels().filter((c) => c.path !== skip);
  const packClips = modelsInPack(pack).filter((c) => c.path !== skip);
  const patterns = preferredNamePatterns(pack);
  for (const re of patterns) {
    const hit = packClips.find((c) => re.test(c.name) || re.test((c.path || "").split("/").pop() || ""));
    if (hit) return hit.path;
  }
  // A single mesh in this pack is the obvious Auto body.
  if (packClips.length === 1) return packClips[0].path;
  // Several meshes and no preset name: leave empty so loadClip can score bone overlap.
  if (packClips.length > 1) return "";
  for (const re of patterns) {
    const hit = candidates.find((c) => re.test(c.name) || re.test((c.path || "").split("/").pop() || ""));
    if (hit) return hit.path;
  }
  return "";
}

function hasPresetBodyName(pack) {
  const packClips = modelsInPack(pack);
  const patterns = preferredNamePatterns(pack);
  return packClips.some((c) => patterns.some((re) => re.test(c.name) || re.test((c.path || "").split("/").pop() || "")));
}

async function pickBodyByBoneOverlap(pack, trackBones, excludePath) {
  const models = modelsInPack(pack).filter((c) => c.path !== excludePath);
  if (!models.length) return "";
  if (models.length === 1) return models[0].path;
  let bestPath = models[0].path;
  let bestRatio = -1;
  for (const m of models) {
    try {
      const obj = await loadFbxOrConverted(m.path);
      const names = collectBindableNames(obj);
      const cov = exactNameCoverage(trackBones || [], names);
      // Dispose unless this is already the live preview (it shouldn't be yet).
      if (obj !== previewObject) disposeObject(obj);
      if (cov.ratio > bestRatio) {
        bestRatio = cov.ratio;
        bestPath = m.path;
      }
    } catch (err) {
      console.warn("Could not score body", m.path, err);
    }
  }
  return bestPath;
}

function bodyChoice() {
  return el.bodySelect ? el.bodySelect.value : "auto";
}

function resolvedBodyPath(pack) {
  const choice = bodyChoice();
  if (choice === "") return "";
  if (choice !== "auto") return choice;
  if (autoResolvedBody && autoResolvedBody !== (selectedPath || "")) return autoResolvedBody;
  return defaultBodyPathForPack(pack || currentPack, selectedPath) || "";
}

function wantsPreviewForPack(pack) {
  return !!resolvedBodyPath(pack);
}

function fillBodySelect() {
  if (!el.bodySelect) return;
  let saved = "auto";
  try {
    saved = localStorage.getItem(BODY_KEY);
    if (saved == null) saved = "auto";
  } catch {
    saved = "auto";
  }
  const models = listMeshModels().slice();
  models.sort((a, b) => {
    const rank = (c) => {
      if (/humanm_model\.fbx$/i.test(c.name) || /humanm_model\.fbx$/i.test(c.path)) return 0;
      if (/sk_protof-actor\.fbx$/i.test(c.name)) return 1;
      if (/sk_protof-actress\.fbx$/i.test(c.name)) return 2;
      return 3;
    };
    return rank(a) - rank(b) || a.name.localeCompare(b.name);
  });
  const opts = [
    { value: "auto", label: "Auto (matches pack)" },
    { value: "", label: "Skeleton only" },
  ];
  for (const c of models) {
    opts.push({ value: c.path, label: bodyShortName(c.path) });
  }
  el.bodySelect.innerHTML = opts
    .map((o) => `<option value="${escapeHtml(o.value)}">${escapeHtml(o.label)}</option>`)
    .join("");
  if (saved === "auto" || saved === "" || models.some((c) => c.path === saved)) {
    el.bodySelect.value = saved;
  } else {
    el.bodySelect.value = "auto";
  }
}

async function ensurePreviewLoaded(path) {
  if (path == null) path = resolvedBodyPath(currentPack);
  if (!path) {
    if (previewObject) {
      scene.remove(previewObject);
      disposeObject(previewObject);
      previewObject = null;
      previewPath = null;
    }
    return null;
  }
  if (previewObject && previewPath === path) {
    previewObject.visible = true;
    return previewObject;
  }
  if (previewLoad && previewLoad.path === path) return previewLoad.promise;
  if (previewObject) {
    scene.remove(previewObject);
    disposeObject(previewObject);
    previewObject = null;
    previewPath = null;
  }
  const promise = loadFbxOrConverted(path);
  previewLoad = { path, promise };
  let obj;
  try {
    obj = await promise;
  } finally {
    if (previewLoad && previewLoad.promise === promise) previewLoad = null;
  }
  prepareMaterials(obj);
  previewObject = obj;
  previewPath = path;
  scene.add(obj);
  frameModel(obj);
  return obj;
}

function setupTakeSelect(clips) {
  if (clips.length > 1) {
    el.clipSelect.hidden = false;
    el.clipSelect.innerHTML = clips
      .map(
        (c, i) =>
          `<option value="${i}">${escapeHtml(c.name || "Take " + (i + 1))}</option>`
      )
      .join("");
    el.clipSelect.value = "0";
  } else {
    el.clipSelect.hidden = true;
    el.clipSelect.innerHTML = "";
  }
}

function presentClipObject(object, path, fallbackNote) {
  const clipInfo = allClips.find((c) => c.path === path);
  prepareMaterials(object);
  const sourceClips = collectClipsFrom(object);
  const sourceBoneObjs = collectBones(object);
  const sourceBoneNames = sourceBoneObjs.map((b) => b.name);

  const pack = detectPackResolved(path, sourceBoneNames);
  currentPack = pack;
  const usePreview =
    previewObject &&
    resolvedBodyPath(pack) &&
    sourceClips.length &&
    wantsPreviewForPack(pack);

  if (usePreview) {
    const targetBones = collectBones(previewObject).map((b) => b.name);
    const targetNames = collectBindableNames(previewObject);
    const bindNames = targetNames.length ? targetNames : targetBones;
    const retargeted = [];
    let last = null;
    for (const clip of sourceClips) {
      const trackBones = uniqueTrackBones(clip);
      const exact = exactNameCoverage(trackBones, bindNames);
      if (exact.ratio >= 0.9) {
        last = bindClipExact(THREE, clip, bindNames, 0.9);
      } else {
        last = retargetClipRestRelative(THREE, {
          sourceObject: object,
          targetObject: previewObject,
          clip,
          sourceBoneNames,
          targetBoneNames: targetBones,
          synonyms: currentSynonyms,
          minRatio: 0.5,
        });
      }
      if (last.ok && last.clip) retargeted.push(last.clip);
    }
    mapInfo = last;
    if (last && last.ok && retargeted.length) {
      usingPreview = true;
      disposeObject(object);
      previewObject.visible = true;
      model = previewObject;
      animClips = retargeted;
      mixer = new THREE.AnimationMixer(previewObject);
      boneCount = targetBones.length;
      meshCount = 0;
      previewObject.traverse((o) => {
        if (o.isMesh || o.isSkinnedMesh) meshCount += 1;
      });
      setupTakeSelect(animClips);
      playTake(0);
      captureRootLock();
      applyRootLock();
      skeletonHelper = new THREE.SkeletonHelper(previewObject);
      skeletonHelper.visible = showBones;
      scene.add(skeletonHelper);
      hideOverlay();
      enableTransport(true);
      if (currentDuration <= 0) {
        el.playBtn.disabled = true;
        el.scrub.disabled = true;
      }
      updateHud(clipInfo ? clipInfo.name : path);
      updateTrackDebug(mapInfo, true);
      return;
    }
  }

  if (previewObject) previewObject.visible = false;
  usingPreview = false;
  if (!fallbackNote && resolvedBodyPath(pack)) {
    if (mapInfo && !mapInfo.ok && wantsPreviewForPack(pack)) {
      if (mapInfo.reason === "sanity") {
        fallbackNote =
          "Retarget onto the preview body did not look right (the character was not upright or hips were out of range). Showing this clip's own skeleton.";
      } else {
        fallbackNote =
          "Only " +
          (mapInfo.mapped || 0) +
          " of " +
          (mapInfo.source || 0) +
          " bones mapped to the preview body (need about 50%). Showing this clip's own skeleton. You can edit the name map.";
      }
    } else if (!wantsPreviewForPack(pack)) {
      // Intentional own-skeleton default or preference; no warning.
      fallbackNote = "";
    }
  }
  model = object;
  animClips = sourceClips;
  mixer = new THREE.AnimationMixer(object);
  boneCount = sourceBoneNames.length;
  scene.add(object);
  setupTakeSelect(animClips);
  playTake(0);
  captureRootLock();
  applyRootLock();
  frameModel(object);
  skeletonHelper = new THREE.SkeletonHelper(object);
  skeletonHelper.visible = showBones;
  scene.add(skeletonHelper);
  if (boneCount === 0 && meshCount === 0) {
    showOverlay(
      "error",
      "Nothing to display",
      "This FBX loaded, but it has no bones or meshes the viewer can show."
    );
  } else if (fallbackNote) {
    showOverlay("idle", "Showing the clip skeleton", fallbackNote);
    setTimeout(() => {
      if (el.overlay.querySelector("h2")?.textContent === "Showing the clip skeleton") {
        hideOverlay();
      }
    }, 3500);
  } else {
    hideOverlay();
  }
  enableTransport(true);
  if (currentDuration <= 0) {
    el.playBtn.disabled = true;
    el.scrub.disabled = true;
  }
  updateHud(clipInfo ? clipInfo.name : path);
  updateTrackDebug(mapInfo, false);
}

function loadClip(path, opts = {}) {
  if (!opts.keepCompare) hideCompare();
  const clipInfo = allClips.find((c) => c.path === path);
  const gen = ++loadGen;
  disposeCurrent();
  enableTransport(false);
  el.hud.hidden = true;
  el.hud.innerHTML = "";
  el.clipMeta.textContent = "";
  el.clipSelect.hidden = true;
  el.clipSelect.innerHTML = "";
  el.playBtn.textContent = "Play";
  el.scrub.value = "0";
  el.scrub.max = "0";
  el.frameReadout.textContent = "—";
  playing = false;
  currentDuration = 0;
  const sizeHint =
    clipInfo && clipInfo.size >= LARGE_FILE
      ? ` This file is ${formatSize(clipInfo.size)}, so the first load may take a moment.`
      : "";
  showOverlay("loading", "Loading clip…", (clipInfo ? clipInfo.name : path) + "." + sizeHint);

  const run = async () => {
    const pack = detectPackResolved(path);
    currentPack = pack;
    autoResolvedBody = "";
    let bodyPath = resolvedBodyPath(pack);
    if (bodyPath) autoResolvedBody = bodyPath;
    const needsOverlap =
      bodyChoice() === "auto" && !bodyPath && modelsInPack(pack).filter((c) => c.path !== path).length > 0;
    if (bodyPath) {
      try {
        await ensurePreviewLoaded(bodyPath);
      } catch (err) {
        console.warn("Preview model failed to load", err);
      }
    }
    const object = await loadFbxOrConverted(path);
    if (gen !== loadGen) {
      disposeObject(object);
      return;
    }
    if (needsOverlap) {
      const sourceClips = collectClipsFrom(object);
      const trackBones = [];
      const seen = new Set();
      for (const clip of sourceClips) {
        for (const b of uniqueTrackBones(clip)) {
          if (!seen.has(b)) {
            seen.add(b);
            trackBones.push(b);
          }
        }
      }
      if (!trackBones.length) {
        for (const b of collectBones(object)) {
          if (!seen.has(b.name)) {
            seen.add(b.name);
            trackBones.push(b.name);
          }
        }
      }
      bodyPath = await pickBodyByBoneOverlap(pack, trackBones, path);
      autoResolvedBody = bodyPath || "";
      if (gen !== loadGen) {
        disposeObject(object);
        return;
      }
      if (bodyPath) {
        try {
          await ensurePreviewLoaded(bodyPath);
        } catch (err) {
          console.warn("Preview model failed to load", err);
        }
      }
    }
    if (gen !== loadGen) {
      disposeObject(object);
      return;
    }
    presentClipObject(object, path, "");
    if (typeof opts.hook === "function") opts.hook();
  };
  run().catch((err) => {
    if (gen !== loadGen) return;
    console.error(err);
    const detail = err && err.message ? err.message : String(err || "Unknown error");
    showOverlay("error", "Could not read this FBX", detail);
    enableTransport(false);
    el.hud.hidden = true;
  });
}

function currentFrameNumber() {
  if (!mixer || currentDuration <= 0) return 0;
  let t = mixer.time % currentDuration;
  if (t < 0) t += currentDuration;
  return Math.round(t * DISPLAY_FPS);
}

function formatPose(pose, label) {
  if (!pose) return label + ": not set";
  const name = pose.clip.split("/").pop();
  return label + ": " + name + "  f" + pose.frame;
}

function updatePoseReadouts() {
  if (el.startReadout) {
    el.startReadout.textContent = formatPose(startPose, "Start");
    el.startReadout.classList.toggle("set", !!startPose);
  }
  if (el.endReadout) {
    el.endReadout.textContent = formatPose(endPose, "End");
    el.endReadout.classList.toggle("set", !!endPose);
  }
  updateSendEnabled();
}

function updateSendEnabled() {
  if (el.sendPairBtn) el.sendPairBtn.disabled = !(startPose && endPose);
}

function setPose(which) {
  if (!selectedPath) return;
  const pose = { clip: selectedPath, frame: currentFrameNumber() };
  if (which === "start") startPose = pose;
  else endPose = pose;
  updatePoseReadouts();
}

function renderPairs() {
  if (!el.pairsList) return;
  if (el.pairsCount) el.pairsCount.textContent = String(pairs.length);
  updateGenerateAll();
  if (!pairs.length) {
    el.pairsList.innerHTML =
      '<div class="empty-list" style="padding:8px 12px">No pairs yet. Set a start and end frame, then Send to Inbetweener. With the local helper running you can Generate the in-between right here.</div>';
    return;
  }
  el.pairsList.innerHTML = pairs
    .map((p) => {
      const s = (p.start && p.start.clip ? p.start.clip.split("/").pop() : "?") + " f" + (p.start && p.start.frame);
      const e = (p.end && p.end.clip ? p.end.clip.split("/").pop() : "?") + " f" + (p.end && p.end.frame);
      const note = p.note ? `<div class="pair-note">${escapeHtml(p.note)}</div>` : "";
      const id = escapeHtml(p.id || "");
      const g = gen.get(p.id);
      const running = g && (g.state === "running" || g.state === "queued");
      const hasResults = g && g.results && g.results.length && g.state !== "running";
      const genTitle = helperState.ready
        ? "Run MotionBricks for this pair"
        : helperState.online
          ? "The helper needs setup (click the Helper pill)"
          : "Start the local helper first (click the Helper pill)";
      const buttons =
        (running
          ? `<button type="button" data-cancel-pair="${id}">Cancel</button>`
          : `<button type="button" data-generate-pair="${id}" title="${escapeHtml(genTitle)}"${helperState.ready ? "" : " disabled"}>Generate</button>`) +
        (hasResults ? `<button type="button" class="view-gen" data-view-pair="${id}">View</button>` : "") +
        `<button type="button" data-delete-pair="${id}">Delete</button>`;
      return `<div class="pair-item" data-pair-id="${id}">
        <div class="pair-top">
          <div class="pair-body">${escapeHtml(s)} → ${escapeHtml(e)} · ${p.variants || 1} var${note}</div>
          <div class="pair-buttons">${buttons}</div>
        </div>
        ${renderGenStatus(p, g)}
      </div>`;
    })
    .join("");
}

function renderGenStatus(p, g) {
  if (!g || g.state === "idle") return "";
  const pct = Math.round((g.progress || 0) * 100);
  let line = "";
  if (g.state === "running" || g.state === "queued") {
    line = `<span>${escapeHtml(g.state === "queued" ? "queued…" : g.step || "working…")} · ${pct}%</span><span class="bar"><i style="width:${pct}%"></i></span>`;
  } else if (g.state === "done") {
    const vs = (g.results || []).map((r) => "v" + r.variant + (r.seconds ? " " + r.seconds + "s" : "")).join(", ");
    const warn = g.warnings && g.warnings.length ? ` <span title="${escapeHtml(g.warnings.join("\n"))}">⚠ ${g.warnings.length}</span>` : "";
    line = `<span class="state-done">${g.fromDisk ? "on disk" : "done"}</span><span>${escapeHtml(vs)}</span>${warn}${g.engine === "mock" ? " <span>(mock engine)</span>" : ""}`;
  } else if (g.state === "error" || g.state === "cancelled") {
    line = `<span class="state-error">${escapeHtml(g.state === "cancelled" ? "cancelled" : g.error || "failed")}</span>`;
  }
  const log =
    g.lines && g.lines.length
      ? `<details class="pair-log" data-log-id="${escapeHtml(p.id)}"${openLogs.has(p.id) ? " open" : ""}><summary>log</summary><pre>${escapeHtml(g.lines.slice(-60).join("\n"))}</pre></details>`
      : "";
  return `<div class="pair-gen">${line}${log}</div>`;
}

function persistPairsLocal() {
  try {
    localStorage.setItem(PAIRS_STORE_KEY, pairsToText({ version: 1, pairs }));
  } catch (err) {
    console.warn("Could not cache pairs in localStorage", err);
  }
  updatePairsSaveState();
}

function updatePairsSaveState() {
  if (!el.savePairsBtn) return;
  el.savePairsBtn.classList.toggle("dirty", !!pairsDirty);
  el.savePairsBtn.title = pairsDirty
    ? "There are unsaved pairs. Click to write pairs.json."
    : (pairsPath || "Save the in-betweener pair list as pairs.json");
}

function markPairsDirty() {
  pairsDirty = true;
  persistPairsLocal();
}

function loadPairsFromStorage() {
  try {
    const raw = localStorage.getItem(PAIRS_STORE_KEY);
    if (!raw) {
      pairs = [];
      return;
    }
    const doc = normalizePairsDoc(JSON.parse(raw));
    pairs = doc.pairs || [];
  } catch {
    pairs = [];
  }
}

async function sendPair() {
  if (!startPose || !endPose) return;
  const item = {
    id: crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + "-" + Math.random().toString(16).slice(2),
    start: { clip: startPose.clip, frame: startPose.frame },
    end: { clip: endPose.clip, frame: endPose.frame },
    variants: Math.max(1, Math.min(32, Number(el.variants && el.variants.value) || 1)),
    note: String((el.note && el.note.value) || "").slice(0, 2000),
    created: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
  };
  item.name = pairName(item);
  const offset = currentTargetOffset();
  if (offset) item.options = { target_offset: offset };
  pairs.push(item);
  markPairsDirty();
  renderPairs();
  let wrote = false;
  if (pairsHandle) {
    try {
      await writePairsToHandle(pairsHandle, { version: 1, pairs });
      pairsDirty = false;
      wrote = true;
      updatePairsSaveState();
    } catch (err) {
      console.warn("Auto-write of pairs.json failed", err);
    }
  }
  showOverlay(
    "idle",
    wrote ? "Pair saved" : "Pair added",
    wrote
      ? "Wrote to " + (pairsPath || "pairs.json") + ". Use Generate on the pair to run MotionBricks (needs the local helper)."
      : "Added to the list in this browser. Click Save pairs.json to write the file to disk (Chrome and Edge can remember the file). Generate runs MotionBricks through the local helper."
  );
  setTimeout(() => {
    const t = el.overlay.querySelector("h2")?.textContent;
    if (t === "Pair saved" || t === "Pair added") hideOverlay();
  }, 4000);
}

async function deletePair(id) {
  if (!id) return;
  const before = pairs.length;
  pairs = pairs.filter((p) => String(p.id) !== String(id));
  if (pairs.length === before) return;
  gen.delete(id);
  markPairsDirty();
  renderPairs();
  if (pairsHandle) {
    try {
      await writePairsToHandle(pairsHandle, { version: 1, pairs });
      pairsDirty = false;
      updatePairsSaveState();
    } catch (err) {
      console.warn("Could not update pairs.json after delete", err);
    }
  }
}

async function savePairsToDisk() {
  const doc = { version: 1, note: undefined, pairs };
  const blob = new Blob([pairsToText({ version: 1, pairs })], { type: "application/json;charset=utf-8" });
  if (pairsHandle) {
    try {
      await writePairsToHandle(pairsHandle, { version: 1, pairs });
      pairsDirty = false;
      updatePairsSaveState();
      showOverlay("idle", "pairs.json saved", "Updated " + (pairsPath || "pairs.json") + ".");
      setTimeout(() => {
        if (el.overlay.querySelector("h2")?.textContent === "pairs.json saved") hideOverlay();
      }, 2500);
      return;
    } catch (err) {
      console.warn("Writing the remembered pairs file failed, asking again", err);
    }
  }
  if (supportsSaveFilePicker()) {
    try {
      const handle = await window.showSaveFilePicker({
        suggestedName: "pairs.json",
        id: "animlab-pairs",
        types: [{ description: "JSON", accept: { "application/json": [".json"] } }],
      });
      await writePairsToHandle(handle, { version: 1, pairs });
      pairsHandle = handle;
      pairsPath = handle.name || "pairs.json";
      await savePairsFileHandle(handle);
      pairsDirty = false;
      updatePairsSaveState();
      showOverlay("idle", "pairs.json saved", "Wrote " + pairsPath + ". This browser can update that file the next time you save.");
      setTimeout(() => {
        if (el.overlay.querySelector("h2")?.textContent === "pairs.json saved") hideOverlay();
      }, 3000);
      return;
    } catch (err) {
      if (err && err.name === "AbortError") return;
      console.warn("showSaveFilePicker failed, falling back to download", err);
    }
  }
  downloadBlob("pairs.json", blob);
  pairsDirty = false;
  pairsPath = "pairs.json (download)";
  updatePairsSaveState();
}

async function openPairsFromDisk() {
  if (supportsDirectoryPicker() && typeof window.showOpenFilePicker === "function") {
    try {
      const [handle] = await window.showOpenFilePicker({
        id: "animlab-pairs",
        types: [{ description: "JSON", accept: { "application/json": [".json"] } }],
        multiple: false,
      });
      const doc = await readPairsFromHandle(handle);
      pairs = doc.pairs || [];
      pairsHandle = handle;
      pairsPath = handle.name || "pairs.json";
      pairsDirty = false;
      await savePairsFileHandle(handle);
      persistPairsLocal();
      renderPairs();
      return;
    } catch (err) {
      if (err && err.name === "AbortError") return;
      console.warn("showOpenFilePicker failed, falling back to file input", err);
    }
  }
  if (el.pairsInput) {
    el.pairsInput.value = "";
    el.pairsInput.click();
  }
}

async function onPairsFileInputChange(ev) {
  const file = ev.target.files && ev.target.files[0];
  ev.target.value = "";
  if (!file) return;
  try {
    const doc = normalizePairsDoc(JSON.parse(await file.text()));
    pairs = doc.pairs || [];
    pairsHandle = null;
    pairsPath = file.name || "pairs.json";
    pairsDirty = false;
    persistPairsLocal();
    renderPairs();
  } catch (err) {
    showOverlay("error", "Could not read pairs.json", String(err && err.message ? err.message : err));
  }
}

function applyNameMapText(text) {
  const obj = JSON.parse(text);
  currentSynonyms = parseNameMap(obj);
}

async function initNameMap() {
  try {
    const res = await fetch("name-map.json");
    defaultNameMapText = await res.text();
  } catch {
    defaultNameMapText = JSON.stringify({ synonyms: DEFAULT_SYNONYMS }, null, 2);
  }
  const saved = localStorage.getItem(NAMEMAP_KEY);
  try {
    applyNameMapText(saved || defaultNameMapText);
  } catch {
    applyNameMapText(defaultNameMapText);
  }
}

function openNameMap() {
  el.nameMapEditor.value = localStorage.getItem(NAMEMAP_KEY) || defaultNameMapText;
  el.nameMapModal.classList.remove("hidden");
}
function closeNameMap() {
  el.nameMapModal.classList.add("hidden");
}


// --- events -----------------------------------------------------------------
if (el.treeCollapseAll) el.treeCollapseAll.addEventListener("click", () => ensureTree().collapseAll());
if (el.treeExpandAll) el.treeExpandAll.addEventListener("click", () => ensureTree().expandAll());
if (el.showHiddenToggle) {
  el.showHiddenToggle.addEventListener("change", () => ensureTree().setShowHidden(el.showHiddenToggle.checked));
}

el.search.addEventListener("input", renderList);
el.starredToggle.addEventListener("change", renderList);

el.playBtn.addEventListener("click", () => setPlaying(!playing));
el.speed.addEventListener("input", () => {
  speed = Number(el.speed.value) || 1;
  el.speedReadout.textContent = speed.toFixed(2) + "×";
  if (action) action.setEffectiveTimeScale(speed);
});
el.scrub.addEventListener("input", () => {
  if (!mixer || currentDuration <= 0) return;
  isScrubbing = true;
  const frame = Number(el.scrub.value) || 0;
  const t = Math.min(currentDuration - 1e-5, Math.max(0, frame / DISPLAY_FPS));
  mixer.setTime(t);
  applyRootLock();
  syncScrub(false);
});
el.scrub.addEventListener("pointerup", () => {
  isScrubbing = false;
});
el.scrub.addEventListener("change", () => {
  isScrubbing = false;
});

el.clipSelect.addEventListener("change", () => {
  playTake(Number(el.clipSelect.value) || 0);
  captureRootLock();
  applyRootLock();
  const clip = allClips.find((c) => c.path === selectedPath);
  updateHud(clip ? clip.name : selectedPath);
});

el.lockRootBtn.addEventListener("click", () => {
  lockRoot = !lockRoot;
  el.lockRootBtn.classList.toggle("active-flag", lockRoot);
  if (mixer) {
    applyRootLock();
  }
  const clip = allClips.find((c) => c.path === selectedPath);
  if (clip) updateHud(clip.name);
});

el.gridBtn.addEventListener("click", () => {
  showGrid = !showGrid;
  grid.visible = showGrid;
  el.gridBtn.classList.toggle("active-flag", showGrid);
});

el.bonesBtn.addEventListener("click", () => {
  showBones = !showBones;
  if (skeletonHelper) skeletonHelper.visible = showBones;
  el.bonesBtn.classList.toggle("active-flag", showBones);
});

el.resetCamBtn.addEventListener("click", resetCamera);
el.starBtn.addEventListener("click", () => {
  if (selectedPath) toggleStar(selectedPath);
});
el.exportBtn.addEventListener("click", exportStarredCsv);
if (el.setStartBtn) el.setStartBtn.addEventListener("click", () => setPose("start"));
if (el.setEndBtn) el.setEndBtn.addEventListener("click", () => setPose("end"));
if (el.sendPairBtn) el.sendPairBtn.addEventListener("click", sendPair);
if (el.pairsList) {
  el.pairsList.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-delete-pair]");
    if (btn) return void deletePair(btn.getAttribute("data-delete-pair"));
    const find = (attr) => {
      const b = e.target.closest("[" + attr + "]");
      return b ? pairs.find((p) => String(p.id) === b.getAttribute(attr)) : null;
    };
    const gp = find("data-generate-pair");
    if (gp) return void generatePair(gp, { autoView: true });
    const cp = find("data-cancel-pair");
    if (cp) return void cancelPair(cp);
    const vp = find("data-view-pair");
    if (vp) return void viewPair(vp, "gen", 1);
  });
  el.pairsList.addEventListener(
    "toggle",
    (e) => {
      const d = e.target;
      if (!d || !d.classList || !d.classList.contains("pair-log")) return;
      const id = d.getAttribute("data-log-id");
      if (d.open) openLogs.add(id);
      else openLogs.delete(id);
    },
    true
  );
}
if (el.openFolderBtn) el.openFolderBtn.addEventListener("click", () => openAnimationFolder(false));
if (el.reopenFolderBtn) el.reopenFolderBtn.addEventListener("click", () => reopenLastFolder());
if (el.folderInput) el.folderInput.addEventListener("change", onFolderInputChange);
if (el.savePairsBtn) el.savePairsBtn.addEventListener("click", savePairsToDisk);
if (el.loadPairsBtn) el.loadPairsBtn.addEventListener("click", openPairsFromDisk);
if (el.pairsInput) el.pairsInput.addEventListener("change", onPairsFileInputChange);
if (el.bodySelect) {
  el.bodySelect.addEventListener("change", () => {
    try {
      localStorage.setItem(BODY_KEY, el.bodySelect.value);
    } catch {
      /* ignore */
    }
    previewPath = null;
    if (selectedPath) loadClip(selectedPath);
  });
}
if (el.nameMapBtn) el.nameMapBtn.addEventListener("click", openNameMap);
if (el.nameMapCancel) el.nameMapCancel.addEventListener("click", closeNameMap);
if (el.nameMapReset) {
  el.nameMapReset.addEventListener("click", () => {
    el.nameMapEditor.value = defaultNameMapText;
  });
}
if (el.nameMapSave) {
  el.nameMapSave.addEventListener("click", () => {
    try {
      applyNameMapText(el.nameMapEditor.value);
      localStorage.setItem(NAMEMAP_KEY, el.nameMapEditor.value);
      closeNameMap();
      if (selectedPath) loadClip(selectedPath);
    } catch (err) {
      showOverlay("error", "Name map is not valid JSON", String(err && err.message ? err.message : err));
    }
  });
}

let noteTimer = null;
el.note.addEventListener("input", () => {
  if (!selectedPath) return;
  clearTimeout(noteTimer);
  noteTimer = setTimeout(() => saveNote(selectedPath, el.note.value), 200);
});
el.note.addEventListener("blur", () => {
  if (selectedPath) saveNote(selectedPath, el.note.value);
});

document.addEventListener("keydown", (e) => {
  const tag = (e.target && e.target.tagName) || "";
  const typing = tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
  if (typing && e.target !== el.search) return;
  if (e.key === "ArrowDown") {
    e.preventDefault();
    if (e.target === el.search) el.search.blur();
    stepSelection(1);
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    if (e.target === el.search) el.search.blur();
    stepSelection(-1);
  } else if (e.key === " " && !typing) {
    e.preventDefault();
    if (!el.playBtn.disabled) setPlaying(!playing);
  }
});

// --- debug hook (used by automated tests; harmless in the UI) ---------------
window.__clipDebug = function () {
  const box = model ? computeBounds(model) : null;
  const size = box && !box.isEmpty() ? box.getSize(new THREE.Vector3()) : null;
  return {
    cam: camera.position.toArray(),
    target: orbit.target.toArray(),
    near: camera.near,
    far: camera.far,
    aspect: camera.aspect,
    fog: scene.fog ? { near: scene.fog.near, far: scene.fog.far } : null,
    modelPos: model ? model.position.toArray() : null,
    modelScale: model ? model.scale.toArray() : null,
    box: box && !box.isEmpty() ? { min: box.min.toArray(), max: box.max.toArray(), size: size.toArray() } : null,
    boneCount,
    meshCount,
    currentDuration,
    usingPreview,
    mapInfo: mapInfo
      ? {
          ok: mapInfo.ok,
          mapped: mapInfo.mapped,
          source: mapInfo.source,
          ratio: mapInfo.ratio,
          reason: mapInfo.reason || null,
          mode: mapInfo.mode || null,
          unmatchedTracks: mapInfo.unmatchedTracks || mapInfo.unmatched || [],
          posScale: mapInfo.posScale,
          sanity: mapInfo.sanity
            ? { ok: mapInfo.sanity.ok, reason: mapInfo.sanity.reason, samples: mapInfo.sanity.samples }
            : null,
        }
      : null,
    previewPath,
    pack: currentPack,
    bodyChoice: bodyChoice(),
    resolvedBody: currentPack ? resolvedBodyPath(currentPack) : "",
    packWantsPreview: currentPack ? wantsPreviewForPack(currentPack) : null,
    canvas: { w: renderer.domElement.width, h: renderer.domElement.height },
    figure: (function () {
      if (!model) return null;
      model.updateMatrixWorld(true);
      let hips = null;
      let head = null;
      model.traverse((o) => {
        if (!o.name) return;
        if (!hips && /(hips|pelvis)/i.test(o.name)) hips = o;
        if (!head && /(^|_|-)head$/i.test(o.name)) head = o;
      });
      const w = (o) => {
        if (!o) return null;
        const v = new THREE.Vector3();
        o.getWorldPosition(v);
        return v.toArray();
      };
      const hp = w(hips);
      const hd = w(head);
      let yComp = null;
      if (hp && hd) {
        const dx = hd[0] - hp[0], dy = hd[1] - hp[1], dz = hd[2] - hp[2];
        const len = Math.hypot(dx, dy, dz) || 1;
        yComp = dy / len;
      }
      return {
        hips: hp,
        head: hd,
        hipY: hp ? hp[1] : null,
        yComp,
        hipsName: hips ? hips.name : null,
        headName: head ? head.name : null,
      };
    })(),
  };
};

// --- local helper: generate in-betweens with MotionBricks -------------------------------------
// Optional. Everything below is inert unless the helper (helper/server.py) answers on 127.0.0.1.
const gen = new Map(); // pairId -> { jobId, state, step, progress, lines, error, warnings, results, engine, fromDisk }
const openLogs = new Set();
let helperState = { online: false, ready: false, mock: false, problems: [], data: null };
let helperTimer = null;
let viewing = null; // { pairId, which, variant }

function currentTargetOffset() {
  const f = Number(el.optForward && el.optForward.value) || 0;
  const r = Number(el.optRight && el.optRight.value) || 0;
  const t = Number(el.optTurn && el.optTurn.value) || 0;
  if (!f && !r && !t) return null;
  return { forward: f, right: r, turn_deg: t };
}

function updateHelperPill() {
  const pill = el.helperPill;
  if (!pill) return;
  pill.classList.remove("on", "warn", "off", "mock");
  if (!helperState.online) {
    pill.classList.add("off");
    pill.textContent = "Helper: not running";
    pill.title = "No local helper found at " + helperBaseUrl() + ". Click for setup. The browser works without it.";
  } else if (!helperState.ready) {
    pill.classList.add("warn");
    pill.textContent = "Helper: needs setup";
    pill.title = (helperState.problems || []).join("\n") || "The helper is running but not ready.";
  } else if (helperState.mock) {
    pill.classList.add("mock", "on");
    pill.textContent = "Helper: connected (MOCK engine)";
    pill.title = "The helper is running with --mock: results are a linear blend, not MotionBricks.";
  } else {
    pill.classList.add("on");
    pill.textContent = "Helper: connected";
    const d = helperState.data || {};
    pill.title = [d.gpu && d.gpu.name, d.blender && "Blender " + d.blender.version].filter(Boolean).join(" · ");
  }
}

function updateGenerateAll() {
  if (!el.generateAllBtn) return;
  const idle = pairs.filter((p) => {
    const g = gen.get(p.id);
    return !g || (g.state !== "running" && g.state !== "queued");
  });
  el.generateAllBtn.disabled = !helperState.ready || !idle.length;
  el.generateAllBtn.title = helperState.ready ? "Generate every pair that is not running" : "Needs the local helper";
}

async function refreshHelper() {
  const was = helperState.online;
  helperState = await checkHealth();
  updateHelperPill();
  updateGenerateAll();
  if (helperState.online && !was) refreshExisting();
  if (helperState.online !== was || el.helperModal.classList.contains("hidden") === false) {
    renderPairs();
    if (!el.helperModal.classList.contains("hidden")) fillHelperModal();
  }
}

function startHelperPolling() {
  refreshHelper();
  clearInterval(helperTimer);
  helperTimer = setInterval(() => {
    if (!document.hidden) refreshHelper();
  }, 4000);
}

async function refreshExisting() {
  if (!helperState.online || !pairs.length) return;
  try {
    const names = pairs.map((p) => pairName(p));
    const found = await existingResults(names);
    for (const p of pairs) {
      const hit = found[pairName(p)];
      const g = gen.get(p.id);
      if (!hit || (g && (g.state === "running" || g.state === "queued"))) continue;
      gen.set(p.id, {
        state: "done",
        fromDisk: true,
        progress: 1,
        lines: [],
        warnings: [],
        engine: hit.engine || null,
        results: hit.variants.map((v) => ({ variant: v })),
      });
    }
    renderPairs();
  } catch (err) {
    console.warn("Could not list existing generated clips", err);
  }
}

function fillHelperModal() {
  const d = helperState.data;
  let html = "";
  if (!helperState.online) {
    html += `<p>The helper is a small program on your PC that connects this page to MotionBricks. It is optional: browsing, Set Start / End and pairs.json work without it.</p>
      <p><strong>Not running</strong> (nothing answered at <code>${escapeHtml(helperBaseUrl())}</code>).</p>
      <p>${escapeHtml(SETUP_STEPS)}</p>
      <p>If it is running and this still says not running, your browser may be blocking a web page from reaching your own PC. Chrome asks for a one-time “local network” permission the first time; allow it. Also check that nothing else uses port 8770.</p>`;
  } else {
    html += `<p><strong>${helperState.ready ? "Connected" : "Running, but not ready"}</strong>${helperState.mock ? " (MOCK engine: linear blend, not MotionBricks)" : ""}.</p>`;
    if (helperState.problems && helperState.problems.length) {
      html += "<ul>" + helperState.problems.map((x) => `<li>${escapeHtml(x)}</li>`).join("") + "</ul>";
    }
    if (d) {
      const rows = [
        ["Helper version", d.helper_version],
        ["GPU", d.gpu && (d.gpu.name || d.gpu.reason)],
        ["Blender", d.blender && (d.blender.version || "not found") + " (" + d.blender.path + ")"],
        ["MotionBricks", d.motionbricks ? (d.motionbricks.version || "?") + (d.motionbricks.importable ? ", importable" : ", NOT importable") : "mock"],
        ["Animation folder", d.paths && d.paths.source && d.paths.source.path + (d.paths.source.exists ? "" : " (missing)")],
        ["Outputs", d.paths && ["soma_bvh", "generated", "export_fbx"].map((k) => d.paths[k] && d.paths[k].path).filter(Boolean).join(" | ")],
      ];
      html += "<ul>" + rows.filter((r) => r[1]).map((r) => `<li>${escapeHtml(r[0])}: <code>${escapeHtml(String(r[1]))}</code></li>`).join("") + "</ul>";
    }
  }
  el.helperModalBody.innerHTML = html;
}

function openHelperModal() {
  fillHelperModal();
  el.helperModal.classList.remove("hidden");
}

// -- generation ---------------------------------------------------------------------------------
function topSegment(path) {
  const parts = String(path || "").split("/");
  return parts.length > 1 ? parts[0] : "";
}

function virtualPathFor(pair, variant) {
  const top = topSegment(pair.start && pair.start.clip);
  return (top ? top + "/" : "") + "__generated__/" + pairName(pair) + variantSuffix(variant) + ".fbx";
}

function dropVirtualFor(pair) {
  for (let v = 1; v <= 32; v++) unregisterVirtualFile(virtualPathFor(pair, v));
}

async function generatePair(pair, { autoView = false } = {}) {
  if (!helperState.ready) {
    openHelperModal();
    return;
  }
  const old = gen.get(pair.id);
  if (old && (old.state === "running" || old.state === "queued")) return;
  if (!pair.name) {
    pair.name = pairName(pair);
    markPairsDirty();
  }
  dropVirtualFor(pair);
  const entry = { state: "queued", step: "queued", progress: 0, lines: [], warnings: [], results: [], error: null, since: 0, autoView };
  gen.set(pair.id, entry);
  renderPairs();
  const body = {
    id: pair.id,
    name: pairName(pair),
    start: pair.start,
    end: pair.end,
    variants: pair.variants || 1,
    options: { target_offset: (pair.options && pair.options.target_offset) || undefined },
  };
  try {
    const r = await startGenerate(body);
    entry.jobId = r.job;
  } catch (err) {
    entry.state = "error";
    entry.error = err && err.message ? err.message : String(err);
    if (err && err.status === undefined) {
      entry.error = "Could not reach the helper (" + entry.error + ")";
      refreshHelper();
    }
    renderPairs();
    return;
  }
  pollJob(pair, entry);
}

function pollJob(pair, entry) {
  const tick = async () => {
    if (gen.get(pair.id) !== entry) return;
    let job;
    try {
      job = await getJob(entry.jobId, entry.since);
    } catch (err) {
      entry.failures = (entry.failures || 0) + 1;
      if (entry.failures > 8) {
        entry.state = "error";
        entry.error = "Lost contact with the helper: " + (err && err.message ? err.message : err);
        renderPairs();
        return;
      }
      setTimeout(tick, 1500);
      return;
    }
    entry.failures = 0;
    entry.since = job.log_total;
    entry.lines.push(...(job.log || []));
    entry.state = job.state;
    entry.step = job.step;
    entry.progress = job.progress;
    entry.warnings = job.warnings || [];
    if (job.state === "done") {
      entry.results = (job.results || []).map((r) => ({ variant: r.variant, frames: r.frames, seconds: r.seconds, tokens: r.tokens }));
      entry.engine = (job.results && job.results[0] && job.results[0].engine) || null;
      renderPairs();
      if (entry.autoView && pairs.includes(pair)) viewPair(pair, "gen", 1);
      return;
    }
    if (job.state === "error") entry.error = job.error || "failed";
    renderPairs();
    if (job.state === "running" || job.state === "queued") setTimeout(tick, 700);
  };
  tick();
}

async function cancelPair(pair) {
  const g = gen.get(pair.id);
  if (!g || !g.jobId) return;
  try {
    await cancelJob(g.jobId);
  } catch (err) {
    console.warn("cancel failed", err);
  }
}

async function generateAll() {
  for (const p of pairs.slice()) {
    const g = gen.get(p.id);
    if (g && (g.state === "running" || g.state === "queued")) continue;
    // eslint-disable-next-line no-await-in-loop
    await generatePair(p, { autoView: false });
  }
}

// -- compare bar: start clip / generated / end clip -------------------------------------------
function hideCompare() {
  viewing = null;
  if (el.compareBar) el.compareBar.hidden = true;
}

function seekFrame(frame) {
  if (!mixer || currentDuration <= 0) return;
  mixer.setTime(Math.min(currentDuration - 1e-5, Math.max(0, frame / DISPLAY_FPS)));
  setPlaying(false);
  applyRootLock();
  syncScrub(true);
}

function showCompare(pair, which, variant) {
  viewing = { pairId: pair.id, which, variant };
  const g = gen.get(pair.id);
  el.compareBar.hidden = false;
  el.compareTitle.textContent = pairName(pair);
  el.compareTitle.title = pairName(pair);
  for (const [btn, key] of [[el.cmpStart, "start"], [el.cmpGen, "gen"], [el.cmpEnd, "end"]]) btn.classList.toggle("active", key === which);
  const variants = (g && g.results) || [];
  el.cmpVariant.hidden = variants.length < 2;
  el.cmpVariant.innerHTML = variants.map((r) => `<option value="${r.variant}">v${r.variant}</option>`).join("");
  el.cmpVariant.value = String(variant);
  const mock = g && g.engine === "mock";
  el.compareNote.classList.toggle("mock", !!mock);
  const frames = (g && g.results && g.results.find((r) => r.variant === variant)) || {};
  const base =
    which === "gen"
      ? "Generated" + (frames.frames ? ": " + frames.frames + " frames (" + frames.seconds + " s)" : "") + ". Ends match the start and end poses; the middle is the model's."
      : which === "start"
        ? "Start clip, paused on frame " + pair.start.frame + "."
        : "End clip, paused on frame " + pair.end.frame + ".";
  el.compareNote.textContent = mock ? base + " MOCK helper: a linear blend, not MotionBricks output." : base;
}

async function viewPair(pair, which, variant = 1) {
  const g = gen.get(pair.id);
  if (which === "gen") {
    const vpath = virtualPathFor(pair, variant);
    showCompare(pair, which, variant);
    try {
      if (!isVirtualPath(vpath)) {
        showOverlay("loading", "Loading generated clip…", pairName(pair) + variantSuffix(variant));
        const buf = await fetchResultBuffer(resultUrl(pairName(pair), variant, "fbx"));
        registerVirtualFile(vpath, new Blob([buf], { type: "application/octet-stream" }));
      }
    } catch (err) {
      showOverlay("error", "Could not load the generated clip", err && err.message ? err.message : String(err));
      return;
    }
    loadClip(vpath, {
      keepCompare: true,
      hook: () => {
        // the pose buttons record the selected clip, not this generated one
        if (el.setStartBtn) el.setStartBtn.disabled = true;
        if (el.setEndBtn) el.setEndBtn.disabled = true;
      },
    });
    return;
  }
  const clip = which === "start" ? pair.start : pair.end;
  showCompare(pair, which, variant);
  setSelectedPath(clip.clip, false, { scrollToPath: true });
  loadClip(clip.clip, { keepCompare: true, hook: () => seekFrame(clip.frame) });
  void g;
}

function currentViewPair() {
  return viewing ? pairs.find((p) => p.id === viewing.pairId) : null;
}

if (el.helperPill) el.helperPill.addEventListener("click", openHelperModal);
if (el.helperModalClose) el.helperModalClose.addEventListener("click", () => el.helperModal.classList.add("hidden"));
if (el.helperRecheck) el.helperRecheck.addEventListener("click", refreshHelper);
if (el.generateAllBtn) el.generateAllBtn.addEventListener("click", generateAll);
if (el.cmpStart) el.cmpStart.addEventListener("click", () => { const p = currentViewPair(); if (p) viewPair(p, "start", viewing.variant); });
if (el.cmpGen) el.cmpGen.addEventListener("click", () => { const p = currentViewPair(); if (p) viewPair(p, "gen", viewing.variant); });
if (el.cmpEnd) el.cmpEnd.addEventListener("click", () => { const p = currentViewPair(); if (p) viewPair(p, "end", viewing.variant); });
if (el.cmpVariant) el.cmpVariant.addEventListener("change", () => { const p = currentViewPair(); if (p) viewPair(p, "gen", Number(el.cmpVariant.value) || 1); });
if (el.cmpClose) el.cmpClose.addEventListener("click", hideCompare);
window.__helperDebug = () => ({ helperState, gen: Object.fromEntries(gen), viewing });

// --- folder open ------------------------------------------------------------
function folderSupportNote() {
  if (supportsDirectoryPicker()) {
    return "Chrome or Edge can remember the folder (you will confirm access once per visit).";
  }
  return "This browser does not support a persistent folder picker. Choose the folder each time (Firefox and Safari use a folder upload). Saving pairs.json will download a file.";
}

function showWelcomeOverlay() {
  const hasHandle = !!(el.reopenFolderBtn && !el.reopenFolderBtn.hidden);
  showOverlay(
    "idle",
    "Open an animation folder",
    "Pick the folder that contains your FBX packs. Files stay on this computer — nothing is uploaded. " + folderSupportNote()
  );
  const actions = [makeButton("Open folder", "primary", () => openAnimationFolder(false))];
  if (hasHandle) actions.push(makeButton("Reopen last folder", "", () => reopenLastFolder()));
  setOverlayActions(actions);
  const note = document.createElement("div");
  note.id = "browser-note";
  note.textContent = folderSupportNote();
  el.overlayActions.appendChild(note);
}

async function refreshReopenButton() {
  if (!el.reopenFolderBtn) return;
  if (!supportsDirectoryPicker()) {
    el.reopenFolderBtn.hidden = true;
    return;
  }
  const handle = await loadDirectoryHandle();
  el.reopenFolderBtn.hidden = !handle;
  return handle;
}

async function afterFolderIngested(label) {
  folderReady = true;
  const folder = getCurrentFolder();
  const rootLabel = label || folder.rootName || "folder";
  el.rootPath.textContent = rootLabel;
  el.rootPath.title = rootLabel;
  showOverlay("loading", "Scanning clips…", "Listing FBX files and detecting character meshes.");
  setOverlayActions([]);
  allClips = listFbxEntries();
  renderList();
  try {
    await detectModels(allClips, (info) => {
      if (info && info.total) {
        const p = el.overlay.querySelector("p");
        if (p) p.textContent = "Checking meshes… " + info.done + " / " + info.total;
      }
    });
  } catch (err) {
    console.warn("Model detection failed", err);
  }
  fillBodySelect();
  renderList();
  if (!allClips.length) {
    showOverlay(
      "error",
      "No FBX files in this folder",
      "The folder you opened does not contain any .fbx files (including in subfolders). Pick a different folder."
    );
    setOverlayActions([makeButton("Open folder", "primary", () => openAnimationFolder(false))]);
    return;
  }
  showOverlay(
    "idle",
    "Click a clip to preview it",
    "Body is Auto (matches pack): it uses the preset character mesh when one is present (for example HumanM for Kevin Iglesias, SK_Protof-Actor for PROTOFACTOR), or the model in that pack with the closest bone names. Set Start / Set End, then Send to Inbetweener to record a pair. Save pairs.json to write the list to disk. With the local helper running (see the Helper pill), Generate runs MotionBricks on a pair."
  );
}

async function openAnimationFolder() {
  if (supportsDirectoryPicker()) {
    try {
      const handle = await window.showDirectoryPicker({
        id: "animlab-clips",
        mode: "read",
        startIn: "documents",
      });
      const perm = await requestPermission(handle, "read");
      if (perm !== "granted") {
        showOverlay("error", "Folder access was not granted", "Allow read access to preview the clips in that folder.");
        return;
      }
      showOverlay("loading", "Reading folder…", "Listing files in " + (handle.name || "the folder") + ".");
      setOverlayActions([]);
      await ingestDirectoryHandle(handle);
      await saveDirectoryHandle(handle);
      await refreshReopenButton();
      await afterFolderIngested(handle.name || "folder");
      return;
    } catch (err) {
      if (err && err.name === "AbortError") return;
      console.warn("showDirectoryPicker failed, falling back to file input", err);
    }
  }
  if (el.folderInput) {
    el.folderInput.value = "";
    el.folderInput.click();
  } else {
    showOverlay(
      "error",
      "Cannot open a folder in this browser",
      "Try Chrome or Edge, which support a folder picker, or a browser that can upload a directory of files."
    );
  }
}

async function reopenLastFolder() {
  const handle = await loadDirectoryHandle();
  if (!handle) {
    showOverlay("error", "No saved folder", "Use Open folder to pick an animation directory.");
    return;
  }
  const perm = await requestPermission(handle, "read");
  if (perm !== "granted") {
    showOverlay("error", "Folder access was not granted", "Allow access to reopen the last folder, or pick a folder again.");
    setOverlayActions([makeButton("Open folder", "primary", () => openAnimationFolder())]);
    return;
  }
  showOverlay("loading", "Reopening folder…", "Reading " + (handle.name || "the last folder") + ".");
  setOverlayActions([]);
  await ingestDirectoryHandle(handle);
  await afterFolderIngested(handle.name || "folder");
}

async function onFolderInputChange(ev) {
  const list = ev.target.files;
  if (!list || !list.length) return;
  showOverlay("loading", "Reading folder…", "Listing the files you selected.");
  setOverlayActions([]);
  const first = list[0];
  const rel = (first && (first.webkitRelativePath || first.name)) || "";
  const rootName = String(rel).replace(/\\/g, "/").split("/").filter(Boolean)[0] || "folder";
  ingestFileList(list, rootName);
  await afterFolderIngested(rootName);
}

async function loadPresets() {
  try {
    const res = await fetch("body-presets.json");
    if (!res.ok) throw new Error("HTTP " + res.status);
    const data = await res.json();
    bodyPresets = Array.isArray(data.presets) ? data.presets : [];
  } catch (err) {
    console.warn("body-presets.json not loaded, using built-in pack names", err);
    bodyPresets = [
      { id: "kevin-iglesias", packName: "Kevin Iglesias", packPattern: "kevin|iglesias", bodyNames: ["HumanM_Model.fbx"] },
      { id: "protofactor", packName: "PROTOFACTOR", packPattern: "protofactor", bodyNames: ["SK_Protof-Actor.fbx", "SK_Protof-Actress.fbx"] },
    ];
  }
}

window.__openFolderFromRecords = async function (records, rootName) {
  ingestRecords(records, rootName || "folder");
  await afterFolderIngested(rootName || "folder");
  return { count: allClips.length, root: getCurrentFolder().rootName, models: allClips.filter((c) => c.isModel).map((c) => c.path) };
};

// --- boot -------------------------------------------------------------------
async function boot() {
  showWelcomeOverlay();
  loadPairsFromStorage();
  renderPairs();
  updatePairsSaveState();
  try {
    const storedPairsHandle = await loadPairsFileHandle();
    if (storedPairsHandle) {
      pairsHandle = storedPairsHandle;
      pairsPath = storedPairsHandle.name || "pairs.json";
      updatePairsSaveState();
    }
  } catch (err) {
    console.warn("Could not restore pairs file handle", err);
  }
  await refreshReopenButton();
  showWelcomeOverlay();
  await initNameMap();
  await loadPresets();
  fillBodySelect();
  renderList();
  startHelperPolling();
}

boot();
