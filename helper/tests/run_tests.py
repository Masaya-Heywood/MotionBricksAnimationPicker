"""Runs every helper test that can run on this machine. No commercial assets needed.

    python tests/run_tests.py --blender D:\\blender.exe --soma-json cache\\soma_skeleton.json
    python tests/run_tests.py --blender ... --motionbricks C:\\Users\\User\\motionbricks      # also exports the SOMA JSON
    optional: --chrome <chrome.exe> --pw <path to playwright-core>   (browser end-to-end test, needs node)

Steps: unit tests -> synthetic FBX fixtures (Blender) -> helper server in --mock mode -> HTTP flow (CORS, errors,
a real two-variant job through both Blender steps) -> output checks (BVH frames/joints, FBX re-import and pose
fidelity) -> real-engine glue with a fake engine (needs --motionbricks) -> browser e2e (needs --chrome/--pw).
"""
import argparse
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
HELPER = os.path.dirname(HERE)
sys.path.insert(0, HELPER)

failures = []


def check(cond, msg):
    print(("ok    " if cond else "FAIL  ") + msg, flush=True)
    if not cond:
        failures.append(msg)


def free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    p = s.getsockname()[1]
    s.close()
    return p


def http(method, url, body=None, headers=None, raw=False):
    data = None if body is None else (body if isinstance(body, bytes) else json.dumps(body).encode())
    h = {"Content-Type": "application/json"} if body is not None else {}
    h.update(headers or {})
    req = urllib.request.Request(url, data=data, method=method, headers=h)
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            payload = r.read()
            return r.status, dict(r.headers), payload if raw else (json.loads(payload) if payload else None)
    except urllib.error.HTTPError as e:
        payload = e.read()
        try:
            return e.code, dict(e.headers), json.loads(payload) if payload else None
        except ValueError:
            return e.code, dict(e.headers), payload


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--blender", default=os.environ.get("BLENDER"))
    ap.add_argument("--soma-json", default=os.environ.get("SOMA_JSON"))
    ap.add_argument("--motionbricks", default=os.environ.get("MOTIONBRICKS"))
    ap.add_argument("--chrome", default=os.environ.get("CHROME"))
    ap.add_argument("--pw", default=os.environ.get("PW"))
    ap.add_argument("--keep", action="store_true")
    ap.add_argument("--screenshot", default=None)
    a = ap.parse_args()
    if not a.blender or not os.path.isfile(a.blender):
        sys.exit("need --blender <path to blender executable>")
    tmp = tempfile.mkdtemp(prefix="mbh-tests-")
    print("work dir", tmp)

    soma_json = a.soma_json
    if not soma_json and a.motionbricks:
        soma_json = os.path.join(tmp, "soma_skeleton.json")
        sys.path.insert(0, os.path.join(HELPER, "tools"))
        import export_soma_skeleton
        export_soma_skeleton.export(os.path.join(a.motionbricks, "motionbricks", "assets", "human", "soma_base_skel_minimal_no_root.usd"), soma_json)
    if not soma_json:
        sys.exit("need --soma-json or --motionbricks (with Git LFS files pulled)")
    env = dict(os.environ, SOMA_JSON=soma_json)

    print("\n== unit tests")
    r = subprocess.run([sys.executable, os.path.join(HERE, "test_units.py")], env=env)
    check(r.returncode == 0, "test_units.py")

    print("\n== fixtures")
    root = os.path.join(tmp, "AnimationLab")
    fx = os.path.join(root, "source_fbx")
    r = subprocess.run([a.blender, "-b", "--factory-startup", "--python", os.path.join(HERE, "make_fixtures.py"), "--",
                        os.path.join(fx, "Synth", "Animations")], capture_output=True, text=True)
    check(r.returncode == 0 and os.path.isfile(os.path.join(fx, "Synth", "Animations", "Synth@Reach.fbx")), "synthetic clips built with Blender")

    print("\n== helper server (--mock)")
    port = free_port()
    cfg = json.load(open(os.path.join(HELPER, "config.json")))
    cfg.update(port=port, blender_exe=a.blender, animationlab_root=root, motionbricks_dir=a.motionbricks or "")
    cfg_path = os.path.join(tmp, "config.json")
    json.dump(cfg, open(cfg_path, "w"))
    srv = subprocess.Popen([sys.executable, os.path.join(HELPER, "server.py"), "--config", cfg_path, "--mock", "--soma-json", soma_json],
                           stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    base = "http://127.0.0.1:%d" % port
    try:
        for _ in range(50):
            try:
                st, _, h = http("GET", base + "/health")
                break
            except Exception:  # noqa: BLE001
                time.sleep(0.2)
        check(st == 200 and h["ready"] and h["mock"], "health: ready, mock engine, blender %s" % h["blender"]["version"])
        origin = "https://masaya-heywood.github.io"
        st, hd, _ = http("OPTIONS", base + "/generate", headers={"Origin": origin, "Access-Control-Request-Method": "POST",
                                                                  "Access-Control-Request-Headers": "content-type",
                                                                  "Access-Control-Request-Private-Network": "true",
                                                                  "Access-Control-Request-Local-Network": "true"})
        hd = {k.lower(): v for k, v in hd.items()}
        check(st == 204 and hd.get("access-control-allow-origin") == origin
              and hd.get("access-control-allow-private-network") == "true"
              and hd.get("access-control-allow-local-network") == "true",
              "CORS + Private/Local Network Access preflight for the Pages origin")
        st, _, _ = http("OPTIONS", base + "/generate", headers={"Origin": "https://evil.example", "Access-Control-Request-Method": "POST"})
        check(st == 403, "preflight from another origin refused")
        st, _, _ = http("POST", base + "/generate", {"x": 1}, headers={"Origin": "https://evil.example"})
        check(st == 403, "POST from another origin refused")
        st, _, _ = http("POST", base + "/generate", b"{}", headers={"Content-Type": "text/plain"})
        check(st == 415, "POST without application/json refused")
        st, _, b = http("POST", base + "/generate", {"start": {"clip": "../../etc/passwd.fbx", "frame": 1}, "end": {"clip": "a.fbx", "frame": 1}})
        check(st == 400, "path traversal rejected (%s)" % st)
        st, _, b = http("POST", base + "/generate", {"start": {"clip": "Nope/x.fbx", "frame": 1}, "end": {"clip": "Nope/y.fbx", "frame": 1}})
        check(st == 404 and "not found" in b["error"], "missing clip gives a clear 404")

        body = {"id": "t1", "start": {"clip": "Synth/Animations/Synth@WalkA.fbx", "frame": 12},
                "end": {"clip": "Synth/Animations/Synth@Reach.fbx", "frame": 20}, "variants": 2,
                "options": {"target_offset": {"forward": 0.25, "turn_deg": 20}}}
        st, _, j = http("POST", base + "/generate", body, headers={"Origin": origin})
        check(st == 202, "job accepted: %s" % j)
        job = None
        for _ in range(240):
            _, _, job = http("GET", base + "/jobs/" + j["job"])
            if job["state"] in ("done", "error", "cancelled"):
                break
            time.sleep(0.5)
        check(job["state"] == "done", "job finished: %s %s" % (job["state"], job.get("error")))
        if job["state"] != "done":
            print("\n".join(job["log"][-30:]))
        else:
            check(len(job["results"]) == 2, "two variants returned")
            from mbh.bvhio import read_bvh
            names_seen = set()
            for res in job["results"]:
                b = read_bvh(res["bvh"])
                check(len(b["names"]) == 77 and b["frames"] == res["frames"] and (b["frames"] + 6) % 4 == 0,
                      "v%d BVH: 77 joints, %d frames (4*tokens-6)" % (res["variant"], b["frames"]))
                check(os.path.getsize(res["fbx"]) > 10000, "v%d FBX written (%d bytes)" % (res["variant"], os.path.getsize(res["fbx"])))
                st, _, data = http("GET", base + res["fbx_url"], raw=True)
                check(st == 200 and data[:18] == b"Kaydara FBX Binary", "v%d FBX downloads over HTTP" % res["variant"])
                names_seen.add(os.path.basename(res["fbx"]))
            check(len(names_seen) == 2 and any("_v02" in n for n in names_seen), "deterministic names with _v02 suffix: %s" % sorted(names_seen))
            st, _, e = http("GET", base + "/existing?names=" + job["name"])
            check(st == 200 and e["existing"].get(job["name"], {}).get("variants") == [1, 2], "existing results found by name after the fact")
            for sub in ("soma_bvh", "generated", "export_fbx"):
                check(os.path.isdir(os.path.join(root, sub)) and os.listdir(os.path.join(root, sub)), "output folder %s populated" % sub)
            # FBX re-import + pose fidelity
            spec = {"start": {"fbx": os.path.join(fx, "Synth", "Animations", "Synth@WalkA.fbx"), "frame": 12},
                    "end": {"fbx": os.path.join(fx, "Synth", "Animations", "Synth@Reach.fbx"), "frame": 20},
                    "gen_fbx": job["results"][0]["fbx"], "out_json": os.path.join(tmp, "check.json")}
            json.dump(spec, open(os.path.join(tmp, "check_spec.json"), "w"))
            subprocess.run([a.blender, "-b", "--factory-startup", "--python", os.path.join(HERE, "check_fbx.py"), "--", os.path.join(tmp, "check_spec.json")],
                           capture_output=True, text=True)
            if os.path.isfile(spec["out_json"]):
                c = json.load(open(spec["out_json"]))
                check(abs(c["duration_s"] - (job["results"][0]["frames"] - 1) / 30.0) < 0.02 and c["fps"] == 30, "re-imported FBX: %.3f s at %g fps" % (c["duration_s"], c["fps"]))
                check(c["start_vs_first"]["max"] < 3.0, "generated first frame matches the start pose (max %.2f cm on a 170 cm figure)" % c["start_vs_first"]["max"])
                check(c["end_vs_last"]["max"] < 3.0, "generated last frame matches the end pose (max %.2f cm)" % c["end_vs_last"]["max"])
            else:
                check(False, "check_fbx.py produced no result")
    finally:
        srv.terminate()
        try:
            srv.wait(timeout=5)
        except subprocess.TimeoutExpired:
            srv.kill()

    if a.motionbricks:
        print("\n== real-engine glue (fake engine on CPU, real motionbricks buffers/BVH loader)")
        conv = os.path.join(root, "soma_bvh")
        ctx = [f for f in os.listdir(conv) if f.endswith("__context.bvh")]
        if ctx:
            ctx_p = os.path.join(conv, ctx[0])
            tgt_p = ctx_p.replace("__context", "__target")
            r = subprocess.run([sys.executable, os.path.join(HERE, "test_real_glue.py"), ctx_p, tgt_p],
                               env=dict(env, MOTIONBRICKS=a.motionbricks), capture_output=True, text=True)
            ok = r.returncode == 0 and "OK real-engine glue" in r.stdout
            check(ok, "RealRunner glue with a fake engine" + ("" if ok else "\n" + (r.stdout + r.stderr)[-1500:]))
    else:
        print("\n(skipping real-engine glue: pass --motionbricks <clone with LFS files and the uv env's python>)")

    if a.chrome and a.pw:
        print("\n== browser end-to-end")
        srv = subprocess.Popen([sys.executable, os.path.join(HELPER, "server.py"), "--config", cfg_path, "--mock", "--soma-json", soma_json],
                               stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
        time.sleep(1.5)
        try:
            e2e_env = dict(os.environ, FIXTURES=fx, HELPER=base, CHROME=a.chrome, PW=a.pw,
                           START_CLIP="Synth/Animations/Synth@WalkA.fbx", END_CLIP="Synth/Animations/Synth@Reach.fbx")
            r = subprocess.run(["node", os.path.join(HERE, "e2e_browser.js"), a.screenshot or os.path.join(tmp, "e2e.png")], env=e2e_env, capture_output=True, text=True, timeout=300)
            print(r.stdout[-2500:])
            check(r.returncode == 0 and "FAIL" not in r.stdout and "ERROR" not in r.stdout, "browser e2e")
        finally:
            srv.terminate()
    else:
        print("\n(skipping browser e2e: pass --chrome and --pw)")

    print("\n%s" % ("ALL PASSED" if not failures else "FAILED: %d" % len(failures)))
    if not a.keep:
        shutil.rmtree(tmp, ignore_errors=True)
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    main()
