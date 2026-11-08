// The viewer (docs/design/12-observability.md, *Live viewer*). For the human only: it reads the
// server's /events stream and voxel endpoints and never talks to an agent or a tool.
//
// Live session: /info, then the base snapshot (its header carries the seq it is current as of),
// then /events?since=0 for the history the panels need. Block changes after the snapshot's seq are
// applied from deltas.bin ranges (fetched in batches), or, for ops without a delta (deltas off or
// capped), by re-reading the op's box. `resync` refetches the snapshot.
//
// Replay (panel 7): the scrubber picks a seq; the views are rebuilt from the events up to it and
// deltas.bin (replay.js). Where a change has no delta, the newest time-lapse snapshot at or before
// that seq is shown instead. A finished log (`autosketch observe <path>`, /info `live: false`) has
// no document to read, so it is always shown through replay, following the end by default.

import { VoxelView } from "./gl.js";
import { Activity, SessionModel, scopeHue, toLocal } from "./model.js";
import { renderActivity, renderFeed, renderScopeTree, renderTimeline } from "./panels.js";
import { Replayer, activityAt, copyRegion, modelAt, recordsOf, scopeSteps } from "./replay.js";
import { VoxelGrid, decodeRecords, decodeVoxels } from "./voxels.js";

const $ = (id) => document.getElementById(id);
const model = new SessionModel();
let activity = new Activity();
const grid = new VoxelGrid();
const filters = { doc: "", kind: "", tool: "", refusals: false };
let view;
let snapshotSeq = Infinity;
let selected = null;
let assets = null; // { models, atlasVersion } once loaded
let drill = null; // { scope, grid, view, seq }
let fitted = false;

// Replay state.
let live = true; // a live session (false: a finished log)
let deltasOn = false;
const allEvents = []; // every event, in seq order (the model keeps only the newest)
let replaySeq = null; // null: follow the latest event
let shown = { model, activity, now: undefined }; // what the panels draw
const replayer = new Replayer(grid);
let deltaBuf = new ArrayBuffer(0); // deltas.bin from byte 0, as far as fetched
let fallbackKey = null; // the gap/snapshot pair the user dismissed

const replaying = () => !live || replaySeq !== null;

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
  if (replaying()) return;
  try {
    const { header, records } = decodeVoxels(await getBuf("doc/base/snapshot"));
    if (replaying()) return;
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

// -- live deltas ---------------------------------------------------------------------------------

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
  if (replaying()) return; // the replayed grid is rebuilt from the log instead
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
  if (!e.box || replaying()) return;
  if (e.doc === "base" && e.kind === "doc.op") activity.addBox(e.box, e.changed);
  const target = e.doc === "base" ? grid : drill && e.doc === drill.scope ? drill.grid : null;
  if (!target) return;
  try {
    const b = e.box;
    const { header, records } = decodeVoxels(await getBuf(`doc/${encodeURIComponent(e.doc)}/region?box=${[...b.min, ...b.max].join(",")}`));
    if (replaying()) return;
    mergeStates(header.states);
    target.clearBox(b);
    target.applyRecords(records);
    (target === grid ? view : drill.view).flash(b);
  } catch {
    /* the document may be gone (merged sandbox) */
  }
}

// -- replay --------------------------------------------------------------------------------------

let fetching = Promise.resolve();
/** Extends the deltas.bin cache to `end` bytes. */
function ensureDeltas(end) {
  fetching = fetching.then(async () => {
    if (!deltasOn || end <= deltaBuf.byteLength) return;
    const start = deltaBuf.byteLength;
    try {
      const buf = await getBuf(`log/deltas?offset=${start}&length=${end - start}`);
      const joined = new Uint8Array(start + buf.byteLength);
      joined.set(new Uint8Array(deltaBuf));
      joined.set(new Uint8Array(buf), start);
      deltaBuf = joined.buffer;
    } catch {
      /* deltas unavailable: replay shows what it has */
    }
  });
  return fetching;
}

function deltaEndAt(seq) {
  let end = 0;
  for (const e of allEvents) {
    if (e.seq > seq) break;
    if (e.delta) end = Math.max(end, e.delta.offset + e.delta.length);
  }
  return end;
}

const lastSeq = () => allEvents[allEvents.length - 1]?.seq ?? 0;

let replayToken = 0;
let replayTimer = null;
/** Rebuilds the views at the scrubber's position (or the end when following a finished log). */
function scheduleReplay(delay = 30) {
  clearTimeout(replayTimer);
  replayTimer = setTimeout(() => void replayTo(replaySeq ?? lastSeq()), delay);
}

async function replayTo(seq) {
  const token = ++replayToken;
  await ensureDeltas(deltaEndAt(seq));
  if (token !== replayToken || !replaying()) return;
  const before = replayer.seq;
  const plan = replayer.seek(allEvents, seq, deltaBuf);
  shown = { model: modelAt(allEvents, seq), activity: activityAt(allEvents, seq, deltaBuf), now: allEvents.find((e) => e.seq >= seq)?.t };
  if (seq > before && before >= 0) for (const e of plan.steps.filter((e) => e.seq > before && e.box).slice(-20)) view.flash(e.box);
  if (!fitted && plan.steps.length) {
    view.fit(grid.bounds() ?? shown.model.bounds);
    fitted = true;
  }
  if (assets === null) scheduleAssets();
  showFallback(plan);
  if (drill) fillDrillFromReplay(seq);
  updateScrubber();
  renderPanels();
}

/** Where the rebuilt grid is incomplete, shows the newest time-lapse snapshot instead (12). */
function showFallback(plan) {
  const fig = $("fallback");
  if (!plan.gap) {
    fig.hidden = true;
    return;
  }
  const key = `${plan.gap.seq}:${plan.snapshot?.seq ?? "-"}`;
  const why = plan.gap.kind === "session.open" ? "this log has no deltas" : `deltas were capped at seq ${plan.gap.seq}`;
  if (plan.snapshot) {
    $("fallback-img").hidden = false;
    $("fallback-img").src = `log/${plan.snapshot.path}`;
    $("fallback-note").textContent = `${why}: time-lapse snapshot from seq ${plan.snapshot.seq}`;
  } else {
    $("fallback-img").hidden = true;
    $("fallback-note").textContent = `${why} and there is no time-lapse snapshot before this point: the 3D view is incomplete`;
  }
  fig.hidden = fallbackKey === key;
  fig.dataset.key = key;
}

function updateScrubber() {
  const r = $("replay-seq");
  const first = allEvents[0]?.seq ?? 0, last = lastSeq();
  r.min = String(first);
  r.max = String(last);
  const at = replaySeq ?? last;
  if (document.activeElement !== r) r.value = String(at);
  const t0 = allEvents[0]?.t ?? 0;
  const t = allEvents.find((e) => e.seq >= at)?.t ?? t0;
  const s = Math.max(0, Math.round((t - t0) / 1000));
  $("replay-pos").textContent = `seq ${at} / ${last} · +${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  $("replay-live").classList.toggle("on", replaySeq === null);
}

/** Leaves replay: back to the live document (or the end of a finished log). */
function follow() {
  stopPlay();
  replaySeq = null;
  if (!live) return void scheduleReplay(0);
  replayer.reset();
  $("fallback").hidden = true;
  shown = { model, activity, now: undefined };
  snapshotSeq = Infinity;
  void (async () => {
    await ensureDeltas(deltaEndAt(lastSeq()));
    activity = activityAt(allEvents, lastSeq(), deltaBuf);
    shown = { model, activity, now: undefined };
    await loadSnapshot();
    if (drill) void openDrill(drill.scope);
    updateScrubber();
    renderPanels();
  })();
}

function seek(seq) {
  replaySeq = Math.max(allEvents[0]?.seq ?? 0, Math.min(seq, lastSeq()));
  scheduleReplay(0);
}

let playTimer = null;
function stopPlay() {
  clearInterval(playTimer);
  playTimer = null;
  $("replay-play").textContent = "▶";
}

function togglePlay() {
  if (playTimer) return stopPlay();
  if (replaySeq === null || replaySeq >= lastSeq()) replaySeq = allEvents[0]?.seq ?? 0;
  $("replay-play").textContent = "❚❚";
  playTimer = setInterval(() => {
    // Step to the next event that changes something visible.
    const next = allEvents.find((e) => e.seq > replaySeq && /^(doc\.|scope\.|session\.open|call\.refused)/.test(e.kind));
    if (!next) {
      stopPlay();
      return;
    }
    seek(next.seq);
  }, 120);
}

// -- events --------------------------------------------------------------------------------------

function onEvent(e) {
  const prevDoc = model.doc;
  if (!model.apply(e)) return;
  allEvents.push(e);
  if (e.kind === "session.open") $("docname").textContent = e.name;
  if (e.kind === "state.add" && assets && !assets.models[e.id]) scheduleAssets();
  if (replaying()) {
    if (!live && replaySeq === null) scheduleReplay();
    else updateScrubber();
    return;
  }
  switch (e.kind) {
    case "session.open":
      if (prevDoc && prevDoc !== e.name) {
        fitted = false;
        void loadSnapshot();
      } else if (!prevDoc && snapshotSeq === 0) void loadSnapshot();
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
  updateScrubber();
  schedulePanels();
}

function connect() {
  const es = new EventSource(`events?since=${model.lastSeq}`);
  es.onopen = () => status(live ? "live" : "finished log", "live");
  es.onerror = () => status(live ? "disconnected, retrying…" : "viewer server stopped", "down");
  es.onmessage = (m) => onEvent(JSON.parse(m.data));
  es.addEventListener("resync", () => {
    if (!live) return;
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
  const open = shown.model.openScopes();
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
    const s = shown.model.scopes.get(el.dataset.scope);
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
  clearTimeout(panelTimer);
  panelTimer = null;
  const select = (id) => selectScope(id);
  const m = shown.model;
  const now = shown.now ?? (live ? Date.now() : m.now);
  renderScopeTree($("scopes"), m, { selected, onSelect: select, now });
  renderFeed($("feed"), m, filters);
  renderTimeline($("timeline"), m, { selected, onSelect: select, ...(replaying() ? { now } : {}) });
  renderActivity($("activity"), shown.activity, m);
  updateOverlays();
  $("seq").textContent = `seq ${m.lastSeq}`;
  const docs = new Set(["base", ...m.scopes.keys()]);
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
  const s = shown.model.scopes.get(id) ?? model.scopes.get(id);
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
  if (replaying()) {
    note = "replay: the base document's context at this seq, in the sandbox frame, plus the job's own ops";
    fillDrillFromReplay(replaySeq ?? lastSeq());
  } else {
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
  }
  if (drill?.scope !== id) return;
  $("drill-note").textContent = note;
  v.fit(s.context ? toLocal(s.context, s.translation) : work);
}

/** Drill-in during replay: the replayed base context moved into the sandbox frame, then the job's deltas up to `seq`. */
function fillDrillFromReplay(seq) {
  const s = shown.model.scopes.get(drill.scope) ?? model.scopes.get(drill.scope);
  if (!s?.work) return;
  drill.grid.clear();
  copyRegion(grid, s.context ?? s.work, drill.grid, s.translation.map((t) => -t));
  for (const e of scopeSteps(allEvents, drill.scope, seq)) if (deltaBuf.byteLength >= e.delta.offset + e.delta.length) drill.grid.applyRecords(recordsOf(e, deltaBuf));
  $("drill-title").textContent = `${s.id}: ${s.brief} (${s.status} at seq ${seq})`;
}

/** Applies the job's own logged deltas (sandbox frame) to the drill-in grid. */
async function replayScopeDeltas(id) {
  const ops = model.events.filter((e) => e.doc === id && e.delta && e.delta.length && /^doc\.(op|undo|redo)$/.test(e.kind));
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
  $("fit").onclick = () => view.fit(grid.bounds() ?? shown.model.bounds);
  $("replay-seq").addEventListener("input", (e) => {
    stopPlay();
    seek(Number(e.target.value));
  });
  $("replay-live").onclick = follow;
  $("replay-play").onclick = togglePlay;
  $("fallback-close").onclick = () => {
    fallbackKey = $("fallback").dataset.key;
    $("fallback").hidden = true;
  };
  try {
    const info = await getJson("info");
    live = info.live !== false;
    deltasOn = !!info.deltas?.on;
    $("docname").textContent = info.doc ?? "(no document open)";
    $("session").textContent = `${live ? "session" : "finished log"} ${info.session}`;
    $("replay-live").textContent = live ? "Live" : "End";
    $("replay-live").title = live ? "Follow the latest event" : "Jump to the end of the log";
    if (!deltasOn) $("assets").textContent = live ? "deltas off: changes re-read per op" : "no deltas in this log: snapshots only";
    else if (info.deltas.capped) $("assets").textContent = "deltas capped: later changes fall back to snapshots";
    if (live) await loadSnapshot();
  } catch (e) {
    status(`failed: ${e.message}`, "down");
  }
  connect();
  setInterval(() => {
    if (live && replaySeq === null) schedulePanels(); // ages and the timeline's "now"
  }, 1000);
}

void main();
