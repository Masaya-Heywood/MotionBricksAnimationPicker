"""Job pipeline: FBX pair -> (Blender) SOMA BVH -> (MotionBricks) generated BVH -> (Blender) FBX."""
import hashlib
import json
import os
import re
import subprocess
import sys
import threading
import time
import traceback
import uuid

HERE = os.path.dirname(os.path.abspath(__file__))
BLENDER_DIR = os.path.join(HERE, "blender")

NAME_RE = re.compile(r"[^A-Za-z0-9._-]+")


def safe_name(s, limit=120):
    s = NAME_RE.sub("_", str(s)).strip("._-")
    return (s or "pair")[:limit]


def clip_stem(rel):
    base = os.path.basename(str(rel).replace("\\", "/"))
    if base.lower().endswith(".fbx"):
        base = base[:-4]
    return base.split("@")[-1]


def default_pair_name(start, end):
    h = hashlib.sha1(("%s|%s|%s|%s" % (start["clip"], start["frame"], end["clip"], end["frame"])).encode()).hexdigest()[:6]
    return safe_name("%s_f%s__%s_f%s_%s" % (clip_stem(start["clip"]), start["frame"], clip_stem(end["clip"]), end["frame"], h))


def variant_suffix(v):
    return "" if v <= 1 else "_v%02d" % v


class JobCancelled(Exception):
    pass


class Job(object):
    def __init__(self, req):
        self.id = uuid.uuid4().hex[:12]
        self.req = req
        self.name = req["name"]
        self.state = "queued"
        self.step = "queued"
        self.progress = 0.0
        self.log = []
        self.results = []
        self.warnings = []
        self.error = None
        self.created = time.time()
        self.started = None
        self.finished = None
        self.cancel = False
        self.proc = None
        self.lock = threading.Lock()

    def add(self, line):
        with self.lock:
            self.log.append(line.rstrip("\n"))
            if len(self.log) > 2000:
                del self.log[:500]

    def snapshot(self, since=0):
        with self.lock:
            return {
                "id": self.id, "name": self.name, "state": self.state, "step": self.step,
                "progress": round(self.progress, 3), "error": self.error, "warnings": list(self.warnings),
                "results": list(self.results), "log": self.log[since:], "log_total": len(self.log),
                "created": self.created, "started": self.started, "finished": self.finished,
                "variants": self.req.get("variants", 1),
            }


class Pipeline(object):
    def __init__(self, cfg, runner, soma_json_provider):
        self.cfg = cfg
        self.runner = runner
        self.soma_json_provider = soma_json_provider

    # -- paths ----------------------------------------------------------------------------------
    def resolve_source(self, rel):
        root = os.path.realpath(self.cfg["_source_root"])
        rel = str(rel).replace("\\", "/").lstrip("/")
        cand = []
        if rel:
            cand.append(os.path.join(root, *rel.split("/")))
            parts = rel.split("/")
            for k in range(1, len(parts)):  # the page may or may not include the picked folder's name
                cand.append(os.path.join(root, *parts[k:]))
        for c in cand:
            rc = os.path.realpath(c)
            if os.path.normcase(rc).startswith(os.path.normcase(root) + os.sep) and os.path.isfile(rc):
                return rc
        # last resort: unique file with the same tail
        tail = os.path.basename(rel).lower()
        hits = []
        for dp, _, fns in os.walk(root):
            for fn in fns:
                if fn.lower() == tail:
                    hits.append(os.path.join(dp, fn))
        if len(hits) == 1:
            return os.path.realpath(hits[0])
        if len(hits) > 1:
            raise FileNotFoundError("%s matches %d files under %s; pick the folder that contains the pack, or use a unique path" % (rel, len(hits), root))
        raise FileNotFoundError("%s not found under %s" % (rel, root))

    def out_path(self, kind, name, ext):
        d = self.cfg["_dirs"][kind]
        os.makedirs(d, exist_ok=True)
        return os.path.join(d, name + ext)

    # -- blender --------------------------------------------------------------------------------
    def run_blender(self, job, script, spec, label):
        exe = self.cfg["blender_exe"]
        spec_path = os.path.join(self.cfg["_dirs"]["cache"], "specs", "%s_%s.json" % (job.name, label))
        os.makedirs(os.path.dirname(spec_path), exist_ok=True)
        result_path = os.path.join(self.cfg["_dirs"]["cache"], "specs", "%s_%s.result.json" % (job.name, label))
        if os.path.exists(result_path):
            os.remove(result_path)
        spec = dict(spec, result_json=result_path)
        with open(spec_path, "w", encoding="utf-8") as f:
            json.dump(spec, f, indent=1)
        cmd = [exe, "-b", "--factory-startup", "-noaudio", "--python", os.path.join(BLENDER_DIR, script), "--", spec_path]
        job.add("$ blender %s (%s)" % (script, label))
        kw = {}
        if os.name == "nt":
            kw["creationflags"] = 0x08000000  # CREATE_NO_WINDOW
        proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, universal_newlines=True,
                                encoding="utf-8", errors="replace", **kw)
        job.proc = proc
        log_dir = os.path.join(self.cfg["_dirs"]["cache"], "logs")
        os.makedirs(log_dir, exist_ok=True)
        deadline = time.time() + float(self.cfg.get("blender_timeout_seconds", 240))
        killer = threading.Timer(max(1.0, deadline - time.time()), lambda: proc.kill())
        killer.start()
        try:
            with open(os.path.join(log_dir, "%s_%s.blender.log" % (job.name, label)), "w", encoding="utf-8") as lf:
                for line in proc.stdout:
                    lf.write(line)
                    s = line.rstrip()
                    if s.startswith("[helper]") or "Error" in s or "Traceback" in s or s.startswith("  File"):
                        job.add(s)
            code = proc.wait()
        finally:
            killer.cancel()
            job.proc = None
        if job.cancel:
            raise JobCancelled()
        res = {}
        if os.path.exists(result_path):
            with open(result_path, "r", encoding="utf-8") as f:
                res = json.load(f)
        if code != 0 or not res.get("ok"):
            raise RuntimeError("Blender %s step failed: %s" % (label, res.get("error") or "exit code %s (see helper_cache/logs)" % code))
        return res

    # -- one job --------------------------------------------------------------------------------
    def run(self, job):
        job.state = "running"
        job.started = time.time()
        req = job.req
        try:
            self._run(job, req)
            job.state = "done"
            job.step = "done"
            job.progress = 1.0
        except JobCancelled:
            job.state = "cancelled"
            job.add("cancelled")
        except Exception as err:  # noqa: BLE001
            job.state = "error"
            job.error = str(err)
            job.add("ERROR: " + str(err))
            job.add(traceback.format_exc())
        finally:
            job.finished = time.time()

    def _check(self, job):
        if job.cancel:
            raise JobCancelled()

    def _run(self, job, req):
        cfg = self.cfg
        name = job.name
        n_var = max(1, min(32, int(req.get("variants", 1))))
        opts = req.get("options", {})
        total = 1 + 2 * n_var
        done = 0

        def bump(step):
            job.step = step
            job.progress = done / float(total)

        soma_json = self.soma_json_provider()
        bonemaps = os.path.join(HERE, "bonemaps.json")
        s_fbx = self.resolve_source(req["start"]["clip"])
        e_fbx = self.resolve_source(req["end"]["clip"])
        job.add("start: %s @ frame %s" % (s_fbx, req["start"]["frame"]))
        job.add("end:   %s @ frame %s" % (e_fbx, req["end"]["frame"]))

        bump("convert")
        meta = self.run_blender(job, "to_soma.py", {
            "soma_json": soma_json, "bonemaps": bonemaps, "name": name, "out_dir": cfg["_dirs"]["soma_bvh"],
            "start": {"fbx": s_fbx, "frame": int(req["start"]["frame"]), "rig": opts.get("rig_start")},
            "end": {"fbx": e_fbx, "frame": int(req["end"]["frame"]), "rig": opts.get("rig_end")},
            "poses_to_use": int(opts.get("poses_to_use", 4)),
            "target_offset": opts.get("target_offset") or {},
        }, "convert")
        with open(os.path.join(cfg["_dirs"]["soma_bvh"], name + "__meta.json"), "w", encoding="utf-8") as f:
            json.dump(meta, f, indent=1)
        job.warnings.extend(meta.get("warnings", []))
        for w in meta.get("warnings", []):
            job.add("warning: " + w)
        done += 1

        out_rig = opts.get("output_rig", "start")
        rig_fbx = e_fbx if out_rig == "end" else s_fbx
        rig_id = opts.get("rig_end") if out_rig == "end" else opts.get("rig_start")
        for v in range(1, n_var + 1):
            self._check(job)
            suffix = variant_suffix(v)
            bump("generate v%d/%d" % (v, n_var) if n_var > 1 else "generate")
            tokens = opts.get("tokens")
            poses, contacts, info = self.runner.generate(
                meta["context_bvh"], meta["target_bvh"], tokens=(int(tokens),) if tokens else None, variant=v,
                log=job.add)
            from mb_generate import save_bvh
            names, parents, ref = self.runner_skeleton()
            gen_bvh = self.out_path("generated", name + suffix, ".bvh")
            save_bvh(gen_bvh, names, parents, ref, poses)
            job.add("saved %s (%d frames)" % (gen_bvh, info["frames"]))
            done += 1
            self._check(job)
            bump("retarget v%d/%d" % (v, n_var) if n_var > 1 else "retarget")
            out_fbx = self.out_path("export_fbx", name + suffix, ".fbx")
            res = self.run_blender(job, "from_soma.py", {
                "soma_json": soma_json, "bonemaps": bonemaps, "name": name + suffix,
                "rig": {"fbx": rig_fbx, "rig": rig_id}, "bvh": gen_bvh, "out_fbx": out_fbx,
                "finger_start": meta.get("finger_start") if out_rig != "end" else meta.get("finger_end"),
                "finger_end": meta.get("finger_end") if out_rig != "end" else meta.get("finger_start"),
                "include_mesh": bool(opts.get("include_mesh")), "fps": 30,
            }, "retarget%s" % suffix)
            done += 1
            job.progress = done / float(total)
            with job.lock:
                job.results.append({
                    "variant": v, "frames": info["frames"], "seconds": round(info["frames"] / 30.0, 3),
                    "tokens": info.get("tokens"), "bvh": gen_bvh, "fbx": out_fbx,
                    "bvh_url": "/result/%s%s.bvh" % (job.id, suffix), "fbx_url": "/result/%s%s.fbx" % (job.id, suffix),
                    "check_max_deg": res.get("check_max_deg"), "engine": self.runner.name,
                })
        with open(self.out_path("generated", name, ".job.json"), "w", encoding="utf-8") as f:
            json.dump({"name": name, "request": req, "results": job.results, "warnings": job.warnings,
                       "engine": self.runner.name, "finished": time.time()}, f, indent=1)

    def runner_skeleton(self):
        if hasattr(self.runner, "skeleton_arrays"):
            return self.runner.skeleton_arrays()
        soma = self.runner.soma
        return soma.names, soma.parents, soma.rest_pos
