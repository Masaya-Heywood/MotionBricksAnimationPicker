/** Collapsible, virtualized folder tree for the clip list. */

export const ROW_HEIGHT = 28;
export const EXPAND_STORE_KEY = "animlab-tree-expanded-v1";
export const HIDDEN_STORE_KEY = "animlab-tree-hidden-v1";
export const SHOW_HIDDEN_KEY = "animlab-tree-show-hidden-v1";

const OVERSCAN = 12;

function loadJson(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}
function saveJson(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* quota / private mode */
  }
}

export function loadExpanded(rootId) {
  const all = loadJson(EXPAND_STORE_KEY, {});
  const rec = all && all[rootId];
  if (rec && Array.isArray(rec.keys)) return { set: new Set(rec.keys), saved: true };
  return { set: new Set(), saved: false };
}

export function saveExpanded(rootId, set) {
  const all = loadJson(EXPAND_STORE_KEY, {});
  all[rootId] = { keys: [...set] };
  saveJson(EXPAND_STORE_KEY, all);
}

export function loadHidden(rootId) {
  const all = loadJson(HIDDEN_STORE_KEY, {});
  const list = all && all[rootId];
  return new Set(Array.isArray(list) ? list : []);
}

export function saveHidden(rootId, set) {
  const all = loadJson(HIDDEN_STORE_KEY, {});
  all[rootId] = [...set];
  saveJson(HIDDEN_STORE_KEY, all);
}

export function loadShowHidden() {
  try {
    return localStorage.getItem(SHOW_HIDDEN_KEY) === "1";
  } catch {
    return false;
  }
}

export function saveShowHidden(on) {
  try {
    localStorage.setItem(SHOW_HIDDEN_KEY, on ? "1" : "0");
  } catch {
    /* ignore */
  }
}

function sortFolders(a, b) {
  return a.label.toLowerCase().localeCompare(b.label.toLowerCase());
}
function sortClips(a, b) {
  return String(a.name || a.path).toLowerCase().localeCompare(String(b.name || b.path).toLowerCase());
}

function recount(node) {
  let n = node.clips.length;
  for (const ch of node.children) n += recount(ch);
  node.count = n;
  return n;
}

function collapseNode(node) {
  node.children = node.children.map(collapseNode);
  // Merge single-child folder chains into one row: A / B / C
  while (node.key && node.children.length === 1 && node.clips.length === 0) {
    const only = node.children[0];
    node.label = node.label ? node.label + " / " + only.label : only.label;
    node.key = only.key;
    node.path = only.path;
    node.children = only.children;
    node.clips = only.clips;
  }
  return node;
}

/** Build a folder tree from clip.path, collapsing single-child folder chains. */
export function buildFolderTree(clips) {
  const root = {
    type: "folder",
    key: "",
    label: "",
    path: "",
    children: [],
    clips: [],
    count: 0,
  };
  const index = new Map([["", root]]);
  for (const clip of clips) {
    const parts = String(clip.path || "")
      .replace(/\\/g, "/")
      .split("/")
      .filter(Boolean);
    if (!parts.length) continue;
    parts.pop();
    let parent = root;
    let acc = [];
    for (const part of parts) {
      acc.push(part);
      const key = acc.join("/");
      let child = index.get(key);
      if (!child) {
        child = {
          type: "folder",
          key,
          label: part,
          path: key,
          children: [],
          clips: [],
          count: 0,
        };
        parent.children.push(child);
        index.set(key, child);
      }
      parent = child;
    }
    parent.clips.push(clip);
  }
  root.children.sort(sortFolders);
  const walk = (n) => {
    n.children.sort(sortFolders);
    n.clips.sort(sortClips);
    n.children.forEach(walk);
  };
  walk(root);
  root.children = root.children.map(collapseNode);
  recount(root);
  return root;
}

function collectFolderKeys(node, out = []) {
  for (const ch of node.children) {
    out.push(ch.key);
    collectFolderKeys(ch, out);
  }
  return out;
}

export function flattenVisibleRows(root, options = {}) {
  const expanded = options.expanded || new Set();
  const hidden = options.hidden || new Set();
  const showHidden = !!options.showHidden;
  const rows = [];

  function walkFolder(folder, depth, parentHidden) {
    const hid = parentHidden || hidden.has(folder.key);
    if (hid && !showHidden) return;
    rows.push({
      type: "folder",
      key: folder.key,
      path: folder.path,
      label: folder.label,
      count: folder.count,
      depth,
      hidden: hid,
      expanded: expanded.has(folder.key),
    });
    if (!expanded.has(folder.key)) return;
    for (const ch of folder.children) walkFolder(ch, depth + 1, hid);
    for (const clip of folder.clips) {
      rows.push({
        type: "clip",
        key: clip.path,
        path: clip.path,
        clip,
        depth: depth + 1,
        hidden: hid,
      });
    }
  }

  for (const ch of root.children) walkFolder(ch, 0, false);
  for (const clip of root.clips) {
    rows.push({ type: "clip", key: clip.path, path: clip.path, clip, depth: 0, hidden: false });
  }
  return rows;
}

/** Folder keys that should be open so every matching clip is reachable. */
export function expandKeysForMatches(root, keep = new Set()) {
  function walk(node, ancestors) {
    let hit = false;
    for (const clip of node.clips) {
      if (keep.has(clip.path)) hit = true;
    }
    for (const ch of node.children) {
      if (walk(ch, ancestors.concat(ch))) hit = true;
    }
    if (hit && node.key) ancestors; // ancestors already include node if passed that way
    return hit;
  }
  const open = new Set();
  function visit(node) {
    let hit = node.clips.some((c) => keep.has(c.path));
    for (const ch of node.children) {
      if (visit(ch)) {
        open.add(ch.key);
        hit = true;
      }
    }
    return hit;
  }
  visit(root);
  return open;
}

export function createTreeList(opts) {
  const container = opts.container;
  const escapeHtml = opts.escapeHtml;
  const formatSize = opts.formatSize;
  const rowHeight = opts.rowHeight || ROW_HEIGHT;

  let rows = [];
  let visibleClips = [];
  let tree = null;
  let expanded = new Set();
  let hidden = new Set();
  let showHidden = loadShowHidden();
  let searchSnapshot = null;
  let lastQuery = "";
  let lastRootId = "";
  let paintRaf = 0;

  function rootId() {
    return (opts.getRootId && opts.getRootId()) || "_";
  }

  function applyDefaultExpanded(nextTree, rec) {
    if (rec.saved) return rec.set;
    const set = new Set();
    for (const ch of nextTree.children) set.add(ch.key);
    return set;
  }

  function ensureState(nextTree) {
    const id = rootId();
    if (id !== lastRootId) {
      lastRootId = id;
      hidden = loadHidden(id);
      const rec = loadExpanded(id);
      expanded = applyDefaultExpanded(nextTree, rec);
      if (!rec.saved) saveExpanded(id, expanded);
      searchSnapshot = null;
      lastQuery = "";
    }
  }

  function currentQuery() {
    return ((opts.getQuery && opts.getQuery()) || "").trim();
  }

  function filterClips(all) {
    const q = currentQuery().toLowerCase();
    const starredOnly = !!(opts.getStarredOnly && opts.getStarredOnly());
    return all.filter((c) => {
      if (starredOnly && opts.isStarred && !opts.isStarred(c.path)) return false;
      if (!q) return true;
      return (c.path + " " + c.name + " " + (c.folder || "") + " " + (c.pack || ""))
        .toLowerCase()
        .includes(q);
    });
  }

  function folderHtml(row) {
    const pad = 8 + row.depth * 14;
    const twistyDir = row.expanded ? "expanded" : "collapsed";
    const hid = row.hidden ? " hidden-folder" : "";
    const eyeLabel = row.hidden ? "Show" : "Hide";
    const eyeTitle = row.hidden ? "Show this folder" : "Hide this folder";
    const eyeOn = row.hidden ? " is-hidden" : "";
    return (
      `<div class="tree-row tree-folder${hid}" data-folder-key="${escapeHtml(row.key)}" style="padding-left:${pad}px;height:${rowHeight}px">` +
      `<span class="twisty ${twistyDir}" aria-hidden="true"></span>` +
      `<span class="tree-label" title="${escapeHtml(row.path)}">${escapeHtml(row.label)}</span>` +
      `<span class="tree-count">${row.count}</span>` +
      `<button type="button" class="tree-hide${eyeOn}" data-hide-folder="${escapeHtml(row.key)}" title="${eyeTitle}" aria-label="${eyeTitle}">${eyeLabel}</button>` +
      `</div>`
    );
  }

  function clipHtml(row) {
    const clip = row.clip;
    const pad = 8 + row.depth * 14;
    const selected = opts.getSelectedPath && opts.getSelectedPath() === clip.path;
    const starred = opts.isStarred && opts.isStarred(clip.path);
    const active = selected ? " active" : "";
    const starCls = starred ? " starred" : "";
    const hid = row.hidden ? " hidden-folder" : "";
    return (
      `<div class="tree-row clip-item${active}${starCls}${hid}" data-path="${escapeHtml(clip.path)}" title="${escapeHtml(clip.path)}" style="padding-left:${pad}px;height:${rowHeight}px">` +
      `<span class="star" data-star-path="${escapeHtml(clip.path)}">${starred ? "★" : "☆"}</span>` +
      `<span class="clip-name">${escapeHtml(clip.name)}</span>` +
      `<span class="clip-size">${formatSize(clip.size)}</span>` +
      `</div>`
    );
  }

  function paint() {
    paintRaf = 0;
    if (!container) return;
    const total = rows.length;
    const height = Math.max(1, container.clientHeight);
    const scrollTop = container.scrollTop;
    if (!total) {
      return;
    }
    const start = Math.max(0, Math.floor(scrollTop / rowHeight) - OVERSCAN);
    const end = Math.min(total, Math.ceil((scrollTop + height) / rowHeight) + OVERSCAN);
    const top = start * rowHeight;
    const parts = [];
    parts.push(`<div class="tree-space" style="height:${total * rowHeight}px">`);
    parts.push(`<div class="tree-window" style="transform:translateY(${top}px)">`);
    for (let i = start; i < end; i++) {
      const row = rows[i];
      parts.push(row.type === "folder" ? folderHtml(row) : clipHtml(row));
    }
    parts.push(`</div></div>`);
    container.innerHTML = parts.join("");
  }

  function schedulePaint() {
    if (paintRaf) return;
    paintRaf = requestAnimationFrame(paint);
  }

  function scrollPathIntoView(path) {
    const idx = rows.findIndex((r) => r.type === "clip" && r.path === path);
    if (idx < 0) return;
    const top = idx * rowHeight;
    const bottom = top + rowHeight;
    const viewTop = container.scrollTop;
    const viewBot = viewTop + container.clientHeight;
    if (top < viewTop) container.scrollTop = top;
    else if (bottom > viewBot) container.scrollTop = bottom - container.clientHeight;
  }

  function render(flags = {}) {
    const all = (opts.getClips && opts.getClips()) || [];
    const filtered = filterClips(all);
    const q = currentQuery();
    tree = buildFolderTree(filtered);
    ensureState(tree);

    // Search: snapshot expansion, auto-open folders with matches, hide the rest via the filtered tree.
    if (q) {
      if (!searchSnapshot) searchSnapshot = new Set(expanded);
      lastQuery = q;
      const keep = new Set(filtered.map((c) => c.path));
      expanded = expandKeysForMatches(tree, keep);
    } else if (lastQuery && !q) {
      if (searchSnapshot) expanded = searchSnapshot;
      searchSnapshot = null;
      lastQuery = "";
    }

    rows = flattenVisibleRows(tree, { expanded, hidden, showHidden });
    visibleClips = rows.filter((r) => r.type === "clip").map((r) => r.clip);

    if (opts.countEl) {
      const hidN = hidden.size;
      const suffix = hidN && !showHidden ? ` · ${hidN} hidden folder${hidN === 1 ? "" : "s"}` : "";
      opts.countEl.textContent = all.length
        ? `${filtered.length} of ${all.length} clips${suffix}`
        : "No clips";
    }

    if (!all.length) {
      container.innerHTML = `<div class="empty-list">No .fbx files found in this folder.</div>`;
      return visibleClips;
    }
    if (!filtered.length) {
      container.innerHTML = `<div class="empty-list">No clips match this search.</div>`;
      return visibleClips;
    }
    if (!rows.length) {
      container.innerHTML = `<div class="empty-list">${
        hidden.size
          ? "All matching folders are hidden. Turn on “Show hidden” to see them."
          : "No clips to show."
      }</div>`;
      return visibleClips;
    }

    if (flags.scrollToPath) scrollPathIntoView(flags.scrollToPath);
    paint();
    return visibleClips;
  }

  function persistExpanded() {
    if (currentQuery()) return; // don't persist search-time expansion
    saveExpanded(rootId(), expanded);
  }

  function toggleFolder(key) {
    if (expanded.has(key)) expanded.delete(key);
    else expanded.add(key);
    persistExpanded();
    render();
  }

  function toggleHidden(key) {
    if (hidden.has(key)) hidden.delete(key);
    else hidden.add(key);
    saveHidden(rootId(), hidden);
    render();
  }

  function expandAll() {
    if (!tree) return;
    expanded = new Set(collectFolderKeys(tree));
    persistExpanded();
    render();
  }

  function collapseAll() {
    expanded = new Set();
    persistExpanded();
    render();
  }

  function setShowHidden(on) {
    showHidden = !!on;
    saveShowHidden(showHidden);
    render();
  }

  function stepSelection(dir) {
    if (!visibleClips.length) return null;
    const selected = opts.getSelectedPath && opts.getSelectedPath();
    const idx = visibleClips.findIndex((c) => c.path === selected);
    let next = idx + dir;
    if (idx < 0) next = dir > 0 ? 0 : visibleClips.length - 1;
    if (next < 0) next = 0;
    if (next >= visibleClips.length) next = visibleClips.length - 1;
    const clip = visibleClips[next];
    if (!clip) return null;
    if (opts.onSelect) opts.onSelect(clip.path, true, { fromTree: true });
    return clip.path;
  }

  function onClick(e) {
    const hideBtn = e.target.closest("[data-hide-folder]");
    if (hideBtn) {
      e.preventDefault();
      e.stopPropagation();
      toggleHidden(hideBtn.getAttribute("data-hide-folder"));
      return;
    }
    const star = e.target.closest("[data-star-path]");
    if (star) {
      e.preventDefault();
      e.stopPropagation();
      if (opts.onToggleStar) opts.onToggleStar(star.getAttribute("data-star-path"));
      return;
    }
    const folder = e.target.closest("[data-folder-key]");
    if (folder) {
      toggleFolder(folder.getAttribute("data-folder-key"));
      return;
    }
    const item = e.target.closest("[data-path]");
    if (item && opts.onSelect) opts.onSelect(item.getAttribute("data-path"), true);
  }

  function onScroll() {
    schedulePaint();
  }

  container.addEventListener("click", onClick);
  container.addEventListener("scroll", onScroll, { passive: true });
  if (typeof ResizeObserver === "function") {
    new ResizeObserver(() => schedulePaint()).observe(container);
  }

  return {
    render,
    stepSelection,
    getVisibleClips: () => visibleClips,
    getRows: () => rows,
    expandAll,
    collapseAll,
    setShowHidden,
    getShowHidden: () => showHidden,
    hiddenCount: () => hidden.size,
    expandKeys: () => expanded,
    debug: () => ({
      rowCount: rows.length,
      visibleClipCount: visibleClips.length,
      expanded: [...expanded],
      hidden: [...hidden],
      showHidden,
      searching: !!currentQuery(),
      folderLabels: rows.filter((r) => r.type === "folder").map((r) => r.label),
      visiblePaths: visibleClips.map((c) => c.path),
    }),
  };
}
