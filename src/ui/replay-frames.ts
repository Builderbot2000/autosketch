import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { PublicBox, Vec3 } from "../core/region.js";
import { readSessionLog } from "../observe/reader.js";
import { modelAt, replayPlan, Replayer, StateGrid, type ReplayEvent } from "../observe/replay.js";
import { describe, type SessionModel } from "../observe/session-model.js";
import type { ReplayFrame, ReplayMarker, UiFlash, WireBox } from "../world/protocol/messages.js";
import { translatePublic, unionPublic } from "./boxes.js";
import { jobColour } from "./colours.js";
import { toWorld, toWorldBox, type WorldFrame } from "./frame.js";
import { uiJob } from "./feed.js";

/**
 * Replay frames (docs/design/16-in-game-ui.md, *Replay in the world*; `13`, `replay.frame`): the
 * replay planner (`observe/replay.ts`) over any session log in the workspace, plus a frame
 * builder. A frame at step S is a keyframe of the replayed volume (every position, states only)
 * or the positions that differ from the step the client shows, with the jobs open at S, the
 * step's edits as flashes, the HUD text and, on keyframes, the log's markers.
 *
 * **Steps** are the log's edits (`doc.op`, `doc.undo`, `doc.redo` of any document, sandboxes
 * included, so their edits flash in their job's colour) and job changes (`scope.fork`,
 * `scope.abandon`; a merge is the base edit it makes). Step 0 is the state before the first.
 *
 * **The volume** is the base document's footprint over the whole log (every `session.open`
 * bounds and base edit box), placed in the world by `frame`: the link's for a linked document, the
 * ghost anchor's otherwise. Logs don't record where a document sat in the world, so a finished
 * log replays at the current frame.
 *
 * **Gaps** (`16`, *Gaps*): a step whose blocks can't be rebuilt (deltas off or capped) says so in
 * `hud.note`, naming the newest time-lapse snapshot at or before it.
 */

const STEP_KINDS = new Set(["doc.op", "doc.undo", "doc.redo", "scope.fork", "scope.abandon"]);
const AIR = "minecraft:air";

/** A session log loaded for replay. */
export interface ReplayLog {
  events: ReplayEvent[];
  /** `deltas.bin` from byte 0 (empty when deltas were off). */
  deltas: ArrayBuffer;
}

export async function loadReplayLog(dir: string): Promise<ReplayLog> {
  const log = await readSessionLog(dir);
  const bin = await readFile(join(dir, "deltas.bin")).catch(() => Buffer.alloc(0));
  return { events: log.events as ReplayEvent[], deltas: bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength) as ArrayBuffer };
}

/** One player's open replay of one log. */
export class ReplaySession {
  readonly steps: ReplayEvent[];
  /** The replayed volume, base-document-local. */
  readonly volume: PublicBox;
  readonly markers: ReplayMarker[];
  private readonly replayer = new Replayer(new StateGrid());
  private readonly states = new Map<number, string>();
  /** The step the client was last sent (undefined: none yet, or unknown). */
  shown: number | undefined;

  constructor(
    readonly id: string,
    readonly player: string,
    readonly log: ReplayLog,
    readonly frame: WorldFrame,
  ) {
    this.steps = log.events.filter((e) => STEP_KINDS.has(e.kind));
    for (const e of log.events) if (e.kind === "state.add") this.states.set(e.id, e.state);
    this.volume = footprint(log.events);
    this.markers = markersOf(log.events, this.steps);
  }

  get stepCount(): number {
    return this.steps.length;
  }

  /** The replayed volume in the world. */
  get worldVolume(): WireBox {
    return toWorldBox(this.frame, this.volume);
  }

  /** The frame that brings the client to `step`: a delta from the step it shows when that is earlier, else a keyframe. */
  frameFor(step: number): ReplayFrame {
    const from = this.shown;
    const delta = from !== undefined && step > from;
    const before = delta ? cloneGrid(this.replayer.grid) : undefined;
    const seq = this.seqAt(step);
    const plan = this.replayer.seek(this.log.events, seq, this.log.deltas);
    const model = modelAt(this.log.events, seq);
    const e = step > 0 ? this.steps[step - 1] : undefined;
    const base = {
      type: "replay.frame" as const,
      players: [this.player],
      replay: this.id,
      step,
      steps: this.steps.length,
      dimension: this.frame.dimension,
      time: new Date((e ?? this.log.events[0])?.t ?? 0).toISOString(),
      hud: { call: this.callLine(step), brief: briefOf(e, model), ...(plan.gap ? { note: this.gapNote(plan.gap, plan.snapshot) } : {}) },
      jobs: model.openScopes().flatMap((s) => (s.work ? [uiJob(s, this.frame)] : [])),
      flashes: e ? flashesOf(e, model, this.frame) : [],
    };
    this.shown = step;
    if (before) return { ...base, keyframe: false, from: from!, blocks: this.diff(before) };
    const { palette, states } = this.keyframeStates();
    return { ...base, keyframe: true, palette, regions: [{ box: this.worldVolume, states }], markers: this.markers };
  }

  /** The bus `seq` the state at `step` is current as of. */
  private seqAt(step: number): number {
    if (step > 0) return this.steps[Math.min(step, this.steps.length) - 1]!.seq;
    const first = this.steps[0];
    return first ? first.seq - 1 : (this.log.events[this.log.events.length - 1]?.seq ?? 0);
  }

  private keyframeStates(): { palette: string[]; states: Uint32Array } {
    const v = this.volume;
    const palette = [AIR];
    const index = new Map<number, number>([[0, 0]]);
    const states = new Uint32Array((v.max[0] - v.min[0] + 1) * (v.max[1] - v.min[1] + 1) * (v.max[2] - v.min[2] + 1));
    let i = 0;
    const g = this.replayer.grid;
    for (let y = v.min[1]; y <= v.max[1]; y++)
      for (let z = v.min[2]; z <= v.max[2]; z++)
        for (let x = v.min[0]; x <= v.max[0]; x++, i++) {
          const id = g.get(x, y, z);
          let p = index.get(id);
          if (p === undefined) index.set(id, (p = palette.push(this.stateName(id)) - 1));
          states[i] = p;
        }
    return { palette, states };
  }

  /** Positions inside the volume whose state differs from `before`, in the world, with their state now. */
  private diff(before: Map<string, Uint32Array>): { pos: Vec3; state: string }[] {
    const after = this.replayer.grid.chunks;
    const out: { pos: Vec3; state: string }[] = [];
    const keys = [...new Set([...before.keys(), ...after.keys()])].sort();
    const v = this.volume;
    for (const k of keys) {
      const a = before.get(k), b = after.get(k);
      const [cx, cy, cz] = k.split(",").map(Number) as Vec3;
      for (let i = 0; i < 4096; i++) {
        const was = a ? a[i]! : 0, now = b ? b[i]! : 0;
        if (was === now) continue;
        const p: Vec3 = [cx * 16 + (i & 15), cy * 16 + (i >> 8), cz * 16 + ((i >> 4) & 15)];
        if (p[0] < v.min[0] || p[1] < v.min[1] || p[2] < v.min[2] || p[0] > v.max[0] || p[1] > v.max[1] || p[2] > v.max[2]) continue;
        out.push({ pos: toWorld(this.frame, p), state: this.stateName(now) });
      }
    }
    return out;
  }

  private stateName(id: number): string {
    return id === 0 ? AIR : (this.states.get(id) ?? AIR);
  }

  /** One line for the step's tool call: the last `call.start` since the previous step, else the step itself. */
  private callLine(step: number): string {
    if (step === 0) return "start";
    const e = this.steps[step - 1]!;
    const prev = step > 1 ? this.steps[step - 2]!.seq : 0;
    let call: ReplayEvent | undefined;
    for (const c of this.log.events) {
      if (c.seq > e.seq) break;
      if (c.seq > prev && c.kind === "call.start") call = c;
    }
    if (call && call.kind === "call.start") return call.scope && call.scope !== "base" ? `${call.tool} (${call.scope})` : call.tool;
    return describe(e);
  }

  private gapNote(gap: ReplayEvent, snapshot: { seq: number; path: string } | undefined): string {
    const at = this.steps.findIndex((s) => s.seq === gap.seq) + 1;
    const head = `No block data from step ${at} on (deltas were off or capped): blocks shown are incomplete.`;
    if (!snapshot) return `${head} No time-lapse snapshot before this step.`;
    const step = this.steps.filter((s) => s.seq <= snapshot.seq).length;
    return `${head} Nearest time-lapse snapshot: ${snapshot.path} (step ${step}).`;
  }
}

/** The base document's footprint over the log, base-local; a single block at the origin when it has none. */
export function footprint(events: ReplayEvent[]): PublicBox {
  let b: PublicBox | undefined;
  for (const e of events) {
    if (e.doc !== "base") continue;
    const box = e.kind === "session.open" ? e.bounds : e.kind === "doc.op" || e.kind === "doc.undo" || e.kind === "doc.redo" ? e.box : undefined;
    if (box) b = b ? unionPublic(b, box) : box;
  }
  return b ?? { min: [0, 0, 0], max: [0, 0, 0] };
}

/** Every fork, merge, refusal and checkpoint, at the step it happened in (steps at or before it). */
export function markersOf(events: ReplayEvent[], steps: ReplayEvent[]): ReplayMarker[] {
  const out: ReplayMarker[] = [];
  let n = 0;
  for (const e of events) {
    while (n < steps.length && steps[n]!.seq <= e.seq) n++;
    if (e.kind === "scope.fork") out.push({ step: n, kind: "fork", label: `${e.scope}: ${e.brief}` });
    else if (e.kind === "scope.merge") out.push({ step: n, kind: "merge", label: e.scope });
    else if (e.kind === "call.refused") out.push({ step: n, kind: "refusal", label: `${e.tool}: ${e.code}` });
    else if (e.kind === "doc.checkpoint") out.push({ step: n, kind: "checkpoint", label: e.name });
  }
  return out;
}

function briefOf(e: ReplayEvent | undefined, m: SessionModel): string | null {
  if (!e) return null;
  if (e.kind === "scope.fork" || e.kind === "scope.abandon") return m.scopes.get(e.scope)?.brief ?? null;
  return e.doc && e.doc !== "base" ? (m.scopes.get(e.doc)?.brief ?? null) : null;
}

function flashesOf(e: ReplayEvent, m: SessionModel, frame: WorldFrame): UiFlash[] {
  if ((e.kind !== "doc.op" && e.kind !== "doc.undo" && e.kind !== "doc.redo") || !e.box || !e.doc) return [];
  const t = e.doc === "base" ? [0, 0, 0] as Vec3 : m.scopes.get(e.doc)?.translation;
  if (!t) return [];
  return [{ job: e.doc, colour: jobColour(e.doc), dimension: frame.dimension, boxes: [toWorldBox(frame, translatePublic(e.box, t))] }];
}

function cloneGrid(g: StateGrid): Map<string, Uint32Array> {
  return new Map([...g.chunks].map(([k, c]) => [k, c.slice()]));
}
