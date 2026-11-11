"""Blender script used by run_tests.py: checks a generated FBX against the clips it was generated from.

    blender -b --factory-startup --python check_fbx.py -- spec.json
spec: {start:{fbx,frame}, end:{fbx,frame}, gen_fbx, out_json}
Compares hips-relative bone-head distances (rotation/heading invariant): generated first frame vs start pose,
generated last frame vs end pose. Also reports clip length and fps.
"""
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(os.path.dirname(HERE), "blender"))
sys.path.insert(0, os.path.dirname(HERE))

import numpy as np  # noqa: E402

from blender_common import action_info, import_fbx, sample_pose  # noqa: E402

spec = json.load(open(sys.argv[sys.argv.index("--") + 1]))


def key(n):
    return re.sub(r"[^a-z0-9]", "", n.lower().split("|")[-1])


def heads(fbx, t):
    arm = import_fbx(fbx)
    action, f0, f1, fps = action_info(arm)
    names = [b.name for b in arm.data.bones]
    out = {}
    ts = t if isinstance(t, list) else [t]
    res = []
    for tt in ts:
        tt = min(tt, (f1 - f0) / fps) if tt >= 0 else (f1 - f0) / fps
        R, H = sample_pose(arm, names, f0, fps, tt)
        hip = [i for i, n in enumerate(names) if "hips" in n.lower() or "pelvis" in n.lower()][0]
        res.append({key(n): float(np.linalg.norm(H[i] - H[hip])) for i, n in enumerate(names) if i != hip})
    return res, (f1 - f0) / fps, fps, len(names)


s_d, _, _, _ = heads(spec["start"]["fbx"], spec["start"]["frame"] / 30.0)
e_d, _, _, _ = heads(spec["end"]["fbx"], spec["end"]["frame"] / 30.0)
(g_first, g_last), g_dur, g_fps, g_n = heads(spec["gen_fbx"], [0.0, -1.0])
(s0,), (e0,) = s_d, e_d


def cmp(a, b):
    """Blender reads the cm-unit FBX root chain differently for the original and the exported clip (a factor of
    exactly 100 in world units; the file's unit settings are identical), so b is rescaled by the nearest power of
    ten before comparing, and that factor is reported."""
    common = [k for k in a if k in b and a[k] > 1e-6 and b[k] > 1e-6]
    va = np.array([a[k] for k in common])
    vb = np.array([b[k] for k in common])
    snap = 10.0 ** round(float(np.log10(np.median(va / vb))))
    d = np.abs(va - vb * snap)
    return {"n": len(common), "max": float(d.max()), "mean": float(d.mean()), "unit_factor": snap,
            "worst_bone": common[int(d.argmax())]}


result = {"start_vs_first": cmp(g_first, s0), "end_vs_last": cmp(g_last, e0), "duration_s": g_dur, "fps": g_fps, "bones": g_n}
json.dump(result, open(spec["out_json"], "w"), indent=1)
print("[check]", json.dumps(result))
