"""SOMA skeleton data (from the JSON exported out of MotionBricks' own USD) and forward kinematics."""
import json

import numpy as np

from .rot import quat_to_mat

# The 30 joints the MotionBricks SOMA model predicts (motionbricks/assets/onnx/soma/soma_n1.json).
MODEL_JOINTS = [
    "Hips", "Spine1", "Spine2", "Chest", "Neck1", "Neck2", "Head", "Jaw", "LeftEye", "RightEye",
    "LeftShoulder", "LeftArm", "LeftForeArm", "LeftHand", "LeftHandThumbEnd", "LeftHandMiddleEnd",
    "RightShoulder", "RightArm", "RightForeArm", "RightHand", "RightHandThumbEnd", "RightHandMiddleEnd",
    "LeftLeg", "LeftShin", "LeftFoot", "LeftToeBase", "RightLeg", "RightShin", "RightFoot", "RightToeBase",
]


class Soma:
    def __init__(self, path):
        d = json.load(open(path, "r", encoding="utf-8"))
        self.names = d["joint_names"]
        self.parents = list(d["parents"])
        self.rest_pos = np.asarray(d["rest_local_pos"], dtype=np.float64)  # (J,3) metres, parent-local
        self.rest_R = quat_to_mat(np.asarray(d["rest_local_quat_xyzw"], dtype=np.float64))  # (J,3,3)
        self.index = {n: i for i, n in enumerate(self.names)}
        self.J = len(self.names)
        assert self.parents[0] == -1 and self.names[0] == "Hips"
        for i, p in enumerate(self.parents):
            assert p < i, "SOMA joints must be ordered parent-first"
        missing = [n for n in MODEL_JOINTS if n not in self.index]
        if missing:
            raise ValueError("SOMA skeleton is missing model joints: %s" % missing)
        self.rest_world_R, self.rest_world_P = self.fk(self.rest_R[None], self.rest_pos[0][None])
        self.rest_world_R, self.rest_world_P = self.rest_world_R[0], self.rest_world_P[0]
        self.children = {i: [] for i in range(self.J)}
        for i, p in enumerate(self.parents):
            if p >= 0:
                self.children[p].append(i)

    def fk(self, local_R, root_pos, offsets=None):
        """local_R (T,J,3,3), root_pos (T,3) -> world R (T,J,3,3), world P (T,J,3)."""
        T = local_R.shape[0]
        off = self.rest_pos if offsets is None else offsets
        WR = np.empty((T, self.J, 3, 3))
        WP = np.empty((T, self.J, 3))
        for j in range(self.J):
            p = self.parents[j]
            if p < 0:
                WR[:, j] = local_R[:, j]
                WP[:, j] = root_pos
            else:
                WR[:, j] = WR[:, p] @ local_R[:, j]
                WP[:, j] = WP[:, p] + np.einsum("tij,j->ti", WR[:, p], off[j])
        return WR, WP

    def rest_frame(self):
        """(left, up, forward) unit vectors of the rest pose in SOMA world space."""
        left = self.rest_world_P[self.index["LeftLeg"]] - self.rest_world_P[self.index["RightLeg"]]
        return body_frame(left, np.array([0.0, 1.0, 0.0]))

    def ground_height(self):
        return float(self.rest_world_P[:, 1].min())


def body_frame(left, up):
    """Orthonormal (left, up, forward) from a leg-to-leg vector and an up hint. forward = left x up."""
    up = np.asarray(up, dtype=np.float64)
    up = up / np.linalg.norm(up)
    left = np.asarray(left, dtype=np.float64)
    left = left - up * np.dot(left, up)
    left = left / np.linalg.norm(left)
    fwd = np.cross(left, up)
    return left, up, fwd
