"""Step (b): generate the in-between motion with MotionBricks and save it as SOMA BVH.

    uv run python mb_generate.py --context a__context.bvh --target a__target.bvh --out a.bvh
    python mb_generate.py ... --mock        # numpy-only stand-in (slerp/lerp), no GPU, no motionbricks

Run it from the motionbricks checkout with `uv run` so warp / TensorRT / the engine import. The real
path follows docs/examples/generate_once.py of MotionBricks v0.2.0 call for call:

    engine = MotionBricksSOMAEngine(SOMA_N1_FP32_ONNX_PATH, model_to_runtime=wp.transform_identity())
    context = engine.create_input(skeleton); target = engine.create_input(skeleton)
    output  = engine.create_output(skeleton)
    context.update_from_poses(context_poses, stream=engine.stream)     # 4 poses, 30 Hz
    target.update_from_poses(target_poses[:n], stream=engine.stream)   # 1-4 poses
    engine.generate_animation(context, target, output, config=...)
    engine.synchronize(); poses = output.poses[:output.num_frames].numpy()

SOMA model space (Y up, meters) is used as is: model_to_runtime is the identity, because to_soma.py
already wrote the context/target windows in SOMA space (context ends on the origin).
"""
import argparse
import os
import sys
import time

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

from mbh.bvhio import read_bvh, write_bvh  # noqa: E402
from mbh.rot import mat_to_quat, quat_to_mat, slerp_mats  # noqa: E402

MODEL_SAMPLE_RATE = 30.0
POSES_PER_TOKEN = 4
BOUNDARY = POSES_PER_TOKEN - 1
DEFAULT_TOKEN_COUNTS = tuple(range(8, 15))
# Variant k pins the token count (= duration) so variants differ even if the model is deterministic.
VARIANT_TOKENS = [None, 10, 12, 8, 14, 9, 11, 13]


def valid_frames(tokens):
    return tokens * POSES_PER_TOKEN - 2 * BOUNDARY  # 6..16 tokens -> 18..58 frames


def variant_tokens(variant, explicit=None, tokens_min=None, tokens_max=None):
    """Allowed token counts for a variant (1-based).

    - explicit: single int or sequence → pin those counts
    - tokens_min/max: Inbetweener range (default 8..14). Variant 1 uses the full range;
      later variants pin a count from VARIANT_TOKENS, clipped into the range.
    - None/None with no explicit → engine default (None → Config() uses 8..14)
    """
    if explicit is not None:
        if isinstance(explicit, (list, tuple)):
            return tuple(int(x) for x in explicit)
        return (int(explicit),)
    if tokens_min is not None or tokens_max is not None:
        lo = int(tokens_min if tokens_min is not None else DEFAULT_TOKEN_COUNTS[0])
        hi = int(tokens_max if tokens_max is not None else DEFAULT_TOKEN_COUNTS[-1])
        if lo > hi:
            lo, hi = hi, lo
        if variant <= 1:
            return tuple(range(lo, hi + 1))
        pinned = VARIANT_TOKENS[(max(1, variant) - 1) % len(VARIANT_TOKENS)]
        if pinned is None:
            return tuple(range(lo, hi + 1))
        return (max(lo, min(hi, int(pinned))),)
    t = VARIANT_TOKENS[(max(1, variant) - 1) % len(VARIANT_TOKENS)]
    return None if t is None else (t,)


def save_bvh(path, joint_names, parent_indices, reference_pos_m, poses):
    """Write generated SOMA poses as BVH. poses: (frames, joints, 7) = position xyz + quaternion xyzw per
    joint (the layout of AnimationBuffer.poses). The root (joint 0) carries the position channels; every
    other joint keeps its reference offset. Same layout MotionBricks' load_bvh reads (see mbh/bvhio.py)."""
    poses = np.asarray(poses, dtype=np.float64)
    R = quat_to_mat(poses[:, :, 3:7])
    return write_bvh(path, list(joint_names), list(parent_indices), np.asarray(reference_pos_m), R,
                     poses[:, 0, :3], MODEL_SAMPLE_RATE)


def write_context_from_poses(path, joint_names, parent_indices, reference_pos_m, poses, soma=None,
                             transition_early=0):
    """Write the last four *played* frames of a generated segment as a context BVH.

    Matches Inbetweener step(): segment_end = max(3, num_frames-1-early); context = poses[end-3:end+1],
    then place_window so the last frame sits on the origin (engine-compatible).
    """
    from mbh.retarget import place_window
    from request_schema import played_frame_count

    poses = np.asarray(poses, dtype=np.float64)
    played = played_frame_count(len(poses), transition_early)
    end = played - 1
    window = poses[end - (POSES_PER_TOKEN - 1):end + 1]
    R = quat_to_mat(window[:, :, 3:7])
    root = window[:, 0, :3].copy()
    if soma is not None:
        R, root = place_window(soma, R, root, ref_index=POSES_PER_TOKEN - 1)
    return write_bvh(path, list(joint_names), list(parent_indices), np.asarray(reference_pos_m), R, root,
                     MODEL_SAMPLE_RATE)


def concat_segment_poses(segments):
    """Concatenate played pose arrays. segments: list of (poses, transition_early).

    First segment keeps frames[0:played]; later segments drop frame 0 (junction duplicate).
    """
    from request_schema import played_frame_count

    out = []
    for i, (poses, early) in enumerate(segments):
        poses = np.asarray(poses, dtype=np.float64)
        n = played_frame_count(len(poses), early)
        chunk = poses[:n]
        if i > 0:
            chunk = chunk[1:]
        if len(chunk):
            out.append(chunk)
    if not out:
        raise ValueError("no frames to concatenate")
    return np.concatenate(out, axis=0)


def _poses_from_bvh(path, names):
    b = read_bvh(path)
    idx = [b["names"].index(n) for n in names]
    R = b["local_R"][:, idx]
    return R, b["root_pos_m"]


class MockRunner(object):
    """Linear stand-in for the engine so the whole pipeline can run without a GPU.
    First frame = last context pose, last frame = first target pose, slerp for joints, smoothstep root."""
    name = "mock"

    def __init__(self, soma):
        self.soma = soma

    def info(self):
        return {"engine": "mock", "gpu": False}

    def generate(self, context_bvh, target_bvh, tokens=None, variant=1, tokens_min=None, tokens_max=None,
                 log=print, **_):
        soma = self.soma
        cR, cP = _poses_from_bvh(context_bvh, soma.names)
        tR, tP = _poses_from_bvh(target_bvh, soma.names)
        counts = variant_tokens(variant, explicit=tokens, tokens_min=tokens_min, tokens_max=tokens_max) or (11,)
        n_tokens = counts[len(counts) // 2]
        T = valid_frames(n_tokens)
        A, B = cR[-1], tR[0]
        poses = np.empty((T, soma.J, 7))
        log("mock engine: tokens %s -> %d frames (linear stand-in, NOT MotionBricks)" % (counts, T))
        for f in range(T):
            u = f / float(T - 1)
            e = u * u * (3 - 2 * u)
            for j in range(soma.J):
                poses[f, j, :3] = soma.rest_pos[j]
                poses[f, j, 3:] = mat_to_quat(slerp_mats(A[j], B[j], e))
            poses[f, 0, :3] = (1 - e) * cP[-1] + e * tP[0]
        # Synthetic foot contacts: high when root is near the start/end (mock only)
        contacts = np.zeros((T, 4), dtype=np.float32)
        for f in range(T):
            u = f / float(max(1, T - 1))
            contacts[f] = 0.2 + 0.8 * (1.0 - abs(2 * u - 1.0))
        return poses, contacts, {"frames": T, "tokens": n_tokens, "allowed_token_counts": list(counts)}


class RealRunner(object):
    """The actual MotionBricks engine. Needs an NVIDIA GPU + the motionbricks uv environment."""
    name = "motionbricks"

    def __init__(self, motionbricks_dir, precision="fp32", device="cuda:0", engine_factory=None):
        self.motionbricks_dir = motionbricks_dir
        self.precision = precision
        self.device = device
        self._engine_factory = engine_factory
        self._ready = False

    def info(self):
        return {"engine": "motionbricks", "precision": self.precision, "device": self.device, "warm": self._ready}

    # -- setup ----------------------------------------------------------------------------------
    def _setup(self, log):
        if self._ready:
            return
        if self.motionbricks_dir and os.path.isdir(self.motionbricks_dir) and self.motionbricks_dir not in sys.path:
            sys.path.insert(0, self.motionbricks_dir)
        import warp as wp  # noqa: WPS433
        from motionbricks.io.bvh import load_bvh
        from motionbricks.io.usd import load_skeleton_from_usd
        from motionbricks.io.utils import SOMA_SKELETON_PRIM_PATH, get_asset_file
        from motionbricks.model.config import MotionBricksInferenceConfig

        self.wp, self.load_bvh, self.Config = wp, load_bvh, MotionBricksInferenceConfig
        t0 = time.time()
        wp.init()
        wp.set_device(self.device)
        usd = get_asset_file("human", "soma_base_skel_minimal_no_root.usd")
        self.skeleton = load_skeleton_from_usd(usd, SOMA_SKELETON_PRIM_PATH)
        if self._engine_factory is not None:
            self.engine = self._engine_factory(self)
        else:
            from motionbricks.model.soma.contract import SOMA_N1_FP16_ONNX_PATH, SOMA_N1_FP32_ONNX_PATH
            from motionbricks.model.soma.engine import MotionBricksSOMAEngine

            onnx = SOMA_N1_FP16_ONNX_PATH if self.precision == "fp16" else SOMA_N1_FP32_ONNX_PATH
            log("loading MotionBricks SOMA engine (%s). The first launch builds a TensorRT plan, which takes "
                "a few minutes; later launches load the cached plan from .trt-cache." % self.precision)
            self.engine = MotionBricksSOMAEngine(
                onnx, model_to_runtime=wp.transform_identity(),
                cache_dir=os.path.join(self.motionbricks_dir or ".", ".trt-cache"),
            )
        eng = self.engine
        self.context = eng.create_input(self.skeleton)
        self.target = eng.create_input(self.skeleton)
        self.output = eng.create_output(self.skeleton)
        self.context_poses = wp.empty_like(self.context.poses)
        self.target_poses = wp.empty_like(self.context.poses)
        self._ready = True
        log("engine ready in %.1f s" % (time.time() - t0))

    def close(self):
        if self._ready:
            try:
                self.engine.close()
            finally:
                self._ready = False

    # -- one generation -------------------------------------------------------------------------
    def generate(self, context_bvh, target_bvh, tokens=None, variant=1, tokens_min=None, tokens_max=None,
                 n_target_poses=None, log=print, **_):
        self._setup(log)
        wp, eng = self.wp, self.engine
        ctx_clip = self.load_bvh(str(context_bvh), self.skeleton)  # remaps by joint name to the SOMA skeleton
        tgt_clip = self.load_bvh(str(target_bvh), self.skeleton)
        want = POSES_PER_TOKEN if n_target_poses is None else max(1, min(POSES_PER_TOKEN, int(n_target_poses)))
        n_target = min(want, int(tgt_clip.num_frames))
        counts = variant_tokens(variant, explicit=tokens, tokens_min=tokens_min, tokens_max=tokens_max)
        # Inbetweener: allowed_token_counts=tuple(range(min, max+1))
        config = self.Config(allowed_token_counts=tuple(counts)) if counts else self.Config()
        stream_ctx = wp.ScopedStream(eng.stream) if eng.stream is not None else _Null()
        with stream_ctx:
            for i in range(POSES_PER_TOKEN):  # four context poses, 30 Hz, ending at the start frame
                ctx_clip.sample(i / MODEL_SAMPLE_RATE, self.context_poses[i], stream=eng.stream)
            for i in range(n_target):
                tgt_clip.sample(i / MODEL_SAMPLE_RATE, self.target_poses[i], stream=eng.stream)
            self.context.update_from_poses(self.context_poses, stream=eng.stream)
            self.target.update_from_poses(self.target_poses[:n_target], stream=eng.stream)
            eng.generate_animation(self.context, self.target, self.output, config=config)
            eng.synchronize()
            frames = int(self.output.num_frames)
            poses = self.output.poses[:frames].numpy().copy()
            contacts = None
            if getattr(self.output, "foot_contacts", None) is not None:
                contacts = self.output.foot_contacts[:frames].numpy().copy()
        log("MotionBricks generated %d frames (%.2f s), tokens %s, poses_to_use=%d" % (
            frames, frames / MODEL_SAMPLE_RATE, counts or "default", n_target))
        return poses, contacts, {
            "frames": frames,
            "tokens": (frames + 2 * BOUNDARY) // POSES_PER_TOKEN,
            "allowed_token_counts": list(counts) if counts else list(DEFAULT_TOKEN_COUNTS),
        }

    def skeleton_arrays(self):
        self._setup(print)
        sk = self.skeleton
        return (list(sk.joint_names), [int(p) for p in sk.parent_indices.numpy()],
                sk.reference_local_transforms.numpy()[:, :3])


class _Null(object):
    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--context", required=True)
    ap.add_argument("--target", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--mock", action="store_true", help="numpy linear stand-in instead of the MotionBricks engine")
    ap.add_argument("--motionbricks-dir", default=os.getcwd())
    ap.add_argument("--precision", choices=("fp32", "fp16"), default="fp32")
    ap.add_argument("--device", default="cuda:0")
    ap.add_argument("--tokens", type=int, default=None, help="pin the token count (6-16); frames = 4*tokens-6")
    ap.add_argument("--variant", type=int, default=1)
    ap.add_argument("--soma-json", default=None, help="exported SOMA skeleton JSON (mock only)")
    a = ap.parse_args()
    if a.mock:
        from mbh.soma import Soma
        if not a.soma_json:
            raise SystemExit("--mock needs --soma-json (run tools/export_soma_skeleton.py first)")
        soma = Soma(a.soma_json)
        runner = MockRunner(soma)
        names, parents, ref = soma.names, soma.parents, soma.rest_pos
    else:
        runner = RealRunner(a.motionbricks_dir, a.precision, a.device)
        names, parents, ref = runner.skeleton_arrays()
    poses, _, info = runner.generate(a.context, a.target, tokens=(a.tokens,) if a.tokens else None, variant=a.variant)
    save_bvh(a.out, names, parents, ref, poses)
    print("wrote %s (%d frames)" % (a.out, info["frames"]))


if __name__ == "__main__":
    main()
