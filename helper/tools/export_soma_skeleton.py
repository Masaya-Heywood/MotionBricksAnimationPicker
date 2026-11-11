"""Export the SOMA rest skeleton from MotionBricks' bundled USD to JSON.

Runs in any Python that has `usd-core` (the MotionBricks uv env does). It mirrors
motionbricks.io.usd._load_skeleton (same joint order, same meters scaling, same
row-major matrix decomposition) but needs neither warp nor a GPU.

    python export_soma_skeleton.py <path-to-soma_base_skel_minimal_no_root.usd> <out.json>

The JSON is derived from NVIDIA's rig asset, so the helper writes it into your
own AnimationLab folder at first run (helper/cache/) and does NOT ship it in the repo.
"""
import json
import os
import sys

import numpy as np
from pxr import Usd, UsdGeom, UsdSkel

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
from mbh.rot import mat_to_quat  # noqa: E402  (numpy only, no scipy)

SKELETON_PRIM = "/OUTPUT/c_skeleton_grp/Hips"  # motionbricks.io.utils.SOMA_SKELETON_PRIM_PATH


def mat_to_pq(mat, scale):
    m = np.asarray(mat, dtype=np.float64)
    pos = m[3, :3] * scale
    rot = m[:3, :3].copy()
    for i in range(3):
        n = np.linalg.norm(rot[:, i])
        if n > 1e-6:
            rot[:, i] /= n
    # USD row-vector convention -> column-vector rotation matrix is the transpose.
    q = mat_to_quat(rot.T)  # xyzw
    return pos.tolist(), q.tolist()


def export(usd_path, out_path):
    with open(usd_path, "rb") as fh:
        if fh.read(24).startswith(b"version https://git-lfs"):
            raise SystemExit(
                f"{usd_path} is a Git LFS pointer, not the real file. Run `git lfs pull` in the motionbricks folder."
            )
    stage = Usd.Stage.Open(str(usd_path))
    prim = stage.GetPrimAtPath(SKELETON_PRIM)
    if not prim.IsValid():
        raise SystemExit(f"Skeleton prim not found: {SKELETON_PRIM}")
    skel = UsdSkel.Skeleton(prim)
    joints = [str(p) for p in skel.GetJointsAttr().Get()]
    rest = skel.GetRestTransformsAttr().Get()
    if stage.GetStartTimeCode() < stage.GetEndTimeCode():
        xc = UsdGeom.XformCache(Usd.TimeCode(stage.GetStartTimeCode()))
    else:
        xc = UsdGeom.XformCache(Usd.TimeCode.Default())
    mat = np.asarray(xc.GetLocalToWorldTransform(prim), dtype=np.float64)
    scale = UsdGeom.GetStageMetersPerUnit(stage) * float(np.linalg.norm(mat[:3, 0]))
    index = {p: i for i, p in enumerate(joints)}
    names = [p.rsplit("/", 1)[-1] for p in joints]
    parents = [index[p.rsplit("/", 1)[0]] if "/" in p else -1 for p in joints]
    pos, quat = zip(*[mat_to_pq(m, scale) for m in rest])
    json.dump({
        "source": "motionbricks soma_base_skel_minimal_no_root.usd",
        "up_axis": "Y",
        "units": "meters",
        "joint_names": names,
        "parents": parents,
        "rest_local_pos": pos,
        "rest_local_quat_xyzw": quat,
    }, open(out_path, "w"), indent=1)
    print(f"wrote {out_path}: {len(names)} joints, scale {scale}")


if __name__ == "__main__":
    export(*sys.argv[1:3])
