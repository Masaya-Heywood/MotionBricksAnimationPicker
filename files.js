/** Local folder access, model-mesh detection, and IndexedDB helpers. */

const DB_NAME = "animlab-clip-browser";
const DB_VERSION = 1;
const MODEL_CACHE_VERSION = 2;

let dbPromise = null;
let current = {
  rootName: "",
  files: new Map(), // relPath -> { path, name, size, lastModified, handle, file }
  directoryHandle: null,
};
const blobUrls = [];

export function supportsDirectoryPicker() {
  return typeof window.showDirectoryPicker === "function";
}

export function supportsSaveFilePicker() {
  return typeof window.showSaveFilePicker === "function";
}

export function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("kv")) db.createObjectStore("kv");
      if (!db.objectStoreNames.contains("modelCache")) db.createObjectStore("modelCache");
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error("IndexedDB open failed"));
  });
  return dbPromise;
}

function idbOp(storeName, mode, fn) {
  return openDb().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, mode);
        const store = tx.objectStore(storeName);
        let req;
        try {
          req = fn(store);
        } catch (err) {
          reject(err);
          return;
        }
        if (req && "onsuccess" in req) {
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => reject(req.error);
        } else {
          tx.oncomplete = () => resolve(req);
          tx.onerror = () => reject(tx.error);
        }
      })
  );
}

export function idbGet(key) {
  return idbOp("kv", "readonly", (s) => s.get(key));
}
export function idbSet(key, value) {
  return idbOp("kv", "readwrite", (s) => s.put(value, key));
}
export function idbDel(key) {
  return idbOp("kv", "readwrite", (s) => s.delete(key));
}

function modelCacheKey(path, size, lastModified) {
  return `${MODEL_CACHE_VERSION}|${path}|${size}|${lastModified}`;
}

export function modelCacheGet(path, size, lastModified) {
  return idbOp("modelCache", "readonly", (s) => s.get(modelCacheKey(path, size, lastModified)));
}

export function modelCacheSet(path, size, lastModified, entry) {
  return idbOp("modelCache", "readwrite", (s) =>
    s.put(entry, modelCacheKey(path, size, lastModified))
  );
}

export async function queryPermission(handle, mode = "read") {
  if (!handle || typeof handle.queryPermission !== "function") return "granted";
  try {
    return await handle.queryPermission({ mode });
  } catch {
    return "prompt";
  }
}

export async function requestPermission(handle, mode = "read") {
  if (!handle) return "denied";
  const currentPerm = await queryPermission(handle, mode);
  if (currentPerm === "granted") return "granted";
  if (typeof handle.requestPermission !== "function") return currentPerm;
  try {
    return await handle.requestPermission({ mode });
  } catch {
    return "denied";
  }
}

export async function loadDirectoryHandle() {
  try {
    const handle = await idbGet("directoryHandle");
    if (handle && handle.kind === "directory") return handle;
  } catch (err) {
    console.warn("Could not read stored folder handle", err);
  }
  return null;
}

export async function saveDirectoryHandle(handle) {
  try {
    if (handle) await idbSet("directoryHandle", handle);
    else await idbDel("directoryHandle");
  } catch (err) {
    console.warn("Could not store folder handle", err);
  }
}

export async function loadPairsFileHandle() {
  try {
    const handle = await idbGet("pairsFileHandle");
    if (handle && handle.kind === "file") return handle;
  } catch (err) {
    console.warn("Could not read stored pairs handle", err);
  }
  return null;
}

export async function savePairsFileHandle(handle) {
  try {
    if (handle) await idbSet("pairsFileHandle", handle);
    else await idbDel("pairsFileHandle");
  } catch (err) {
    console.warn("Could not store pairs handle", err);
  }
}

function normalizeRel(path) {
  return String(path || "").replace(/\\/g, "/").replace(/^\/+/, "");
}

async function walkDirectory(dirHandle, prefix, out) {
  for await (const entry of dirHandle.values()) {
    if (!entry || !entry.name || entry.name.startsWith(".")) continue;
    const rel = prefix ? prefix + "/" + entry.name : entry.name;
    if (entry.kind === "directory") {
      await walkDirectory(entry, rel, out);
    } else if (entry.kind === "file") {
      out.push({ path: rel, name: entry.name, handle: entry });
    }
  }
}

export async function ingestDirectoryHandle(dirHandle) {
  const listed = [];
  await walkDirectory(dirHandle, "", listed);
  const files = new Map();
  for (const item of listed) {
    let file = null;
    try {
      file = await item.handle.getFile();
    } catch (err) {
      console.warn("Could not stat", item.path, err);
      continue;
    }
    files.set(item.path, {
      path: item.path,
      name: item.name,
      size: file.size,
      lastModified: file.lastModified,
      handle: item.handle,
      file,
    });
  }
  revokeBlobUrls();
  current = {
    rootName: dirHandle.name || "folder",
    files,
    directoryHandle: dirHandle,
  };
  return current;
}

/** Build a folder from a FileList / File[] produced by <input webkitdirectory>. */
export function ingestFileList(fileList, rootName) {
  const files = new Map();
  const arr = Array.from(fileList || []);
  for (const file of arr) {
    const webkit = file.webkitRelativePath || file._relativePath || file.name;
    const parts = String(webkit).replace(/\\/g, "/").split("/").filter(Boolean);
    if (!rootName && parts.length > 1) rootName = parts[0];
    // Paths are relative to the picked folder, so drop the root folder name.
    if (parts.length > 1 && rootName && parts[0] === rootName) parts.shift();
    else if (parts.length > 1) {
      if (!rootName) rootName = parts[0];
      parts.shift();
    }
    const rel = parts.join("/") || file.name;
    files.set(rel, {
      path: rel,
      name: file.name,
      size: file.size,
      lastModified: file.lastModified,
      handle: null,
      file,
    });
  }
  revokeBlobUrls();
  current = {
    rootName: rootName || "folder",
    files,
    directoryHandle: null,
  };
  return current;
}

/**
 * Test / tooling hook: records are
 * { path, name, size, lastModified, buffer|file }.
 */
export function ingestRecords(records, rootName) {
  const files = new Map();
  for (const rec of records || []) {
    const path = normalizeRel(rec.path);
    const name = rec.name || path.split("/").pop();
    let file = rec.file;
    if (!file) {
      const buf = rec.buffer || rec.arrayBuffer;
      file = new File([buf], name, {
        lastModified: rec.lastModified || Date.now(),
        type: rec.type || "application/octet-stream",
      });
    }
    files.set(path, {
      path,
      name,
      size: rec.size != null ? rec.size : file.size,
      lastModified: rec.lastModified != null ? rec.lastModified : file.lastModified,
      handle: rec.handle || null,
      file,
    });
  }
  revokeBlobUrls();
  current = {
    rootName: rootName || "folder",
    files,
    directoryHandle: null,
  };
  return current;
}

export function getCurrentFolder() {
  return current;
}

export function listFbxEntries() {
  const clips = [];
  for (const rec of current.files.values()) {
    if (!rec.name.toLowerCase().endsWith(".fbx")) continue;
    const parts = rec.path.split("/");
    const pack = parts.length > 1 ? parts[0] : "(root)";
    const folder = parts.length > 1 ? parts.slice(0, -1).join("/") : "";
    clips.push({
      path: rec.path,
      name: rec.name,
      folder,
      pack,
      size: rec.size,
      lastModified: rec.lastModified,
      isModel: false,
    });
  }
  clips.sort((a, b) => a.path.toLowerCase().localeCompare(b.path.toLowerCase()));
  return clips;
}

export async function getFile(path) {
  const rec = current.files.get(normalizeRel(path));
  if (!rec) throw new Error("File not found in the open folder: " + path);
  if (rec.file) return rec.file;
  if (rec.handle && typeof rec.handle.getFile === "function") {
    rec.file = await rec.handle.getFile();
    return rec.file;
  }
  throw new Error("No file data for " + path);
}

export async function getArrayBuffer(path) {
  const file = await getFile(path);
  return file.arrayBuffer();
}

export function lookupFile(relPath) {
  const p = normalizeRel(relPath);
  if (current.files.has(p)) return current.files.get(p);
  const lower = p.toLowerCase();
  for (const [k, v] of current.files) {
    if (k.toLowerCase() === lower) return v;
  }
  return null;
}

function revokeBlobUrls() {
  for (const u of blobUrls) {
    try {
      URL.revokeObjectURL(u);
    } catch {
      /* ignore */
    }
  }
  blobUrls.length = 0;
}

export function revokeAllBlobUrls() {
  revokeBlobUrls();
}

/**
 * Resolve a texture / sidecar URL against the open folder.
 * Returns a blob: URL, or null if the file is not local.
 */
export function resolveLocalResource(url, baseDir) {
  if (!url) return null;
  if (url.startsWith("blob:") || url.startsWith("data:")) return url;
  let raw = String(url);
  try {
    const u = new URL(raw, "https://local.invalid/" + (baseDir || ""));
    raw = decodeURIComponent(u.pathname.replace(/^\/+/, ""));
  } catch {
    raw = raw.split("?")[0].split("#")[0];
    if (baseDir && !raw.includes("/")) raw = baseDir.replace(/\/?$/, "/") + raw;
    raw = raw.replace(/^\/+/, "");
  }
  raw = normalizeRel(raw);
  // Strip a leading "./"
  raw = raw.replace(/^\.\//, "");
  // Normalize "foo/../bar"
  const parts = [];
  for (const seg of raw.split("/")) {
    if (!seg || seg === ".") continue;
    if (seg === "..") parts.pop();
    else parts.push(seg);
  }
  const rel = parts.join("/");
  const rec = lookupFile(rel) || lookupFile(rel.split("/").pop());
  if (!rec || !rec.file) return null;
  const blobUrl = URL.createObjectURL(rec.file);
  blobUrls.push(blobUrl);
  return blobUrl;
}

export const MIN_MODEL_VERTS = 256;
export const MAX_NEGLIGIBLE_CURVES = 16;

function normRel(rel) {
  return String(rel || "").replace(/\\/g, "/").toLowerCase();
}

function pathParts(rel) {
  return normRel(rel).split("/").filter(Boolean);
}

export function strongMeshName(name) {
  const nl = String(name || "").toLowerCase();
  return (
    nl.startsWith("sk_") ||
    nl.includes("_model") ||
    nl.endsWith("model.fbx") ||
    nl.includes("protof-actor") ||
    nl.includes("protof-actress")
  );
}

export function inModelFolder(rel) {
  const parts = pathParts(rel);
  const dirs = parts.slice(0, -1);
  return dirs.some((p) => p === "models" || p === "characters" || p === "character" || p === "meshes");
}

export function inAnimFolder(rel) {
  const parts = pathParts(rel);
  const dirs = parts.slice(0, -1);
  return dirs.some((p) => p === "animation" || p === "animations" || p === "anim" || p === "anims" || p === "clips");
}

export function filenameModelHint(name, rel) {
  const nl = String(name || "").toLowerCase();
  const pl = normRel(rel);
  if (nl.startsWith("sm_") || pl.includes("/prop/") || pl.includes("/props/")) return "no";
  if (String(name || "").includes("@")) return "no";
  if (strongMeshName(name)) return "yes";
  if (inAnimFolder(rel) && !inModelFolder(rel)) return "no";
  if (inModelFolder(rel) || !String(name || "").includes("@")) return "maybe";
  return "no";
}

function indexOfBytes(haystack, needle, from = 0) {
  const n = needle.length;
  const limit = haystack.length - n;
  outer: for (let i = from; i <= limit; i++) {
    for (let j = 0; j < n; j++) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}

function countNeedle(haystack, needle) {
  let n = 0;
  let start = 0;
  while (true) {
    const i = indexOfBytes(haystack, needle, start);
    if (i < 0) return n;
    n += 1;
    start = i + Math.max(needle.length, 1);
  }
}

function concatBytes(a, b) {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

const GEO_BIN = Uint8Array.from([0x08, ...[...("Geometry")].map((c) => c.charCodeAt(0))]);
const DEF_BIN = Uint8Array.from([0x08, ...[...("Deformer")].map((c) => c.charCodeAt(0))]);
const SUBDEF_BIN = Uint8Array.from([0x0c, ...[...("SubDeformer")].map((c) => c.charCodeAt(0))]);
const CURVE_BIN = Uint8Array.from([0x0e, ...[...("AnimationCurve")].map((c) => c.charCodeAt(0))]);
const GEO_ASC = new TextEncoder().encode("Geometry:");
const DEF_ASC = new TextEncoder().encode("Deformer:");
const SUBDEF_ASC = new TextEncoder().encode("SubDeformer:");
const CURVE_ASC = new TextEncoder().encode("AnimationCurve:");
const VERTICES_NAME = new TextEncoder().encode("Vertices");
const VERTICES_ASC = /Vertices:\s*\*(\d+)/g;

export function maxVertexCount(data) {
  let best = 0;
  let start = 0;
  while (true) {
    const i = indexOfBytes(data, VERTICES_NAME, start);
    if (i < 0) break;
    const j = i + VERTICES_NAME.length;
    if (j + 5 <= data.length && (data[j] === 0x64 || data[j] === 0x66)) {
      const n = data[j + 1] | (data[j + 2] << 8) | (data[j + 3] << 16) | (data[j + 4] << 24);
      if (n % 3 === 0 && n >= 3 && n <= 30000000) {
        const verts = n / 3;
        if (verts > best) best = verts;
      }
    }
    start = i + 1;
  }
  try {
    const text = new TextDecoder("latin1").decode(data);
    VERTICES_ASC.lastIndex = 0;
    let m;
    while ((m = VERTICES_ASC.exec(text))) {
      const n = parseInt(m[1], 10);
      if (n % 3 === 0 && n >= 3 && n <= 30000000) {
        const verts = n / 3;
        if (verts > best) best = verts;
      }
    }
  } catch {
    /* ignore decode errors */
  }
  return best;
}

export async function scanFbxMesh(file) {
  const out = { hasGeo: false, hasDef: false, maxVertices: 0, animCurves: 0 };
  try {
    const head = new Uint8Array(await file.slice(0, 32).arrayBuffer());
    const magic = new TextDecoder("latin1").decode(head.subarray(0, 21));
    const isBin = magic.startsWith("Kaydara FBX Binary");
    const chunkSize = 1 << 20;
    let offset = 0;
    let overlap = new Uint8Array(0);
    const size = file.size;
    while (offset < size) {
      const end = Math.min(offset + chunkSize, size);
      const chunk = new Uint8Array(await file.slice(offset, end).arrayBuffer());
      const data = overlap.length ? concatBytes(overlap, chunk) : chunk;
      if (isBin) {
        if (!out.hasGeo && indexOfBytes(data, GEO_BIN) >= 0) out.hasGeo = true;
        if (!out.hasDef && (indexOfBytes(data, DEF_BIN) >= 0 || indexOfBytes(data, SUBDEF_BIN) >= 0)) {
          out.hasDef = true;
        }
        out.animCurves += countNeedle(data, CURVE_BIN);
      } else {
        if (!out.hasGeo && indexOfBytes(data, GEO_ASC) >= 0) out.hasGeo = true;
        if (!out.hasDef && (indexOfBytes(data, DEF_ASC) >= 0 || indexOfBytes(data, SUBDEF_ASC) >= 0)) {
          out.hasDef = true;
        }
        out.animCurves += countNeedle(data, CURVE_ASC);
      }
      const verts = maxVertexCount(data);
      if (verts > out.maxVertices) out.maxVertices = verts;
      overlap = data.subarray(Math.max(0, data.length - 64));
      offset = end;
    }
  } catch (err) {
    console.warn("FBX mesh scan failed", err);
  }
  return out;
}

export async function scanFbxNodes(file) {
  const s = await scanFbxMesh(file);
  return { hasGeo: s.hasGeo, hasDef: s.hasDef, maxVertices: s.maxVertices, animCurves: s.animCurves };
}

export async function isMeshModel(name, rel, file, hint) {
  if (hint === "no") return false;
  if (String(name || "").includes("@")) return false;
  const scan = await scanFbxMesh(file);
  if (!scan.hasGeo || !scan.hasDef) return false;
  if (scan.maxVertices < MIN_MODEL_VERTS) return false;
  const strong = strongMeshName(name) || inModelFolder(rel);
  const inAnims = inAnimFolder(rel);
  const hasClipCurves = scan.animCurves > MAX_NEGLIGIBLE_CURVES;
  if (strong && !(inAnims && hasClipCurves && !inModelFolder(rel))) return true;
  if (inAnims) return false;
  if (hasClipCurves) return false;
  return true;
}

/**
 * Fill clip.isModel using IndexedDB cache + header scans.
 * onProgress({ done, total, path }) is optional.
 */
export async function detectModels(clips, onProgress) {
  let done = 0;
  const total = clips.length;
  for (const clip of clips) {
    done += 1;
    if (onProgress) onProgress({ done, total, path: clip.path });
    const hint = filenameModelHint(clip.name, clip.path);
    if (hint === "no") {
      clip.isModel = false;
      continue;
    }
    const rec = lookupFile(clip.path);
    const size = rec ? rec.size : clip.size;
    const mtime = rec ? rec.lastModified : clip.lastModified;
    try {
      const cached = await modelCacheGet(clip.path, size, mtime);
      if (cached && typeof cached.isModel === "boolean") {
        clip.isModel = cached.isModel;
        continue;
      }
    } catch {
      /* cache miss */
    }
    let isModel = false;
    try {
      const file = rec ? rec.file || (await getFile(clip.path)) : null;
      if (file) isModel = await isMeshModel(clip.name, clip.path, file, hint);
    } catch (err) {
      console.warn("Model scan failed for", clip.path, err);
      isModel = false;
    }
    clip.isModel = isModel;
    try {
      await modelCacheSet(clip.path, size, mtime, { isModel, size, mtime });
    } catch {
      /* ignore cache write errors */
    }
  }
  return clips;
}

export function downloadBlob(filename, blob) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

export const PAIR_NOTE =
  "Input for a future MotionBricks / SOMA batch script. " +
  "clip paths are relative to the FBX root. frame is an integer at 30 fps " +
  "display time. BVH conversion is a later step; this file does not launch MotionBricks.";

export function defaultPairsDoc() {
  return { version: 1, note: PAIR_NOTE, pairs: [] };
}

export function normalizePairsDoc(data) {
  const doc = data && typeof data === "object" ? data : {};
  const out = defaultPairsDoc();
  if (typeof doc.note === "string" && doc.note) out.note = doc.note;
  if (doc.version) out.version = doc.version;
  if (Array.isArray(doc.pairs)) out.pairs = doc.pairs;
  return out;
}

export function pairsToText(doc) {
  return JSON.stringify(normalizePairsDoc(doc), null, 2) + "\n";
}

export async function writePairsToHandle(handle, doc) {
  const perm = await requestPermission(handle, "readwrite");
  if (perm !== "granted") throw new Error("Permission to write pairs.json was not granted.");
  const writable = await handle.createWritable();
  await writable.write(pairsToText(doc));
  await writable.close();
}

export async function readPairsFromHandle(handle) {
  const perm = await requestPermission(handle, "read");
  if (perm !== "granted") throw new Error("Permission to read pairs.json was not granted.");
  const file = await handle.getFile();
  const text = await file.text();
  return normalizePairsDoc(JSON.parse(text));
}
