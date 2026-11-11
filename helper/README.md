# AnimLab MotionBricks helper

A small local program that connects the clip browser (the static GitHub Pages app) to NVIDIA MotionBricks v0.2.0 on your own PC. It is optional. Without it the browser works exactly as before.

```
 Pages app (browser)  --HTTP, 127.0.0.1:8770-->  server.py
                                                   |-- Blender (headless): clip FBX -> SOMA BVH  (blender/to_soma.py)
                                                   |-- MotionBricks (in-process, GPU, warm): BVH -> generated BVH (mb_generate.py)
                                                   '-- Blender (headless): generated BVH -> FBX on the start clip's rig (blender/from_soma.py)
```

Nothing leaves your PC. The server listens on 127.0.0.1 only, answers only the GitHub Pages origin (`https://masaya-heywood.github.io`) and `localhost` origins, refuses POSTs without `Content-Type: application/json`, and only reads FBX files inside your `source_fbx` folder.

## Run it (Windows, PowerShell or Explorer)

Prerequisites you already have: `uv`, MotionBricks v0.2.0 cloned at `C:\Users\User\motionbricks` with its demo working (that means TensorRT, Warp, CUDA and the Git LFS model files are fine), Blender at `D:\blender.exe`.

1. Copy this `helper` folder anywhere, for example `D:\AnimationLab\helper`. (It is also in the repo.)
2. Check `helper\config.json`. The defaults are your paths: `motionbricks_dir` `C:\Users\User\motionbricks`, `blender_exe` `D:\blender.exe`, `animationlab_root` `D:\AnimationLab` (clips are read from `D:\AnimationLab\source_fbx`; outputs go to `soma_bvh`, `generated`, `export_fbx` next to it). If `Start-Helper.bat` needs another MotionBricks path, edit `MB_DIR` at its top too.
3. Double-click `Start-Helper.bat` (or run `.\Start-Helper.bat` in PowerShell). It runs `uv run python server.py` inside the MotionBricks folder. Keep the window open.
   - The console prints `ready` when Blender, the GPU and MotionBricks all check out, otherwise a line starting with `!` for each problem.
4. Open the clip browser, open your folder (`D:\AnimationLab\source_fbx` itself, or a folder above it; paths are matched either way), and look at the header pill: **Helper: connected**.
5. Set Start and End on two clips, **Send to Inbetweener**, then **Generate** on the pair. The first generation builds a TensorRT plan, which takes a few minutes. It is cached in `C:\Users\User\motionbricks\.trt-cache`, and later launches are fast. The helper keeps the engine warm between jobs.
6. When it finishes, the page plays the generated clip with a bar at the top of the viewport: **Start clip / Generated / End clip** (pauses on the picked frame) and a variant selector.

Outputs for a pair named `<name>` (the name is `<startclip>_f<N>__<endclip>_f<N>_<hash>` unless the pair has a `name`; re-running overwrites; variants after the first get `_v02`, `_v03`, ...):

| Folder | File |
| --- | --- |
| `soma_bvh\` | `<name>__context.bvh` (4 poses ending at the start frame), `<name>__target.bvh` (end pose window), `<name>__meta.json` |
| `generated\` | `<name>.bvh`, `<name>_v02.bvh`, ... (SOMA skeleton, 77 joints, 30 fps, metres/cm as `load_bvh` expects), `<name>.job.json` |
| `export_fbx\` | `<name>.fbx`, `<name>_v02.fbx`, ... (armature-only, on the start clip's rig, take name = `<name>`) |

Logs of every Blender run: `D:\AnimationLab\helper_cache\logs`. The SOMA skeleton JSON is exported once from MotionBricks' own USD into `D:\AnimationLab\helper_cache\soma_skeleton.json`.

Test without a GPU: `python server.py --mock --soma-json <soma_skeleton.json>` replaces MotionBricks with a linear blend. The pill then says "MOCK engine" and the compare bar says so too. Never use mock output as real results.

## What the pair becomes

* **Context**: 4 poses at times `start-3 .. start` (frames, 30 fps) from the start clip, moved so the last one stands on the origin at the SOMA rest heading (ground position and heading removed, height kept). The engine removes ground position and heading of the last context pose itself; the converter does the same so the BVHs are self-consistent and the target can be placed relative to it.
* **Target(s)**: one or more targets (`targets[]` on the request; legacy `end` + `options` becomes a single target). Each target sends up to `poses_to_use` poses (1–4, default 4) from its frame. `target_offset {forward, right, turn_deg}` places that pose relative to the previous keypose (metres, degrees, + = left). The page can Auto-fill `forward = speed_mps × seconds` from the end clip’s horizontal root speed.
* **Tokens**: `tokens_min` / `tokens_max` (default 8–14) become `MotionBricksInferenceConfig(allowed_token_counts=range(min, max+1))`, same as the Inbetweener. Raw frames readout = 4×tokens (32–56 for 8–14); the engine’s valid output length is still `4*tokens - 6` after boundary trim. Equal min/max fixes length. Variant k > 1 pins a count inside the range. Legacy `options.tokens` still pins min=max.
* **Transition early**: `transition_early` (frames, default 0) shortens how much of a segment is kept before chaining the next target: `segment_end = max(3, num_frames - 1 - early)`, matching the Inbetweener. The next context is the last four played frames.
* **Chaining**: with multiple targets the helper generates Start→T1, then T1→T2, …, concatenates the played frames into one BVH/FBX. Single-target pairs stay backward compatible.
* Window times outside the clip are clamped and a warning is shown on the pair (hover the warning mark).
* **Fingers** (and any bone matching `passthrough_regex`) are not sent to the model. On the way back they are blended between the start frame's and the end frame's finger pose.
* Result root motion starts at the start pose's SOMA ground position and ends at the placed final target.
* The page’s **Foot contacts** toggle is a viewport heuristic (foot height + speed vs threshold, default 0.5). The real engine also exposes `output.foot_contacts`; mock mode writes a synthetic contacts curve.

## Bone maps and gaps

SOMA has 77 joints; the model uses 30 of them (`Hips, Spine1, Spine2, Chest, Neck1, Neck2, Head, Jaw, LeftEye, RightEye, Left/RightShoulder|Arm|ForeArm|Hand|HandThumbEnd|HandMiddleEnd, Left/RightLeg|Shin|Foot|ToeBase`). Unmapped model joints keep the SOMA rest rotation on the way in and are ignored on the way out. `bonemaps.json` holds the maps; edit it to add a rig. To force a map for a clip, set `options.rig_start` / `options.rig_end` to a rig id from that file in the request (not exposed in the UI).

| SOMA joint | Kevin Iglesias HumanM (`kevin_humanm`) | PROTOFACTOR SK_Protof-Actor (`protofactor_actor`) |
| --- | --- | --- |
| Hips | B-hips | humanoid_ Pelvis |
| Spine1 | B-spine | humanoid_ Spine |
| Spine2 | **not mapped** | humanoid_ Spine1 |
| Chest | B-chest | humanoid_ Spine2 |
| Neck1 / Head | B-neck / B-head | humanoid_ Neck / Head |
| Neck2, Jaw, LeftEye, RightEye | **not mapped** | **not mapped** |
| Left/RightShoulder | B-shoulder.L/R | humanoid_ L/R Clavicle |
| Left/RightArm, ForeArm, Hand | B-upperArm / forearm / hand .L/R | humanoid_ L/R UpperArm / Forearm / Hand |
| Left/Right Hand ThumbEnd, MiddleEnd | **not mapped** (fingers pass through) | **not mapped** (fingers pass through) |
| Left/RightLeg, Shin, Foot, ToeBase | B-thigh / shin / foot / toe .L/R | humanoid_ L/R Thigh / Calf / Foot / Toe0 |

Kevin: 21 of 30 model joints mapped. PROTOFACTOR: 22 of 30. Other rigs fall through to `generic`, a name heuristic (Mixamo `mixamorig:`, Unity Humanoid, Bip01, `_L/_R`, ...). It needs at least Hips, Head, both arms and both legs. A rig with a third spine bone (Mixamo has Spine, Spine1, Spine2) loses one spine bone's motion, because SOMA's mapped spine has two.

The mapping is by *world* rotation and bone direction, so it does not depend on each rig's local bone axes, on Z-up vs Y-up, or on A-pose vs T-pose. The source body frame (up, left, forward) is measured from the rig's own rest pose.

## Tests

`python tests\run_tests.py --blender D:\blender.exe --motionbricks C:\Users\User\motionbricks` (run it with the uv Python so `pxr` exists, or pass `--soma-json` instead of `--motionbricks`). It needs no asset pack: Blender builds two synthetic Mixamo-named clips. It runs unit tests, an HTTP flow against `server.py --mock` (CORS, refusals, a two-variant job through both Blender steps, BVH and FBX checks, pose fidelity after re-import), and, with `--motionbricks`, the real-engine glue using a fake engine on CPU. With `--chrome <chrome.exe> --pw <playwright-core path>` it also drives the site in headless Chrome.

## Tested vs not tested

Tested here (Linux box, Blender 4.2.3, no GPU):

* SOMA skeleton JSON, BVH writer and reader checked against MotionBricks' own `load_skeleton_from_usd` and `load_bvh` (identical, 1e-5 degrees).
* FBX -> BVH -> (mock engine) -> BVH -> FBX on the real Kevin Iglesias HumanM clips and the real PROTOFACTOR clips, plus the synthetic Mixamo-style rig. Generated first/last frames match the start/end poses within 0.6 / 1.4 cm on a 170 cm synthetic figure, at most 0.3 cm on the real Kevin clips and 0.06 cm on the real PROTOFACTOR clips (the synthetic figure's larger error is most likely its third spine bone, which SOMA has no joint for).
* The `RealRunner` code path (BVH -> `clip.sample` -> `PoseToken.update_from_poses` -> `generate_animation` -> `AnimationBuffer` -> BVH) against the real MotionBricks classes on CPU with a fake engine.
* The exported FBX re-imports in Blender and in the page's three.js viewer (cm units like the originals, take name = pair name, 30 fps).
* The site flow in headless Chrome against the mock helper: Generate, progress, result playback on the HumanM body, Start/Generated/End bar, variant switch, and the page with no helper.

**Not tested (needs your PC):**

* The real MotionBricks engine itself (TensorRT, GPU, the `MotionBricksSOMAEngine` constructor and `generate_animation`). The code follows `docs/examples/generate_once.py` of v0.2.0 exactly, but it has never run against a GPU here.
* Windows specifics: `Start-Helper.bat`, `D:\blender.exe`, path handling with backslashes, console encoding.
* Blender 4.x versions other than 4.2.3. Blender 5.x uses a different importer; it is handled but untried.
* Importing the exported FBX into Unity (see risks).
* Chrome's "local network access" permission prompt for a public page calling `127.0.0.1` (the server answers the Private Network Access preflight; the prompt itself could not be exercised from a localhost page).

## Known risks

* **Unity import**: the FBX comes from Blender's exporter with Blender's axis conversion (-Z forward, Y up), no scale applied, and unit setting identical to the source files. Blender's exporter also writes constant scale tracks for every bone (the HumanM root carries 100); the page drops them when playing, Unity's Humanoid retargeting normally ignores them but it is unverified. Import with Rig = Humanoid using the pack's own avatar, and compare against the original clip in the Animation window before trusting it.
* **Bone-map gaps**: see the table. Spine2 (Kevin), Neck2, Jaw, eyes and the thumb/middle finger end joints are not driven. Kevin's `B-jaw` is not driven, and fingers are only blended start to end.
* **Root motion and axes**: root translation is the hips world displacement from the rest pose times the ratio of SOMA hips height (1.012 m) to the source hips height, rotated into the SOMA frame. The model removes ground position and heading of the last context pose by itself; the converter normalises the same way, and the generated clip is returned in SOMA heading. If a clip is exported with a different forward axis than expected, `target_offset.turn_deg` and the preview will show it first; the body frame is measured from the rig, not assumed.
* **PROTOFACTOR rest pose** in the clip files is a posed, not a T-pose, rig; a warning appears. Arm twist for the model is derived by shortest-arc alignment and may be off by some degrees. The way back is the exact inverse, so the picked start/end frames are reproduced exactly on the source rig.
* **Model FBX files** (`HumanM_Model`, `SK_Protof-Actor`) do not import in Blender 4.2's legacy importer, so the helper uses the clip's own armature as the output rig. Mesh export is off by default (`include_mesh`).
* The engine runs in the helper's process on one worker thread; jobs queue. A crash in TensorRT takes the helper down; restart it.
* Do not ship or commit Bones RP1 evaluation sample clips or anything derived from them. Nothing here does.
