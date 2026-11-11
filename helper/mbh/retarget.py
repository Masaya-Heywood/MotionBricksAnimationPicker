"""Pose retargeting between an arbitrary humanoid rig and the SOMA skeleton, in pure numpy.

Everything is expressed with *world* rotations so it does not matter which local bone axes a rig
uses. For a mapped bone b <-> SOMA joint j:

    Ds   = Gs(b,t) . Gs_rest(b)^-1          world rotation of the bone relative to its rest pose
    Ds'  = C . Ds . C^-1                    expressed in the SOMA body frame (C: source frame -> SOMA frame)
    Gt(j,t) = Ds' . A_j^-1 . Gt_rest(j)     SOMA world rotation; A_j = shortest arc from the rest
                                            direction of the source bone (in SOMA frame) to the rest
                                            direction of the SOMA bone (so rest-pose differences such
                                            as A-pose vs T-pose cancel in the bone direction)
    local(j) = Gt(parent)^-1 . Gt(j)        (unmapped joints keep their SOMA rest local rotation)

`backward` is the exact inverse, so a pose that went forward comes back unchanged (see tests).
Root translation: hips displacement from rest, scaled by the hips-height ratio, rotated by C.
"""
import numpy as np

from .rot import angle_between_mats, axis_angle, rot_between
from .soma import body_frame

MIN_AIM_LEN = 0.015  # SOMA metres; shorter bone vectors are too noisy to define a direction


class RigRest(object):
    """Rest-pose measurements of the source armature, in the armature's world space (metres).
    The world axes are arbitrary (an FBX imported into Blender can lie on its back); the body's own
    up/left/forward are derived from the rest pose, so nothing here assumes Z up."""

    def __init__(self, names, parents, rest_R, rest_head, rest_points):
        self.names = list(names)
        self.parents = list(parents)
        self.rest_R = np.asarray(rest_R, dtype=np.float64)  # (N,3,3) world rest rotation of each bone
        self.rest_head = np.asarray(rest_head, dtype=np.float64)  # (N,3) world rest head position
        self.rest_points = np.asarray(rest_points, dtype=np.float64)  # (M,3) all bone heads and tails
        self.index = {n: i for i, n in enumerate(self.names)}


class Retargeter(object):
    def __init__(self, soma, rig, mapping, aim_candidates):
        self.soma = soma
        self.rig = rig
        self.mapping = {j: b for j, b in mapping.items() if j in soma.index and b in rig.index}
        for need in ("Hips", "LeftLeg", "RightLeg"):
            if need not in self.mapping:
                raise ValueError("Bone map has no bone for SOMA joint %s" % need)
        self.src_idx = {soma.index[j]: rig.index[b] for j, b in self.mapping.items()}
        # body frames: up from mid-feet (or head) to hips, left from the two upper-leg joints
        hips_p = rig.rest_head[rig.index[self.mapping["Hips"]]]
        if "LeftFoot" in self.mapping and "RightFoot" in self.mapping:
            feet = 0.5 * (rig.rest_head[rig.index[self.mapping["LeftFoot"]]] + rig.rest_head[rig.index[self.mapping["RightFoot"]]])
            up_s = hips_p - feet
        elif "Head" in self.mapping:
            up_s = rig.rest_head[rig.index[self.mapping["Head"]]] - hips_p
        else:
            raise ValueError("Bone map needs Head or both feet to find the body's up direction")
        l_s = rig.rest_head[rig.index[self.mapping["LeftLeg"]]] - rig.rest_head[rig.index[self.mapping["RightLeg"]]]
        fs = body_frame(l_s, up_s)
        self.up = fs[1]
        ft = soma.rest_frame()
        Bs = np.stack(fs, axis=1)
        Bt = np.stack(ft, axis=1)
        self.C = Bt @ Bs.T
        self.src_frame, self.soma_frame = fs, ft
        # hips height scale
        hips_s = rig.rest_head[rig.index[self.mapping["Hips"]]]
        ground_s = float(np.min(rig.rest_points @ fs[1]))
        h_s = float(np.dot(hips_s, fs[1])) - ground_s
        h_t = float(soma.rest_world_P[0][1]) - soma.ground_height()
        self.scale = h_t / h_s if h_s > 1e-6 else 1.0
        self.src_hips_rest = hips_s
        # per joint alignment A_j
        self.A = {}
        self.aim_used = {}
        for j in sorted(self.src_idx):
            name = soma.names[j]
            A = None
            for cand in aim_candidates.get(name, []):
                cj = soma.index.get(cand)
                if cj is None or cj not in self.src_idx:
                    continue
                d_s = self.C @ (rig.rest_head[self.src_idx[cj]] - rig.rest_head[self.src_idx[j]])
                d_t = soma.rest_world_P[cj] - soma.rest_world_P[j]
                if np.linalg.norm(d_s) * self.scale < MIN_AIM_LEN or np.linalg.norm(d_t) < MIN_AIM_LEN:
                    continue
                A = rot_between(d_s, d_t)
                self.aim_used[name] = cand
                break
            if A is None:
                p = soma.parents[j]
                while p >= 0 and p not in self.A:
                    p = soma.parents[p]
                A = self.A[p] if p >= 0 else np.eye(3)
                self.aim_used[name] = "(inherited)"
            self.A[j] = A

    # -- helpers -----------------------------------------------------------------------------
    def rest_pose_quality(self):
        """Angles (deg) between the source rest arm/leg directions and what a T-pose would have."""
        rig, m = self.rig, self.mapping
        out = {}
        for side in ("Left", "Right"):
            a, f = side + "Arm", side + "ForeArm"
            if a in m and f in m:
                d = self.C @ (rig.rest_head[rig.index[m[f]]] - rig.rest_head[rig.index[m[a]]])
                dt = self.soma.rest_world_P[self.soma.index[side + "ForeArm"]] - self.soma.rest_world_P[self.soma.index[a]]
                out[side.lower() + "_upper_arm_vs_soma_rest_deg"] = float(
                    np.degrees(np.arccos(np.clip(np.dot(d, dt) / np.linalg.norm(d) / np.linalg.norm(dt), -1, 1)))
                )
        return out

    def forward(self, anim_R, hips_pos):
        """anim_R (T,N,3,3) world rotation of every source bone, hips_pos (T,3) world hips head.
        Returns SOMA local_R (T,J,3,3) and root_pos (T,3) in SOMA space (not yet heading-normalised)."""
        soma = self.soma
        T = anim_R.shape[0]
        G = np.empty((T, soma.J, 3, 3))
        L = np.empty((T, soma.J, 3, 3))
        CT = self.C.T
        for j in range(soma.J):
            p = soma.parents[j]
            if j in self.src_idx:
                b = self.src_idx[j]
                Ds = anim_R[:, b] @ self.rig.rest_R[b].T
                Dsp = self.C @ Ds @ CT
                G[:, j] = Dsp @ self.A[j].T @ soma.rest_world_R[j]
            else:
                G[:, j] = (G[:, p] if p >= 0 else np.eye(3)) @ soma.rest_R[j]
            if p < 0:
                L[:, j] = G[:, j]
            else:
                L[:, j] = np.swapaxes(G[:, p], -1, -2) @ G[:, j]
        root = soma.rest_world_P[0][None, :] + self.scale * ((hips_pos - self.src_hips_rest[None, :]) @ self.C.T)
        return L, root

    def backward(self, local_R, root_pos):
        """Inverse of forward. Returns {source bone index: (T,3,3) world R} and hips_pos (T,3)."""
        soma = self.soma
        WR, _ = soma.fk(local_R, root_pos)
        out = {}
        for j, b in self.src_idx.items():
            Dsp = WR[:, j] @ soma.rest_world_R[j].T @ self.A[j]
            Ds = self.C.T @ Dsp @ self.C
            out[b] = Ds @ self.rig.rest_R[b]
        hips = self.src_hips_rest[None, :] + ((root_pos - soma.rest_world_P[0][None, :]) / self.scale) @ self.C
        return out, hips


def heading_yaw_rotation(soma, local_R, root_pos, ref_index):
    """Rotation about SOMA up that turns the pose at ref_index to face the SOMA rest forward."""
    WR, WP = soma.fk(local_R[ref_index:ref_index + 1], root_pos[ref_index:ref_index + 1])
    left = WP[0, soma.index["LeftLeg"]] - WP[0, soma.index["RightLeg"]]
    _, up, fwd = body_frame(left, [0, 1, 0])
    f0 = soma.rest_frame()[2]
    theta = np.arctan2(np.dot(np.cross(fwd, f0), up), np.dot(fwd, f0))
    return axis_angle(up, theta), float(np.degrees(theta))


def place_window(soma, local_R, root_pos, ref_index, offset_forward=0.0, offset_right=0.0, turn_deg=0.0):
    """Move a window so the pose at ref_index stands on the origin facing SOMA forward (ground position
    and heading removed, height kept, like the engine does), then place it: turn_deg (+ = left) and a
    ground offset (forward, right) in metres. Returns new (local_R, root_pos)."""
    Q, _ = heading_yaw_rotation(soma, local_R, root_pos, ref_index)
    left0, up0, f0 = soma.rest_frame()
    ground0 = root_pos[ref_index].copy()
    ground0[1] = 0.0
    Qe = axis_angle(up0, np.radians(turn_deg))
    off = f0 * offset_forward + (-left0) * offset_right
    new_R = local_R.copy()
    new_R[:, 0] = (Qe @ Q) @ local_R[:, 0]
    new_pos = ((root_pos - ground0[None, :]) @ Q.T) @ Qe.T + off[None, :]
    return new_R, new_pos
