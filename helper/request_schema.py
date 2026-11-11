"""Normalize and validate /generate request bodies (single- and multi-target).

Backward compatible: a body with only start/end (+ options) becomes one target.
"""
from __future__ import annotations

POSES_PER_TOKEN = 4
DEFAULT_TOKENS_MIN = 8
DEFAULT_TOKENS_MAX = 14
TOKEN_LO = 6
TOKEN_HI = 16


def raw_frames_for_tokens(tmin, tmax):
    """Inbetweener readout: each token is 4 raw frames (before boundary trim)."""
    return int(tmin) * POSES_PER_TOKEN, int(tmax) * POSES_PER_TOKEN


def played_frame_count(num_frames, transition_early):
    """Frames kept from a generated segment (MotionBricks Inbetweener semantics)."""
    early = max(0, int(transition_early or 0))
    end = max(POSES_PER_TOKEN - 1, int(num_frames) - 1 - early)
    return end + 1


def default_target_from_end(end, options=None, defaults=None):
    defaults = defaults or {}
    options = options or {}
    to_def = dict(defaults.get("target_offset") or {})
    to_def.update(options.get("target_offset") or {})
    tmin = options.get("tokens_min", defaults.get("tokens_min", DEFAULT_TOKENS_MIN))
    tmax = options.get("tokens_max", defaults.get("tokens_max", DEFAULT_TOKENS_MAX))
    # Legacy single tokens pin → min=max
    if options.get("tokens") not in (None, "") and options.get("tokens_min") is None and options.get("tokens_max") is None:
        t = int(options["tokens"])
        tmin = tmax = t
    elif defaults.get("tokens") not in (None, "") and options.get("tokens_min") is None and options.get("tokens_max") is None and "tokens" not in options:
        # keep null default (engine range) unless explicitly pinned in defaults
        pass
    return {
        "clip": end["clip"],
        "frame": int(end["frame"]),
        "seconds": float(options.get("seconds", defaults.get("seconds", 1.0))),
        "speed_mps": options.get("speed_mps", None),
        "auto_distance": bool(options.get("auto_distance", defaults.get("auto_distance", False))),
        "target_offset": {
            "forward": float(to_def.get("forward", 0.0)),
            "right": float(to_def.get("right", 0.0)),
            "turn_deg": float(to_def.get("turn_deg", 0.0)),
        },
        "poses_to_use": int(options.get("poses_to_use", defaults.get("poses_to_use", 4))),
        "transition_early": int(options.get("transition_early", defaults.get("transition_early", 0))),
        "tokens_min": int(tmin) if tmin not in (None, "") else DEFAULT_TOKENS_MIN,
        "tokens_max": int(tmax) if tmax not in (None, "") else DEFAULT_TOKENS_MAX,
    }


def _validate_pose(p, label):
    if not isinstance(p, dict) or not isinstance(p.get("clip"), str) or not p["clip"].lower().endswith(".fbx"):
        raise ValueError("%s needs {clip: 'relative/path.fbx', frame: n}" % label)
    try:
        p["frame"] = int(p.get("frame", 0))
    except (TypeError, ValueError):
        raise ValueError("%s.frame must be an integer" % label)
    if p["frame"] < 0 or p["frame"] > 100000:
        raise ValueError("%s.frame out of range" % label)
    if ".." in p["clip"].replace("\\", "/").split("/"):
        raise ValueError("%s.clip must not contain '..'" % label)
    return p


def normalize_target(raw, defaults, index=0):
    if not isinstance(raw, dict):
        raise ValueError("targets[%d] must be an object" % index)
    clip = _validate_pose({"clip": raw.get("clip"), "frame": raw.get("frame", 0)}, "targets[%d]" % index)
    base = default_target_from_end(clip, raw, defaults)
    # Prefer explicit fields on the target over options-style defaults
    for key in ("seconds", "speed_mps", "auto_distance", "poses_to_use", "transition_early", "tokens_min", "tokens_max"):
        if key in raw and raw[key] is not None:
            base[key] = raw[key]
    if "target_offset" in raw and isinstance(raw["target_offset"], dict):
        to = dict(base["target_offset"])
        to.update(raw["target_offset"])
        base["target_offset"] = {k: float(to.get(k, 0.0)) for k in ("forward", "right", "turn_deg")}
    base["clip"] = clip["clip"]
    base["frame"] = clip["frame"]
    base["seconds"] = float(base.get("seconds", 1.0))
    if base.get("speed_mps") not in (None, ""):
        base["speed_mps"] = float(base["speed_mps"])
    else:
        base["speed_mps"] = None
    base["auto_distance"] = bool(base.get("auto_distance", False))
    base["poses_to_use"] = max(1, min(4, int(base.get("poses_to_use", 4))))
    base["transition_early"] = max(0, min(200, int(base.get("transition_early", 0))))
    tmin = int(base.get("tokens_min", DEFAULT_TOKENS_MIN))
    tmax = int(base.get("tokens_max", DEFAULT_TOKENS_MAX))
    if not (TOKEN_LO <= tmin <= TOKEN_HI and TOKEN_LO <= tmax <= TOKEN_HI):
        raise ValueError("tokens_min/max must be %d..%d" % (TOKEN_LO, TOKEN_HI))
    if tmin > tmax:
        raise ValueError("tokens_min must be <= tokens_max")
    base["tokens_min"] = tmin
    base["tokens_max"] = tmax
    # Optional legacy pin
    if raw.get("tokens") not in (None, ""):
        t = int(raw["tokens"])
        if not (TOKEN_LO <= t <= TOKEN_HI):
            raise ValueError("tokens must be %d..%d" % (TOKEN_LO, TOKEN_HI))
        base["tokens_min"] = base["tokens_max"] = t
    return base


def normalize_request(body, defaults=None, name_fn=None):
    """Validate a /generate body. Returns a normalized request dict."""
    defaults = defaults or {}
    if not isinstance(body, dict):
        raise ValueError("Body must be a JSON object")
    start = _validate_pose(dict(body.get("start") or {}), "start")

    targets_in = body.get("targets")
    if targets_in is None:
        end = _validate_pose(dict(body.get("end") or {}), "end")
        targets = [normalize_target(default_target_from_end(end, body.get("options") or {}, defaults), defaults, 0)]
    else:
        if not isinstance(targets_in, list) or not targets_in:
            raise ValueError("targets must be a non-empty list")
        if len(targets_in) > 16:
            raise ValueError("at most 16 targets per pair")
        targets = [normalize_target(t, defaults, i) for i, t in enumerate(targets_in)]

    end = {"clip": targets[-1]["clip"], "frame": targets[-1]["frame"]}
    # Pair-level options: merge defaults with body.options, then first target's fields for single-target callers
    opts = dict(defaults)
    opts.update(body.get("options") or {})
    t0 = targets[0]
    opts["target_offset"] = dict(t0["target_offset"])
    opts["poses_to_use"] = t0["poses_to_use"]
    opts["transition_early"] = t0["transition_early"]
    opts["tokens_min"] = t0["tokens_min"]
    opts["tokens_max"] = t0["tokens_max"]
    opts["seconds"] = t0["seconds"]
    opts["auto_distance"] = t0["auto_distance"]
    opts["speed_mps"] = t0.get("speed_mps")
    # Legacy single tokens: if min==max expose as tokens, else null
    if t0["tokens_min"] == t0["tokens_max"]:
        opts["tokens"] = t0["tokens_min"]
    else:
        opts["tokens"] = None
    if "include_mesh" in (body.get("options") or {}):
        opts["include_mesh"] = bool((body.get("options") or {}).get("include_mesh"))
    else:
        opts["include_mesh"] = bool(defaults.get("include_mesh", False))
    for k in ("rig_start", "rig_end", "output_rig"):
        if (body.get("options") or {}).get(k) is not None:
            opts[k] = (body.get("options") or {}).get(k)

    variants = max(1, min(32, int(body.get("variants", defaults.get("variants", 1)))))
    if name_fn:
        name = name_fn(body.get("name"), start, end)
    else:
        name = body.get("name") or "pair"
    return {
        "name": name,
        "start": start,
        "end": end,
        "targets": targets,
        "variants": variants,
        "options": opts,
        "pair_id": str(body.get("id", ""))[:80],
    }
