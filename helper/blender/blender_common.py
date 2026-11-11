"""Shared helpers for the headless Blender scripts (run with: blender -b --python script.py -- spec.json).

Blender 3.6 - 4.5 are supported (bpy.ops.import_scene.fbx); 5.x falls back to bpy.ops.wm.fbx_import.
"""
import json
import math
import os
import sys

import bpy  # noqa: F401  (only available inside Blender)
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, ".."))

from mbh.bonemap import load_maps, resolve  # noqa: E402
from mbh.retarget import RigRest, Retargeter  # noqa: E402
from mbh.soma import Soma  # noqa: E402

DISPLAY_FPS = 30.0


def log(msg):
    print("[helper] " + str(msg), flush=True)


def read_spec():
    argv = sys.argv
    if "--" not in argv:
        raise SystemExit("usage: blender -b --python <script> -- spec.json")
    spec_path = argv[argv.index("--") + 1]
    with open(spec_path, "r", encoding="utf-8") as f:
        spec = json.load(f)
    spec["_spec_path"] = spec_path
    return spec


def write_result(spec, data):
    path = spec.get("result_json")
    if path:
        with open(path, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=1)


def fail(spec, message, **extra):
    log("ERROR: " + message)
    write_result(spec, dict(ok=False, error=message, **extra))
    sys.exit(2)


def reset_scene():
    bpy.ops.wm.read_factory_settings(use_empty=True)


def import_fbx(path):
    reset_scene()
    if hasattr(bpy.ops, "import_scene") and hasattr(bpy.ops.import_scene, "fbx"):
        try:
            bpy.ops.import_scene.fbx(filepath=path, use_anim=True, automatic_bone_orientation=False)
        except RuntimeError as err:
            # FBX 7.7 mesh files can trip the legacy importer; animation clips normally do not.
            raise RuntimeError("Blender could not import %s: %s" % (os.path.basename(path), str(err).splitlines()[-1]))
    else:  # Blender 5.x C++ importer
        bpy.ops.wm.fbx_import(filepath=path)
    arms = [o for o in bpy.data.objects if o.type == "ARMATURE"]
    if not arms:
        raise RuntimeError("No armature found in %s (is it a mesh-only file?)" % os.path.basename(path))
    arms.sort(key=lambda o: (1 if (o.animation_data and o.animation_data.action) else 0, len(o.data.bones)), reverse=True)
    return arms[0]


def scene_fps():
    r = bpy.context.scene.render
    return float(r.fps) / float(r.fps_base or 1.0)


def action_info(arm):
    ad = arm.animation_data
    action = ad.action if ad else None
    if action is None and bpy.data.actions:
        action = bpy.data.actions[0]
        if ad is None:
            ad = arm.animation_data_create()
        ad.action = action
    if action is None:
        raise RuntimeError("This FBX has no animation to sample.")
    f0, f1 = action.frame_range
    fps = scene_fps()
    return action, float(f0), float(f1), fps


def topo_bones(arm):
    """Bone names, parent index, parent-first."""
    bones = list(arm.data.bones)
    order, seen = [], set()

    def visit(b):
        if b.name in seen:
            return
        if b.parent:
            visit(b.parent)
        seen.add(b.name)
        order.append(b)

    for b in bones:
        visit(b)
    names = [b.name for b in order]
    idx = {n: i for i, n in enumerate(names)}
    parents = [idx[b.parent.name] if b.parent else -1 for b in order]
    return order, names, parents


def world_rot3(m4):
    return np.array([[m4[i][j] for j in range(3)] for i in range(3)], dtype=np.float64)


def normed_rot(m3):
    # remove scale: orthonormalise columns
    u, _, vt = np.linalg.svd(m3)
    r = u @ vt
    if np.linalg.det(r) < 0:
        u[:, -1] *= -1
        r = u @ vt
    return r


def hips_ancestors(arm, hips_name):
    out, b = [], arm.data.bones[hips_name].parent
    while b:
        out.append(b.name)
        b = b.parent
    return out


def rig_rest(arm, names, hips_name, f0):
    """RigRest: the bind/rest configuration as the *posed hierarchy* sees it.

    Clip FBX files exported from Blender carry a constant rotation/scale on a root bone above the hips
    (e.g. B-root: -90 deg X, scale 100) that cancels the armature object's own 90 deg X / 0.01 scale. To
    keep rest and animated poses in the same space, every bone except the ancestors of the hips is put
    at identity pose (that is the rest pose) while those ancestors keep their clip transform. Units are
    whatever the world ends up in (can be cm); the retargeter normalises by the hips-height ratio."""
    from mathutils import Matrix

    set_time(f0, scene_fps(), 0.0)
    anc = set(hips_ancestors(arm, hips_name))
    saved = {}
    for pb in arm.pose.bones:
        if pb.name not in anc:
            saved[pb.name] = pb.matrix_basis.copy()
            pb.matrix_basis = Matrix.Identity(4)
    bpy.context.view_layer.update()
    Mw = np.array(arm.matrix_world, dtype=np.float64)
    rest_R, heads, pts = [], [], []
    for n in names:
        pb = arm.pose.bones[n]
        M = Mw @ np.array(pb.matrix, dtype=np.float64)
        rest_R.append(normed_rot(M[:3, :3]))
        heads.append(M[:3, 3])
        pts.append(M[:3, 3])
        tail = Mw @ np.append(np.array(pb.tail, dtype=np.float64), 1.0)
        pts.append(tail[:3])
    for n, m in saved.items():
        arm.pose.bones[n].matrix_basis = m
    parents = topo_bones(arm)[2]
    return RigRest(names, parents, np.array(rest_R), np.array(heads), np.array(pts))


def time_to_frame(f0, fps, t):
    return f0 + t * fps


def set_time(f0, fps, t):
    fr = time_to_frame(f0, fps, t)
    base = math.floor(fr + 1e-9)
    bpy.context.scene.frame_set(int(base), subframe=float(max(0.0, fr - base)))


def sample_pose(arm, names, f0, fps, t):
    """World rotation of every bone (N,3,3) and every bone head (N,3) at time t (seconds from clip start)."""
    set_time(f0, fps, t)
    Mw = np.array(arm.matrix_world, dtype=np.float64)
    R = np.empty((len(names), 3, 3))
    H = np.empty((len(names), 3))
    for i, n in enumerate(names):
        pb = arm.pose.bones[n]
        M = Mw @ np.array(pb.matrix, dtype=np.float64)
        R[i] = normed_rot(M[:3, :3])
        H[i] = M[:3, 3]
    return R, H


def sample_basis_quats(arm, bone_names, f0, fps, t):
    set_time(f0, fps, t)
    out = {}
    for n in bone_names:
        pb = arm.pose.bones.get(n)
        if pb is None:
            continue
        q = pb.matrix_basis.to_quaternion()
        out[n] = [q.w, q.x, q.y, q.z]
    return out


def load_everything(spec_soma_json, spec_bonemaps):
    soma = Soma(spec_soma_json)
    maps = load_maps(spec_bonemaps)
    return soma, maps


def build_retargeter(arm, soma, maps, hint, requested=None, f0=1.0):
    order, names, parents = topo_bones(arm)
    res = resolve(maps, names, hint=hint, requested=requested)
    if res.missing_core:
        raise RuntimeError(
            "Rig '%s' is missing bones for %s. Bones in file: %s ... Add a rig entry to helper/bonemaps.json."
            % (res.rig_id, res.missing_core, ", ".join(names[:12]))
        )
    rest = rig_rest(arm, names, res.mapping["Hips"], f0)
    rt = Retargeter(soma, rest, res.mapping, maps["aim_candidates"])
    return rt, res, names
