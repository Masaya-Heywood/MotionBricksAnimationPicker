"""Read and write BVH in the layout MotionBricks' load_bvh expects.

MotionBricks (motionbricks/io/bvh.py) treats rotation channels as the *full local rotation* of the
SOMA joint (its rest orientation included), positions in centimetres, and fills joints missing from
the file from its own skeleton. So this writer emits the SOMA hierarchy with the USD rest offsets,
`Xposition Yposition Zposition Zrotation Yrotation Xrotation` on the root (Hips) and
`Zrotation Yrotation Xrotation` on every other joint, exactly like NVIDIA's sample clips are laid out.
A generic BVH viewer will show such a file with the SOMA joint axes, which is expected.
"""
import numpy as np

from .rot import euler_zyx_to_mat, mat_to_euler_zyx

_AXIS = {"x": 0, "y": 1, "z": 2}


def _dfs_order(parents):
    children = {}
    root = None
    for i, p in enumerate(parents):
        if p < 0:
            root = i
        else:
            children.setdefault(p, []).append(i)
    order, stack = [], [root]
    while stack:
        j = stack.pop()
        order.append(j)
        for c in reversed(children.get(j, [])):
            stack.append(c)
    return order, children, root


def write_bvh(path, names, parents, offsets_m, local_R, root_pos_m, fps=30.0):
    """names/parents/offsets_m: skeleton (offsets in metres, parent-local). local_R: (T,J,3,3) full
    local rotations. root_pos_m: (T,3) root translation in metres (Y up)."""
    local_R = np.asarray(local_R, dtype=np.float64)
    root_pos_m = np.asarray(root_pos_m, dtype=np.float64)
    T, J = local_R.shape[0], len(names)
    assert local_R.shape == (T, J, 3, 3) and root_pos_m.shape == (T, 3)
    order, children, root = _dfs_order(parents)
    off_cm = np.asarray(offsets_m, dtype=np.float64) * 100.0
    lines = ["HIERARCHY"]

    def emit(j, depth):
        pad = " " * depth
        kw = "ROOT" if j == root else "JOINT"
        lines.append(f"{pad}{kw} {names[j]}")
        lines.append(pad + "{")
        o = off_cm[j]
        lines.append(f"{pad}  OFFSET {o[0]:.6f} {o[1]:.6f} {o[2]:.6f}")
        if j == root:
            lines.append(f"{pad}  CHANNELS 6 Xposition Yposition Zposition Zrotation Yrotation Xrotation")
        else:
            lines.append(f"{pad}  CHANNELS 3 Zrotation Yrotation Xrotation")
        for c in children.get(j, []):
            emit(c, depth + 1)
        lines.append(pad + "}")

    emit(root, 0)
    lines += ["MOTION", f"Frames: {T}", f"Frame Time: {1.0 / fps:.9f}"]
    eul = mat_to_euler_zyx(local_R)  # (T,J,3) z,y,x deg
    cols = []
    for j in order:
        if j == root:
            cols.append(root_pos_m * 100.0)
        cols.append(eul[:, j, :])
    data = np.concatenate(cols, axis=1)
    with open(path, "w", encoding="utf-8", newline="\n") as f:
        f.write("\n".join(lines) + "\n")
        for row in data:
            f.write(" ".join(f"{v:.6f}" for v in row) + "\n")
    return {"frames": T, "joints": J, "path": str(path)}


def read_bvh(path):
    """Parse a BVH. Returns dict: names, parents, offsets_m (J,3), local_R (T,J,3,3), root_pos_m (T,3),
    fps. Generic channel orders are supported; rotations are composed in channel order."""
    names, parents, offsets, chans = [], [], [], []
    stack = []
    in_end = False
    with open(path, "r", encoding="utf-8") as f:
        lines = f.read().splitlines()
    i = 0
    while i < len(lines):
        tok = lines[i].split()
        i += 1
        if not tok:
            continue
        if tok[0] == "MOTION":
            break
        if tok[0] in ("ROOT", "JOINT"):
            names.append(tok[1].rsplit(":", 1)[-1])
            parents.append(stack[-1] if stack else -1)
            stack.append(len(names) - 1)
            offsets.append([0.0, 0.0, 0.0])
            chans.append([])
        elif tok[:2] == ["End", "Site"]:
            in_end = True
        elif tok[0] == "OFFSET" and not in_end:
            offsets[stack[-1]] = [float(v) for v in tok[1:4]]
        elif tok[0] == "CHANNELS":
            chans[stack[-1]] = tok[2:]
        elif tok[0] == "}":
            if in_end:
                in_end = False
            else:
                stack.pop()
    frames, ftime = 0, 1 / 30.0
    while i < len(lines):
        tok = lines[i].split()
        i += 1
        if tok[:1] == ["Frames:"]:
            frames = int(tok[1])
        elif tok[:2] == ["Frame", "Time:"]:
            ftime = float(tok[2])
            break
    data = np.array([[float(v) for v in l.split()] for l in lines[i:] if l.strip()], dtype=np.float64)
    data = data.reshape(frames, -1)
    J = len(names)
    local_R = np.tile(np.eye(3), (frames, J, 1, 1))
    root_pos = np.zeros((frames, 3))
    col = 0
    for j in range(J):
        rot = []
        for ch in chans[j]:
            lc = ch.lower()
            if lc.endswith("position"):
                if j == 0 or parents[j] < 0:
                    root_pos[:, _AXIS[lc[0]]] = data[:, col]
            elif lc.endswith("rotation"):
                rot.append((_AXIS[lc[0]], data[:, col]))
            col += 1
        if rot:
            R = np.tile(np.eye(3), (frames, 1, 1))
            for axis, vals in rot:
                a = np.radians(vals)
                c, s = np.cos(a), np.sin(a)
                M = np.zeros((frames, 3, 3))
                M[:, axis, axis] = 1
                a1, a2 = [k for k in range(3) if k != axis]
                if axis == 1:
                    a1, a2 = 2, 0
                M[:, a1, a1] = c
                M[:, a2, a2] = c
                M[:, a1, a2] = -s
                M[:, a2, a1] = s
                R = R @ M
            local_R[:, j] = R
    return {
        "names": names,
        "parents": parents,
        "offsets_m": np.asarray(offsets) * 0.01,
        "local_R": local_R,
        "root_pos_m": root_pos * 0.01,
        "fps": 1.0 / ftime,
        "frames": frames,
    }
