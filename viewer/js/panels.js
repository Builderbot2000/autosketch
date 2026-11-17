// DOM panels (docs/design/12-observability.md, *Panels*): scope tree, event feed, job timeline
// and the top-down activity map. Each takes the SessionModel and redraws from it.

import { describe, filterEvents, scopeHue } from "./model.js";

const h = (tag, attrs = {}, ...kids) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") el.className = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null && v !== false) el.setAttribute(k, v);
  }
  for (const k of kids.flat()) if (k !== null && k !== undefined) el.append(k);
  return el;
};

export const ago = (t, now) => {
  const s = Math.max(0, Math.round((now - t) / 1000));
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
};

/** Panel 2: a live, human-readable scope_list(). */
export function renderScopeTree(el, model, { selected, onSelect, now = Date.now() }) {
  const node = ({ scope: s, children }) => {
    const age = s.forkT ? ago(s.forkT, s.endT ?? now) : "";
    const row = h(
      "div",
      { class: `scope ${s.status}${selected === s.id ? " selected" : ""}`, style: `--hue:${scopeHue(s.id)}`, title: s.report ? `report: ${s.report}` : s.brief, onclick: () => onSelect(s.id) },
      h("span", { class: "swatch" }),
      h("b", {}, s.id === "base" ? model.doc ?? "base" : s.id),
      h("span", { class: "status" }, s.id === "base" ? "base" : s.status),
      h("span", { class: "meta" }, `${age}${age ? " · " : ""}${s.ops} ops${s.lastTool ? " · " + s.lastTool : ""}${s.refusals.length ? ` · ${s.refusals.length} refused` : ""}${spendText(model.spend?.scopeTotals(s.id))}`),
      s.id !== "base" ? h("div", { class: "brief" }, s.brief) : null,
    );
    return h("div", { class: "node" }, row, children.length ? h("div", { class: "children" }, children.map(node)) : null);
  };
  el.replaceChildren(node(model.tree()));
}

/** Panel 3: the event feed, filtered; refusals highlighted. */
export function renderFeed(el, model, filters, limit = 400) {
  const rows = filterEvents(model.events, filters).slice(-limit).reverse();
  el.replaceChildren(
    ...rows.map((e) =>
      h(
        "div",
        { class: `ev k-${e.kind.replace(/\./g, "-")}${e.kind === "call.refused" ? " refused" : ""}${e.kind === "call.end" && !e.ok ? " failed" : ""}` },
        h("span", { class: "seq" }, e.seq ?? ""),
        h("span", { class: "doc", style: `--hue:${scopeHue(e.doc ?? "base")}` }, e.doc ?? ""),
        h("span", { class: "kind" }, e.kind),
        h("span", { class: "text" }, describe(e) + (e.kind === "call.end" ? actionLabel(model.spend?.label(e.call)) : "")),
      ),
    ),
  );
}

/** "12.3k" style token counts. */
export const tok = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e4 ? `${Math.round(n / 1e3)}k` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(Math.round(n)));
const usd = (c) => `$${c < 1 ? c.toFixed(3) : c.toFixed(2)}`;
const allTokens = (t) => t.input + t.output + t.cacheRead + t.cacheWrite;

function spendText(t) {
  return t ? ` · ${tok(allTokens(t))} tok · ${usd(t.cost)}` : "";
}

/** A call's tokens (13 B3): the issuing request's output tokens, split across its tool calls, and the result size. */
function actionLabel(l) {
  if (!l) return "";
  const parts = [];
  if (l.outputTokens !== undefined) parts.push(`${tok(l.outputTokens)} out tok${l.shared > 1 ? ` (1/${l.shared} of a request)` : ""}`);
  if (l.bytes !== undefined) parts.push(`result ${tok(l.bytes)} B`);
  return parts.length ? ` · ${parts.join(", ")}` : "";
}

/**
 * Token spend from Claude Code's OpenTelemetry (13 B3): per-prompt totals by token type with cost,
 * counting up as batches arrive. `otel` is /info's `otel` (live sessions only): with no records yet,
 * a notice with the setup snippet.
 */
export function renderSpend(el, spend, otel) {
  if (!spend.records) {
    if (!otel) {
      el.replaceChildren(h("div", { class: "dim spend-note" }, "no token data in this log"));
      return;
    }
    const snippet = JSON.stringify({ env: otel.setup }, null, 2);
    el.replaceChildren(
      h(
        "div",
        { class: "spend-note" },
        "No token data from Claude Code yet. To see per-prompt and per-action token spend, add this to ~/.claude/settings.json (a repository's .claude/settings.json can't set exporters) and restart Claude Code:",
        h("pre", { class: "snippet" }, snippet),
        otel.portPinned
          ? null
          : h("div", { class: "warn" }, `This viewer is on a free port this launch (${otel.setup.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT.replace(/^.*:(\d+)\/.*$/, "$1")}), because its usual port was taken or observe.http is set to true. The port changes every launch, so telemetry may not reach it; close the other session or pin a port in Settings (observe.http).`),
      ),
    );
    return;
  }
  const t = spend.total;
  const row = (label, x, cls = "") =>
    h("div", { class: `spend-row ${cls}` },
      h("span", { class: "spend-label" }, label),
      h("span", { title: "input" }, `in ${tok(x.input)}`),
      h("span", { title: "output" }, `out ${tok(x.output)}`),
      h("span", { title: "cache read" }, `cache r ${tok(x.cacheRead)}`),
      h("span", { title: "cache write" }, `cache w ${tok(x.cacheWrite)}`),
      h("b", {}, usd(x.cost)),
    );
  const prompts = spend.promptList().slice(0, 12);
  el.replaceChildren(
    row(`session · ${t.requests} requests`, t, "total"),
    ...prompts.map((p, i) => {
      const what = p.command ? `/${p.command}` : p.text ? p.text.slice(0, 40) : `prompt ${spend.prompts.size - i}${p.length !== undefined ? ` (${p.length} chars)` : ""}`;
      return row(what, p.tokens);
    }),
  );
}

/** Panel 5: one bar per job from fork to merge, nested under its parent; refusals and lock waits marked. */
export function renderTimeline(el, model, { selected, onSelect, now }) {
  const rows = model.timelineRows();
  const t0 = rows[0]?.start ?? 0;
  // A live session runs to now; a finished one (no open scopes) ends at its last event.
  const live = model.openScopes().length > 0;
  // During replay the caller passes the replayed event's time as "now".
  const t1 = Math.max(now ?? (live ? Date.now() : model.now), t0 + 1000);
  const W = Math.max(300, el.clientWidth || 600), rowH = 18, labelW = 120;
  const x = (t) => labelW + ((t - t0) / (t1 - t0)) * (W - labelW - 8);
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("width", W);
  svg.setAttribute("height", rows.length * rowH + 20);
  const s = (tag, attrs, text) => {
    const n = document.createElementNS("http://www.w3.org/2000/svg", tag);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
    if (text !== undefined) n.textContent = text;
    svg.append(n);
    return n;
  };
  rows.forEach((r, i) => {
    const y = i * rowH + 2;
    const sc = r.scope;
    const hue = scopeHue(sc.id);
    const label = s("text", { x: 4 + sc.depth * 8, y: y + 12, class: "tl-label" }, sc.id === "base" ? model.doc ?? "base" : sc.id);
    label.addEventListener("click", () => onSelect(sc.id));
    const end = sc.status === "open" ? Math.max(r.end, t1) : r.end;
    const bar = s("rect", {
      x: x(r.start), y: y + 2, width: Math.max(2, x(Math.min(end, t1)) - x(r.start)), height: rowH - 6, rx: 2,
      class: `tl-bar ${sc.status}${selected === sc.id ? " selected" : ""}`, style: `--hue:${hue}`,
    });
    bar.addEventListener("click", () => onSelect(sc.id));
    bar.append(titleNode(`${sc.id}: ${sc.brief}\n${sc.status}, ${sc.ops} ops`));
    for (const w of r.waits) s("rect", { x: x(w.fromT), y: y + 4, width: Math.max(2, x(w.toT) - x(w.fromT)), height: rowH - 10, class: "tl-wait" }).append(titleNode(`lock wait → ${w.scope}`));
    for (const f of sc.refusals) s("line", { x1: x(f.t), x2: x(f.t), y1: y, y2: y + rowH - 2, class: "tl-refusal" }).append(titleNode(`${f.tool} refused: ${f.code}`));
  });
  s("text", { x: labelW, y: rows.length * rowH + 16, class: "tl-axis" }, `${Math.round((t1 - t0) / 1000)} s`);
  el.replaceChildren(svg);
}

function titleNode(text) {
  const t = document.createElementNS("http://www.w3.org/2000/svg", "title");
  t.textContent = text;
  return t;
}

/** Panel 4: edit density per column with lock rectangles; readable on very large builds. */
export function renderActivity(canvas, activity, model) {
  const ctx = canvas.getContext("2d");
  const dpr = window.devicePixelRatio || 1;
  const r = canvas.getBoundingClientRect();
  canvas.width = Math.max(1, r.width * dpr);
  canvas.height = Math.max(1, r.height * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = "#15171a";
  ctx.fillRect(0, 0, r.width, r.height);
  let min = activity.min ? [...activity.min] : null, max = activity.maxXZ ? [...activity.maxXZ] : null;
  const grow = (b) => {
    if (!min) {
      min = [b.min[0], b.min[2]];
      max = [b.max[0], b.max[2]];
    } else {
      min = [Math.min(min[0], b.min[0]), Math.min(min[1], b.min[2])];
      max = [Math.max(max[0], b.max[0]), Math.max(max[1], b.max[2])];
    }
  };
  if (model.bounds) grow(model.bounds);
  for (const s of model.scopes.values()) if (s.work) grow(s.work);
  if (!min) {
    ctx.fillStyle = "#777";
    ctx.fillText("no edits yet", 10, 20);
    return;
  }
  const w = max[0] - min[0] + 1, d = max[1] - min[1] + 1;
  const scale = Math.min((r.width - 16) / w, (r.height - 16) / d);
  const ox = (r.width - w * scale) / 2, oz = (r.height - d * scale) / 2;
  const X = (x) => ox + (x - min[0]) * scale, Z = (z) => oz + (z - min[1]) * scale;
  ctx.strokeStyle = "#333";
  ctx.strokeRect(X(min[0]), Z(min[1]), w * scale, d * scale);
  const lmax = Math.log1p(activity.max || 1);
  for (const [k, v] of activity.cells) {
    const [x, z] = k.split(",").map(Number);
    const f = Math.log1p(v) / lmax;
    ctx.fillStyle = `hsl(${40 - f * 40}, 95%, ${18 + f * 50}%)`;
    ctx.fillRect(X(x), Z(z), Math.max(1, scale), Math.max(1, scale));
  }
  ctx.font = "11px system-ui, sans-serif";
  for (const s of model.scopes.values()) {
    if (!s.work) continue;
    const hue = scopeHue(s.id);
    const open = s.status === "open";
    ctx.setLineDash(open ? [] : [3, 3]);
    ctx.strokeStyle = `hsla(${hue}, 80%, 60%, ${open ? 1 : 0.35})`;
    ctx.lineWidth = open ? 2 : 1;
    ctx.strokeRect(X(s.work.min[0]), Z(s.work.min[2]), (s.work.max[0] - s.work.min[0] + 1) * scale, (s.work.max[2] - s.work.min[2] + 1) * scale);
    if (open) {
      ctx.fillStyle = `hsl(${hue}, 80%, 70%)`;
      ctx.fillText(s.id, X(s.work.min[0]) + 3, Z(s.work.min[2]) + 12);
    }
  }
  ctx.setLineDash([]);
  ctx.fillStyle = "#888";
  ctx.fillText(`x ${min[0]}..${max[0]}  z ${min[1]}..${max[1]}  (north up)`, 6, r.height - 4);
}
