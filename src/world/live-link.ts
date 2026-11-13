import { existsSync } from "node:fs";
import { join } from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { EventSink } from "../core/events.js";
import type { EventListener } from "../core/fanout.js";
import { Mask } from "../core/mask.js";
import { formatBox, fromPublic, toPublic, unionBox, type Box, type Vec3 } from "../core/region.js";
import { Document, type EditResult } from "../document/document.js";
import { loadNative } from "../document/native.js";
import type { AutosketchPlugin } from "../plugins/types.js";
import { extendWholeBlocks } from "../scope/multiblock.js";
import { refusal, type ScopeManager } from "../scope/scopes.js";
import type { Compound } from "prismarine-nbt";
import { Bridge, BridgeError, type BridgeConnection } from "./bridge.js";
import { tapJournal, type JournalStep, type JournalTap } from "./journal-tap.js";
import type { DirtyState, LinkOpenOptions, LinkState, LinkVolumes, SyncFn, SyncReason, WorldLink } from "./link.js";
import { patchBlocks } from "./patch.js";
import { DEFAULT_VOLATILE, mergeVolatile } from "./protocol/hash.js";
import { PAIRING_FILE, type PatchAck, type PatchBlock, type SnapshotResult, type VolatileList, type VolumesMessage, type WireBox, type WorldBlock } from "./protocol/messages.js";
import { applyWorldState } from "./sync.js";

/**
 * The world link (docs/design/13-live-world.md, W2–W4, W8): the `WorldLink` implementation.
 *
 * - **Root scope** (W2): `open` snapshots the player's work and context volumes into a new base
 *   document re-origined to the work volume's minimum corner, extends the work volume to whole
 *   blocks (declared to the mod with `volumes.extend` before any patch), marks the context
 *   (`Document.context`, ghosted in renders) and applies the sandbox write rule through
 *   `ScopeManager.root`. A new work volume or dimension relinks with a fresh journal; a context-only
 *   change syncs the added and removed context in one `world_sync` entry.
 * - **Patches** (W3): every committed journal entry on the linked document (one per restore) is
 *   one conditional patch, in journal order, stamped with the current `link`. `world_sync` commits
 *   are never sent. Nothing is queued while the game is disconnected.
 * - **Acks** (W4): skipped, rejected and normalized positions go into the cache through silo Q's
 *   `applyWorldState` as one `world_sync` entry, and a `world:` line goes to the result of the
 *   call that sent the patch (or the next call on the linked document).
 *
 * Cache writes that arrive between tool calls (acks, context changes, relinks) are applied at
 * once when no call is running, otherwise when the running call's body has returned, so a tool
 * never sees the document change under it.
 */

/** Silo Q's sync primitive (`world/sync.ts`). */
export type ApplyWorldState = typeof applyWorldState;

/** A tool call as the link's call hook sees it (the session's `CallInfo`, structurally). */
export interface HookCall {
  tool: string;
  scope: string;
  doc: boolean;
  mutating: boolean;
}

/** What the link uses of the session (structurally `server/session.ts`'s `Session`). */
export interface LinkHost {
  readonly doc?: Document | undefined;
  readonly scopes: ScopeManager;
  readonly events: EventSink;
  subscribe(fn: EventListener): () => void;
  adopt(doc: Document, opts?: { overwrite?: boolean }): Promise<Document>;
  pathFor(name: string): string;
  touch(): void;
  readonly callHooks: { before?(call: HookCall): Promise<void> | void; after?(call: HookCall, result: CallToolResult): Promise<CallToolResult> | CallToolResult }[];
}

export interface LiveLinkOptions {
  /** Overrides the game folder holding the pairing file (setting `world.gameDir`). */
  gameDir?: string;
  /** How long a call waits for the acks of its patches (setting `world.ackWaitMs`). */
  ackWaitMs?: number;
  /** The sync primitive (default: silo Q's `applyWorldState`); tests may wrap it. */
  apply?: ApplyWorldState;
  /** Bridge reconnect backoff (tests shorten it). */
  backoff?: { minMs: number; maxMs: number };
  log?: (msg: string) => void;
}

/** The linked frame: volumes plus the local masks the root rule uses. */
interface Frame extends LinkVolumes {
  /** The work volume the agent writes, local (the player's box plus whole-block extension). */
  workLocal: Mask;
  /** The read-only context, local. */
  contextLocal: Mask;
  /** Positions the cache holds, as world boxes (for sync filtering). */
  held: WireBox[];
}

interface SentPatch {
  id: number;
  jseq: number[];
  blocks: number;
  /** The NBT the patch wrote, by world position "x,y,z" (null: none), for reconciling normalized NBT. */
  sent: (pos: Vec3) => Compound | null;
  forced: boolean;
  done: Promise<void>;
}

const DEFAULT_NAME = "world";
const fmt = (n: number) => n.toLocaleString("en-US");

export class LiveLink implements WorldLink {
  readonly bridge: Bridge;
  volatile: VolatileList = DEFAULT_VOLATILE;
  private frame?: Frame;
  private linkedDoc?: Document;
  private tap?: JournalTap;
  private sync?: SyncFn;
  private readonly apply: ApplyWorldState;
  private dirty?: { everything: boolean; blocks: Map<string, WorldBlock> };
  /** How the document was opened, for relinks. */
  private openedWith?: LinkOpenOptions & { name: string };
  /** Cache writes waiting for the running call to finish. */
  private readonly pendingWrites: (() => Promise<void> | void)[] = [];
  private running = 0;
  /** Patches sent during the running call. */
  private callPatches: SentPatch[] = [];
  private readonly inflight = new Set<SentPatch>();
  /** Counts and notes for the next `world:` line. */
  private report = { applied: 0, skipped: 0, rejected: 0, overwritten: 0, patches: 0, notes: [] as string[] };
  /** Serialises link changes (open, relink, context sync, reconnect). */
  private chain: Promise<unknown> = Promise.resolve();
  private wasLinked = false;

  constructor(
    private readonly host: LinkHost,
    private readonly opts: LiveLinkOptions = {},
  ) {
    this.apply = opts.apply ?? applyWorldState;
    this.bridge = new Bridge({ instanceDir: opts.gameDir ?? "", volatile: this.volatile, ...(opts.backoff ? { backoff: opts.backoff } : {}), ...(opts.log ? { log: opts.log } : {}) });
    this.bridge.on("volumes", (m) => this.onVolumes(m));
    this.bridge.on("dirty", (m) => {
      if (!this.frame) return;
      const d = (this.dirty ??= { everything: false, blocks: new Map() });
      if (m.everything) d.everything = true;
      else for (const b of m.blocks) d.blocks.set(b.pos.join(","), b);
    });
    this.bridge.onConnection((s, why) => (s === "up" ? this.onUp() : this.onDown(why)));
    host.callHooks.push({ before: (c) => this.before(c), after: (c, r) => this.after(c, r) });
  }

  // -- WorldLink ------------------------------------------------------------------------------

  get state(): LinkState {
    if (!this.bridge.connected) return this.frame && this.current() ? "disconnected" : this.connecting ? "connecting" : "disconnected";
    return this.frame && this.current() ? "linked" : "connected";
  }

  get doc(): Document | undefined {
    return this.frame ? this.current() : undefined;
  }

  get volumes(): LinkVolumes | undefined {
    if (!this.frame || !this.current()) return undefined;
    const { link, dimension, work, extended, context, origin } = this.frame;
    return { link, dimension, work, extended, context, origin };
  }

  isDirty(): boolean {
    return !!this.dirty && (this.dirty.everything || this.dirty.blocks.size > 0);
  }

  takeDirty(): DirtyState | undefined {
    const d = this.dirty;
    this.dirty = undefined;
    return d && { everything: d.everything, blocks: d.everything ? [] : [...d.blocks.values()] };
  }

  async syncNow(reason: SyncReason = "manual"): Promise<EditResult | undefined> {
    if (!this.sync || !this.doc) return undefined;
    const r = await this.sync(this, reason);
    if (r?.changed) this.emit({ kind: "world.sync", reason, changed: r.changed, jseq: r.seq });
    if (r?.changed) this.host.touch();
    return r;
  }

  setSync(fn: SyncFn): void {
    this.sync = fn;
  }

  toWorld(p: Vec3): Vec3 {
    const o = this.frame?.origin ?? [0, 0, 0];
    return [p[0] + o[0], p[1] + o[1], p[2] + o[2]];
  }

  toLocal(p: Vec3): Vec3 {
    const o = this.frame?.origin ?? [0, 0, 0];
    return [p[0] - o[0], p[1] - o[1], p[2] - o[2]];
  }

  open(o: LinkOpenOptions): Promise<{ doc: Document; report: string }> {
    return this.serial(() => this.doOpen({ ...o, name: o.name ?? DEFAULT_NAME }, false));
  }

  /** Disconnects and stops (server shutdown). */
  close(): void {
    this.tap?.close();
    this.bridge.close();
  }

  // -- linking --------------------------------------------------------------------------------

  private connecting = false;

  /** The linked document while it is still the session's base document. */
  private current(): Document | undefined {
    const d = this.linkedDoc;
    return d && this.host.doc === d ? d : undefined;
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => {});
    return run;
  }

  private async connect(o: LinkOpenOptions): Promise<void> {
    this.volatile = mergeVolatile(DEFAULT_VOLATILE, ...o.plugins.map((p) => p.volatileKeys ?? {}));
    this.bridge.setVolatile(this.volatile);
    if (this.bridge.connected) return;
    this.bridge.setInstanceDir(this.opts.gameDir ?? gameDirOf(o.instanceDir));
    this.connecting = true;
    try {
      await this.bridge.connect();
    } finally {
      this.connecting = false;
    }
  }

  /** The mod sends `volumes` right after its hello; wait briefly for it. */
  private async volumesMessage(): Promise<VolumesMessage> {
    for (let i = 0; i < 200 && !this.bridge.volumes; i++) await new Promise((r) => setTimeout(r, 10));
    const v = this.bridge.volumes;
    if (!v) throw new BridgeError("world_disconnected", "The game connected but didn't report its volumes.");
    return v;
  }

  private async doOpen(o: LinkOpenOptions & { name: string }, relink: boolean): Promise<{ doc: Document; report: string }> {
    await this.connect(o);
    const v = await this.volumesMessage();
    if (v.work === null)
      throw refusal("world_no_volume", "No work volume is set in-game. In the game, run /autosketch wand and mark the work volume (left-click one corner, right-click the other), then call doc_open({world: true}) again.");
    if (!relink && existsSync(this.host.pathFor(o.name)) && !o.overwrite) {
      const old = await loadNative(this.host.pathFor(o.name), { journal: false }).catch(() => undefined);
      if (!old?.meta.source?.startsWith("world:"))
        throw new Error(`a document named "${o.name}" already exists and isn't a linked world document; pass another name, or overwrite: true to replace it`);
    }
    const previous = this.current();
    const dimension = v.dimension;
    const origin: Vec3 = [...v.work.min];
    const boxes = [v.work, ...v.context];
    const snap = await this.bridge.request({ type: "snapshot", dimension, boxes });
    const doc = Document.create({ name: o.name, dataVersion: this.bridge.hello?.game.dataVersion ?? 0, palettes: o.palettes });
    doc.meta.source = `world:${dimension} ${fmtWire(v.work)}`;
    let held = boxes.slice();
    writeSnapshot(doc, snap, origin);

    // Whole blocks (13, *Model*): extend the work volume over every multi-block it cuts.
    const toLocalBox = (b: WireBox): Box => fromPublic({ min: sub(b.min, origin), max: sub(b.max, origin) });
    let workLocal = Mask.fromBox(toLocalBox(v.work));
    const ext = extendWholeBlocks(doc, workLocal, o.plugins);
    let extended = v.work;
    if (!ext.added.isEmpty()) {
      const eb = ext.mask.bbox()!;
      extended = { min: add(eb.min, origin), max: add([eb.max[0] - 1, eb.max[1] - 1, eb.max[2] - 1], origin) };
      if (!held.some((b) => contains(b, extended))) {
        // A plugin multi-block reaching past the context: read the rest of it too.
        writeSnapshot(doc, await this.bridge.request({ type: "snapshot", dimension, boxes: [extended] }), origin);
        held = [...held, extended];
      }
      workLocal = ext.mask;
      await this.bridge.request({ type: "volumes.extend", link: v.link, work: extended });
    }
    let contextLocal = new Mask();
    for (const b of held) contextLocal.unionWith(Mask.fromBox(toLocalBox(b)));
    contextLocal = contextLocal.subtract(workLocal);
    let bounds: Box | undefined;
    for (const b of held) bounds = unionBox(bounds, toLocalBox(b));
    doc.bounds = bounds;
    doc.context = contextLocal;
    if (previous) {
      for (const [k, s] of previous.selections) doc.selections.set(k, s);
      for (const [k, c] of previous.cameras) doc.cameras.set(k, c);
    }

    this.tap?.close();
    await this.host.adopt(doc, { overwrite: true });
    this.host.scopes.root = { work: workLocal, context: contextLocal };
    this.frame = { link: v.link, dimension, work: v.work, extended, context: v.context, origin, workLocal, contextLocal, held };
    this.linkedDoc = doc;
    this.openedWith = o;
    this.dirty = undefined;
    this.wasLinked = true;
    this.tap = tapJournal((fn) => this.host.subscribe(fn), () => this.current(), (d, steps) => this.onBatch(d, steps));
    const added = ext.added.count();
    this.emit({ kind: "world.link", state: relink ? "relinked" : "linked", dimension, work: toPublic(toLocalBox(v.work)), extended: added, context: v.context.length });

    const lines = [
      `${relink ? "Relinked" : "Linked"} to the world (${dimension}): work volume ${size(v.work)} at world ${fmtVec(v.work.min)}, local ${formatBox(toLocalBox(v.work))}; ` +
        `context ${v.context.length} box${v.context.length === 1 ? "" : "es"}, local ${formatBox(bounds!)} (read-only, live).`,
      ...(added ? [`Work volume extended by ${fmt(added)} block${added === 1 ? "" : "s"} to include whole blocks (doors, beds, double chests, multi-blocks): ${formatBox(workLocal.bbox()!)}. The player was told.`] : []),
      "Writes outside the work volume are refused. Each edit goes to the game as one patch; blocks the player changed since are skipped, and results gain a \"world:\" line.",
      ...(relink && previous ? ["The player set a new work volume, so the history before this point is gone (old checkpoints can't be restored)."] : []),
    ];
    return { doc, report: lines.join("\n") };
  }

  // -- patches --------------------------------------------------------------------------------

  private nextPatch = 0;

  private onBatch(doc: Document, steps: JournalStep[]): void {
    const f = this.frame;
    if (!f || doc !== this.current()) return;
    const forced = (doc as { overwriting?: boolean }).overwriting === true;
    const blocks = patchBlocks(doc, steps, f.workLocal, f.origin, this.volatile);
    if (!blocks.length) return;
    const jseq = steps.map((s) => s.entry.seq);
    if (!this.bridge.connected) {
      this.note(`world: not connected to the game, so ${fmt(blocks.length)} block${blocks.length === 1 ? " was" : "s were"} not sent; the next sync makes the cache match the world again.`);
      this.emit({ kind: "world.patch", patch: 0, jseq, blocks: blocks.length, ...(forced ? { forced } : {}), applied: 0, skipped: 0, rejected: 0, overwritten: 0, normalized: 0, dropped: "disconnected" });
      return;
    }
    const sent = this.send(blocks, jseq, forced, f);
    if (this.running) this.callPatches.push(sent);
  }

  private send(blocks: PatchBlock[], jseq: number[], forced: boolean, f: Frame): SentPatch {
    const id = ++this.nextPatch;
    let byPos: Map<string, Compound | null> | undefined;
    const sent = (pos: Vec3) => {
      byPos ??= new Map(blocks.map((b) => [b.pos.join(","), b.nbt ?? null]));
      return byPos.get(pos.join(",")) ?? null;
    };
    const p: SentPatch = { id, jseq, blocks: blocks.length, forced, sent, done: Promise.resolve() };
    p.done = this.bridge
      .request({ type: "patch", link: f.link, dimension: f.dimension, ...(forced ? { force: true } : {}), blocks })
      .then(
        (ack) => this.onAck(p, ack, f),
        (e: BridgeError) => {
          this.note(`world: patch not confirmed (${e.message}); the next sync makes the cache match the world again.`);
          this.emit({ kind: "world.patch", patch: id, jseq, blocks: blocks.length, ...(forced ? { forced } : {}), applied: 0, skipped: 0, rejected: 0, overwritten: 0, normalized: 0, dropped: e.refusal });
        },
      )
      .finally(() => this.inflight.delete(p));
    this.inflight.add(p);
    return p;
  }

  private async onAck(p: SentPatch, ack: PatchAck, f: Frame): Promise<void> {
    const r = this.report;
    r.patches++;
    r.applied += ack.applied;
    r.skipped += ack.skipped.length;
    r.rejected += ack.rejected.length;
    r.overwritten += ack.overwritten;
    this.emit({ kind: "world.patch", patch: p.id, jseq: p.jseq, blocks: p.blocks, ...(p.forced ? { forced: true } : {}), applied: ack.applied, skipped: ack.skipped.length, rejected: ack.rejected.length, overwritten: ack.overwritten, normalized: ack.normalized.length });
    // Rejected positions carry no state, and the world is authoritative: read what it holds there.
    const reread = ack.rejected.map((x) => x.pos);
    let snapshot: SnapshotResult | undefined;
    if (reread.length) {
      const boxes = reread.length <= 4096 ? reread.map((pos) => ({ min: pos, max: pos })) : [bboxOf(reread)];
      snapshot = await this.bridge.request({ type: "snapshot", dimension: f.dimension, boxes }).catch((e: Error) => {
        this.note(`world: couldn't read the rejected positions back from the game (${e.message}); call world_sync.`);
        return undefined;
      });
    }
    const reasons = new Map<string, number>();
    for (const x of ack.rejected) reasons.set(x.reason, (reasons.get(x.reason) ?? 0) + 1);
    if (reasons.size) this.note(`world: rejected by the game: ${[...reasons].map(([k, n]) => `${fmt(n)} ${k}`).join(", ")}.`);
    if (!ack.skipped.length && !ack.normalized.length && !snapshot) return;
    this.whenIdle(() => {
      if (this.frame !== f || !this.current()) return;
      const res = this.apply(this.current()!, { blocks: ack.skipped, nbt: ack.normalized.map((n) => ({ ...n, sent: p.sent(n.pos) })), ...(snapshot ? { snapshot } : {}) }, { origin: f.origin, volumes: f.held, volatile: this.volatile, reconcile: true, summary: `world sync: patch ${p.id} (${fmt(ack.skipped.length)} skipped, ${fmt(ack.rejected.length)} rejected, ${fmt(ack.normalized.length)} normalized)` });
      if (res.changed) {
        this.host.touch();
        this.emit({ kind: "world.sync", reason: "ack", changed: res.changed, jseq: res.seq });
      }
    });
  }

  // -- volumes and connection -----------------------------------------------------------------

  private onVolumes(m: VolumesMessage): void {
    const f = this.frame;
    if (!f || !this.current() || (m.work !== null && m.extended && sameBox(m.work, f.work) && m.dimension === f.dimension && m.link === f.link && sameBoxes(m.context, f.context))) return;
    this.whenIdle(() => this.serial(() => this.followVolumes(m)));
  }

  /** Brings the link in line with the mod's volumes: unlink, relink, or a context sync. */
  private async followVolumes(m: VolumesMessage): Promise<void> {
    const f = this.frame;
    const doc = this.current();
    if (!f || !doc) return;
    if (m.work === null) return this.unlink("the player cleared the work volume");
    if (m.dimension !== f.dimension || !sameBox(m.work, f.work)) {
      const open = this.host.scopes.openCount;
      if (open) return this.unlink(`the player set a new work volume while ${open} scoped job${open === 1 ? " is" : "s are"} open; merge or abandon them, then call doc_open({world: true}) to relink`);
      try {
        const r = await this.doOpen(this.openedWith!, true);
        this.note(`world: ${r.report.split("\n")[0]}`);
      } catch (e) {
        // The player may have moved on while this relink ran (two corners marked in quick
        // succession): follow the latest volumes rather than unlinking over a stale box.
        const latest = this.bridge.volumes;
        if (latest && latest !== m && this.bridge.connected) return this.followVolumes(latest);
        this.unlink(`relinking failed: ${(e as Error).message}`);
      }
      return;
    }
    // Same work volume (a reconnect may renumber the link): keep the frame, follow the context.
    f.link = m.link;
    if (f.extended !== f.work && !(m.extended && sameBox(m.extended, f.extended)))
      await this.bridge.request({ type: "volumes.extend", link: m.link, work: f.extended }).catch((e: Error) => this.note(`world: couldn't re-declare the whole-block extension: ${e.message}`));
    if (!sameBoxes(m.context, f.context)) await this.followContext(f, doc, m.context);
  }

  /** A context-only change (13): snapshot the added context and clear the removed, in one entry. */
  private async followContext(f: Frame, doc: Document, context: WireBox[]): Promise<void> {
    const toLocalBox = (b: WireBox): Box => fromPublic({ min: sub(b.min, f.origin), max: sub(b.max, f.origin) });
    const extraHeld = f.held.filter((b) => b !== f.work && !f.context.includes(b)); // extension snapshots
    const held = [f.work, ...context, ...extraHeld];
    let next = new Mask();
    for (const b of held) next.unionWith(Mask.fromBox(toLocalBox(b)));
    const removed = f.contextLocal.clone().subtract(next);
    next = next.subtract(f.workLocal);
    const added = context.filter((b) => !f.context.some((o) => contains(o, b)));
    const snapshot = added.length ? await this.bridge.request({ type: "snapshot", dimension: f.dimension, boxes: added }) : undefined;
    const clears: WorldBlock[] = removed.positions().map((p) => ({ pos: add(p, f.origin), state: "minecraft:air" }));
    if (snapshot || clears.length) {
      const res = this.apply(doc, { blocks: clears, ...(snapshot ? { snapshot } : {}) }, { origin: f.origin, volatile: this.volatile, summary: `world sync: context changed (${added.length} box${added.length === 1 ? "" : "es"} added, ${fmt(removed.count())} blocks removed)` });
      if (res.changed) this.emit({ kind: "world.sync", reason: "context", changed: res.changed, jseq: res.seq });
    }
    f.context = context;
    f.held = held;
    f.contextLocal = next;
    this.host.scopes.root = { work: f.workLocal, context: next };
    doc.context = next;
    let bounds: Box | undefined;
    for (const b of held) bounds = unionBox(bounds, toLocalBox(b));
    doc.bounds = bounds;
    this.host.touch();
    this.note(`world: the player changed the context volume (now ${context.length} box${context.length === 1 ? "" : "es"}, local ${formatBox(bounds!)}).`);
  }

  private unlink(why: string): void {
    this.tap?.close();
    this.tap = undefined;
    if (this.current()) {
      this.host.scopes.root = undefined;
      this.note(`world: no longer linked: ${why}. The document stays open as a plain schematic.`);
    }
    this.frame = undefined;
    this.linkedDoc = undefined;
    this.emit({ kind: "world.link", state: "unlinked", reason: why });
  }

  private onUp(): void {
    if (!this.wasLinked || !this.frame || !this.current()) return this.emit({ kind: "world.link", state: "connected" });
    // A reconnect: follow the volumes (relink if the work volume changed), then a section-hash sync.
    this.whenIdle(() =>
      this.serial(async () => {
        const v = await this.volumesMessage().catch(() => undefined);
        if (v) await this.followVolumes(v);
        if (!this.current()) return;
        this.emit({ kind: "world.link", state: "connected", reason: "reconnected" });
        try {
          const r = await this.syncNow("reconnect");
          this.note(`world: reconnected to the game${r?.changed ? `; ${fmt(r.changed)} blocks synced from the world` : ""}.`);
        } catch (e) {
          this.note(`world: reconnected, but the sync failed: ${(e as Error).message}`);
        }
      }),
    );
  }

  private onDown(why?: string): void {
    if (!this.frame || !this.current()) return;
    this.emit({ kind: "world.link", state: "disconnected", ...(why ? { reason: why } : {}) });
    this.note("world: the game disconnected; edits stay in the cache only until it reconnects, then the world wins.");
  }

  // -- call hooks -----------------------------------------------------------------------------

  private async before(_call: HookCall): Promise<void> {
    await this.flush();
    await this.chain;
    this.running++;
    if (this.running === 1) this.callPatches = [];
  }

  private async after(call: HookCall, result: CallToolResult): Promise<CallToolResult> {
    const mine = this.callPatches;
    if (mine.length && this.opts.ackWaitMs !== 0) {
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([Promise.all(mine.map((p) => p.done)), new Promise((r) => (timer = setTimeout(r, this.opts.ackWaitMs ?? 1500)))]);
      clearTimeout(timer);
    }
    this.running = Math.max(0, this.running - 1);
    if (!this.running) {
      await this.flush();
      await this.chain;
    }
    // A merge names the job's scope, but its patch is the base document's: its result gets the line.
    const linkedCall = (call.doc && call.scope === "base") || call.tool === "doc_open" || (call.tool === "scope_merge" && mine.length > 0);
    if (!linkedCall || this.running) return result;
    const line = this.takeLine();
    return line ? { ...result, content: [...result.content, { type: "text", text: line }] } : result;
  }

  /** Runs a cache write now if no call is running, else after the running call's body returns. */
  private whenIdle(fn: () => Promise<void> | void): void {
    if (this.running) this.pendingWrites.push(fn);
    else void Promise.resolve(fn()).catch((e: Error) => this.opts.log?.(`world: ${e.message}`));
  }

  private async flush(): Promise<void> {
    while (this.pendingWrites.length) {
      try {
        await this.pendingWrites.shift()!();
      } catch (e) {
        this.opts.log?.(`world: ${(e as Error).message}`);
      }
    }
  }

  private note(line: string): void {
    if (!this.report.notes.includes(line)) this.report.notes.push(line);
  }

  /** The `world:` line(s) since the last report, or undefined. */
  private takeLine(): string | undefined {
    const r = this.report;
    this.report = { applied: 0, skipped: 0, rejected: 0, overwritten: 0, patches: 0, notes: [] };
    const lines: string[] = [];
    if (r.patches) lines.push(`world: ${fmt(r.applied)} placed, ${fmt(r.skipped)} skipped (hand-edited), ${fmt(r.rejected)} rejected${r.overwritten ? `, ${fmt(r.overwritten)} hand-edited overwritten` : ""}`);
    lines.push(...r.notes);
    return lines.length ? lines.join("\n") : undefined;
  }

  /** Waits for every patch in flight to be acked and its cache write applied (tests, shutdown). */
  async settle(): Promise<void> {
    while (this.inflight.size) await Promise.all([...this.inflight].map((p) => p.done));
    await this.chain;
    if (!this.running) await this.flush();
    await this.chain;
  }

  private emit(e: Parameters<EventSink["emit"]>[0]): void {
    const s = this.host.events;
    if (s.enabled) s.emit(e);
  }
}

// -- helpers ------------------------------------------------------------------------------------

/** The game folder: the instance itself, or its `.minecraft` / `minecraft` folder when the pairing file is there. */
export function gameDirOf(instanceDir: string): string {
  for (const d of [instanceDir, join(instanceDir, ".minecraft"), join(instanceDir, "minecraft")]) if (existsSync(join(d, PAIRING_FILE))) return d;
  return instanceDir;
}

/** Writes a snapshot's regions into a fresh document (store = local; local = world − origin). */
function writeSnapshot(doc: Document, snap: SnapshotResult, origin: Vec3): void {
  const ids = snap.palette.map((s) => doc.states.intern(s === "minecraft:cave_air" || s === "minecraft:void_air" ? "minecraft:air" : s));
  for (const r of snap.regions) {
    const { min, max } = r.box;
    let i = 0;
    for (let y = min[1]; y <= max[1]; y++)
      for (let z = min[2]; z <= max[2]; z++)
        for (let x = min[0]; x <= max[0]; x++) {
          const id = ids[r.states[i++]!]!;
          doc.voxels.set(x - origin[0], y - origin[1], z - origin[2], id);
        }
    for (const be of r.blockEntities) doc.blockEntities.set(`${be.pos[0] - origin[0]},${be.pos[1] - origin[1]},${be.pos[2] - origin[2]}`, be.nbt);
  }
}

const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const sameBox = (a: WireBox, b: WireBox) => a.min.join() === b.min.join() && a.max.join() === b.max.join();
const sameBoxes = (a: readonly WireBox[], b: readonly WireBox[]) => a.length === b.length && a.every((x, i) => sameBox(x, b[i]!));
const contains = (o: WireBox, b: WireBox) => [0, 1, 2].every((i) => o.min[i]! <= b.min[i]! && o.max[i]! >= b.max[i]!);
const size = (b: WireBox) => [0, 1, 2].map((i) => b.max[i]! - b.min[i]! + 1).join("×");
const fmtVec = (v: Vec3) => `(${v.join(",")})`;
const fmtWire = (b: WireBox) => `${fmtVec(b.min)}–${fmtVec(b.max)}`;

function bboxOf(ps: Vec3[]): WireBox {
  const min: Vec3 = [...ps[0]!], max: Vec3 = [...ps[0]!];
  for (const p of ps) for (let i = 0; i < 3; i++) (min[i] = Math.min(min[i]!, p[i]!)), (max[i] = Math.max(max[i]!, p[i]!));
  return { min, max };
}

export type { AutosketchPlugin };
