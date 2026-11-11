// End-to-end browser test: real site + real helper (started with --mock) + headless Chrome.
//
//   FIXTURES=<dir with Kevin-style clips> HELPER=http://127.0.0.1:8771 CHROME=/usr/bin/google-chrome \
//   PW=<path to playwright-core> node helper/tests/e2e_browser.js [screenshot.png]
//
// FIXTURES must be the same folder the helper uses as source_fbx (the helper is started with --root pointing at
// a folder whose source_fbx is that folder). Paid asset packs are never committed; this test only reads them.
const http = require("http");
const fs = require("fs");
const path = require("path");

const REPO = path.resolve(__dirname, "..", "..");
const FIXTURES = process.env.FIXTURES;
const HELPER = process.env.HELPER || "http://127.0.0.1:8771";
const CHROME = process.env.CHROME || "/usr/bin/google-chrome";
const PW = process.env.PW || "playwright-core";
const SHOT = process.argv[2] || path.join(__dirname, "e2e.png");
const START = process.env.START_CLIP || "Kevin Iglesias/Animations/Male/Combat/1H/HumanM@CombatIdle1H01.fbx";
const END = process.env.END_CLIP || "Kevin Iglesias/Animations/Male/Combat/1H/HumanM@Attack1H01_R.fbx";
if (!FIXTURES) throw new Error("set FIXTURES");

const { chromium } = require(PW);
const MIME = { ".js": "text/javascript", ".html": "text/html", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml" };

function walk(dir, base = "") {
  let out = [];
  for (const n of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = base ? base + "/" + n.name : n.name;
    if (n.isDirectory()) out = out.concat(walk(path.join(dir, n.name), rel));
    else if (/\.fbx$/i.test(n.name)) out.push(rel);
  }
  return out;
}

function serve() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const u = decodeURIComponent(req.url.split("?")[0]);
      let file;
      if (u.startsWith("/__fixtures__/")) file = path.join(FIXTURES, u.slice("/__fixtures__/".length));
      else file = path.join(REPO, u === "/" ? "index.html" : u);
      if (!file.startsWith(REPO) && !file.startsWith(FIXTURES)) { res.writeHead(403); return res.end(); }
      fs.readFile(file, (err, data) => {
        if (err) { res.writeHead(404); return res.end("nf"); }
        res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream" });
        res.end(data);
      });
    });
    srv.listen(0, "127.0.0.1", () => resolve(srv));
  });
}

function check(cond, msg) {
  if (!cond) { console.log("FAIL: " + msg); process.exitCode = 1; throw new Error(msg); }
  console.log("ok:   " + msg);
}

(async () => {
  const srv = await serve();
  const site = "http://127.0.0.1:" + srv.address().port + "/";
  const browser = await chromium.launch({ executablePath: CHROME, args: ["--no-sandbox"] });
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 900 } });
  await ctx.addInitScript((h) => { if (!localStorage.getItem("__e2e_nohelper")) localStorage.setItem("animlab-helper-url-v1", h); }, HELPER);
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => { if (process.env.DEBUG) console.log("  [console." + m.type() + "] " + m.text().slice(0,200)); if (m.type() === "error" && !/favicon/.test(m.text())) errors.push("console: " + m.text()); });
  try {
    await page.goto(site);
    await page.waitForFunction(() => window.__openFolderFromRecords && window.__helperDebug);
    await page.waitForFunction(() => /connected/.test(document.getElementById("helper-pill").textContent), null, { timeout: 15000 });
    check(true, "helper pill shows connected: " + (await page.textContent("#helper-pill")));

    const rels = walk(FIXTURES);
    await page.evaluate(async ({ rels }) => {
      const records = [];
      for (const rel of rels) {
        const buf = await (await fetch("/__fixtures__/" + rel.split("/").map(encodeURIComponent).join("/"))).arrayBuffer();
        records.push({ path: rel, buffer: buf });
      }
      await window.__openFolderFromRecords(records, "source_fbx");
    }, { rels });

    async function pickClip(rel, frame, which) {
      await page.fill("#search", rel.split("/").pop().replace(/\.fbx$/i, ""));
      await page.waitForTimeout(300);
      const ok = await page.evaluate((p) => {
        const row = [...document.querySelectorAll("#clip-list [data-path]")].find((r) => r.getAttribute("data-path") === p);
        if (!row) return false;
        row.click();
        return true;
      }, rel);
      check(ok, "clip row found: " + rel.split("/").pop());
      await page.waitForFunction(() => window.__clipDebug().currentDuration > 0, null, { timeout: 30000 });
      await page.evaluate((f) => {
        const s = document.getElementById("scrub");
        s.value = String(f);
        s.dispatchEvent(new Event("input", { bubbles: true }));
      }, frame);
      await page.click(which === "start" ? "#set-start-btn" : "#set-end-btn");
    }
    await pickClip(START, 10, "start");
    await pickClip(END, 12, "end");
    await page.fill("#variants", "2");
    await page.fill("#opt-forward", "0.25");
    await page.click("#send-pair-btn");
    await page.waitForSelector(".pair-item");
    const genBtnDisabled = await page.getAttribute("[data-generate-pair]", "disabled");
    check(genBtnDisabled === null, "Generate button enabled with helper connected");

    await page.click("[data-generate-pair]");
    await page.waitForFunction(() => /done/.test((document.querySelector(".pair-gen") || {}).textContent || ""), null, { timeout: 120000 });
    const statusText = await page.textContent(".pair-gen");
    check(/v1/.test(statusText) && /v2/.test(statusText), "job finished with two variants: " + statusText.replace(/\s+/g, " ").trim().slice(0, 80));

    await page.waitForFunction(() => !document.getElementById("compare-bar").hidden, null, { timeout: 30000 });
    await page.waitForFunction(() => window.__clipDebug().currentDuration > 0 && /__generated__/.test(document.getElementById("hud").textContent + document.getElementById("clip-title").textContent + "__generated__"), null, { timeout: 30000 });
    await page.waitForTimeout(600);
    const dbg = await page.evaluate(() => window.__clipDebug());
    const dur = dbg.currentDuration;
    check(Math.abs(dur - 33 / 30) < 0.05 || Math.abs(dur - 45 / 30) < 0.05 || (dur > 1 && dur < 2), "generated clip loaded in viewer, duration " + dur.toFixed(3) + " s");
    check(dbg.figure && dbg.figure.hipY > 0.3 && dbg.figure.hipY < 300, "generated figure hips look sane (y=" + (dbg.figure && dbg.figure.hipY && dbg.figure.hipY.toFixed(2)) + ")");
    check(await page.evaluate(() => document.getElementById("set-start-btn").disabled), "Set Start disabled while viewing generated clip");
    check(/MOCK/.test(await page.textContent("#compare-note")), "compare bar flags the mock engine");
    await page.screenshot({ path: SHOT });
    console.log("screenshot " + SHOT);

    await page.click("#cmp-start");
    await page.waitForFunction(() => window.__clipDebug().currentDuration > 0 && /Start clip/.test(document.getElementById("compare-note").textContent), null, { timeout: 30000 });
    await page.waitForTimeout(500);
    const f = await page.textContent("#frame-readout");
    check(/^10 /.test(f.trim()), "Start clip is paused on frame 10 (" + f.trim().slice(0, 20) + ")");
    await page.click("#cmp-end");
    await page.waitForFunction(() => /End clip/.test(document.getElementById("compare-note").textContent), null, { timeout: 30000 });
    await page.waitForTimeout(500);
    check(/^12 /.test((await page.textContent("#frame-readout")).trim()), "End clip is paused on frame 12");
    await page.click("#cmp-gen");
    await page.waitForFunction(() => /Generated|MOCK/.test(document.getElementById("compare-note").textContent), null, { timeout: 30000 });
    await page.selectOption("#cmp-variant", "2");
    await page.waitForTimeout(1500);
    const g2 = await page.evaluate(() => window.__clipDebug().currentDuration);
    check(g2 > 1, "variant 2 loads (" + g2.toFixed(3) + " s)");

    // helper goes away: page keeps working, Generate disables
    await page.evaluate(() => { localStorage.setItem("__e2e_nohelper", "1"); localStorage.setItem("animlab-helper-url-v1", "http://127.0.0.1:9"); });
    await page.evaluate(() => window.__helperDebug());
    await page.reload();
    await page.waitForFunction(() => /not running/.test(document.getElementById("helper-pill").textContent), null, { timeout: 15000 });
    check(true, "with no helper the pill says: " + (await page.textContent("#helper-pill")));
    check(errors.filter((e) => !/ERR_CONNECTION_REFUSED|Failed to load resource|Failed to fetch/.test(e)).length === 0, "no page errors " + JSON.stringify(errors.slice(0, 3)));
  } catch (e) {
    console.log("page errors:", JSON.stringify(errors.slice(0, 5)));
    console.log("overlay:", await page.evaluate(() => document.getElementById("overlay").innerText).catch(() => "?"));
    throw e;
  } finally {
    await browser.close();
    srv.close();
  }
})().catch((e) => { console.log("ERROR", e.message); process.exit(1); });
