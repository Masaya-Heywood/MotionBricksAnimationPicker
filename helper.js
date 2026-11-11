/**
 * Client for the optional local MotionBricks helper (helper/server.py).
 * Everything here fails soft: with no helper running the page behaves exactly as before.
 */

export const HELPER_URL_KEY = "animlab-helper-url-v1";
export const DEFAULT_HELPER_URL = "http://127.0.0.1:8770";

const LOOPBACK_HOST_RE = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i;

export function helperBaseUrl() {
  try {
    const v = localStorage.getItem(HELPER_URL_KEY);
    if (v && LOOPBACK_HOST_RE.test(v)) return v;
  } catch {
    /* ignore */
  }
  return DEFAULT_HELPER_URL;
}

function isLoopbackUrl(url) {
  return LOOPBACK_HOST_RE.test(url);
}

/** Chrome LNA: public https → loopback needs targetAddressSpace (harmless where unsupported). */
function withLoopbackAddressSpace(init = {}) {
  if (!isLoopbackUrl(helperBaseUrl())) return { ...init };
  return { ...init, targetAddressSpace: "loopback" };
}

/**
 * Query Chrome's loopback Local Network Access permission.
 * Prefer "loopback-network" (Chrome 142+); never query "local-network-access"
 * (crashes some older Chromium builds). Guarded in try/catch.
 * @returns {"granted"|"prompt"|"denied"|"unknown"}
 */
export async function queryLoopbackPermission() {
  if (!navigator.permissions || typeof navigator.permissions.query !== "function") {
    return "unknown";
  }
  for (const name of ["loopback-network", "local-network"]) {
    try {
      const status = await navigator.permissions.query({ name });
      if (status && typeof status.state === "string") return status.state;
    } catch {
      /* unrecognized PermissionName */
    }
  }
  return "unknown";
}

async function req(path, init = {}, timeoutMs = 4000) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  const started = typeof performance !== "undefined" && performance.now ? performance.now() : Date.now();
  try {
    const res = await fetch(helperBaseUrl() + path, {
      ...withLoopbackAddressSpace(init),
      signal: ctl.signal,
      cache: "no-store",
    });
    return res;
  } catch (err) {
    const elapsed = (typeof performance !== "undefined" && performance.now ? performance.now() : Date.now()) - started;
    if (err && err.name === "AbortError") {
      err.helperKind = "timeout";
      err.helperElapsedMs = elapsed;
    } else {
      err.helperKind = "network";
      err.helperElapsedMs = elapsed;
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function json(res) {
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* not json */
  }
  if (!res.ok) {
    const err = new Error((data && data.error) || "Helper returned HTTP " + res.status);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

/**
 * -> { online, ready, mock, problems, data, error, blocked, permission }
 * blocked: browser LNA/CORS likely preventing loopback access (not "helper not running").
 */
export async function checkHealth() {
  let permission = "unknown";
  try {
    permission = await queryLoopbackPermission();
  } catch {
    permission = "unknown";
  }
  try {
    const data = await json(await req("/health"));
    return {
      online: true,
      ready: !!data.ready,
      mock: !!data.mock,
      problems: data.problems || [],
      data,
      error: null,
      blocked: false,
      permission,
    };
  } catch (err) {
    // Offline + Permissions API prompt/denied ⇒ treat as browser LNA block (not "helper down").
    // A stopped helper also yields TypeError; only label blocked when permission says so.
    const blocked = permission === "prompt" || permission === "denied";
    return {
      online: false,
      ready: false,
      mock: false,
      problems: [],
      data: null,
      error: err,
      blocked,
      permission,
    };
  }
}

export async function startGenerate(body) {
  return json(
    await req("/generate", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }, 15000)
  );
}

export async function getJob(id, since = 0) {
  return json(await req("/jobs/" + encodeURIComponent(id) + "?since=" + since, {}, 8000));
}

export async function cancelJob(id) {
  return json(await req("/jobs/" + encodeURIComponent(id) + "/cancel", { method: "POST" }, 8000));
}

export async function existingResults(names) {
  if (!names.length) return {};
  const data = await json(await req("/existing?names=" + encodeURIComponent(names.join(",")), {}, 8000));
  return (data && data.existing) || {};
}

export async function fetchResultBuffer(url) {
  const res = await req(url, {}, 60000);
  if (!res.ok) throw new Error("Could not download result (HTTP " + res.status + ")");
  return res.arrayBuffer();
}

// --- naming (must match helper/pipeline.py safe_name; the helper re-sanitises anyway) -----------------
function stem(clip) {
  let base = String(clip || "").replace(/\\/g, "/").split("/").pop() || "clip";
  base = base.replace(/\.fbx$/i, "");
  return base.split("@").pop();
}

function fnv6(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0").slice(0, 6);
}

export function safeName(s) {
  const t = String(s || "").replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^[._-]+|[._-]+$/g, "");
  return (t || "pair").slice(0, 120);
}

/** Deterministic output name for a pair: <start>_f<N>__<end>_f<N>_<hash>. */
export function pairName(pair) {
  if (pair.name) return safeName(pair.name);
  const s = pair.start || {};
  const e = pair.end || {};
  const key = [s.clip, s.frame, e.clip, e.frame].join("|");
  return safeName(`${stem(s.clip)}_f${s.frame}__${stem(e.clip)}_f${e.frame}_${fnv6(key)}`);
}

export function variantSuffix(v) {
  return v <= 1 ? "" : "_v" + String(v).padStart(2, "0");
}

export function resultUrl(name, variant, ext) {
  return "/result/" + name + variantSuffix(variant) + "." + ext;
}

export const SETUP_STEPS =
  "Double-click helper\\Start-Helper.bat (or run it from PowerShell). It opens a console window that must stay open. " +
  "When it prints \u201cready\u201d, this page connects by itself.";

export const LNA_STEPS =
  "Chrome (141+) blocks public sites from talking to programs on your PC until you allow Local network / Loopback access. " +
  "Click the Helper pill or Check again so Chrome can show the permission prompt. " +
  "If nothing appears: site settings (lock icon) \u2192 Local network access / Loopback network \u2192 Allow, then reload.";
