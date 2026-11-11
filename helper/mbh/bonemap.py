"""Resolve which bone map applies to a source armature."""
import json
import re

from .soma import MODEL_JOINTS

_PREFIX = re.compile(r"^(mixamorig\d*[:_]?|bip0?1[ _]?|humanoid_+\s*|b[-_](?=[a-z]))", re.I)


def normalize(name):
    n = _PREFIX.sub("", name.strip())
    return re.sub(r"[^a-z0-9]", "", n.lower())


def load_maps(path):
    return json.load(open(path, "r", encoding="utf-8"))


class Resolved(object):
    def __init__(self, rig_id, label, mapping, passthrough, notes, missing_core, source_names):
        self.rig_id = rig_id
        self.label = label
        self.mapping = mapping  # SOMA joint -> source bone name
        self.passthrough = passthrough  # source bone names carried between start/end pose
        self.notes = notes
        self.missing_core = missing_core
        self.source_names = source_names

    def unmapped_model_joints(self):
        return [j for j in MODEL_JOINTS if j not in self.mapping]

    def unmapped_source_bones(self):
        used = set(self.mapping.values()) | set(self.passthrough)
        return [b for b in self.source_names if b not in used]

    def summary(self):
        return {
            "rig": self.rig_id,
            "label": self.label,
            "mapped": len(self.mapping),
            "unmapped_model_joints": self.unmapped_model_joints(),
            "passthrough_bones": len(self.passthrough),
            "unmapped_source_bones": self.unmapped_source_bones(),
            "missing_core": self.missing_core,
        }


def _resolve_exact(entry_map, names, by_norm):
    out = {}
    for soma_j, bone in entry_map.items():
        if bone in names:
            out[soma_j] = bone
        else:
            hit = by_norm.get(normalize(bone))
            if hit:
                out[soma_j] = hit
    return out


def _resolve_generic(cands, names, by_norm):
    out = {}
    used = set()
    for soma_j, options in cands.items():
        for o in options:
            hit = by_norm.get(o)
            if hit and hit not in used:
                out[soma_j] = hit
                used.add(hit)
                break
    return out


def resolve(maps, bone_names, hint="", requested=None):
    """Pick a rig entry. requested = rig id to force. hint = clip path (used only to break ties)."""
    names = list(bone_names)
    nameset = set(names)
    by_norm = {}
    for n in names:
        k = normalize(n)
        if k and k not in by_norm:
            by_norm[k] = n
    core = maps.get("required_core", [])
    best = None
    for entry in maps["rigs"]:
        if requested and entry["id"] != requested:
            continue
        if "map" in entry:
            mapping = _resolve_exact(entry["map"], nameset, by_norm)
            total = len(entry["map"])
        else:
            mapping = _resolve_generic(entry["normalized_candidates"], nameset, by_norm)
            total = len(entry["normalized_candidates"])
        missing = [j for j in core if j not in mapping]
        coverage = len(mapping) / float(total)
        pat = entry.get("pack_pattern")
        hinted = 1 if (pat and hint and re.search(pat, hint, re.I)) else 0
        score = (0 if missing else 1, coverage >= 0.85, hinted, coverage)
        if best is None or score > best[0]:
            best = (score, entry, mapping, missing)
        if requested:
            break
    if best is None:
        raise ValueError("Unknown rig id %r" % requested)
    _, entry, mapping, missing = best
    rx = re.compile(entry.get("passthrough_regex") or "(?!x)x")
    used = set(mapping.values())
    passthrough = [n for n in names if n not in used and rx.search(n)]
    return Resolved(entry["id"], entry["label"], mapping, passthrough, entry.get("notes", ""), missing, names)
