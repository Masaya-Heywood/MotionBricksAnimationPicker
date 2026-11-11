"""Exercises RealRunner against the REAL motionbricks buffer/BVH/skeleton classes (CPU) with a fake engine,
so the glue (BVH -> clip.sample -> PoseToken.update_from_poses -> AnimationBuffer -> numpy -> BVH) is checked
without TensorRT or a GPU.

    MOTIONBRICKS=<clone> python tests/test_real_glue.py <context.bvh> <target.bvh>
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
MB = os.environ.get("MOTIONBRICKS", "/workspace/motionbricks-research")
sys.path.insert(0, MB)

import numpy as np  # noqa: E402
import warp as wp  # noqa: E402

wp.config.quiet = True
from motionbricks.animation.animation_buffer import AnimationBuffer  # noqa: E402
from motionbricks.animation.foot_contacts import FOOT_CONTACT_COUNT  # noqa: E402
from motionbricks.model.contract import MODEL_MAX_VALID_FRAMES, MODEL_SAMPLE_RATE  # noqa: E402
from motionbricks.model.soma.buffers import PoseToken  # noqa: E402

import mb_generate  # noqa: E402


class FakeEngine(object):
    """Same surface as MotionBricksSOMAEngine; 'generates' by copying the last context pose to the target."""
    stream = None

    def __init__(self, runner):
        self.device = "cpu"
        self.configs = []

    def create_input(self, skeleton):
        return PoseToken(skeleton.num_joints, device=self.device)

    def create_output(self, skeleton):
        return AnimationBuffer(skeleton, MODEL_SAMPLE_RATE,
                               wp.empty((MODEL_MAX_VALID_FRAMES, skeleton.num_joints), dtype=wp.transform, device=self.device),
                               num_frames=0,
                               foot_contacts=wp.zeros((MODEL_MAX_VALID_FRAMES, FOOT_CONTACT_COUNT), dtype=wp.float32, device=self.device))

    def generate_animation(self, context, target, output, config=None):
        self.configs.append(config)
        n = max(config.allowed_token_counts) if config is not None and config.allowed_token_counts else 10
        frames = n * 4 - 6
        c = context.poses.numpy()[3]
        t = target.poses.numpy()[0]
        out = np.zeros((MODEL_MAX_VALID_FRAMES, c.shape[0], 7), dtype=np.float32)
        for f in range(frames):
            u = f / (frames - 1.0)
            out[f] = c * (1 - u) + t * u
            out[f, :, 3:] /= np.linalg.norm(out[f, :, 3:], axis=1, keepdims=True)
        output.poses.assign(out)
        output.num_frames = frames

    def synchronize(self):
        pass

    def close(self):
        pass


def main():
    ctx, tgt = sys.argv[1], sys.argv[2]
    r = mb_generate.RealRunner(MB, "fp32", "cpu", engine_factory=lambda runner: FakeEngine(runner))
    logs = []
    poses, contacts, info = r.generate(ctx, tgt, tokens=(10,), variant=1, log=logs.append)
    assert poses.shape == (34, 77, 7), poses.shape
    assert info["frames"] == 34 and info["tokens"] == 10, info
    names, parents, ref = r.skeleton_arrays()
    assert len(names) == 77 and len(parents) == 77 and np.asarray(ref).shape == (77, 3)
    out = os.path.join("/tmp", "glue_out.bvh")
    mb_generate.save_bvh(out, names, parents, ref, poses)
    from mbh.bvhio import read_bvh
    b = read_bvh(out)
    assert b["frames"] == 34
    # first output frame == last context pose (what the model sees as the continuation point)
    c = read_bvh(ctx)
    from mbh.rot import angle_between_mats
    soma_idx = [c["names"].index(n) for n in b["names"]]
    d = np.degrees(angle_between_mats(b["local_R"][0], c["local_R"][3][soma_idx]))
    print("first-frame vs last-context pose, max joint diff: %.4f deg" % d.max())
    assert d.max() < 0.05
    r.close()
    print("OK real-engine glue (fake engine, real buffers): %d frames, %d joints" % (poses.shape[0], poses.shape[1]))


if __name__ == "__main__":
    main()
