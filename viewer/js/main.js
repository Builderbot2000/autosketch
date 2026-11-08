// The live viewer (docs/design/12-observability.md, *Live viewer*). For the human only: it reads
// the server's /events stream and voxel endpoints and never talks to an agent or a tool.
//
// Flow: /info, then the base snapshot (its header carries the seq it is current as of), then
// /events?since=0 for the history the panels need. Block changes after the snapshot's seq are
// applied from deltas.bin ranges (fetched in batches), or, for ops without a delta (deltas off or
// capped), by re-reading the op's box. `resync` refetches the snapshot.

import { VoxelView } from "./gl.js";
import { Activity, SessionModel, scopeHue, toLocal } from "./model.js";
import { renderActivity, renderFeed, renderScopeTree, renderTimeline } from "./panels.js";
import { VoxelGrid, decodeRecords, decodeVoxels } from "./voxels.js";

const $ = (id) => document.getElementById(id);
const model = new SessionModel();
const activity = new Activity();
const grid = new VoxelGrid();
const filters = { doc: "", kind: "", tool: "", refusals: false };
let view;
let snapshotSeq = Infinity;
let selected = null;
let assets = null; // { models, atlasVersion } once loaded
let drill = null; // { scope, grid, view, seq }
let fitted = false;

function status(text, cls = "") {
  $("status").textContent = text;
  $("status").className = cls;
}

async function getJson(url) {
  const r = await fetch(url);
  if (!r.ok) throw Object.assign(new Error(`${url}: ${r.status}`), { status: r.status });
  return r.json();
}

async function getBuf(url) {
  const r = await fetch(url);
  if (!r.ok) throw Object.assign(new Error(`${url}: ${r.status}`), { status: r.status });
  return r.arrayBuffer();
}

function mergeStates(states) {
  for (const [id, s] of Object.entries(states)) model.states.set(Number(id), s);
}

async function loadSnapshot() {
  try {
    const { header, records } = decodeVoxels(await getBuf("doc/base/snapshot"));
    mergeStates(header.states);
    grid.clear();
    grid.applyRecords(records);
    snapshotSeq = header.seq;
    if (!fitted && (header.bounds || records.length)) {
      view.fit(header.bounds ?? grid.bounds());
      fitted = true;
    }
    scheduleAssets();
  } catch (e) {
    if (e.status === 404) snapshotSeq = 0; // no document open yet: every later delta applies
    else throw e;
  }
}

// -- assets --------------------------------------------------------------------------------------

let assetTimer = null;
function scheduleAssets() {
  clearTimeout(assetTimer);
  assetTimer = setTimeout(loadAssets, 250);
}

async function loadAssets() {
  let m;
  try {
    m = await getJson("assets/models.json");
  } catch {
    if (!assets) $("assets").textContent = "no instance textures: blocks drawn in flat colours";
    assets = assets ?? { models: {}, atlasVersion: -1 };
    for (const v of allViews()) v.setModels({}, model.states);
    return;
  }
  const atlasChanged = !assets || m.atlas.version !== assets.atlasVersion;
  assets = { models: m.models, atlasVersion: m.atlas.version };
  $("assets").textContent = `${Object.keys(m.models).length} baked models`;
  if (atlasChanged) {
    const img = new Image();
    img.src = `assets/atlas.png?v=${m.atlas.version}`;
    await img.decode();
    for (const v of allViews()) v.setAtlas(img);
  }
  for (const v of allViews()) v.setModels(m.models, model.states);
}

const allViews = () => [view, drill?.view].filter(Boolean);

// -- deltas --------------------------------------------------------------------------------------

let pending = [];
let deltaTimer = null;
function queueDelta(e) {
  pending.push(e);
  if (!deltaTimer) deltaTimer = setTimeout(flushDeltas, 80);
}

async function flushDeltas() {
  deltaTimer = null;
  const batch = pending;
  pending = [];
  if (!batch.length) return;
  const start = Math.min(...batch.map((e) => e.delta.offset));
  const end = Math.max(...batch.map((e) => e.delta.offset + e.delta.length));
  let buf;
  try {
    buf = await getBuf(`log/deltas?offset=${start}&length=${end - start}`);
  } catch {
    return;
  }
  for (const e of batch.sort((a, b) => a.seq - b.seq)) {
    const rec = decodeRecords(buf.slice(e.delta.offset - start, e.delta.offset - start + e.delta.length));
    applyChange(e, rec);
  }
}

function applyChange(e, rec) {
  if (e.doc === "base" && e.seq > snapshotSeq) {
    grid.applyRecords(rec);
    if (e.kind === "doc.op") activity.addRecords(rec);
    if (e.box) view.flash(e.box);
  }
  if (drill && e.doc === drill.scope && e.seq > drill.seq) {
    drill.grid.applyRecords(rec);
    if (e.box) drill.view.flash(e.box);
  }
  schedulePanels();
}

/** An op logged without a delta: re-read its box from the live document. */
async function refreshBox(e) {
  if (!e.box) return;
  if (e.doc === "base" && e.kind === "doc.op") activity.addBox(e.box, e.changed);
  const target = e.doc === "base" ? grid : drill && e.doc === drill.scope ? drill.grid : null;
  if (!target) return;
  try {
    const b = e.box;
    const { header, records } = decodeVoxels(await getBuf(`doc/${encodeURIComponent(e.doc)}/region?box=${[...b.min, ...b.max].join(",")}`));
    mergeStates(header.states);
    target.clearBox(b);
    target.applyRecords(records);
    (target === grid ? view : drill.view).flash(b);
  } catch {
    /* the document may be gone (merged sandbox) */
  }
}

// -- events --------------------------------------------------------------------------------------

function onEvent(e) {
  const prevDoc = model.doc;
  if (!model.apply(e)) return;
  switch (e.kind) {
    case "session.open":
      if (prevDoc && prevDoc !== e.name) {
        fitted = false;
        void loadSnapshot();
      } else if (!prevDoc && snapshotSeq === 0) void loadSnapshot();
      $("docname").textContent = e.name;
      break;
    case "state.add":
      if (assets && !assets.models[e.id]) scheduleAssets();
      break;
    case "doc.op":
    case "doc.undo":
    case "doc.redo":
      if (e.doc === "base" && e.shift) {
        void loadSnapshot(); // the base frame moved: refetch rather than patch
        break;
      }
      if (e.doc === "base" && e.seq <= snapshotSeq) {
        if (e.kind === "doc.op" && e.box) activity.addBox(e.box, e.changed); // history before the snapshot
        break;
      }
      if (e.delta) queueDelta(e);
      else void refreshBox(e);
      break;
    case "scope.merge":
      if (e.box) view.flash(e.box, [0.3, 1, 0.5]);
      break;
  }
  schedulePanels();
}

function connect() {
  const es = new EventSource(`events?since=${model.lastSeq}`);
  es.onopen = () => status("live", "live");
  es.onerror = () => status("disconnected, retrying…", "down");
  es.onmessage = (m) => onEvent(JSON.parse(m.data));
  es.addEventListener("resync", () => {
    status("resyncing…", "warn");
    void loadSnapshot().then(() => status("live", "live"));
  });
}

// -- overlays and panels -------------------------------------------------------------------------

function hueRgb(hue, l = 0.6) {
  const s = 0.8, a = s * Math.min(l, 1 - l);
  const f = (n) => {
    const k = (n + hue / 30) % 12;
    return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  };
  return [f(0), f(8), f(4)];
}

function updateOverlays() {
  const open = model.openScopes();
  view.overlays = [];
  for (const s of open) {
    const c = hueRgb(scopeHue(s.id));
    view.overlays.push({ box: s.work, color: [...c, 1], fill: selected === s.id ? 0.22 : 0.1 });
    if (s.context) view.overlays.push({ box: s.context, color: [...c, 0.45] });
  }
  view.needsDraw = true;
  const labels = $("labels");
  labels.replaceChildren(
    ...open.map((s) => {
      const el = document.createElement("div");
      el.className = "label";
      el.style.setProperty("--hue", scopeHue(s.id));
      el.textContent = `${s.id}: ${s.brief}`;
      el.dataset.scope = s.id;
      return el;
    }),
  );
}

function placeLabels() {
  for (const el of $("labels").children) {
    const s = model.scopes.get(el.dataset.scope);
    const p = s && view.project([(s.work.min[0] + s.work.max[0] + 1) / 2, s.work.max[1] + 1.5, (s.work.min[2] + s.work.max[2] + 1) / 2]);
    el.style.display = p ? "" : "none";
    if (p) el.style.transform = `translate(${p[0]}px, ${p[1]}px) translate(-50%, -100%)`;
  }
}

let panelTimer = null;
function schedulePanels() {
  if (!panelTimer) panelTimer = setTimeout(renderPanels, 120);
}

function renderPanels() {
  panelTimer = null;
  const select = (id) => selectScope(id);
  renderScopeTree($("scopes"), model, { selected, onSelect: select });
  renderFeed($("feed"), model, filters);
  renderTimeline($("timeline"), model, { selected, onSelect: select });
  renderActivity($("activity"), activity, model);
  updateOverlays();
  $("seq").textContent = `seq ${model.lastSeq}`;
  const docs = new Set(["base", ...model.scopes.keys()]);
  const sel = $("f-doc");
  if (sel.options.length !== docs.size + 1) {
    const cur = sel.value;
    sel.replaceChildren(new Option("all documents", ""), ...[...docs].map((d) => new Option(d, d)));
    sel.value = cur;
  }
}

// -- drill-in (panel 6) --------------------------------------------------------------------------

function selectScope(id) {
  selected = id;
  if (id !== "base") void openDrill(id);
  else closeDrill();
  renderPanels();
}

function closeDrill() {
  drill?.view.destroy();
  drill = null;
  $("drill").hidden = true;
}

async function openDrill(id) {
  const s = model.scopes.get(id);
  if (!s?.work) return;
  closeDrill();
  $("drill").hidden = false;
  $("drill-title").textContent = `${id}: ${s.brief} (${s.status})`;
  const g = new VoxelGrid();
  const v = new VoxelView($("drill-canvas"), g);
  const work = toLocal(s.work, s.translation);
  v.ghost = (x, y, z) => x < work.min[0] || y < work.min[1] || z < work.min[2] || x > work.max[0] || y > work.max[1] || z > work.max[2];
  v.overlays = [{ box: work, color: [...hueRgb(scopeHue(id)), 1] }];
  drill = { scope: id, grid: g, view: v, seq: 0 };
  if (assets) v.setModels(assets.models, model.states);
  if (assets?.atlasVersion >= 0) {
    const img = new Image();
    img.src = `assets/atlas.png?v=${assets.atlasVersion}`;
    img.decode().then(() => v.setAtlas(img), () => {});
  }
  let note = "sandbox frame; context ghosted";
  try {
    const { header, records } = decodeVoxels(await getBuf(`doc/${encodeURIComponent(id)}/snapshot`));
    mergeStates(header.states);
    g.applyRecords(records);
    drill.seq = header.seq;
  } catch {
    // The sandbox document isn't served (merged, abandoned, or not exposed): show the base
    // document's context region moved into the sandbox frame, then replay the job's own deltas.
    const box = s.context ?? s.work;
    note = s.status === "open" ? "sandbox not served: base context shown in the sandbox frame" : `${s.status}: base document region shown in the sandbox frame`;
    try {
      const { header, records } = decodeVoxels(await getBuf(`doc/base/region?box=${[...box.min, ...box.max].join(",")}`));
      mergeStates(header.states);
      g.applyRecords(records, s.translation.map((t) => -t));
    } catch {
      /* nothing to show */
    }
    if (s.status === "open") await replayScopeDeltas(id);
  }
  if (drill?.scope !== id) return;
  $("drill-note").textContent = note;
  v.fit(s.context ? toLocal(s.context, s.translation) : work);
}

/** Applies the job's own logged deltas (sandbox frame) to the drill-in grid. */
async function replayScopeDeltas(id) {
  const ops = model.events.filter((e) => e.doc === id && e.delta && /^doc\.(op|undo|redo)$/.test(e.kind));
  if (!ops.length) return;
  const start = ops[0].delta.offset, end = Math.max(...ops.map((e) => e.delta.offset + e.delta.length));
  try {
    const buf = await getBuf(`log/deltas?offset=${start}&length=${end - start}`);
    for (const e of ops) drill?.grid.applyRecords(decodeRecords(buf.slice(e.delta.offset - start, e.delta.offset - start + e.delta.length)));
  } catch {
    /* deltas unavailable */
  }
}

// -- start ---------------------------------------------------------------------------------------

async function main() {
  window.addEventListener("error", (e) => status(`error: ${e.message}`, "down"));
  window.addEventListener("unhandledrejection", (e) => status(`error: ${e.reason?.message ?? e.reason}`, "down"));
  try {
    view = new VoxelView($("view"), grid);
  } catch (e) {
    $("view-wrap").textContent = e.message;
    return;
  }
  view.onFrame = placeLabels;
  $("drill-close").onclick = () => {
    selected = null;
    closeDrill();
    renderPanels();
  };
  for (const [id, key, prop] of [["f-doc", "doc", "value"], ["f-kind", "kind", "value"], ["f-tool", "tool", "value"], ["f-refusals", "refusals", "checked"]])
    $(id).addEventListener("input", (e) => {
      filters[key] = e.target[prop];
      renderPanels();
    });
  $("fit").onclick = () => view.fit(grid.bounds() ?? model.bounds);
  try {
    const info = await getJson("info");
    $("docname").textContent = info.doc ?? "(no document open)";
    $("session").textContent = `session ${info.session}`;
    if (!info.deltas.on) $("assets").textContent = "deltas off: changes re-read per op";
    await loadSnapshot();
  } catch (e) {
    status(`failed: ${e.message}`, "down");
  }
  connect();
  setInterval(schedulePanels, 1000); // ages and the timeline's "now"
}

void main();
