"""Pure-numpy unit tests (no Blender, no GPU).

    SOMA_JSON=<exported soma skeleton json> python tests/test_units.py
Without SOMA_JSON only the rotation tests run.
"""
import json
import os
import sys
import tempfile

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))

from mbh import rot  # noqa: E402

rng = np.random.RandomState(7)


def rand_rot(n=None, max_angle=np.pi):
    """Random rotation matrix (or (n,3,3)) with angle up to max_angle."""
    def one():
        v = rng.randn(3)
        return rot.axis_angle(v / np.linalg.norm(v), rng.rand() * max_angle)
    return one() if n is None else np.array([one() for _ in range(n)])


def test_rotation_helpers():
    R = rand_rot(50)
    assert np.allclose(rot.quat_to_mat(rot.mat_to_quat(R)), R, atol=1e-9)
    e = rot.mat_to_euler_zyx(R)
    assert np.allclose(rot.euler_zyx_to_mat(e), R, atol=1e-8)
    a, b = rng.randn(3), rng.randn(3)
    assert np.allclose(rot.rot_between(a, b) @ (a / np.linalg.norm(a)), b / np.linalg.norm(b), atol=1e-9)
    assert np.allclose(rot.slerp_mats(R[0], R[1], 0.0), R[0], atol=1e-9)
    assert np.allclose(rot.slerp_mats(R[0], R[1], 1.0), R[1], atol=1e-9)
    print("ok  rotation helpers")


def load_soma():
    path = os.environ.get("SOMA_JSON")
    if not path:
        return None
    from mbh.soma import Soma
    return Soma(path)


def test_bvh_roundtrip(soma):
    from mbh.bvhio import read_bvh, write_bvh
    T = 6
    L = np.repeat(soma.rest_R[None], T, axis=0).copy()
    for j in range(soma.J):
        L[:, j] = L[:, j] @ rand_rot(T)
    P = rng.randn(T, 3)
    with tempfile.TemporaryDirectory() as d:
        path = os.path.join(d, "x.bvh")
        write_bvh(path, soma.names, soma.parents, soma.rest_pos, L, P, 30)
        b = read_bvh(path)
    assert b["names"] == soma.names and b["frames"] == T and abs(b["fps"] - 30) < 1e-6
    ang = rot.angle_between_mats(b["local_R"], L)
    assert ang.max() < 1e-2, ang.max()
    assert np.abs(b["root_pos_m"] - P).max() < 1e-4
    print("ok  BVH write/read round trip (max %.5f deg)" % ang.max())


def test_retarget_roundtrip(soma):
    from mbh.retarget import RigRest, Retargeter, place_window
    from mbh.soma import MODEL_JOINTS
    cands = json.load(open(os.path.join(os.path.dirname(HERE), "bonemaps.json")))["aim_candidates"]
    Q = rand_rot()  # source world axes are arbitrary (e.g. an FBX lying on its back in Blender)
    s = 1.37  # and a different unit/size
    rest_R = np.array([Q @ soma.rest_world_R[j] for j in range(soma.J)])
    rest_head = s * (soma.rest_world_P @ Q.T)
    rig = RigRest(soma.names, soma.parents, rest_R, rest_head, rest_head)
    rt = Retargeter(soma, rig, {n: n for n in MODEL_JOINTS}, cands)
    # rest in -> SOMA rest out
    L, root = rt.forward(rest_R[None], rest_head[0][None])
    # Output bones follow the source's actual directions (not 'rest in -> rest out'): the SOMA rest is not exactly
    # upright from mid-feet (the feet sit 2 cm forward of the hips), so a source built from it comes back ~1.4 deg off.
    assert rot.angle_between_mats(L[0], soma.rest_R).max() < 2.0
    assert np.allclose(root[0], soma.rest_world_P[0], atol=1e-9)
    # SOMA pose -> source -> SOMA is the identity on the mapped joints
    T = 5
    Lin = np.repeat(soma.rest_R[None], T, axis=0).copy()
    mapped = [soma.index[n] for n in MODEL_JOINTS]
    for j in mapped:
        Lin[:, j] = soma.rest_R[j] @ rand_rot(T, 0.6)
    pos = soma.rest_world_P[0][None] + 0.3 * rng.randn(T, 3)
    world, hips = rt.backward(Lin, pos)
    anim = np.repeat(rest_R[None], T, axis=0).copy()
    for b, Rb in world.items():
        anim[:, b] = Rb
    L2, root2 = rt.forward(anim, hips)
    err = rot.angle_between_mats(L2[:, mapped], Lin[:, mapped]).max()
    assert err < 1e-6 and np.abs(root2 - pos).max() < 1e-9, (err, np.abs(root2 - pos).max())
    # window placement: heading and ground position removed at the reference frame, offset applied
    R3, p3 = place_window(soma, Lin, pos, 3, offset_forward=0.5, offset_right=-0.2, turn_deg=30)
    _, WP = soma.fk(R3[3:4], p3[3:4])
    assert abs(WP[0, 0, 1] - pos[3, 1]) < 1e-9  # height kept
    print("ok  retarget forward/backward round trip (max %.2e deg)" % err)


def test_bonemap():
    from mbh.bonemap import load_maps, resolve
    maps = load_maps(os.path.join(os.path.dirname(HERE), "bonemaps.json"))
    kev = ["B-root", "B-hips", "B-spine", "B-chest", "B-neck", "B-head", "B-shoulder.L", "B-upperArm.L", "B-forearm.L",
           "B-hand.L", "B-shoulder.R", "B-upperArm.R", "B-forearm.R", "B-hand.R", "B-thigh.L", "B-shin.L", "B-foot.L",
           "B-toe.L", "B-thigh.R", "B-shin.R", "B-foot.R", "B-toe.R"]
    r = resolve(maps, kev, "HumanM@Idle.fbx", None)
    assert r.rig_id == "kevin_humanm" and not r.missing_core and r.mapping["Hips"] == "B-hips", r.summary()
    mix = ["mixamorig:" + n for n in ("Hips", "Spine", "Spine1", "Spine2", "Neck", "Head", "LeftShoulder", "LeftArm", "LeftForeArm", "LeftHand",
                                      "RightShoulder", "RightArm", "RightForeArm", "RightHand", "LeftUpLeg", "LeftLeg", "LeftFoot", "LeftToeBase",
                                      "RightUpLeg", "RightLeg", "RightFoot", "RightToeBase")]
    r = resolve(maps, mix, "Walk.fbx", None)
    assert r.rig_id == "generic" and not r.missing_core and r.mapping["LeftLeg"] == "mixamorig:LeftUpLeg", r.summary()
    r = resolve(maps, ["foo", "bar"], "x.fbx", None)
    assert r.missing_core
    print("ok  bone maps (Kevin, Mixamo-style, unknown rig)")


if __name__ == "__main__":
    test_rotation_helpers()
    test_bonemap()
    soma = load_soma()
    if soma is None:
        print("SKIP SOMA tests (set SOMA_JSON)")
    else:
        test_bvh_roundtrip(soma)
        test_retarget_roundtrip(soma)
    print("\n== request schema / chaining")
    import test_request
    test_request.test_raw_frames_readout()
    test_request.test_played_frame_count()
    test_request.test_variant_tokens_range()
    test_request.test_normalize_legacy_single_target()
    test_request.test_normalize_multi_target()
    test_request.test_normalize_rejects_bad_tokens()
    test_request.test_concat_segments()
    test_request.test_default_target_helpers()
    print("ALL OK")
