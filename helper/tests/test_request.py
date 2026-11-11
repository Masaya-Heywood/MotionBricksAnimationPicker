"""Unit tests for /generate request schema and chaining helpers (no Blender, no GPU)."""
import os
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
HELPER = os.path.dirname(HERE)
sys.path.insert(0, HELPER)

from request_schema import (  # noqa: E402
    default_target_from_end,
    normalize_request,
    played_frame_count,
    raw_frames_for_tokens,
)
from mb_generate import concat_segment_poses, variant_tokens, valid_frames  # noqa: E402


def check(cond, msg):
    if not cond:
        raise AssertionError(msg)
    print("ok  " + msg)


def test_raw_frames_readout():
    # Inbetweener screenshot: tokens 8-14 => raw frames 32-56
    a, b = raw_frames_for_tokens(8, 14)
    check((a, b) == (32, 56), "raw frames 8-14 -> 32-56")
    check(valid_frames(8) == 26 and valid_frames(14) == 50, "engine valid frames still 4*tokens-6")


def test_played_frame_count():
    check(played_frame_count(50, 0) == 50, "early 0 keeps all frames")
    check(played_frame_count(50, 10) == 40, "early 10 trims end")
    check(played_frame_count(50, 100) == 4, "early never leaves fewer than 4 frames")


def test_variant_tokens_range():
    check(variant_tokens(1, tokens_min=8, tokens_max=14) == tuple(range(8, 15)), "v1 uses full min-max range")
    check(variant_tokens(2, tokens_min=8, tokens_max=14) == (10,), "v2 pins within range")
    check(variant_tokens(1, explicit=12) == (12,), "legacy single tokens pin")
    check(variant_tokens(1, tokens_min=10, tokens_max=10) == (10,), "equal min/max fixes length")


def test_normalize_legacy_single_target():
    body = {
        "id": "p1",
        "start": {"clip": "A/Walk.fbx", "frame": 12},
        "end": {"clip": "B/Run.fbx", "frame": 20},
        "variants": 2,
        "options": {"target_offset": {"forward": 1.5, "right": 0.1, "turn_deg": 15}, "poses_to_use": 3},
    }
    req = normalize_request(body, defaults={"poses_to_use": 4, "tokens_min": 8, "tokens_max": 14},
                            name_fn=lambda n, s, e: n or "pair")
    check(len(req["targets"]) == 1, "legacy body becomes one target")
    check(req["end"]["clip"] == "B/Run.fbx" and req["end"]["frame"] == 20, "end mirrors last target")
    t = req["targets"][0]
    check(t["target_offset"]["forward"] == 1.5 and t["poses_to_use"] == 3, "offset and poses from options")
    check(t["tokens_min"] == 8 and t["tokens_max"] == 14, "default token range 8-14")
    check(t["transition_early"] == 0, "default transition_early 0")


def test_normalize_multi_target():
    body = {
        "start": {"clip": "A/Idle.fbx", "frame": 0},
        "targets": [
            {"clip": "A/Walk.fbx", "frame": 30, "seconds": 1.0, "auto_distance": True,
             "speed_mps": 1.5, "target_offset": {"forward": 1.5, "right": 0, "turn_deg": 0},
             "tokens_min": 8, "tokens_max": 14, "poses_to_use": 4, "transition_early": 2},
            {"clip": "A/Stop.fbx", "frame": 5, "seconds": 0.8, "tokens_min": 6, "tokens_max": 10,
             "poses_to_use": 2, "transition_early": 0, "target_offset": {"forward": 0.5, "right": 0, "turn_deg": -10}},
        ],
        "variants": 1,
    }
    req = normalize_request(body, defaults={}, name_fn=lambda n, s, e: "multi")
    check(len(req["targets"]) == 2, "two targets accepted")
    check(req["targets"][0]["transition_early"] == 2 and req["targets"][1]["poses_to_use"] == 2, "per-target fields")
    check(req["end"]["clip"].endswith("Stop.fbx"), "end is last target")
    check(req["options"]["tokens_min"] == 8, "pair options mirror first target")


def test_normalize_rejects_bad_tokens():
    body = {
        "start": {"clip": "A/a.fbx", "frame": 0},
        "end": {"clip": "A/b.fbx", "frame": 1},
        "options": {"tokens_min": 3, "tokens_max": 14},
    }
    try:
        normalize_request(body, defaults={})
        check(False, "tokens_min 3 should raise")
    except ValueError as e:
        check("tokens" in str(e).lower(), "bad tokens raise ValueError (%s)" % e)


def test_concat_segments():
    # Two short segments; early=0; second drops frame 0
    a = np.arange(10 * 2 * 7, dtype=np.float64).reshape(10, 2, 7)
    b = np.arange(100, 100 + 8 * 2 * 7, dtype=np.float64).reshape(8, 2, 7)
    out = concat_segment_poses([(a, 0), (b, 0)])
    check(out.shape[0] == 10 + 7, "concat drops junction frame of later segments")
    check(np.allclose(out[0], a[0]) and np.allclose(out[10], b[1]), "frames ordered start then target2[1:]")
    # With transition_early on first
    out2 = concat_segment_poses([(a, 3), (b, 0)])
    check(out2.shape[0] == played_frame_count(10, 3) + 7, "early shortens first segment before concat")


def test_default_target_helpers():
    t = default_target_from_end({"clip": "x.fbx", "frame": 4}, {"tokens": 11})
    check(t["tokens_min"] == 11 and t["tokens_max"] == 11, "legacy options.tokens pins min=max")


if __name__ == "__main__":
    test_raw_frames_readout()
    test_played_frame_count()
    test_variant_tokens_range()
    test_normalize_legacy_single_target()
    test_normalize_multi_target()
    test_normalize_rejects_bad_tokens()
    test_concat_segments()
    test_default_target_helpers()
    print("ALL OK")
