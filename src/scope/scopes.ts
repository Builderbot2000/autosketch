import type { Compound } from "prismarine-nbt";
import { NO_EVENTS, type EventSink } from "../core/events.js";
import { Mask } from "../core/mask.js";
import { boxVolume, formatBox, toPublic, translateBox, unionBox, type Box, type PublicBox, type Vec3 } from "../core/region.js";
import { listCameras, saveCamera } from "../document/cameras.js";
import type { Component } from "../document/components.js";
import { Document, type EditResult, type PendingChanges, type WriteGuard } from "../document/document.js";
import type { StateTable } from "../document/voxels.js";
import { connectionNeutral, reconnectPositions, type ConnectEnv } from "../ops/connect.js";
import type { AutosketchPlugin } from "../plugins/types.js";
import { extendWholeBlocks } from "./multiblock.js";
import { DEFAULT_SCOPE_LIMITS, type ScopeLimits } from "./settings.js";

/**
 * Scoped sessions (docs/design/11-scoped-sessions.md). A scope is a sandbox: a separate Document
 * holding only a copy of its work and context volumes, re-origined so the work volume's minimum
 * corner is (0,0,0). Its parent (the base document or another sandbox) holds a lock on the work
 * volume until the job merges back as one journal entry or is abandoned.
 *
 * Coordinates: a scope's `work`, `context` and lock are in its parent's local frame; `workLocal`
 * and `contextLocal` in its own. `offset` is the parent-local position of sandbox (0,0,0).
 *
 * Enforcement runs through `Document.guard`, so every write path (tools, scripts, plugin actions,
 * undo and redo) obeys it: a sandbox refuses changes outside its work volume, except connection
 * properties recomputed in its context; a parent refuses changes inside a held lock, except
 * connection properties (derived state, 11 *Connection seams*).
 *
 * Persistence: in memory only (11, resolved): scopes are abandoned when the session closes.
 */

export const BASE = "base";

/** Shared design data a job must match (11, *Fork*): coordinates are given in the parent's frame. */
export interface ScopeSpec {
  /** Palette name to build with ("palette:<name>.<role>"). */
  palette?: string;
  /** Named heights (storey floors, cornice y…): y values, translated into the local frame. */
  levels?: Record<string, number>;
  /** Named points, translated into the local frame. */
  anchors?: Record<string, Vec3>;
  /** Other shared values that are not coordinates (wall thickness, style notes…), passed as is. */
  values?: Record<string, string | number>;
}

export interface Scope {
  id: string;
  parent: string;
  depth: number;
  doc: Document;
  brief: string;
  spec?: ScopeSpec;
  openedAt: number;
  offset: Vec3;
  /** Parent frame. */
  work: Mask;
  context: Mask;
  workBox: Box;
  /** Own frame. */
  workLocal: Mask;
  contextLocal: Mask;
  workBoxLocal: Box;
  /** Hash of the parent's content in the work volume at fork, connection properties ignored. */
  contentHash: number;
  /** Components copied editable, and those copied as read-only references. */
  copied: Set<string>;
  external: Set<string>;
  /** Component ids in use elsewhere in the document chain. */
  reserved: Set<string>;
  /** Set while merging, so the parent's guard lets the merge write into the lock. */
  merging?: boolean;
}

/**
 * The root scope's volumes (docs/design/13-live-world.md, *Model*): the work and context volumes
 * the player set in-game, which a linked base document holds. Local masks of the base document.
 * Set by the world link (`ScopeManager.root`); undefined on an unlinked document, which keeps
 * today's behaviour exactly.
 */
export interface RootVolumes {
  /** The work volume the agent may write, already extended to whole blocks. */
  work: Mask;
  /** The read-only context volume (never overlapping `work`). */
  context: Mask;
}

export interface ForkInput {
  /** Work volume, resolved in the parent's frame. */
  work: Mask;
  /** Context volume (parent frame), or the work volume plus `padding` blocks (default 3). */
  context?: Mask | { padding: number };
  brief: string;
  spec?: ScopeSpec;
  env?: ConnectEnv;
}

export interface ForkResult {
  scope: Scope;
  /** Positions the whole-block rule added to the work volume (parent frame). */
  extension: Mask;
  /** Context positions dropped because a nested context must stay inside the parent's volumes. */
  contextClipped: number;
  /** Open jobs whose work volume the context overlaps (shown as of fork time). */
  stale: { scope: string; brief: string; box: Box }[];
  handoff: string;
}

export interface MergeResult {
  scope: Scope;
  parent: string;
  edit: EditResult;
  /** Blocks whose connection properties the seam recompute changed. */
  seam: number;
  components: { written: string[]; removed: string[] };
}

export interface ScopeInfo {
  id: string;
  parent: string;
  depth: number;
  brief: string;
  ageMs: number;
  lock: Box;
  workBlocks: number;
  ops: number;
  children: string[];
}

/** An error carrying a refusal code (12, `call.refused`). */
export function refusal(code: string, message: string): Error & { refusal: string } {
  return Object.assign(new Error(message), { refusal: code });
}

const DEFAULT_PADDING = 3;

/** Neighbour offsets whose connection properties can depend on each other (as in ops/connect.ts). */
const AROUND: Vec3[] = [
  [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1],
  [1, 1, 0], [-1, 1, 0], [0, 1, 1], [0, 1, -1], [1, -1, 0], [-1, -1, 0], [0, -1, 1], [0, -1, -1],
];

const posKey = (x: number, y: number, z: number) => `${x},${y},${z}`;
const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const neg = (a: Vec3): Vec3 => [-a[0], -a[1], -a[2]];

export class ScopeManager {
  readonly scopes = new Map<string, Scope>();
  limits: ScopeLimits;
  /**
   * The root scope's volumes while the base document is linked to the world (13): the base
   * document then obeys the sandbox write rule (`outside_work_volume`), and forks from it must lie
   * inside these volumes, as for any nested fork, with the ratio limit measured against its work
   * volume.
   */
  root?: RootVolumes;
  private next = 1;
  private env: ConnectEnv = {};
  /** Connection-neutral content per state id, per state table (11: locks and checks ignore derived state). */
  private readonly neutral = new WeakMap<StateTable, Map<number, string>>();

  constructor(
    private readonly base: () => Document | undefined,
    opts: { limits?: ScopeLimits; events?: (doc: string) => EventSink; now?: () => number } = {},
  ) {
    this.limits = opts.limits ?? DEFAULT_SCOPE_LIMITS;
    this.sinkFor = opts.events ?? (() => NO_EVENTS);
    this.now = opts.now ?? Date.now;
  }

  /** The sink for a document ("base" or a scope id). */
  sinkFor: (doc: string) => EventSink;
  private readonly now: () => number;

  get openCount(): number {
    return this.scopes.size;
  }

  /** Installs the lock guard on a base document. */
  attach(doc: Document): void {
    doc.guard = this.guardFor(BASE);
  }

  get(id: string): Scope {
    const s = this.scopes.get(id);
    if (!s) throw refusal("scope_unknown", `no open scope "${id}"${this.scopes.size ? ` (open: ${[...this.scopes.keys()].join(", ")})` : " (none are open)"}. scope_list shows open jobs; "base" is the base document.`);
    return s;
  }

  docOf(id: string): Document {
    if (id === BASE) {
      const d = this.base();
      if (!d) throw new Error("No document is open. Call doc_new({name}) to start one, or doc_open({name}).");
      return d;
    }
    return this.get(id).doc;
  }

  children(id: string): Scope[] {
    return [...this.scopes.values()].filter((s) => s.parent === id && !s.merging);
  }

  /** Position of a document's local (0,0,0) in the base frame. */
  baseOffset(id: string): Vec3 {
    let o: Vec3 = [0, 0, 0];
    for (let s = this.scopes.get(id); s; s = this.scopes.get(s.parent)) o = add(o, s.offset);
    return o;
  }

  // -- fork -------------------------------------------------------------------------------------

  fork(parentId: string, input: ForkInput): ForkResult {
    const parent = this.docOf(parentId);
    const ps = parentId === BASE ? undefined : this.get(parentId);
    // The parent's own volumes: a sandbox's, or the root scope's on a linked base document (13).
    const pv = ps ? { work: ps.workLocal, context: ps.contextLocal } : this.root;
    if (input.env) this.env = input.env;
    const plugins = (this.env.plugins ?? []) as readonly AutosketchPlugin[];
    if (!input.brief.trim()) throw new Error("brief is required: describe the job in a few sentences");

    const depth = (ps?.depth ?? 0) + 1;
    if (depth > this.limits.maxDepth)
      throw refusal("nest_depth", `Too deep: finish this job in your own sandbox. (A fork here would be depth ${depth}; the limit is ${this.limits.maxDepth} below the base build.)`);

    if (input.work.isEmpty()) throw new Error("the work selection is empty");
    const { mask: work, added: extension } = extendWholeBlocks(parent, input.work, plugins);
    if (pv) {
      const outside = work.clone().subtract(pv.work);
      if (!outside.isEmpty())
        throw refusal(
          "nest_outside",
          `A child's work volume must lie inside ${ps ? "your own work volume" : "the work volume the player set in-game"} ${formatBox(ps ? ps.workBoxLocal : pv.work.bbox()!)}: ${outside.count()} of its blocks are outside (e.g. ${fmt(outside.positions()[0]!)}).`,
        );
    }
    const n = work.count();
    if (n < this.limits.minWorkBlocks)
      throw refusal("nest_too_small", `Small enough to do directly. (The work volume has ${n.toLocaleString("en-US")} blocks; a fork needs at least ${this.limits.minWorkBlocks.toLocaleString("en-US")}.)`);
    const parentVolume = pv ? pv.work.count() : boxVolume(parent.localBounds() ?? { min: [0, 0, 0], max: [0, 0, 0] });
    if (n > this.limits.maxWorkRatio * parentVolume)
      throw refusal(
        "nest_too_large",
        `This is most of your own job: do it yourself, or split it into smaller jobs. (The work volume has ${n.toLocaleString("en-US")} blocks, over ${Math.round(this.limits.maxWorkRatio * 100)}% of ` +
          `${ps ? "your own work volume" : pv ? "the work volume the player set in-game" : "the base document's bounds"} (${parentVolume.toLocaleString("en-US")}).)`,
      );
    for (const l of this.children(parentId)) {
      const overlap = l.work.clone().intersectWith(work);
      if (!overlap.isEmpty())
        throw refusal("lock_overlap", `The work volume overlaps the lock held by job ${l.id} ("${short(l.brief)}") in ${formatBox(overlap.bbox()!)}. Wait for it to merge (or be abandoned), or pick another region.`);
    }

    // Context: the selection or the grown work volume, whole blocks, minus the work volume.
    let context = input.context instanceof Mask ? input.context.clone() : dilate(work, input.context?.padding ?? DEFAULT_PADDING);
    context = extendWholeBlocks(parent, context, plugins).mask.subtract(work);
    let contextClipped = 0;
    if (pv) {
      const allowed = pv.work.clone().unionWith(pv.context);
      const before = context.count();
      context.intersectWith(allowed);
      contextClipped = before - context.count();
    }
    const stale = this.children(parentId)
      .map((l) => ({ l, o: l.work.clone().intersectWith(context) }))
      .filter((x) => !x.o.isEmpty())
      .map(({ l, o }) => ({ scope: l.id, brief: l.brief, box: o.bbox()! }));

    // The sandbox: a copy of both volumes, re-origined, sharing the parent's state table.
    const id = `s${this.next++}`;
    const workBox = work.bbox()!;
    const offset: Vec3 = [...workBox.min];
    const doc = new Document({ ...parent.meta, name: `${parent.meta.name}-${id}`, createdAt: new Date(this.now()).toISOString() }, { states: parent.states, palettes: parent.palettes });
    const copy = (x: number, y: number, z: number) => {
      const sid = parent.voxels.get(...parent.toStore(x, y, z));
      const [lx, ly, lz] = sub([x, y, z], offset);
      if (sid) doc.voxels.set(lx, ly, lz, sid);
      const be = parent.getBlockEntity(x, y, z);
      if (be) doc.blockEntities.set(posKey(lx, ly, lz), structuredClone(be));
    };
    work.forEach(copy);
    context.forEach(copy);
    const workLocal = work.translated(neg(offset));
    const contextLocal = context.translated(neg(offset));
    const workBoxLocal = translateBox(workBox, neg(offset));
    const cb = contextLocal.bbox();
    doc.bounds = cb ? unionBox(workBoxLocal, cb) : workBoxLocal;
    doc.context = contextLocal;

    // Components (11, *Components*): inside the work volume → editable; crossing it or in the
    // context → read-only reference, clipped; elsewhere → absent. Ids from the whole chain are reserved.
    const copied = new Set<string>(), external = new Set<string>();
    const reserved = new Set<string>([...(ps?.reserved ?? [])]);
    const visible = doc.bounds;
    for (const c of parent.components.values()) {
      const loc = translateBox(parent.boxToLocal(c.box), neg(offset));
      const inside = boxInMask(translateBox(loc, offset), work);
      const clip = intersect(loc, visible);
      if (inside) copied.add(c.id);
      else if (clip && boxIntersectsMask(translateBox(loc, offset), work.clone().unionWith(context))) external.add(c.id);
      else reserved.add(c.id);
    }
    for (const c of parent.components.values()) {
      if (!copied.has(c.id) && !external.has(c.id)) continue;
      const loc = translateBox(parent.boxToLocal(c.box), neg(offset));
      const clip = intersect(loc, visible)!;
      const partial = external.has(c.id) && boxVolume(clip) < boxVolume(loc);
      const anchors: Record<string, Vec3> = {};
      for (const [k, v] of Object.entries(c.anchors)) anchors[k] = sub(parent.toLocal(...v), offset);
      const keepParent = c.parent && (copied.has(c.parent) || external.has(c.parent));
      doc.components.set(c.id, {
        ...structuredClone(c),
        box: external.has(c.id) ? clip : loc,
        anchors,
        tags: external.has(c.id) ? [...c.tags.filter((t) => t !== "external" && t !== "partial"), "external", ...(partial ? ["partial"] : [])] : [...c.tags],
        ...(keepParent ? { parent: c.parent } : {}),
      });
      if (!keepParent) delete doc.components.get(c.id)!.parent;
    }

    // Saved cameras (06, *Cameras*): those whose eye lies in the sandbox's volumes come along,
    // translated into its frame like anchors; the rest would look from outside what it holds.
    for (const [name, cam] of listCameras(parent)) {
      const [ex, ey, ez] = cam.eye.map(Math.round) as Vec3;
      if (work.has(ex, ey, ez) || context.has(ex, ey, ez)) saveCamera(doc, name, { ...cam, eye: sub(cam.eye, offset), target: sub(cam.target, offset) });
    }

    const spec = input.spec && translateSpec(input.spec, offset);
    const scope: Scope = {
      id,
      parent: parentId,
      depth,
      doc,
      brief: input.brief.trim(),
      ...(spec ? { spec } : {}),
      openedAt: this.now(),
      offset,
      work,
      context,
      workBox,
      workLocal,
      contextLocal,
      workBoxLocal,
      contentHash: this.contentHash(parent, work),
      copied,
      external,
      reserved,
    };
    this.scopes.set(id, scope);
    doc.guard = this.guardFor(id);
    doc.events = this.sinkFor(id);

    const events = this.sinkFor(parentId);
    if (events.enabled) {
      const bo = this.baseOffset(parentId);
      const cbox = context.bbox();
      events.emit({
        kind: "scope.fork",
        scope: id,
        parent: parentId,
        depth,
        work: toPublic(translateBox(workBox, bo)),
        context: toPublic(translateBox(cbox ?? workBox, bo)),
        translation: add(bo, offset),
        brief: scope.brief,
        workLocal: toPublic(workBoxLocal),
        ...(cb ? { contextLocal: toPublic(cb) } : {}),
        workBlocks: n,
        extension: extension.count(),
        stale: stale.map((s) => ({ scope: s.scope, box: toPublic(translateBox(s.box, bo)) })),
      });
    }
    return { scope, extension, contextClipped, stale, handoff: handoffText(scope) };
  }

  // -- merge and abandon ----------------------------------------------------------------------

  merge(id: string, report: string, env?: ConnectEnv): MergeResult {
    const s = this.get(id);
    if (env) this.env = env;
    const kids = this.children(id);
    if (kids.length) throw refusal("scope_children", `Job ${id} still has open child jobs (${kids.map((k) => k.id).join(", ")}): merge or abandon them first.`);
    const parent = this.docOf(s.parent);
    if (this.contentHash(parent, s.work) !== s.contentHash)
      throw refusal("merge_check", `Merge sanity check failed: the parent's blocks inside job ${id}'s locked work volume ${formatBox(s.workBox)} changed since the fork. Locks should prevent this, so it is a bug; nothing was merged. Abandon the job or inspect the region.`);

    // Components: the sandbox's own (not external) ones, checked against the parent's ids again.
    const mine = [...s.doc.components.values()].filter((c) => !s.external.has(c.id));
    for (const c of mine)
      if (!s.copied.has(c.id) && parent.components.has(c.id)) throw new Error(`component id "${c.id}" created in job ${id} is already used in the parent document; rename it in the sandbox before merging`);
    const removed = [...s.copied].filter((cid) => !s.doc.components.has(cid));

    s.merging = true;
    let seam = 0;
    let edit: EditResult;
    try {
      edit = parent.edit("scope_merge", `merge ${id}: ${short(s.brief)}`, (tx) => {
        s.work.forEach((x, y, z) => {
          const [lx, ly, lz] = sub([x, y, z], s.offset);
          const want = s.doc.voxels.get(lx, ly, lz);
          const wantBe = s.doc.blockEntities.get(posKey(lx, ly, lz));
          const have = tx.getId(x, y, z);
          const haveBe = parent.getBlockEntity(x, y, z);
          if (want === have && sameNbt(wantBe, haveBe)) return;
          tx.set(x, y, z, want, wantBe ? structuredClone(wantBe) : null);
        });
        // Parents before children, so setComponent finds them.
        const order = sortByParent(mine);
        for (const c of order) {
          const loc = s.doc.componentLocal(c.id)!;
          const anchors: Record<string, Vec3> = {};
          for (const [k, v] of Object.entries(loc.anchors)) anchors[k] = add(v, s.offset);
          tx.setComponent({
            id: c.id,
            box: translateBox(loc.box, s.offset),
            anchors,
            tags: c.tags,
            ...(c.kind ? { kind: c.kind } : {}),
            ...(c.parent && (parent.components.has(c.parent) || mine.some((m) => m.id === c.parent)) ? { parent: c.parent } : {}),
            ...(c.notes ? { notes: c.notes } : {}),
          });
        }
        for (const cid of removed) tx.removeComponent(cid);
        // Seams: recompute connection properties one block on both sides of the boundary (11).
        seam = reconnectPositions(parent, tx, seamShell(s.work), this.env);
      });
    } catch (e) {
      s.merging = false;
      throw e;
    }
    this.scopes.delete(id);
    const events = this.sinkFor(s.parent);
    if (events.enabled) {
      const bo = this.baseOffset(s.parent);
      events.emit({
        kind: "scope.merge",
        scope: id,
        report,
        ...(edit.box ? { box: toPublic(translateBox(edit.box, bo)) } : {}),
        jseq: edit.seq,
        parent: s.parent,
        changed: edit.changed,
      });
    }
    return { scope: s, parent: s.parent, edit, seam, components: { written: mine.map((c) => c.id), removed } };
  }

  /** Discards a job and every job forked from it, releasing their locks. Returns the ids closed. */
  abandon(id: string, reason: "call" | "restart" = "call"): string[] {
    const s = this.get(id);
    const out: string[] = [];
    for (const k of this.children(id)) out.push(...this.abandon(k.id, reason));
    this.scopes.delete(id);
    out.push(id);
    const events = this.sinkFor(s.parent);
    if (events.enabled) events.emit({ kind: "scope.abandon", scope: id, reason });
    return out;
  }

  /** Abandons every open job (session close). */
  abandonAll(reason: "call" | "restart" = "restart"): string[] {
    const out: string[] = [];
    for (const s of [...this.scopes.values()]) if (this.scopes.has(s.id) && s.parent === BASE) out.push(...this.abandon(s.id, reason));
    return out;
  }

  list(): ScopeInfo[] {
    const now = this.now();
    return [...this.scopes.values()].map((s) => ({
      id: s.id,
      parent: s.parent,
      depth: s.depth,
      brief: s.brief,
      ageMs: now - s.openedAt,
      lock: s.workBox,
      workBlocks: s.work.count(),
      ops: s.doc.journal.headSeq,
      children: this.children(s.id).map((c) => c.id),
    }));
  }

  // -- guard ------------------------------------------------------------------------------------

  private neutralOf(states: StateTable, id: number): string {
    let m = this.neutral.get(states);
    if (!m) this.neutral.set(states, (m = new Map()));
    let v = m.get(id);
    if (v === undefined) m.set(id, (v = connectionNeutral(states.get(id), this.env)));
    return v;
  }

  /** Order-dependent hash of the connection-neutral content of `mask` in `doc`. */
  private contentHash(doc: Document, mask: Mask): number {
    let h = 0x811c9dc5;
    const strHash = new Map<number, number>();
    mask.forEach((x, y, z) => {
      const id = doc.voxels.get(...doc.toStore(x, y, z));
      let v = strHash.get(id);
      if (v === undefined) strHash.set(id, (v = fnv(this.neutralOf(doc.states, id))));
      h = Math.imul(h ^ v, 0x01000193) >>> 0;
    });
    return h;
  }

  /** The write guard of a document ("base" or a scope id). */
  guardFor(docId: string): WriteGuard {
    return (changes, op) => this.check(docId, changes, op);
  }

  private check(docId: string, changes: PendingChanges, op: string): void {
    const sandbox = docId === BASE ? undefined : this.scopes.get(docId);
    const root = docId === BASE ? this.root : undefined;
    const locks = this.children(docId);
    if (!sandbox && !root && !locks.length) return;
    const vol = sandbox ? { work: sandbox.workLocal, context: sandbox.contextLocal } : root;
    const doc = this.docOf(docId);
    let outside = 0;
    let firstOutside: Vec3 | undefined;
    let inContext = 0;
    const locked = new Map<Scope, { n: number; first: Vec3 }>();
    changes.forEach((x, y, z, before, after, nbt) => {
      const derived = !nbt && before !== after && this.neutralOf(doc.states, before) === this.neutralOf(doc.states, after);
      if (vol && !vol.work.has(x, y, z)) {
        const ctx = vol.context.has(x, y, z);
        if (!(derived && ctx)) {
          outside++;
          if (ctx) inContext++;
          firstOutside ??= [x, y, z];
        }
      }
      if (derived) return;
      for (const l of locks)
        if (l.work.has(x, y, z)) {
          const e = locked.get(l);
          if (e) e.n++;
          else locked.set(l, { n: 1, first: [x, y, z] });
        }
    });
    if (sandbox && outside)
      throw refusal(
        "outside_work_volume",
        `${op} would change ${outside} block${outside === 1 ? "" : "s"} outside the work volume of scope ${sandbox.id} (e.g. ${fmt(firstOutside!)}${inContext ? `; ${inContext} in the read-only context` : ""}). ` +
          `The sandbox only holds its work volume ${formatBox(sandbox.workBoxLocal)} as editable space; the context is a read-only copy and nothing exists beyond it. Nothing was written.`,
      );
    if (root && outside)
      throw refusal(
        "outside_work_volume",
        `${op} would change ${outside} block${outside === 1 ? "" : "s"} outside the work volume the player set in-game (e.g. ${fmt(firstOutside!)}${inContext ? `; ${inContext} in the read-only context` : ""}). ` +
          `The linked document holds that work volume ${formatBox(root.work.bbox()!)} as editable space; the context is read-only and nothing exists beyond it. Nothing was written.`,
      );
    if (locked.size) {
      const [l, e] = [...locked][0]!;
      throw refusal(
        "lock_overlap",
        `${op} would change ${e.n} block${e.n === 1 ? "" : "s"} inside the work volume locked by job ${l.id} ("${short(l.brief)}"), e.g. ${fmt(e.first)}. ` +
          `Wait for it to merge (scope_merge) or abandon it, or edit elsewhere. Nothing was written.`,
      );
    }
    if (sandbox && changes.components) this.checkComponents(sandbox, changes.components);
  }

  private checkComponents(s: Scope, c: { before: readonly Component[]; after: readonly Component[] }): void {
    const before = new Map(c.before.map((x) => [x.id, x]));
    const after = new Map(c.after.map((x) => [x.id, x]));
    for (const id of new Set([...before.keys(), ...after.keys()])) {
      const was = before.get(id), now = after.get(id);
      if (was && now && JSON.stringify(was) === JSON.stringify(now)) continue;
      if (s.external.has(id))
        throw refusal("outside_work_volume", `component "${id}" is read-only in scope ${s.id}: it extends outside the work volume (tagged external). Its anchors can still be used for placement.`);
      if (!now) continue;
      if (!was && s.reserved.has(id)) throw refusal("component_reserved", `component id "${id}" is already used elsewhere in the build; pick another id`);
      const b = s.doc.boxToLocal(now.box);
      if (!boxInMask(b, s.workLocal))
        throw refusal("outside_work_volume", `component "${id}" ${formatBox(b)} must lie wholly inside the work volume ${formatBox(s.workBoxLocal)} of scope ${s.id}`);
    }
  }
}

// -- handoff ------------------------------------------------------------------------------------

/** The block the parent pastes into the subagent's prompt (11, *Fork*). Local coordinates only. */
export function handoffText(s: Scope): string {
  const wb = s.workBoxLocal;
  const full = s.workLocal.count() === boxVolume(wb);
  const cb = s.contextLocal.bbox();
  const lines = [
    `Scoped job ${s.id}. Pass scope:"${s.id}" on EVERY Autosketch call for this job (calls without it go to another document or are refused).`,
    `Local frame: the work volume's minimum corner is (0,0,0). These are the only coordinates you need.`,
    `Work volume (editable): ${formatBox(wb)}${full ? "" : `, ${s.workLocal.count().toLocaleString("en-US")} blocks (not the whole box)`}.`,
    cb ? `Context volume (read-only copy of the surroundings, ghosted in renders, marked in slices): ${formatBox(cb)}.` : "Context volume: none.",
    `Writes outside the work volume are refused. Fences, walls and stairs still connect to context blocks.`,
    `Brief: ${s.brief}`,
  ];
  const sp = s.spec;
  if (sp) {
    if (sp.palette) lines.push(`Palette: ${sp.palette} (materials as "palette:${sp.palette}.<role>")`);
    if (sp.levels && Object.keys(sp.levels).length) lines.push(`Levels (y, local): ${Object.entries(sp.levels).map(([k, v]) => `${k} ${v}`).join(", ")}`);
    if (sp.anchors && Object.keys(sp.anchors).length) lines.push(`Anchors (local): ${Object.entries(sp.anchors).map(([k, v]) => `${k} ${fmt(v)}`).join(", ")}`);
    if (sp.values && Object.keys(sp.values).length) lines.push(`Shared values: ${Object.entries(sp.values).map(([k, v]) => `${k} ${v}`).join(", ")}`);
  }
  if (s.copied.size) lines.push(`Components you may edit: ${[...s.copied].join(", ")}`);
  if (s.external.size) lines.push(`Read-only components (anchors usable): ${[...s.external].map((id) => (s.doc.components.get(id)?.tags.includes("partial") ? `${id} (partial)` : id)).join(", ")}`);
  if (s.reserved.size) lines.push(`New component ids must be new to the whole build (${s.reserved.size} reserved; a clash fails when you create it) and lie inside the work volume.`);
  lines.push(`When done, reply with a short report (what you built, anything the parent must know). The parent merges it with scope_merge({scope:"${s.id}", report}). Don't merge it yourself.`);
  return lines.join("\n");
}

// -- helpers ------------------------------------------------------------------------------------

function translateSpec(spec: ScopeSpec, offset: Vec3): ScopeSpec {
  return {
    ...(spec.palette ? { palette: spec.palette } : {}),
    ...(spec.levels ? { levels: Object.fromEntries(Object.entries(spec.levels).map(([k, y]) => [k, y - offset[1]])) } : {}),
    ...(spec.anchors ? { anchors: Object.fromEntries(Object.entries(spec.anchors).map(([k, p]) => [k, sub(p, offset)])) } : {}),
    ...(spec.values ? { values: { ...spec.values } } : {}),
  };
}

/** Grows a mask by `r` blocks in every direction (a cube kernel, separable). */
export function dilate(m: Mask, r: number): Mask {
  if (!Number.isInteger(r) || r < 0 || r > 64) throw new Error(`context padding must be an integer 0..64 (got ${r})`);
  let cur = m;
  for (let a = 0; a < 3; a++) {
    const next = cur.clone();
    cur.forEach((x, y, z) => {
      for (let d = -r; d <= r; d++) {
        if (!d) continue;
        if (a === 0) next.add(x + d, y, z);
        else if (a === 1) next.add(x, y + d, z);
        else next.add(x, y, z + d);
      }
    });
    cur = next;
  }
  return cur;
}

/** The one-block shell on both sides of a volume's boundary, over connection neighbours (11, *Connection seams*). */
export function seamShell(work: Mask): Mask {
  const out = new Mask();
  work.forEach((x, y, z) => {
    for (const d of AROUND) {
      const q: Vec3 = [x + d[0], y + d[1], z + d[2]];
      if (!work.has(...q)) {
        out.add(...q);
        out.add(x, y, z);
      }
    }
  });
  return out;
}

function boxInMask(b: Box, m: Mask): boolean {
  const mb = m.bbox();
  if (!mb || b.min.some((v, i) => v < mb.min[i]!) || b.max.some((v, i) => v > mb.max[i]!)) return false;
  if (m.isBox()) return true;
  for (let y = b.min[1]; y < b.max[1]; y++) for (let z = b.min[2]; z < b.max[2]; z++) for (let x = b.min[0]; x < b.max[0]; x++) if (!m.has(x, y, z)) return false;
  return true;
}

function boxIntersectsMask(b: Box, m: Mask): boolean {
  if (boxVolume(b) <= m.count()) {
    for (let y = b.min[1]; y < b.max[1]; y++) for (let z = b.min[2]; z < b.max[2]; z++) for (let x = b.min[0]; x < b.max[0]; x++) if (m.has(x, y, z)) return true;
    return false;
  }
  let hit = false;
  m.forEach((x, y, z) => {
    if (!hit && x >= b.min[0] && x < b.max[0] && y >= b.min[1] && y < b.max[1] && z >= b.min[2] && z < b.max[2]) hit = true;
  });
  return hit;
}

function intersect(a: Box, b: Box): Box | undefined {
  const r: Box = { min: [Math.max(a.min[0], b.min[0]), Math.max(a.min[1], b.min[1]), Math.max(a.min[2], b.min[2])], max: [Math.min(a.max[0], b.max[0]), Math.min(a.max[1], b.max[1]), Math.min(a.max[2], b.max[2])] };
  return boxVolume(r) > 0 ? r : undefined;
}

function sortByParent(list: Component[]): Component[] {
  const ids = new Set(list.map((c) => c.id));
  const out: Component[] = [];
  const done = new Set<string>();
  const visit = (c: Component, seen: Set<string>) => {
    if (done.has(c.id) || seen.has(c.id)) return;
    seen.add(c.id);
    if (c.parent && ids.has(c.parent) && c.parent !== c.id) visit(list.find((p) => p.id === c.parent)!, seen);
    done.add(c.id);
    out.push(c);
  };
  for (const c of list) visit(c, new Set());
  return out;
}

function sameNbt(a: Compound | undefined, b: Compound | undefined): boolean {
  if (!a || !b) return a === b;
  return a === b || JSON.stringify(a) === JSON.stringify(b);
}

function fnv(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return h >>> 0;
}

function fmt(p: Vec3): string {
  return `(${p.join(",")})`;
}

function short(s: string, n = 60): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

export type { PublicBox };
