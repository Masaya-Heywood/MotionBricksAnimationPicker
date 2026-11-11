/** Bone-name normalization and clip retargeting for the AnimLab clip browser. */

export const DEFAULT_SYNONYMS = {
  pelvis: "hips",
  hip: "hips",
  spine01: "spine",
  spine1: "chest",
  spine02: "chest",
  spine2: "chest",
  spine3: "chest",
  spine03: "chest",
  neck01: "neck",
  neck1: "neck",
  lclavicle: "shoulderl",
  claviclel: "shoulderl",
  leftclavicle: "shoulderl",
  leftshoulder: "shoulderl",
  rclavicle: "shoulderr",
  clavicler: "shoulderr",
  rightclavicle: "shoulderr",
  rightshoulder: "shoulderr",
  lupperarm: "upperarml",
  leftarm: "upperarml",
  leftupperarm: "upperarml",
  rupperarm: "upperarmr",
  rightarm: "upperarmr",
  rightupperarm: "upperarmr",
  llowerarm: "forearml",
  leftforearm: "forearml",
  leftlowerarm: "forearml",
  rlowerarm: "forearmr",
  rightforearm: "forearmr",
      rightlowerarm: "forearmr",
    lforearm: "forearml",
    rforearm: "forearmr",
  lhand: "handl",
  lefthand: "handl",
  rhand: "handr",
  righthand: "handr",
  lthigh: "thighl",
  lupleg: "thighl",
  leftupleg: "thighl",
  leftthigh: "thighl",
  rthigh: "thighr",
  rupleg: "thighr",
  rightupleg: "thighr",
  rightthigh: "thighr",
  lcalf: "shinl",
  lleg: "shinl",
  leftleg: "shinl",
  leftcalf: "shinl",
  leftshin: "shinl",
  rcalf: "shinr",
  rleg: "shinr",
  rightleg: "shinr",
  rightcalf: "shinr",
  rightshin: "shinr",
  lfoot: "footl",
  leftfoot: "footl",
  rfoot: "footr",
  rightfoot: "footr",
  ltoe: "toel",
  ltoe0: "toel",
  lefttoe: "toel",
  rtoe: "toer",
  rtoe0: "toer",
  righttoe: "toer",
  lfinger0: "thumb01l",
  lfinger01: "thumb02l",
  lfinger02: "thumb03l",
  lfinger1: "indexfinger01l",
  lfinger11: "indexfinger02l",
  lfinger12: "indexfinger03l",
  lfinger2: "middlefinger01l",
  lfinger21: "middlefinger02l",
  lfinger22: "middlefinger03l",
  lfinger3: "ringfinger01l",
  lfinger31: "ringfinger02l",
  lfinger32: "ringfinger03l",
  lfinger4: "pinky01l",
  lfinger41: "pinky02l",
  lfinger42: "pinky03l",
  rfinger0: "thumb01r",
  rfinger01: "thumb02r",
  rfinger02: "thumb03r",
  rfinger1: "indexfinger01r",
  rfinger11: "indexfinger02r",
  rfinger12: "indexfinger03r",
  rfinger2: "middlefinger01r",
  rfinger21: "middlefinger02r",
  rfinger22: "middlefinger03r",
  rfinger3: "ringfinger01r",
  rfinger31: "ringfinger02r",
  rfinger32: "ringfinger03r",
  rfinger4: "pinky01r",
  rfinger41: "pinky02r",
  rfinger42: "pinky03r",
};

const PREFIXES = [
  /^mixamorig[:_\-]?/i,
  /^bip01[_\-\s]*/i,
  /^humanoid__+/i,
  // Do not strip a bone that is literally named "humanoid_".
  /^humanoid_(?=[A-Za-z0-9])/i,
  /^b-/i,
];

export function normalizeBoneName(name) {
  let n = String(name || "").trim();
  let prev = "";
  while (n && n !== prev) {
    prev = n;
    for (const re of PREFIXES) n = n.replace(re, "");
  }
  return n.replace(/[^A-Za-z0-9]/g, "").toLowerCase();
}

export function parseNameMap(obj) {
  if (!obj) return { ...DEFAULT_SYNONYMS };
  const src = obj.synonyms && typeof obj.synonyms === "object" ? obj.synonyms : obj;
  const out = {};
  for (const [k, v] of Object.entries(src)) {
    if (k === "comment") continue;
    if (typeof v === "string" && v) out[normalizeBoneName(k)] = normalizeBoneName(v);
  }
  return out;
}

/**
 * Build a map of sourceBoneName -> targetBoneName.
 * Exact normalized matches win first; remaining sources use synonyms.
 */
export function buildBoneMap(sourceNames, targetNames, synonyms = DEFAULT_SYNONYMS) {
  const syn = parseNameMap(synonyms);
  const targetByNorm = new Map();
  for (const t of targetNames) {
    const n = normalizeBoneName(t);
    if (n && !targetByNorm.has(n)) targetByNorm.set(n, t);
  }
  const used = new Set();
  const map = new Map();

  function claim(src, norm) {
    if (!norm || !targetByNorm.has(norm) || used.has(norm)) return false;
    used.add(norm);
    map.set(src, targetByNorm.get(norm));
    return true;
  }

  for (const src of sourceNames) {
    claim(src, normalizeBoneName(src));
  }
  for (const src of sourceNames) {
    if (map.has(src)) continue;
    const n = normalizeBoneName(src);
    claim(src, syn[n]);
  }
  return map;
}

export function uniqueTrackBones(clip) {
  const names = [];
  const seen = new Set();
  const tracks = (clip && clip.tracks) || [];
  for (const t of tracks) {
    const parts = String(t.name || "").split(".");
    if (parts.length < 2) continue;
    const bone = parts.slice(0, -1).join(".");
    if (!seen.has(bone)) {
      seen.add(bone);
      names.push(bone);
    }
  }
  return names;
}

export function trackBoneAndProp(trackName) {
  const parts = String(trackName || "").split(".");
  if (parts.length < 2) return { bone: "", prop: "" };
  const prop = parts.pop();
  return { bone: parts.join("."), prop };
}

/**
 * Exact bone-name coverage (no prefix stripping, no synonyms).
 * Used to decide whether a clip can play directly on a body.
 */
export function exactNameCoverage(trackBones, targetNames) {
  const targets = new Set(targetNames || []);
  const matched = [];
  const unmatched = [];
  for (const b of trackBones || []) {
    if (targets.has(b)) matched.push(b);
    else unmatched.push(b);
  }
  const source = (trackBones || []).length;
  const ratio = source ? matched.length / source : 0;
  return { matched, unmatched, ratio, mapped: matched.length, source };
}

/**
 * Bind a clip onto a body that already uses the same bone names.
 * Tracks keep their exact names; no rest-pose delta is applied.
 */
export function bindClipExact(THREE, clip, targetNames, minRatio = 0.9) {
  const trackBones = uniqueTrackBones(clip);
  const coverage = exactNameCoverage(trackBones, targetNames);
  const targetSet = new Set(targetNames || []);
  const unmatchedTracks = [];
  const newTracks = [];
  for (const track of (clip && clip.tracks) || []) {
    const { bone, prop } = trackBoneAndProp(track.name);
    if (!bone || !targetSet.has(bone)) {
      unmatchedTracks.push(track.name || "(unnamed track)");
      continue;
    }
    const cloned = track.clone();
    cloned.name = bone + "." + prop;
    newTracks.push(cloned);
  }
  const ok = coverage.ratio >= minRatio && newTracks.length > 0;
  const newClip =
    ok && clip ? new THREE.AnimationClip(clip.name, clip.duration, newTracks) : null;
  return {
    ok,
    clip: newClip,
    ratio: coverage.ratio,
    mapped: coverage.mapped,
    source: coverage.source,
    unmatched: coverage.unmatched,
    unmatchedTracks,
    tracks: newTracks.length,
    reason: ok ? "exact" : "low-exact",
    mode: "exact",
  };
}

export function retargetAnimationClip(THREE, clip, sourceBoneNames, targetBoneNames, synonyms, minRatio = 0.5) {
  const trackBones = uniqueTrackBones(clip);
  const sources = trackBones.length ? trackBones : sourceBoneNames;
  const boneMap = buildBoneMap(sources, targetBoneNames, synonyms);
  const ratio = sources.length ? boneMap.size / sources.length : 0;
  const ok = ratio >= minRatio && boneMap.size > 0;
  if (!ok || !clip) {
    return { ok, ratio, mapped: boneMap.size, source: sources.length, clip: null, boneMap };
  }
  const newTracks = [];
  for (const track of clip.tracks) {
    const parts = String(track.name || "").split(".");
    if (parts.length < 2) continue;
    const prop = parts.pop();
    const srcBone = parts.join(".");
    const tgt = boneMap.get(srcBone);
    if (!tgt) continue;
    const cloned = track.clone();
    cloned.name = tgt + "." + prop;
    newTracks.push(cloned);
  }
  const newClip = new THREE.AnimationClip(clip.name + " (retargeted)", clip.duration, newTracks);
  return { ok: newTracks.length > 0, ratio, mapped: boneMap.size, source: sources.length, clip: newClip, boneMap, tracks: newTracks.length };
}

/** Pack id used for per-pack preview preferences. */
export function detectPack(clipPath, boneNames = []) {
  const p = String(clipPath || "").replace(/\\/g, "/").toLowerCase();
  if (p.includes("protofactor")) return "PROTOFACTOR";
  if (p.includes("kevin") || p.includes("iglesias")) return "Kevin Iglesias";
  const names = (boneNames || []).join(" ");
  if (/humanoid_/.test(names)) return "PROTOFACTOR";
  if (/\bB-hips\b/.test(names) || /(^|\s)B-[a-z]/i.test(names)) return "Kevin Iglesias";
  const first = String(clipPath || "")
    .replace(/\\/g, "/")
    .split("/")
    .filter(Boolean)[0];
  return first || "Other";
}

/**
 * Default "use preview body" when no localStorage pref is set.
 * PROTOFACTOR falls back to own-skeleton only when its actor model is absent
 * (see wantsPreviewForPack / defaultBodyPathForPack in app.js). When the
 * actor is present, app.js turns retarget on automatically.
 */
export function defaultRetargetToPreview(pack) {
  return pack !== "PROTOFACTOR";
}

/** Filename / path patterns for a pack's default character body. */
export function packBodyPreferredNames(pack) {
  if (pack === "PROTOFACTOR") {
    return [/^sk_protof-actor\.fbx$/i, /protof-actor/i, /^sk_protof-actress\.fbx$/i, /protof-actress/i];
  }
  if (pack === "Kevin Iglesias") {
    return [/^humanm_model\.fbx$/i, /humanm.*model\.fbx$/i];
  }
  return [/_model\.fbx$/i];
}

export function looksLikePreviewBody(path, name) {
  const n = String(name || path || "").replace(/\\/g, "/");
  const base = n.split("/").pop() || "";
  const pl = n.toLowerCase();
  if (/_model\.fbx$/i.test(base) || /model/i.test(base)) return true;
  if (/^sk_protof-/i.test(base) || /protof-act/i.test(base)) return true;
  if (/\/characters\//i.test(pl) || /\/models\//i.test(pl)) return true;
  return false;
}

export function snapshotTransforms(object, THREE) {
  const list = [];
  object.traverse((o) => {
    list.push({
      obj: o,
      pos: o.position.clone(),
      quat: o.quaternion.clone(),
      scale: o.scale.clone(),
    });
  });
  return list;
}

export function restoreTransforms(list) {
  for (const s of list) {
    s.obj.position.copy(s.pos);
    s.obj.quaternion.copy(s.quat);
    s.obj.scale.copy(s.scale);
    s.obj.updateMatrix();
  }
}

export function findNamed(object, regex) {
  let hit = null;
  object.traverse((o) => {
    if (!hit && regex.test(o.name)) hit = o;
  });
  return hit;
}

export function hipsAndHead(object, boneMap) {
  let hips = findNamed(object, /(^|_|-)(hips|pelvis)$/i) || findNamed(object, /hips|pelvis/i);
  let head = findNamed(object, /(^|_|-)head$/i) || findNamed(object, /head/i);
  if (boneMap) {
    for (const [src, tgt] of boneMap) {
      if (/hips|pelvis/i.test(src) || /hips|pelvis/i.test(tgt)) {
        const n = object.getObjectByName(tgt) || object.getObjectByName(src);
        if (n) hips = n;
      }
      if (/head$/i.test(src) || /head$/i.test(tgt)) {
        const n = object.getObjectByName(tgt) || object.getObjectByName(src);
        if (n) head = n;
      }
    }
  }
  return { hips, head };
}

/** Rotate the root so hips-to-head points roughly +Y. Returns true if a rotation was applied. */
export function alignSkeletonToYUp(object, THREE, hips, head) {
  if (!hips || !head) return false;
  object.updateMatrixWorld(true);
  const up = new THREE.Vector3();
  const hp = new THREE.Vector3();
  head.getWorldPosition(up);
  hips.getWorldPosition(hp);
  up.sub(hp);
  if (up.lengthSq() < 1e-8) return false;
  up.normalize();
  const target = new THREE.Vector3(0, 1, 0);
  if (up.dot(target) > 0.92) return false;
  const q = new THREE.Quaternion().setFromUnitVectors(up, target);
  object.quaternion.premultiply(q);
  object.updateMatrixWorld(true);
  return true;
}

function sameHemisphere(q, ref) {
  if (q.x * ref.x + q.y * ref.y + q.z * ref.z + q.w * ref.w < 0) {
    q.set(-q.x, -q.y, -q.z, -q.w);
  }
  return q;
}

function collectSampleTimes(clip, fps) {
  const set = new Set([0]);
  if (clip.duration > 0) set.add(clip.duration);
  for (const track of clip.tracks || []) {
    for (const t of track.times) set.add(t);
  }
  const n = Math.max(2, Math.round((clip.duration || 0) * fps));
  for (let i = 0; i <= n; i++) set.add((i / n) * (clip.duration || 0));
  return [...set]
    .filter((t) => t >= -1e-8)
    .map((t) => Math.min(Math.max(0, t), clip.duration || 0))
    .sort((a, b) => a - b)
    .filter((t, i, arr) => i === 0 || Math.abs(t - arr[i - 1]) > 1e-6);
}

function byName(object, name) {
  return (name && object.getObjectByName(name)) || null;
}

/**
 * Rest-pose-relative retarget: rotation is applied as a delta from the source
 * bind/rest onto the target rest, and hips position is transferred as a
 * scaled world-space delta (units / axis differences included).
 */
export function retargetClipRestRelative(THREE, options) {
  const {
    sourceObject,
    targetObject,
    clip,
    sourceBoneNames,
    targetBoneNames,
    synonyms,
    minRatio = 0.5,
    fps = 30,
  } = options;
  const trackBones = uniqueTrackBones(clip);
  const sources = trackBones.length ? trackBones : sourceBoneNames;
  const boneMap = buildBoneMap(sources, targetBoneNames, synonyms);
  const ratio = sources.length ? boneMap.size / sources.length : 0;
  const base = { ratio, mapped: boneMap.size, source: sources.length, boneMap };
  if (!clip || ratio < minRatio || boneMap.size === 0) {
    const unmatched = sources.filter((n) => !boneMap.has(n));
    return { ok: false, clip: null, ...base, reason: "low-map", mode: "delta", unmatched, unmatchedTracks: unmatched };
  }

  const srcSnap = snapshotTransforms(sourceObject, THREE);
  const tgtSnap = snapshotTransforms(targetObject, THREE);

  // Put the source under a wrapper so an axis-alignment rotation is not
  // overwritten by a clip that animates the FBX root / Rig.
  const srcParent = sourceObject.parent;
  const srcIndex = srcParent ? srcParent.children.indexOf(sourceObject) : -1;
  const wrapper = new THREE.Group();
  wrapper.add(sourceObject);
  const srcHipsHead0 = hipsAndHead(sourceObject, null);
  alignSkeletonToYUp(wrapper, THREE, srcHipsHead0.hips, srcHipsHead0.head);

  const unwrapSource = () => {
    wrapper.remove(sourceObject);
    if (srcParent) {
      if (srcIndex >= 0 && srcIndex <= srcParent.children.length) {
        srcParent.children.splice(srcIndex, 0, sourceObject);
        sourceObject.parent = srcParent;
      } else {
        srcParent.add(sourceObject);
      }
    }
  };

  sourceObject.updateMatrixWorld(true);
  wrapper.updateMatrixWorld(true);
  targetObject.updateMatrixWorld(true);

  const srcHH = hipsAndHead(sourceObject, null);
  const tgtHH = hipsAndHead(targetObject, boneMap);
  if (!srcHH.hips || !tgtHH.hips || !srcHH.head || !tgtHH.head) {
    unwrapSource();
    restoreTransforms(srcSnap);
    restoreTransforms(tgtSnap);
    return { ok: false, clip: null, ...base, reason: "no-hips-head", mode: "delta", unmatched: sources.filter((n) => !boneMap.has(n)), unmatchedTracks: sources.filter((n) => !boneMap.has(n)) };
  }

  const srcHipsRestW = new THREE.Vector3();
  const srcHeadRestW = new THREE.Vector3();
  const tgtHipsRestW = new THREE.Vector3();
  const tgtHeadRestW = new THREE.Vector3();
  srcHH.hips.getWorldPosition(srcHipsRestW);
  srcHH.head.getWorldPosition(srcHeadRestW);
  tgtHH.hips.getWorldPosition(tgtHipsRestW);
  tgtHH.head.getWorldPosition(tgtHeadRestW);
  const srcLen = srcHipsRestW.distanceTo(srcHeadRestW);
  const tgtLen = tgtHipsRestW.distanceTo(tgtHeadRestW);
  const posScale = srcLen > 1e-5 ? tgtLen / srcLen : 1;

  const srcRestLocalQ = new Map();
  const tgtRestLocalQ = new Map();
  const srcRestLocalP = new Map();
  const tgtRestLocalP = new Map();
  for (const [srcName, tgtName] of boneMap) {
    const s = byName(sourceObject, srcName);
    const t = byName(targetObject, tgtName);
    if (s) {
      srcRestLocalQ.set(srcName, s.quaternion.clone());
      srcRestLocalP.set(srcName, s.position.clone());
    }
    if (t) {
      tgtRestLocalQ.set(tgtName, t.quaternion.clone());
      tgtRestLocalP.set(tgtName, t.position.clone());
    }
  }

  const times = collectSampleTimes(clip, fps);
  const samples = new Map(); // tgtName -> { times, q:[], p:[], writeP }
  for (const tgtName of boneMap.values()) {
    samples.set(tgtName, { times: [], q: [], p: [], writeP: false });
  }

  const mixer = new THREE.AnimationMixer(sourceObject);
  const action = mixer.clipAction(clip);
  action.play();
  action.setLoop(THREE.LoopOnce, 1);
  action.clampWhenFinished = true;

  const srcNowW = new THREE.Vector3();
  const qDelta = new THREE.Quaternion();
  const qOut = new THREE.Quaternion();
  const pOut = new THREE.Vector3();
  const invRest = new THREE.Quaternion();

  try {
    for (const t of times) {
      mixer.setTime(Math.min(t, clip.duration || 0));
      sourceObject.updateMatrixWorld(true);
      srcHH.hips.getWorldPosition(srcNowW);
      const hipsWorldDelta = srcNowW.clone().sub(srcHipsRestW).multiplyScalar(posScale);

      for (const [srcName, tgtName] of boneMap) {
        const s = byName(sourceObject, srcName);
        const tBone = byName(targetObject, tgtName);
        const rec = samples.get(tgtName);
        const sQrest = srcRestLocalQ.get(srcName);
        const tQrest = tgtRestLocalQ.get(tgtName);
        if (!s || !tBone || !sQrest || !tQrest || !rec) continue;

        invRest.copy(sQrest).invert();
        qDelta.copy(invRest).multiply(s.quaternion);
        sameHemisphere(qDelta, new THREE.Quaternion()); // keep w>=0-ish
        qOut.copy(tQrest).multiply(qDelta);
        sameHemisphere(qOut, tQrest);

        const sPrest = srcRestLocalP.get(srcName);
        const tPrest = tgtRestLocalP.get(tgtName);
        const isHips = tBone === tgtHH.hips || s === srcHH.hips;
        if (isHips) {
          const world = tgtHipsRestW.clone().add(hipsWorldDelta);
          const parent = tBone.parent;
          if (parent) {
            parent.updateWorldMatrix(true, false);
            pOut.copy(world).applyMatrix4(new THREE.Matrix4().copy(parent.matrixWorld).invert());
          } else {
            pOut.copy(world);
          }
          rec.writeP = true;
        } else if (sPrest && tPrest) {
          pOut.copy(s.position).sub(sPrest).multiplyScalar(posScale).add(tPrest);
          if (s.position.distanceTo(sPrest) > 1e-4) rec.writeP = true;
        } else {
          pOut.copy(tPrest || tBone.position);
        }

        rec.times.push(t);
        rec.q.push(qOut.x, qOut.y, qOut.z, qOut.w);
        rec.p.push(pOut.x, pOut.y, pOut.z);
      }
    }
  } finally {
    mixer.stopAllAction();
    try {
      mixer.uncacheRoot(sourceObject);
    } catch {
      /* ignore */
    }
    unwrapSource();
    restoreTransforms(srcSnap);
    sourceObject.updateMatrixWorld(true);
  }

  const newTracks = [];
  for (const [tgtName, rec] of samples) {
    if (!rec.times.length) continue;
    newTracks.push(
      new THREE.QuaternionKeyframeTrack(tgtName + ".quaternion", rec.times.slice(), rec.q)
    );
    if (rec.writeP) {
      newTracks.push(new THREE.VectorKeyframeTrack(tgtName + ".position", rec.times.slice(), rec.p));
    }
  }
  if (!newTracks.length) {
    restoreTransforms(tgtSnap);
    return { ok: false, clip: null, ...base, reason: "no-tracks", mode: "delta", unmatched: sources.filter((n) => !boneMap.has(n)), unmatchedTracks: sources.filter((n) => !boneMap.has(n)) };
  }
  const newClip = new THREE.AnimationClip(clip.name + " (retargeted)", clip.duration, newTracks);

  const sanity = sanityCheckClip(THREE, targetObject, newClip, tgtHH.hips, tgtHH.head, tgtSnap);
  restoreTransforms(tgtSnap);
  targetObject.updateMatrixWorld(true);

  if (!sanity.ok) {
    return { ok: false, clip: null, ...base, tracks: newTracks.length, reason: "sanity", sanity, posScale, mode: "delta", unmatched: sources.filter((n) => !boneMap.has(n)), unmatchedTracks: sources.filter((n) => !boneMap.has(n)) };
  }
  return { ok: true, clip: newClip, ...base, tracks: newTracks.length, reason: "ok", sanity, posScale, mode: "delta", unmatched: sources.filter((n) => !boneMap.has(n)), unmatchedTracks: sources.filter((n) => !boneMap.has(n)) };
}

export function sanityCheckClip(THREE, targetObject, clip, hips, head, targetSnap) {
  const result = { ok: false, samples: [], reason: "" };
  if (!hips || !head) {
    result.reason = "no-hips-head";
    return result;
  }
  const snap = targetSnap || snapshotTransforms(targetObject, THREE);
  const mixer = new THREE.AnimationMixer(targetObject);
  const action = mixer.clipAction(clip);
  action.play();
  action.setLoop(THREE.LoopOnce, 1);
  action.clampWhenFinished = true;
  const hip = new THREE.Vector3();
  const hd = new THREE.Vector3();
  const times = [0];
  if (clip.duration > 0) {
    times.push(clip.duration * 0.2, clip.duration * 0.4, clip.duration * 0.6, clip.duration * 0.8, clip.duration);
  }
  try {
    for (const t of times) {
      mixer.setTime(Math.min(t, clip.duration || 0));
      targetObject.updateMatrixWorld(true);
      hips.getWorldPosition(hip);
      head.getWorldPosition(hd);
      const up = hd.clone().sub(hip);
      const len = up.length();
      const yComp = len > 1e-5 ? up.y / len : 0;
      const sample = {
        t,
        hipY: hip.y,
        len,
        yComp,
        pass: hip.y >= 0.15 && hip.y <= 1.7 && len >= 0.35 && len <= 1.6 && yComp >= 0.45,
      };
      result.samples.push(sample);
    }
  } finally {
    mixer.stopAllAction();
    try {
      mixer.uncacheRoot(targetObject);
    } catch {
      /* ignore */
    }
    restoreTransforms(snap);
    targetObject.updateMatrixWorld(true);
  }
  const passed = result.samples.filter((s) => s.pass).length;
  const t0 = result.samples[0];
  if (!t0 || !t0.pass) {
    result.reason = "t0";
    result.ok = false;
    return result;
  }
  result.ok = passed >= Math.ceil(result.samples.length * 0.7);
  result.reason = result.ok ? "ok" : "samples";
  return result;
}
