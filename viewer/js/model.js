// Session model for the viewer (docs/design/12-observability.md, *Panels*). Pure: no DOM, no
// network, so tests run it in Node. Built only from the event stream, the same one replay reads.
//
// Frames (12, *One frame*): every box in an event is in the base document's local frame. A scope's
// sandbox has its own local frame whose (0,0,0) is the work volume's minimum corner (11); the fork
// event's `translation` maps sandbox to base: base = local + translation.

export const MAX_EVENTS = 20000;

/** @typedef {{min:number[],max:number[]}} PublicBox */

export class SessionModel {
  constructor() {
    this.reset();
  }

  reset() {
    this.lastSeq = 0;
    /** @type {any[]} */
    this.events = [];
    this.doc = null;
    /** @type {PublicBox|undefined} */
    this.bounds = undefined;
    /** @type {Map<string, any>} scope id → scope; "base" is the root. */
    this.scopes = new Map();
    this.scopes.set("base", newScope("base", { brief: "base document", depth: 0, status: "open" }));
    this.refusals = [];
    this.lockWaits = [];
    /** @type {Map<number,string>} log-wide state ids (state.add). */
    this.states = new Map();
    this.pendingWaits = new Map();
    this.now = 0;
  }

  /** Applies one event. Returns false for an event already seen (seq at or below lastSeq). */
  apply(e) {
    if (typeof e.seq === "number") {
      if (e.seq <= this.lastSeq) return false;
      this.lastSeq = e.seq;
    }
    if (typeof e.t === "number") this.now = Math.max(this.now, e.t);
    this.events.push(e);
    if (this.events.length > MAX_EVENTS * 1.25) this.events = this.events.slice(-MAX_EVENTS);
    const base = this.scopes.get("base");
    switch (e.kind) {
      case "session.open":
        if (this.doc !== e.name) {
          this.doc = e.name;
          base.forkT = e.t;
        }
        this.bounds = e.bounds;
        break;
      case "state.add":
        this.states.set(e.id, e.state);
        break;
      case "doc.op":
      case "doc.undo":
      case "doc.redo": {
        const s = this.scopes.get(e.doc);
        if (s) {
          s.ops++;
          s.lastT = e.t;
        }
        if (e.doc === "base" && e.box) this.bounds = this.bounds ? union(this.bounds, e.box) : e.box;
        break;
      }
      case "call.start": {
        const s = this.scopes.get(e.scope ?? "base");
        if (s) {
          s.lastTool = e.tool;
          s.lastT = e.t;
        }
        break;
      }
      case "call.refused": {
        const r = { seq: e.seq, t: e.t, tool: e.tool, scope: e.scope ?? "base", code: e.code, message: e.message };
        this.refusals.push(r);
        const s = this.scopes.get(r.scope);
        if (s) s.refusals.push(r);
        if (e.tool === "scope_fork" && e.code === "lock_overlap" && !this.pendingWaits.has(r.scope)) this.pendingWaits.set(r.scope, r);
        break;
      }
      case "scope.fork": {
        const parent = e.parent || "base";
        const s = newScope(e.scope, {
          parent,
          depth: e.depth,
          work: e.work,
          context: e.context,
          translation: e.translation || e.work?.min || [0, 0, 0],
          brief: e.brief || "",
          status: "open",
          forkSeq: e.seq,
          forkT: e.t,
        });
        this.scopes.set(e.scope, s);
        const p = this.scopes.get(parent);
        if (p && !p.children.includes(e.scope)) p.children.push(e.scope);
        const wait = this.pendingWaits.get(parent);
        if (wait) {
          this.lockWaits.push({ parent, scope: e.scope, fromT: wait.t, toT: e.t, fromSeq: wait.seq, toSeq: e.seq });
          this.pendingWaits.delete(parent);
        }
        break;
      }
      case "scope.merge":
      case "scope.abandon": {
        const s = this.scopes.get(e.scope);
        if (!s) break;
        s.status = e.kind === "scope.merge" ? "merged" : e.reason === "restart" ? "lost" : "abandoned";
        s.endSeq = e.seq;
        s.endT = e.t;
        if (e.report) s.report = e.report;
        if (e.box) s.changed = e.box;
        break;
      }
    }
    return true;
  }

  /** Scopes whose lock is held at the latest seq (open forks, not the base). */
  openScopes() {
    return [...this.scopes.values()].filter((s) => s.id !== "base" && s.status === "open");
  }

  /** The scope tree as nested nodes, children in fork order. */
  tree(id = "base") {
    const s = this.scopes.get(id);
    return { scope: s, children: s.children.map((c) => this.tree(c)) };
  }

  /** Timeline rows: depth-first under their parents, one per scope, base first. */
  timelineRows() {
    const rows = [];
    const walk = (id) => {
      const s = this.scopes.get(id);
      rows.push({ scope: s, start: s.forkT ?? this.events[0]?.t ?? 0, end: s.endT ?? this.now, waits: this.lockWaits.filter((w) => w.parent === id) });
      for (const c of s.children) walk(c);
    };
    walk("base");
    return rows;
  }
}

function newScope(id, fields) {
  return { id, parent: null, depth: 0, children: [], ops: 0, refusals: [], lastTool: null, lastT: null, status: "open", ...fields };
}

export function union(a, b) {
  return { min: a.min.map((v, i) => Math.min(v, b.min[i])), max: a.max.map((v, i) => Math.max(v, b.max[i])) };
}

/** A scope's work or context box in its own sandbox frame. */
export function toLocal(box, translation) {
  return { min: box.min.map((v, i) => v - translation[i]), max: box.max.map((v, i) => v - translation[i]) };
}

/** Feed filter: by document tag, kind prefix and tool substring; refusals only when asked. */
export function filterEvents(events, f = {}) {
  return events.filter(
    (e) =>
      (!f.doc || e.doc === f.doc) &&
      (!f.kind || e.kind === f.kind || e.kind.startsWith(f.kind + ".")) &&
      (!f.tool || (e.tool ?? "").includes(f.tool)) &&
      (!f.refusals || e.kind === "call.refused") &&
      (f.states || e.kind !== "state.add"),
  );
}

const fmtBox = (b) => (b ? `${b.min.join(",")}..${b.max.join(",")}` : "");

/** One line for the feed. */
export function describe(e) {
  switch (e.kind) {
    case "session.open": return `opened ${e.name}${e.bounds ? " " + fmtBox(e.bounds) : ""}`;
    case "session.close": return `closed ${e.name}`;
    case "state.add": return `#${e.id} ${e.state}`;
    case "doc.op": return `${e.op}: ${e.summary} (${e.changed} changed${e.box ? " in " + fmtBox(e.box) : ""})`;
    case "doc.undo":
    case "doc.redo": return `${e.kind.slice(4)} ${e.op} (${e.changed})`;
    case "doc.checkpoint": return `checkpoint "${e.name}"`;
    case "call.start": return `${e.tool}`;
    case "call.end": return `${e.tool} ${e.ok ? "ok" : "error"} ${e.ms} ms, ${e.chars} chars${e.images ? `, ${e.images} image(s)` : ""}`;
    case "call.refused": return `${e.tool} refused [${e.code}] ${e.message}`;
    case "render.produced": return `render ${e.view} ${e.size?.join("×") ?? ""}${e.source === "snapshot" ? " (snapshot)" : ""}`;
    case "scope.fork": return `fork ${e.scope} from ${e.parent || "base"}: ${e.brief} work ${fmtBox(e.work)}`;
    case "scope.merge": return `merge ${e.scope}: ${e.report ?? ""}`;
    case "scope.abandon": return `abandon ${e.scope} (${e.reason})`;
    default: return e.kind;
  }
}

/** Stable per-scope hue. */
export function scopeHue(id) {
  if (id === "base") return 210;
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return (h * 137) % 360;
}

/**
 * Edit density per (x, z) column of the base document, for the activity map. Fed from delta
 * records when there are some, from op boxes (spread evenly) when deltas are off or capped.
 */
export class Activity {
  constructor() {
    this.cells = new Map();
    this.max = 0;
    this.min = null;
    this.maxXZ = null;
  }

  add(x, z, n = 1) {
    const k = x + "," + z;
    const v = (this.cells.get(k) ?? 0) + n;
    this.cells.set(k, v);
    if (v > this.max) this.max = v;
    if (!this.min) {
      this.min = [x, z];
      this.maxXZ = [x, z];
    } else {
      this.min = [Math.min(this.min[0], x), Math.min(this.min[1], z)];
      this.maxXZ = [Math.max(this.maxXZ[0], x), Math.max(this.maxXZ[1], z)];
    }
  }

  /** Delta records (x, y, z, id) × n, as an Int32Array. */
  addRecords(rec) {
    for (let i = 0; i + 3 < rec.length; i += 4) this.add(rec[i], rec[i + 2]);
  }

  /** An op without deltas: its changed count spread over the box's columns. */
  addBox(box, changed) {
    const w = box.max[0] - box.min[0] + 1, d = box.max[2] - box.min[2] + 1;
    const per = changed / (w * d);
    if (w * d > 65536) return; // too coarse to be useful; skip rather than flood the map
    for (let x = box.min[0]; x <= box.max[0]; x++) for (let z = box.min[2]; z <= box.max[2]; z++) this.add(x, z, per);
  }
}
