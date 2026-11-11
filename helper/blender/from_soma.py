"""Step (c): generated SOMA BVH -> source rig animation -> FBX.

Spec JSON keys: soma_json, bonemaps, rig {fbx, rig?}, bvh, out_fbx, result_json, name,
  finger_start / finger_end (bone -> [w,x,y,z] basis quaternions from to_soma's meta, optional),
  include_mesh (bool), fps
The rig FBX (the start clip) provides the armature, the bone names and the rest pose, so the exported
clip binds to the same skeleton as the pack it came from. Mapped bones are driven from the BVH
(exact inverse of to_soma), the root bone chain keeps the clip's own constant transform, fingers are
blended between the start/end finger pose, every other bone sits at its rest pose.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import bpy  # noqa: E402
import numpy as np  # noqa: E402
from mathutils import Matrix, Quaternion, Vector  # noqa: E402

from blender_common import (action_info, build_retargeter, fail, hips_ancestors, import_fbx, load_everything, log,  # noqa: E402
                            normed_rot, read_spec, sample_pose, scene_fps, set_time, topo_bones, write_result)
from mbh.bvhio import read_bvh  # noqa: E402
from mbh.rot import angle_between_mats, mat_to_quat, quat_to_mat  # noqa: E402


def slerp_q(a, b, t):
    a = np.asarray(a, dtype=np.float64)
    b = np.asarray(b, dtype=np.float64)
    if np.dot(a, b) < 0:
        b = -b
    d = np.clip(np.dot(a, b), -1, 1)
    th = np.arccos(d)
    if th < 1e-6:
        q = a * (1 - t) + b * t
    else:
        q = (np.sin((1 - t) * th) * a + np.sin(t * th) * b) / np.sin(th)
    return q / np.linalg.norm(q)


def export_fbx(path, include_mesh, extra=None):
    bpy.ops.object.select_all(action="DESELECT")
    arm = [o for o in bpy.data.objects if o.type == "ARMATURE"][0]
    arm.select_set(True)
    types = {"ARMATURE"}
    if include_mesh:
        types.add("MESH")
        for o in bpy.data.objects:
            if o.type == "MESH":
                o.select_set(True)
    bpy.context.view_layer.objects.active = arm
    kwargs = dict(
        filepath=path, use_selection=True, object_types=types, use_armature_deform_only=False,
        add_leaf_bones=False, bake_anim=True, bake_anim_use_all_bones=True, bake_anim_use_nla_strips=False,
        bake_anim_use_all_actions=False, bake_anim_force_startend_keying=True, bake_anim_step=1.0,
        bake_anim_simplify_factor=0.0, axis_forward="-Z", axis_up="Y", global_scale=1.0,
        apply_scale_options="FBX_SCALE_NONE", primary_bone_axis="Y", secondary_bone_axis="X",
    )
    kwargs.update(extra or {})
    try:
        bpy.ops.export_scene.fbx(**kwargs)
    except TypeError:
        for k in ("primary_bone_axis", "secondary_bone_axis", "apply_scale_options", "bake_anim_simplify_factor"):
            kwargs.pop(k, None)
        bpy.ops.export_scene.fbx(**kwargs)


def main():
    spec = read_spec()
    soma, maps = load_everything(spec["soma_json"], spec["bonemaps"])
    try:
        arm = import_fbx(spec["rig"]["fbx"])
        action, f0, f1, fps_src = action_info(arm)
        rt, res, names = build_retargeter(arm, soma, maps, spec["rig"]["fbx"], spec["rig"].get("rig"), f0)
        order, _, parents = topo_bones(arm)
        bvh = read_bvh(spec["bvh"])
        missing = [n for n in soma.names if n not in bvh["names"]]
        if missing:
            raise RuntimeError("Generated BVH lacks SOMA joints: %s" % missing[:8])
        idx = [bvh["names"].index(n) for n in soma.names]
        local_R = bvh["local_R"][:, idx]
        root = bvh["root_pos_m"]
        T = local_R.shape[0]
        log("generated BVH: %d frames, %d joints" % (T, len(bvh["names"])))
        world_R, hips_w = rt.backward(local_R, root)  # {bone idx: (T,3,3)}, (T,3)

        # clip-constant transform of the bones above the hips (e.g. B-root: -90 X, scale 100)
        hips_name = res.mapping["Hips"]
        anc = hips_ancestors(arm, hips_name)
        set_time(f0, fps_src, 0.0)
        anc_basis = {n: np.array(arm.pose.bones[n].matrix_basis, dtype=np.float64) for n in anc}

        Mw = np.array(arm.matrix_world, dtype=np.float64)
        Mw_inv = np.linalg.inv(Mw)
        Mw3n_inv = normed_rot(Mw[:3, :3]).T
        rest_arm = {b.name: np.array(b.matrix_local, dtype=np.float64) for b in order}
        name_to_idx = {n: i for i, n in enumerate(names)}
        mapped = {name_to_idx[b]: j for j, b in res.mapping.items()}
        mapped = {rt.src_idx[soma.index[j]]: soma.index[j] for j in res.mapping if soma.index[j] in rt.src_idx}
        fs, fe = spec.get("finger_start") or {}, spec.get("finger_end") or {}
        fingers = [n for n in res.passthrough if n in fs]

        # build per-frame basis for every bone
        basis = {n: [] for n in names}
        want_R = {}  # (frame, bone idx) -> desired world R for self-check
        for fi in range(T):
            pose_arm = {}
            u = fi / float(max(1, T - 1))
            ease = u * u * (3 - 2 * u)
            for b in order:
                n = b.name
                i = name_to_idx[n]
                if b.parent:
                    P = pose_arm[b.parent.name]
                    restrel = np.linalg.inv(rest_arm[b.parent.name]) @ rest_arm[n]
                else:
                    P = np.eye(4)
                    restrel = rest_arm[n]
                M0 = P @ restrel
                k = np.linalg.norm(M0[:3, 0])
                if n in anc_basis:
                    B = anc_basis[n]
                elif i in mapped:
                    R_a = Mw3n_inv @ world_R[i][fi]
                    Bm = np.eye(4)
                    Bm[:3, :3] = normed_rot(M0[:3, :3] / k).T @ R_a
                    if n == hips_name:
                        pos_a = (Mw_inv @ np.append(hips_w[fi], 1.0))[:3]
                        Bm[:3, 3] = (np.linalg.inv(M0) @ np.append(pos_a, 1.0))[:3]
                    B = Bm
                    want_R[(fi, i)] = world_R[i][fi]
                elif n in fingers:
                    q = slerp_q(fs[n], fe.get(n, fs[n]), ease)  # wxyz
                    Bm = np.eye(4)
                    Bm[:3, :3] = quat_to_mat(np.array([q[1], q[2], q[3], q[0]]))
                    B = Bm
                else:
                    B = np.eye(4)
                pose_arm[n] = M0 @ B
                basis[n].append(B)

        # write keyframes
        scene = bpy.context.scene
        scene.render.fps = int(round(spec.get("fps", 30)))
        scene.render.fps_base = 1.0
        scene.frame_start = 0
        scene.frame_end = T - 1
        scene.name = spec.get('name', 'MotionBricks')  # the FBX exporter names the take after the scene
        arm.animation_data_clear()
        arm.animation_data_create()
        act = bpy.data.actions.new(spec.get("name", "MotionBricks"))
        arm.animation_data.action = act
        for n in names:
            pb = arm.pose.bones[n]
            pb.rotation_mode = "QUATERNION"
        for fi in range(T):
            for n in names:
                pb = arm.pose.bones[n]
                B = basis[n][fi]
                m = Matrix(B.tolist())
                loc, rot, scl = m.decompose()
                pb.location = loc
                pb.rotation_quaternion = rot
                pb.scale = scl
                pb.keyframe_insert("location", frame=fi)
                pb.keyframe_insert("rotation_quaternion", frame=fi)
                pb.keyframe_insert("scale", frame=fi)
        act.name = spec.get("name", act.name)

        # self-check: evaluate the keyed armature and compare with the targets
        worst = 0.0
        hip_err = 0.0
        for fi in sorted({0, T // 2, T - 1}):
            bpy.context.scene.frame_set(fi)
            Mw_ = np.array(arm.matrix_world, dtype=np.float64)
            for (f, i), Rw in want_R.items():
                if f != fi:
                    continue
                M = Mw_ @ np.array(arm.pose.bones[names[i]].matrix, dtype=np.float64)
                worst = max(worst, float(angle_between_mats(normed_rot(M[:3, :3]), Rw)))
            hm = Mw_ @ np.array(arm.pose.bones[hips_name].matrix, dtype=np.float64)
            hip_err = max(hip_err, float(np.linalg.norm(hm[:3, 3] - hips_w[fi])))
        log("self-check: max bone rotation error %.4f deg, hips position error %.5f units" % (worst, hip_err))

        out_fbx = spec["out_fbx"]
        os.makedirs(os.path.dirname(out_fbx), exist_ok=True)
        export_fbx(out_fbx, bool(spec.get("include_mesh")), spec.get("export_args"))
        log("wrote " + out_fbx)
        write_result(spec, {"ok": True, "out_fbx": out_fbx, "frames": T, "bones": len(names),
                            "mapped_bones": len(mapped), "finger_bones": len(fingers),
                            "check_max_deg": worst, "check_hips_err": hip_err, "rig": res.summary()})
    except Exception as err:  # noqa: BLE001
        import traceback
        traceback.print_exc()
        fail(spec, str(err))


main()
