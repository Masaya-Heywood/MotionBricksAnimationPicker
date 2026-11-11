# AnimLab Clip Browser

A static, in-browser preview tool for local FBX animation clips. Open it on GitHub Pages (or any static host), point it at a folder of `.fbx` files on your machine, and preview, star, and mark start/end poses for an offline motion-inbetweening pipeline.

Your clips stay on your computer. This repository does **not** include any animation files, character models, or other third-party assets.

## What it does

- Browse every `.fbx` under a folder you pick, grouped by pack (top-level subfolder).
- Play clips in a 3D viewport with play/pause, speed, a 30 fps scrubber, root-motion lock, a ground grid, and a bone overlay.
- Preview clips on a real character mesh when one is in the folder. **Body → Auto** uses a small preset table (Kevin Iglesias → `HumanM_Model`, PROTOFACTOR → `SK_Protof-Actor`) and otherwise picks the mesh model in the same pack folder with the best bone-name overlap. You can also choose **Skeleton only** or a specific body.
- Same-skeleton clips (about 90% of bone names match) bind directly. Cross-pack previews use rest-pose delta retargeting. Open **Details** for unmatched tracks, and **Name map** to edit synonyms.
- Star clips and add notes (saved in this browser only). **Export starred CSV** downloads a spreadsheet you can use as start/end candidates.
- **Set Start** / **Set End** / **Send to Inbetweener** builds a `pairs.json` list of start and end poses. This is only a pose list for a future batch script. It does not launch MotionBricks or convert to BVH.
- **Save pairs.json** writes that list to a file you choose (Chrome/Edge can remember the file and overwrite it). Other browsers download the file instead. **Open pairs.json** loads an existing list.

## Supported browsers

| Browser | Open a folder | Reopen last folder | Save `pairs.json` in place |
| --- | --- | --- | --- |
| Chrome or Edge (recommended) | Folder picker | Yes, after you grant permission again | Yes, via a file picker |
| Firefox or Safari | Folder upload (`<input webkitdirectory>`) | No — pick the folder each visit | Download only |

The folder picker and in-place save use the File System Access API, which needs a [secure context](https://developer.mozilla.org/en-US/docs/Web/Security/Secure_Contexts) (HTTPS, or `localhost` if you run it yourself). GitHub Pages is HTTPS, so that is already covered.

A desktop computer with a mouse works best. This is a preview tool, not a mobile app.

## How to use

1. Open the GitHub Pages site for this repo (or open `index.html` from a local static server).
2. Click **Open folder** and choose the root folder that contains your FBX packs — for example a `source_fbx` directory with one subfolder per pack. In Chrome or Edge you can use **Reopen last folder** on the next visit.
3. Search or click a clip to load it. Use **Body** to pick a preview mesh, or leave it on Auto.
4. Star useful clips, add notes, and export a CSV if you want a shortlist.
5. Mark start and end frames, send them to the Inbetweener list, then **Save pairs.json** when you want that list on disk.

Up / Down steps through the visible list. Space plays or pauses.

### Running it yourself

There is no build step. Any static server works:

```bash
python3 -m http.server 8765
```

Then open `http://localhost:8765`. Serving over `file://` is not recommended (module imports and the folder picker may fail).

To publish on GitHub Pages: push this folder as the repo root (or copy these files there), then in the repo settings enable Pages from the `main` branch, `/ (root)`. A `.nojekyll` file is included so GitHub does not process the vendor files.

## Privacy

**Files you open never leave your machine.** The page reads them locally in your browser. Nothing is uploaded to GitHub, to this site's host, or to any other server. Stars, notes, and a cache of “is this FBX a character mesh?” stay in your browser (`localStorage` and IndexedDB). The last folder and `pairs.json` file handles, when the browser supports them, are also stored only in IndexedDB on your computer.

Do not add paid or licensed FBX files to this repository. Keep those packs on your own disk and open them with the folder picker.

## Pairs file schema

```json
{
  "version": 1,
  "note": "Input for a future MotionBricks / SOMA batch script. clip paths are relative to the FBX root. frame is an integer at 30 fps display time. BVH conversion is a later step; this file does not launch MotionBricks.",
  "pairs": [
    {
      "id": "<uuid>",
      "start": { "clip": "relative/path/to/clip.fbx", "frame": 30 },
      "end":   { "clip": "relative/path/to/other.fbx", "frame": 0 },
      "variants": 1,
      "note": "optional text",
      "created": "2026-11-10T21:00:00Z"
    }
  ]
}
```

Clip paths are relative to the folder you opened. Frame numbers use the 30 fps display rate shown in the scrubber.

## Notes and limits

- The viewer uses a vendored [three.js](https://threejs.org/) r180 FBX loader, with a small local patch so binary FBX 7.3 files (common in some marketplace packs) open correctly. Typical Unity / Mixamo FBX 7.4 / 7.5 / 7.7 files also work. Some older or unusual FBX versions, or files that are only an Animator controller, may fail to open. The page will say so.
- This static build does **not** convert unreadable FBX through Blender or FBX2glTF. That fallback exists only in the optional local Python server version of the tool.
- Very large files (tens of megabytes) can take a few seconds to load. The viewer does not keep previous clips in memory.
- External texture files sitting next to an FBX may not always show up; embedded textures usually do. Fingers, props, and weapons only appear if they are in the FBX itself.
- Mesh-model detection (so animation-only files do not appear in the Body menu) runs in the browser. A file is listed only if it is a genuine character mesh: skinned Geometry with a substantial vertex count, and either a model-like name or folder (`SK_`, `_Model`, `Models/`, `Characters/`) or almost no animation curves. Clips named with `@`, files under `Animations/`, and skinned files that carry a full clip are excluded; if in doubt, the file is left out. Results are cached in IndexedDB by path, size, and last-modified time (cache version 2).
- Auto body matching is configurable in `body-presets.json` if you fork the project.
- This tool is for preview and picking poses. It does not write clips back out, and it does not talk to Unity or MotionBricks.

## Credits and licenses

- The 3D engine is [three.js](https://github.com/mrdoob/three.js) r180, MIT licensed. The license text is in `vendor/LICENSE-three.js`. `vendor/addons/libs/fflate.module.js` is also MIT licensed.
- This repo does not include a project license file; the owner can add one.
- Marketplace animation packs (for example Kevin Iglesias or PROTOFACTOR) are third-party products. This tool is not affiliated with those authors, or with Unity, NVIDIA, or Autodesk. Do not redistribute those assets.
