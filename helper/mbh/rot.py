"""Small numpy rotation toolbox. Quaternions are XYZW. Matrices act on column vectors."""
import numpy as np


def quat_to_mat(q):
    q = np.asarray(q, dtype=np.float64)
    q = q / np.linalg.norm(q, axis=-1, keepdims=True)
    x, y, z, w = q[..., 0], q[..., 1], q[..., 2], q[..., 3]
    m = np.empty(q.shape[:-1] + (3, 3))
    m[..., 0, 0] = 1 - 2 * (y * y + z * z)
    m[..., 0, 1] = 2 * (x * y - z * w)
    m[..., 0, 2] = 2 * (x * z + y * w)
    m[..., 1, 0] = 2 * (x * y + z * w)
    m[..., 1, 1] = 1 - 2 * (x * x + z * z)
    m[..., 1, 2] = 2 * (y * z - x * w)
    m[..., 2, 0] = 2 * (x * z - y * w)
    m[..., 2, 1] = 2 * (y * z + x * w)
    m[..., 2, 2] = 1 - 2 * (x * x + y * y)
    return m


def mat_to_quat(m):
    """Robust (Shepperd) matrix -> XYZW quaternion with w >= 0. Accepts (...,3,3)."""
    m = np.asarray(m, dtype=np.float64)
    flat = m.reshape(-1, 3, 3)
    out = np.empty((flat.shape[0], 4))
    for i, r in enumerate(flat):
        t = r[0, 0] + r[1, 1] + r[2, 2]
        if t > 0:
            s = np.sqrt(t + 1.0) * 2
            q = [(r[2, 1] - r[1, 2]) / s, (r[0, 2] - r[2, 0]) / s, (r[1, 0] - r[0, 1]) / s, 0.25 * s]
        elif r[0, 0] > r[1, 1] and r[0, 0] > r[2, 2]:
            s = np.sqrt(1.0 + r[0, 0] - r[1, 1] - r[2, 2]) * 2
            q = [0.25 * s, (r[0, 1] + r[1, 0]) / s, (r[0, 2] + r[2, 0]) / s, (r[2, 1] - r[1, 2]) / s]
        elif r[1, 1] > r[2, 2]:
            s = np.sqrt(1.0 + r[1, 1] - r[0, 0] - r[2, 2]) * 2
            q = [(r[0, 1] + r[1, 0]) / s, 0.25 * s, (r[1, 2] + r[2, 1]) / s, (r[0, 2] - r[2, 0]) / s]
        else:
            s = np.sqrt(1.0 + r[2, 2] - r[0, 0] - r[1, 1]) * 2
            q = [(r[0, 2] + r[2, 0]) / s, (r[1, 2] + r[2, 1]) / s, 0.25 * s, (r[1, 0] - r[0, 1]) / s]
        q = np.asarray(q)
        q /= np.linalg.norm(q)
        if q[3] < 0:
            q = -q
        out[i] = q
    return out.reshape(m.shape[:-2] + (4,))


def rot_x(a):
    c, s = np.cos(a), np.sin(a)
    return np.array([[1, 0, 0], [0, c, -s], [0, s, c]])


def rot_y(a):
    c, s = np.cos(a), np.sin(a)
    return np.array([[c, 0, s], [0, 1, 0], [-s, 0, c]])


def rot_z(a):
    c, s = np.cos(a), np.sin(a)
    return np.array([[c, -s, 0], [s, c, 0], [0, 0, 1]])


def axis_angle(axis, angle):
    axis = np.asarray(axis, dtype=np.float64)
    axis = axis / np.linalg.norm(axis)
    k = np.array([[0, -axis[2], axis[1]], [axis[2], 0, -axis[0]], [-axis[1], axis[0], 0]])
    return np.eye(3) + np.sin(angle) * k + (1 - np.cos(angle)) * (k @ k)


def euler_zyx_to_mat(deg):
    """BVH channel order Zrotation Yrotation Xrotation -> R = Rz @ Ry @ Rx. deg (...,3)=(z,y,x)."""
    a = np.radians(np.asarray(deg, dtype=np.float64))
    cz, sz = np.cos(a[..., 0]), np.sin(a[..., 0])
    cy, sy = np.cos(a[..., 1]), np.sin(a[..., 1])
    cx, sx = np.cos(a[..., 2]), np.sin(a[..., 2])
    m = np.empty(a.shape[:-1] + (3, 3))
    m[..., 0, 0] = cz * cy
    m[..., 0, 1] = cz * sy * sx - sz * cx
    m[..., 0, 2] = cz * sy * cx + sz * sx
    m[..., 1, 0] = sz * cy
    m[..., 1, 1] = sz * sy * sx + cz * cx
    m[..., 1, 2] = sz * sy * cx - cz * sx
    m[..., 2, 0] = -sy
    m[..., 2, 1] = cy * sx
    m[..., 2, 2] = cy * cx
    return m


def mat_to_euler_zyx(m):
    """Inverse of euler_zyx_to_mat. Returns degrees (...,3)=(z,y,x). Gimbal-safe."""
    m = np.asarray(m, dtype=np.float64)
    sy = np.clip(-m[..., 2, 0], -1.0, 1.0)
    y = np.arcsin(sy)
    cy = np.sqrt(np.maximum(0.0, 1 - sy * sy))
    gimbal = cy < 1e-6
    x = np.where(gimbal, np.arctan2(-m[..., 1, 2], m[..., 1, 1]), np.arctan2(m[..., 2, 1], m[..., 2, 2]))
    z = np.where(gimbal, 0.0, np.arctan2(m[..., 1, 0], m[..., 0, 0]))
    return np.degrees(np.stack([z, y, x], axis=-1))


def rot_between(a, b):
    """Shortest-arc rotation matrix taking direction a to direction b."""
    a = np.asarray(a, dtype=np.float64)
    b = np.asarray(b, dtype=np.float64)
    a = a / np.linalg.norm(a)
    b = b / np.linalg.norm(b)
    c = float(np.dot(a, b))
    if c > 1 - 1e-12:
        return np.eye(3)
    if c < -1 + 1e-12:
        helper = np.array([1.0, 0, 0]) if abs(a[0]) < 0.9 else np.array([0, 1.0, 0])
        axis = np.cross(a, helper)
        return axis_angle(axis, np.pi)
    v = np.cross(a, b)
    k = np.array([[0, -v[2], v[1]], [v[2], 0, -v[0]], [-v[1], v[0], 0]])
    return np.eye(3) + k + (k @ k) * (1.0 / (1.0 + c))


def orthonormalize(m):
    u, _, vt = np.linalg.svd(np.asarray(m, dtype=np.float64))
    r = u @ vt
    if np.linalg.det(r) < 0:
        u[:, -1] *= -1
        r = u @ vt
    return r


def angle_between_mats(a, b):
    """Geodesic angle in degrees between rotation matrices (broadcasting)."""
    r = np.einsum("...ij,...kj->...ik", a, b)
    tr = np.clip((np.trace(r, axis1=-2, axis2=-1) - 1) / 2, -1, 1)
    return np.degrees(np.arccos(tr))


def slerp_mats(a, b, t):
    """Interpolate two rotation matrices (3,3) at fraction t."""
    qa, qb = mat_to_quat(a), mat_to_quat(b)
    if np.dot(qa, qb) < 0:
        qb = -qb
    d = np.clip(np.dot(qa, qb), -1, 1)
    th = np.arccos(d)
    if th < 1e-6:
        q = qa * (1 - t) + qb * t
    else:
        q = (np.sin((1 - t) * th) * qa + np.sin(t * th) * qb) / np.sin(th)
    return quat_to_mat(q / np.linalg.norm(q))
