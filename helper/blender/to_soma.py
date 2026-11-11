"""Step (a): FBX clips -> SOMA BVH context + target windows.

Spec JSON keys: soma_json, bonemaps, name, out_dir, result_json,
  start {fbx, frame, rig?}, end {fbx, frame, rig?}, poses_to_use (1-4),
  target_offset {forward, right, turn_deg}, only ("both"|"target")
Writes <out_dir>/<name>__context.bvh (4 poses ending at the start frame, standing on the origin)
and <out_dir>/<name>__target.bvh (1-4 poses starting at the end frame, placed by target_offset).
only="target" skips context (used when chaining from a previous generated segment).
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import numpy as np  # noqa: E402

from blender_common import (DISPLAY_FPS, action_info, build_retargeter, fail, import_fbx, load_everything, log,  # noqa: E402
                            read_spec, sample_basis_quats, sample_pose, write_result)
from mbh.bvhio import write_bvh  # noqa: E402
from mbh.retarget import place_window  # noqa: E402


def convert_window(clip, soma, maps, times, ref_index, placement, warnings, label):
    arm = import_fbx(clip["fbx"])
    action, f0, f1, fps = action_info(arm)
    dur = (f1 - f0) / fps
    log("%s: %s | armature %s, %d bones, action '%s' %.2fs @ %.1f fps" % (
        label, os.path.basename(clip["fbx"]), arm.name, len(arm.data.bones), action.name, dur, fps))
    rt, res, names = build_retargeter(arm, soma, maps, clip["fbx"], clip.get("rig"), f0)
    log("%s: rig '%s' mapped %d/%d model joints; aim: %s" % (
        label, res.rig_id, len(res.mapping), len(res.mapping) + len(res.unmapped_model_joints()), rt.aim_used))
    q = rt.rest_pose_quality()
    if any(v > 25 for v in q.values()):
        warnings.append("%s: source rest pose is far from a T-pose (%s). Arm/hand twist may be off for the model; "
                        "the pose is reproduced exactly only on its own rig." % (label, {k: round(v) for k, v in q.items()}))
    hips_i = names.index(res.mapping["Hips"])
    if callable(times):
        times = times(dur)
    clamped = 0
    Rs, Hs = [], []
    for t in times:
        tt = min(max(t, 0.0), dur)
        if abs(tt - t) > 1e-9:
            clamped += 1
        R, H = sample_pose(arm, names, f0, fps, tt)
        Rs.append(R)
        Hs.append(H[hips_i])
    if clamped:
        warnings.append("%s: %d requested pose time(s) fell outside the clip (%.2fs) and were clamped." % (label, clamped, dur))
    local_R, root = rt.forward(np.array(Rs), np.array(Hs))
    local_R, root = place_window(soma, local_R, root, ref_index, **placement)
    fingers = sample_basis_quats(arm, res.passthrough, f0, fps, times[ref_index] if ref_index < len(times) else times[0])
    return local_R, root, res, rt, dur, fingers, times


def main():
    spec = read_spec()
    soma, maps = load_everything(spec["soma_json"], spec["bonemaps"])
    name = spec["name"]
    out_dir = spec["out_dir"]
    os.makedirs(out_dir, exist_ok=True)
    warnings = []
    # only: None/"both" | "target" (skip context; used when chaining from a previous segment)
    only = (spec.get("only") or "both").lower()
    s, e = spec.get("start") or {}, spec["end"]
    res_s = rt_s = None
    dur_s = fingers_s = None
    ctx_path = os.path.join(out_dir, name + "__context.bvh")
    tgt_path = os.path.join(out_dir, name + "__target.bvh")
    try:
        if only != "target":
            # context: 4 poses ending at the start frame
            ctx_times = [(s["frame"] - 3 + i) / DISPLAY_FPS for i in range(4)]
            ctx_R, ctx_root, res_s, rt_s, dur_s, fingers_s, _ = convert_window(
                s, soma, maps, ctx_times, 3, {}, warnings, "start")
            write_bvh(ctx_path, soma.names, soma.parents, soma.rest_pos, ctx_R, ctx_root, DISPLAY_FPS)
        # target: up to 4 poses starting at the end frame (only poses that exist in the clip)
        want = max(1, min(4, int(spec.get("poses_to_use", 4))))

        def target_times(dur):
            avail = int(np.floor(max(0.0, dur - e["frame"] / DISPLAY_FPS) * DISPLAY_FPS + 1e-6)) + 1
            k = max(1, min(want, avail))
            if k < want:
                warnings.append("end: only %d pose(s) available after frame %d, using %d target pose(s)." % (avail, e["frame"], k))
            return [(e["frame"] + i) / DISPLAY_FPS for i in range(k)]

        off = spec.get("target_offset") or {}
        placement = dict(offset_forward=float(off.get("forward", 0.0)), offset_right=float(off.get("right", 0.0)),
                         turn_deg=float(off.get("turn_deg", 0.0)))
        tgt_R, tgt_root, res_e, rt_e, dur_e2, fingers_e, tgt_times = convert_window(
            e, soma, maps, target_times, 0, placement, warnings, "end")
        write_bvh(tgt_path, soma.names, soma.parents, soma.rest_pos, tgt_R, tgt_root, DISPLAY_FPS)
    except Exception as err:  # noqa: BLE001
        fail(spec, str(err))
        return
    if only != "target":
        log("wrote %s (4 poses) and %s (%d poses)" % (ctx_path, tgt_path, len(tgt_times)))
    else:
        log("wrote %s only (%d poses); context supplied by previous segment" % (tgt_path, len(tgt_times)))
    result = {
        "ok": True,
        "context_bvh": None if only == "target" else ctx_path,
        "target_bvh": tgt_path,
        "target_poses": len(tgt_times),
        "rig_end": res_e.summary(),
        "finger_end": fingers_e,
        "end_clip_seconds": dur_e2,
        "scale_end": rt_e.scale,
        "warnings": warnings,
    }
    if res_s is not None:
        result.update({
            "rig_start": res_s.summary(),
            "same_rig": res_s.rig_id == res_e.rig_id,
            "finger_start": fingers_s,
            "start_clip_seconds": dur_s,
            "scale_start": rt_s.scale,
        })
    write_result(spec, result)


main()
