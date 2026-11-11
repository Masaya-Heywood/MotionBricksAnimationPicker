"""AnimLab MotionBricks helper: a tiny local HTTP server the clip browser talks to.

    uv run python server.py                  # from the motionbricks folder, real engine (NVIDIA GPU)
    python server.py --mock --soma-json ...  # no GPU: linear stand-in for the engine (testing)

Binds 127.0.0.1 only. CORS is limited to the origins in config.json (GitHub Pages + localhost), POSTs from
other origins are refused. Chrome Private Network Access / Local Network Access preflight headers are answered.
"""
import argparse
import json
import os
import platform
import queue
import re
import shutil
import subprocess
import sys
import threading
import time
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

from mbh import __version__  # noqa: E402
from pipeline import Job, Pipeline, default_pair_name, safe_name, variant_suffix  # noqa: E402

LOCALHOST_RE = re.compile(r"^https?://(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$")


# -- config -------------------------------------------------------------------------------------
def load_config(path, overrides):
    with open(path, "r", encoding="utf-8") as f:
        cfg = json.load(f)
    cfg.update({k: v for k, v in overrides.items() if v is not None})
    root = cfg["animationlab_root"]
    d = {}
    for key, cfgkey in (("source", "source_fbx_dir"), ("soma_bvh", "soma_bvh_dir"), ("generated", "generated_dir"),
                        ("export_fbx", "export_fbx_dir"), ("cache", "cache_dir")):
        p = cfg[cfgkey]
        d[key] = p if os.path.isabs(p) else os.path.join(root, p)
    cfg["_dirs"] = d
    cfg["_source_root"] = d["source"]
    return cfg


# -- diagnostics --------------------------------------------------------------------------------
_blender_cache = {}


def blender_version(exe):
    if exe in _blender_cache:
        return _blender_cache[exe]
    info = {"exists": os.path.isfile(exe), "version": None}
    if info["exists"]:
        try:
            out = subprocess.run([exe, "--version"], capture_output=True, text=True, timeout=40,
                                 creationflags=0x08000000 if os.name == "nt" else 0).stdout
            m = re.search(r"Blender\s+([0-9][0-9.]*)", out)
            info["version"] = m.group(1) if m else (out.strip().splitlines() or ["?"])[0]
        except Exception as err:  # noqa: BLE001
            info["error"] = str(err)
    _blender_cache[exe] = info
    return info


_gpu_cache = {"t": 0.0, "v": None}


def gpu_info():
    if _gpu_cache["v"] is not None and time.time() - _gpu_cache["t"] < 60:
        return _gpu_cache["v"]
    v = _gpu_info()
    _gpu_cache.update(t=time.time(), v=v)
    return v


def _gpu_info():
    exe = shutil.which("nvidia-smi")
    if not exe:
        return {"found": False, "reason": "nvidia-smi not found"}
    try:
        out = subprocess.run([exe, "--query-gpu=name,driver_version,memory.total", "--format=csv,noheader"],
                             capture_output=True, text=True, timeout=10,
                             creationflags=0x08000000 if os.name == "nt" else 0).stdout.strip()
        if out:
            return {"found": True, "name": out.splitlines()[0]}
    except Exception as err:  # noqa: BLE001
        return {"found": False, "reason": str(err)}
    return {"found": False, "reason": "nvidia-smi returned nothing"}


def motionbricks_info(cfg):
    import importlib.util
    d = cfg.get("motionbricks_dir")
    info = {"dir": d, "dir_exists": bool(d and os.path.isdir(d)), "importable": False, "version": None}
    try:
        info["importable"] = importlib.util.find_spec("motionbricks") is not None
    except Exception:  # noqa: BLE001
        pass
    vf = os.path.join(d or "", "motionbricks", "_version.py")
    if os.path.isfile(vf):
        m = re.search(r"__version__\s*=\s*['\"]([^'\"]+)", open(vf, encoding="utf-8").read())
        info["version"] = m.group(1) if m else None
    onnx = os.path.join(d or "", "motionbricks", "assets", "onnx", "soma", "mmm_v6_soma_fp32.onnx")
    info["onnx_present"] = os.path.isfile(onnx)
    if info["onnx_present"]:
        with open(onnx, "rb") as fh:
            info["onnx_is_lfs_pointer"] = fh.read(24).startswith(b"version https://git-lfs")
    for mod in ("warp", "tensorrt"):
        try:
            info[mod] = importlib.util.find_spec(mod) is not None
        except Exception:  # noqa: BLE001
            info[mod] = False
    return info


class App(object):
    def __init__(self, cfg, mock):
        self.cfg = cfg
        self.mock = mock
        self.jobs = {}
        self.order = []
        self.q = queue.Queue()
        self.runner = None
        self.runner_error = None
        self.soma_json_override = None
        self.soma = None
        self.started = time.time()
        self.pipeline = None
        self._soma_lock = threading.Lock()

    # SOMA skeleton JSON (exported once from MotionBricks' own USD)
    def soma_json(self):
        with self._soma_lock:
            if self.soma_json_override:
                return self.soma_json_override
            out = os.path.join(self.cfg["_dirs"]["cache"], "soma_skeleton.json")
            if os.path.isfile(out):
                return out
            usd = os.path.join(self.cfg["motionbricks_dir"], "motionbricks", "assets", "human",
                               "soma_base_skel_minimal_no_root.usd")
            if not os.path.isfile(usd):
                raise RuntimeError("SOMA skeleton file not found: %s (is motionbricks_dir right?)" % usd)
            os.makedirs(os.path.dirname(out), exist_ok=True)
            sys.path.insert(0, os.path.join(HERE, "tools"))
            try:
                import export_soma_skeleton
            except ImportError as err:
                raise RuntimeError("Need the usd-core package (it is part of the MotionBricks uv environment) to read "
                                   "the SOMA skeleton: %s. Start the helper with Start-Helper.bat." % err)
            export_soma_skeleton.export(usd, out)
            return out

    def ensure_runner(self):
        """Create the engine runner lazily (on the worker thread, which owns the GPU context)."""
        if self.runner is not None:
            return self.runner
        if self.mock:
            from mb_generate import MockRunner
            from mbh.soma import Soma
            self.soma = Soma(self.soma_json())
            self.runner = MockRunner(self.soma)
        else:
            from mb_generate import RealRunner
            self.runner = RealRunner(self.cfg["motionbricks_dir"], self.cfg.get("precision", "fp32"),
                                     self.cfg.get("device", "cuda:0"))
        self.pipeline = Pipeline(self.cfg, self.runner, self.soma_json)
        return self.runner

    def readiness(self):
        problems = []
        cfg = self.cfg
        b = blender_version(cfg["blender_exe"])
        if not b["exists"]:
            problems.append("Blender not found at %s (edit blender_exe in helper/config.json)" % cfg["blender_exe"])
        if not os.path.isdir(cfg["_dirs"]["source"]):
            problems.append("Source folder not found: %s" % cfg["_dirs"]["source"])
        if not self.mock:
            mb = motionbricks_info(cfg)
            if not mb["importable"] and not os.path.isdir(os.path.join(cfg.get("motionbricks_dir") or "", "motionbricks")):
                problems.append("The motionbricks package was not found. Check motionbricks_dir in helper/config.json (now %s)." % cfg.get("motionbricks_dir"))
            if not (mb.get("warp") and mb.get("tensorrt")):
                problems.append("This Python has no %s. Start the helper with Start-Helper.bat so it runs inside the "
                                "MotionBricks uv environment (cd %s && uv run python <path to>\\server.py)." % (
                                    " or ".join(m for m in ("warp", "tensorrt") if not mb.get(m)), cfg.get("motionbricks_dir")))
            if not mb.get("onnx_present") or mb.get("onnx_is_lfs_pointer"):
                problems.append("MotionBricks model files are missing: run `git lfs pull` in %s" % cfg["motionbricks_dir"])
            if not gpu_info()["found"]:
                problems.append("No NVIDIA GPU found (nvidia-smi). MotionBricks needs one.")
        return problems

    def health(self):
        cfg = self.cfg
        problems = self.readiness()
        d = cfg["_dirs"]
        return {
            "ok": True,
            "ready": not problems,
            "problems": problems,
            "helper_version": __version__,
            "mock": self.mock,
            "engine": self.runner.info() if self.runner else ({"engine": "mock"} if self.mock else {"engine": "motionbricks", "warm": False}),
            "python": sys.version.split()[0],
            "platform": platform.platform(),
            "gpu": {"found": True, "name": "n/a (mock engine)"} if self.mock else gpu_info(),
            "motionbricks": None if self.mock else motionbricks_info(cfg),
            "blender": dict(blender_version(cfg["blender_exe"]), path=cfg["blender_exe"]),
            "paths": {k: {"path": v, "exists": os.path.isdir(v)} for k, v in d.items()},
            "defaults": cfg.get("defaults", {}),
            "queue": sum(1 for j in self.jobs.values() if j.state in ("queued", "running")),
            "uptime_s": round(time.time() - self.started, 1),
        }

    # jobs
    def submit(self, req):
        job = Job(req)
        self.jobs[job.id] = job
        self.order.append(job.id)
        self.q.put(job)
        return job

    def worker(self):
        while True:
            job = self.q.get()
            try:
                if job.cancel:
                    job.state = "cancelled"
                    continue
                try:
                    self.ensure_runner()
                except Exception as err:  # noqa: BLE001
                    job.state = "error"
                    job.error = "Could not start the engine: %s" % err
                    job.add("ERROR: " + job.error)
                    job.finished = time.time()
                    continue
                self.pipeline.run(job)
            finally:
                self.q.task_done()

    def find_result_file(self, rid, ext):
        """rid = <jobid>[_vNN] or <pair name>[_vNN]. Returns a path or None."""
        m = re.match(r"^(.*?)(_v\d\d)?$", rid)
        base, suffix = m.group(1), m.group(2) or ""
        job = self.jobs.get(base)
        if job:
            name = job.name
        else:
            name = safe_name(base)
            if name != base:
                return None
        kind = "export_fbx" if ext == ".fbx" else "generated"
        p = os.path.join(self.cfg["_dirs"][kind], name + suffix + ext)
        return p if os.path.isfile(p) else None

    def existing(self, names):
        out = {}
        for n in names:
            n = safe_name(n)
            variants = []
            for v in range(1, 33):
                if os.path.isfile(os.path.join(self.cfg["_dirs"]["export_fbx"], n + variant_suffix(v) + ".fbx")):
                    variants.append(v)
                elif v > 1:
                    break
            if variants:
                engine = None
                try:
                    with open(os.path.join(self.cfg["_dirs"]["generated"], n + ".job.json"), "r", encoding="utf-8") as fh:
                        engine = json.load(fh).get("engine")
                except (OSError, ValueError):
                    pass
                out[n] = {"variants": variants, "engine": engine, "fbx_url": "/result/%s.fbx" % n,
                          "bvh_url": "/result/%s.bvh" % n}
        return out


def validate_request(app, body):
    if not isinstance(body, dict):
        raise ValueError("Body must be a JSON object")
    for k in ("start", "end"):
        p = body.get(k)
        if not isinstance(p, dict) or not isinstance(p.get("clip"), str) or not p["clip"].lower().endswith(".fbx"):
            raise ValueError("%s needs {clip: 'relative/path.fbx', frame: n}" % k)
        try:
            p["frame"] = int(p.get("frame", 0))
        except (TypeError, ValueError):
            raise ValueError("%s.frame must be an integer" % k)
        if p["frame"] < 0 or p["frame"] > 100000:
            raise ValueError("%s.frame out of range" % k)
        if ".." in p["clip"].replace("\\", "/").split("/"):
            raise ValueError("%s.clip must not contain '..'" % k)
    defaults = app.cfg.get("defaults", {})
    opts = dict(defaults)
    opts.update(body.get("options") or {})
    to = dict(defaults.get("target_offset") or {})
    to.update((body.get("options") or {}).get("target_offset") or {})
    opts["target_offset"] = {k: float(to.get(k, 0.0)) for k in ("forward", "right", "turn_deg")}
    opts["poses_to_use"] = max(1, min(4, int(opts.get("poses_to_use", 4))))
    if opts.get("tokens") not in (None, ""):
        t = int(opts["tokens"])
        if not 6 <= t <= 16:
            raise ValueError("options.tokens must be 6..16")
        opts["tokens"] = t
    else:
        opts["tokens"] = None
    variants = max(1, min(32, int(body.get("variants", defaults.get("variants", 1)))))
    name = safe_name(body.get("name") or default_pair_name(body["start"], body["end"]))
    return {"name": name, "start": body["start"], "end": body["end"], "variants": variants, "options": opts,
            "pair_id": str(body.get("id", ""))[:80]}


# -- HTTP ---------------------------------------------------------------------------------------
def make_handler(app):
    cfg = app.cfg
    allowed = set(cfg.get("allowed_origins", []))
    allow_local = bool(cfg.get("allow_localhost_origins", True))
    port = cfg["port"]

    class H(BaseHTTPRequestHandler):
        server_version = "AnimLabHelper/" + __version__
        protocol_version = "HTTP/1.1"

        def log_message(self, fmt, *a):
            sys.stderr.write("[%s] %s\n" % (time.strftime("%H:%M:%S"), fmt % a))

        # --- origin / host checks
        def origin_ok(self):
            o = self.headers.get("Origin")
            if not o:
                return None  # curl, same-machine tools
            if o in allowed or (allow_local and LOCALHOST_RE.match(o)):
                return o
            return False

        def host_ok(self):
            h = (self.headers.get("Host") or "").lower()
            return h in ("127.0.0.1:%d" % port, "localhost:%d" % port, "[::1]:%d" % port)

        def cors(self):
            o = self.origin_ok()
            if o:
                self.send_header("Access-Control-Allow-Origin", o)
                self.send_header("Vary", "Origin")
                self.send_header("Access-Control-Expose-Headers", "Content-Length, Content-Type")
            # Legacy PNA + newer LNA preflight opt-in headers (harmless if unused).
            if self.headers.get("Access-Control-Request-Private-Network", "").lower() == "true":
                self.send_header("Access-Control-Allow-Private-Network", "true")
            if self.headers.get("Access-Control-Request-Local-Network", "").lower() == "true":
                self.send_header("Access-Control-Allow-Local-Network", "true")

        def send_json(self, code, obj):
            data = json.dumps(obj).encode("utf-8")
            self.send_response(code)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-store")
            self.cors()
            self.end_headers()
            self.wfile.write(data)

        def guard(self):
            if not self.host_ok():
                self.send_json(403, {"error": "bad Host header"})
                return False
            if self.origin_ok() is False:
                self.send_json(403, {"error": "origin not allowed: %s" % self.headers.get("Origin")})
                return False
            return True

        def do_OPTIONS(self):
            if not self.host_ok() or self.origin_ok() is False:
                self.send_response(403)
                self.send_header("Content-Length", "0")
                self.end_headers()
                return
            self.send_response(204)
            self.cors()
            self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
            self.send_header("Access-Control-Allow-Headers",
                             self.headers.get("Access-Control-Request-Headers") or "Content-Type")
            self.send_header("Access-Control-Max-Age", "600")
            self.send_header("Content-Length", "0")
            self.end_headers()

        def do_GET(self):
            if not self.guard():
                return
            u = urllib.parse.urlparse(self.path)
            path = u.path
            q = urllib.parse.parse_qs(u.query)
            try:
                if path in ("/", "/health"):
                    return self.send_json(200, app.health())
                if path == "/jobs":
                    return self.send_json(200, {"jobs": [app.jobs[i].snapshot(10 ** 9) for i in app.order[-50:]]})
                m = re.match(r"^/jobs/([0-9a-f]+)$", path)
                if m:
                    job = app.jobs.get(m.group(1))
                    if not job:
                        return self.send_json(404, {"error": "unknown job"})
                    since = int((q.get("since") or ["0"])[0])
                    return self.send_json(200, job.snapshot(since))
                if path == "/existing":
                    names = [n for n in ",".join(q.get("names", [])).split(",") if n]
                    return self.send_json(200, {"existing": app.existing(names[:200])})
                m = re.match(r"^/result/([A-Za-z0-9._-]+)\.(bvh|fbx)$", path)
                if m:
                    f = app.find_result_file(m.group(1), "." + m.group(2))
                    if not f:
                        return self.send_json(404, {"error": "no such result"})
                    data = open(f, "rb").read()
                    self.send_response(200)
                    self.send_header("Content-Type", "application/octet-stream" if m.group(2) == "fbx" else "text/plain; charset=utf-8")
                    self.send_header("Content-Length", str(len(data)))
                    self.send_header("Cache-Control", "no-store")
                    self.cors()
                    self.end_headers()
                    self.wfile.write(data)
                    return
                return self.send_json(404, {"error": "not found"})
            except Exception as err:  # noqa: BLE001
                return self.send_json(500, {"error": str(err)})

        def do_POST(self):
            if not self.guard():
                return
            path = urllib.parse.urlparse(self.path).path
            ctype = (self.headers.get("Content-Type") or "").split(";")[0].strip().lower()
            try:
                m = re.match(r"^/jobs/([0-9a-f]+)/cancel$", path)
                if m:
                    job = app.jobs.get(m.group(1))
                    if not job:
                        return self.send_json(404, {"error": "unknown job"})
                    job.cancel = True
                    if job.proc:
                        try:
                            job.proc.kill()
                        except Exception:  # noqa: BLE001
                            pass
                    return self.send_json(200, {"ok": True})
                if path != "/generate":
                    return self.send_json(404, {"error": "not found"})
                if ctype != "application/json":
                    return self.send_json(415, {"error": "Content-Type must be application/json"})
                n = int(self.headers.get("Content-Length") or 0)
                if n > 200000:
                    return self.send_json(413, {"error": "body too large"})
                body = json.loads(self.rfile.read(n) or b"{}")
                problems = app.readiness()
                if problems:
                    return self.send_json(503, {"error": problems[0], "problems": problems})
                req = validate_request(app, body)
                # fail fast on missing clips so the page gets a clear message
                pl = app.pipeline or Pipeline(app.cfg, None, app.soma_json)
                for k in ("start", "end"):
                    try:
                        pl.resolve_source(req[k]["clip"])
                    except FileNotFoundError as err:
                        return self.send_json(404, {"error": str(err)})
                job = app.submit(req)
                return self.send_json(202, {"job": job.id, "name": job.name, "variants": req["variants"],
                                            "status_url": "/jobs/" + job.id})
            except ValueError as err:
                return self.send_json(400, {"error": str(err)})
            except Exception as err:  # noqa: BLE001
                return self.send_json(500, {"error": str(err)})

    return H


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--config", default=os.environ.get("ANIMLAB_HELPER_CONFIG") or os.path.join(HERE, "config.json"))
    ap.add_argument("--mock", action="store_true", help="linear stand-in for MotionBricks (no GPU needed). Testing only.")
    ap.add_argument("--port", type=int, default=None)
    ap.add_argument("--soma-json", default=None, help="use this exported SOMA skeleton JSON instead of exporting from the USD")
    ap.add_argument("--blender", default=None)
    ap.add_argument("--root", default=None, help="animationlab_root override")
    ap.add_argument("--motionbricks-dir", default=None)
    a = ap.parse_args()
    cfg = load_config(a.config, {"port": a.port, "blender_exe": a.blender, "animationlab_root": a.root,
                                 "motionbricks_dir": a.motionbricks_dir})
    app = App(cfg, a.mock)
    app.soma_json_override = a.soma_json
    for d in cfg["_dirs"].values():
        os.makedirs(d, exist_ok=True) if d != cfg["_dirs"]["source"] else None
    threading.Thread(target=app.worker, daemon=True).start()
    httpd = ThreadingHTTPServer(("127.0.0.1", cfg["port"]), make_handler(app))
    print("AnimLab MotionBricks helper %s on http://127.0.0.1:%d  (%s)" % (
        __version__, cfg["port"], "MOCK ENGINE - not MotionBricks" if a.mock else "MotionBricks engine"), flush=True)
    problems = app.readiness()
    for p in problems:
        print("  ! " + p, flush=True)
    if not problems:
        print("  ready. Open https://masaya-heywood.github.io/MotionBricksAnimationPicker/ and use Generate.", flush=True)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        if app.runner is not None and hasattr(app.runner, "close"):
            app.runner.close()


if __name__ == "__main__":
    main()
