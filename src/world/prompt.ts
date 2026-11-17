import type { PublicBox, Vec3 } from "../core/region.js";
import type { EventListener } from "../core/fanout.js";
import { lookTarget, removeCamera, saveCamera } from "../document/cameras.js";
import type { Document } from "../document/document.js";
import type { PaletteBook } from "../palette/pick.js";
import { refusal } from "../scope/scopes.js";
import { ActivityStream, type OpenRequest } from "./chat-stream.js";
import type { LinkVolumes, WorldLink } from "./link.js";
import { MODE_ALLOWS, modeOf, READ_ONLY_MODES, RequestModeRule, type ModeRequest } from "./modes.js";
import type { GameContext, ModHello, PlayerRef, PromptClose, PromptMessage, PromptRefusal, RequestMode, WireBox } from "./protocol/messages.js";
import { loadProbe, probeText, type Probe } from "./probe.js";
import { setVolumes, type ContextArg, type VolumesFrame } from "./set-volumes.js";
import type { PromptSettings } from "./settings.js";

/**
 * In-game requests, MCP side (docs/design/13-live-world.md, *Prompting from the game*, W11).
 *
 * A `prompt` from the mod goes through, in order:
 * 1. **The allowlist** (`world.promptPlayers`, plus the singleplayer host the mod's `hello` names).
 *    It runs before anything else, so a player who isn't allowed learns nothing and nothing reaches
 *    the channel: refused `not_allowed`.
 * 1b. **The mode gate:** a request in a mode this MCP's hello didn't list is refused
 *    `unsupported_mode` (the mod should have refused it itself; `13`, *Versions and features*), so a
 *    read-only mode is never run as a build. A prompt without `mode` is a `build` request.
 * 2. **The link:** no linked document, refused `no_link`.
 * 3. **A listener:** refused `no_listener` when the MCP client is known not to receive channel
 *    events. Claude Code doesn't say whether a session loaded the server as a channel (the client's
 *    capabilities at initialize don't include it, and notifications aren't acknowledged), so this
 *    only catches a server with no initialized client; otherwise delivery is optimistic.
 * 4. **Context as handles:** the game context is converted to document-local coordinates and saved
 *    on the linked document: `focus` and `target` as saved selections, the player's view as the
 *    saved camera `player` (70° field of view; the server doesn't know the client's). Each request
 *    replaces them; one it doesn't carry is removed, so a stale handle is never mistaken for a new
 *    one. Outside both volumes they are reported, not saved; in the context volume they are saved
 *    and the text says they are read-only there.
 * 5. **One channel event** with the fixed text shape `13` shows, opening with the mode and what it
 *    allows, then the handoff facts; then `prompt.result` delivered, and the request's chat stream
 *    opens. While it is open, its mode is enforced (`modes.ts`, `modeRule`).
 *
 * A read-only request (`ask`, `plan`, `scan`) holds its mode until the player lifts it: the mode is
 * the player's permission over their world, so only the player ends it (settled with the user
 * 2026-11-16). The agent's `world_reply` with `done` answers the request and closes its activity
 * stream, but the mode stays in force until `/autosketch done` (`prompt.close`), the player's next
 * delivered request, or the game disconnecting.
 */

/** Claude Code's channel notification (Claude Code docs, *Channels reference*). */
export const CHANNEL_METHOD = "notifications/claude/channel";
/** The experimental capability that declares the server a Claude Code channel. */
export const CHANNEL_CAPABILITY = "claude/channel";
/** Appended to the server instructions when the channel is declared (Claude Code recommends saying what events mean and how to answer). */
export const CHANNEL_INSTRUCTIONS =
  'In-game requests from the linked Minecraft world arrive as <channel source="autosketch" request="…" player="…">: the player\'s words, the work volume, and handles for what they point at ' +
  '(selections "focus" and "target", camera "player"). The request names its mode (ask, plan, scan or build), and edits the mode doesn\'t allow are refused while it is open. Do the work on the linked document as usual, and answer the player with world_reply (done: true when finished); they only see what you send through it.';

/** Answers to in-game requests, as the `world_reply` tool reaches them (through `Session.inGame`). */
export interface InGameReplies {
  /** Whether a game is connected to send to. */
  readonly connected: boolean;
  /** The open request stream, if any. */
  readonly current: OpenRequest | undefined;
  /**
   * Sends reply lines; `done` marks the request answered and closes its stream. `open` says whether
   * the request answered was the open one; `held` names the read-only mode still in force after it
   * (only the player ends that, B6).
   */
  reply(lines: string[], opts?: { done?: boolean; request?: number }): { request: OpenRequest | undefined; open: boolean; held?: RequestMode };
  /** Sets the player's volumes (`world_volumes`, B4) in the coordinates of the open probe or linked document; resolves with the result text. */
  setVolumes(work: PublicBox, context?: ContextArg): Promise<string>;
}

/** What the scan probe uses of the session (structurally `Session`). */
export interface ProbeHost {
  readonly doc?: Document | undefined;
  adoptTemporary(doc: Document): Promise<Document>;
}

export interface InGameRequestsOptions extends PromptSettings {
  /** The session's event fan-out (`Session.subscribe`). */
  subscribe: (fn: EventListener) => () => void;
  /** Pushes one channel event (`notifications/claude/channel`, `content` and `meta`). */
  notify: (content: string, meta: Record<string, string>) => Promise<void>;
  /** False when no agent session can receive channel events (see 3. above). */
  listening: () => boolean;
  /** Schedules an autosave of the linked document (`Session.touch`). */
  touch?: () => void;
  /** Opens the scan probe as the session's temporary document (B4). Without it, scan requests arrive without a probe. */
  host?: ProbeHost;
  /** The palettes the probe document carries (the instance's book). */
  palettes?: () => PaletteBook | undefined;
  /** Whether linking follows a volume change on its own (setting `world.autoLink`; default true), for `world_volumes`' result. */
  autoLink?: boolean;
  log?: (msg: string) => void;
}

/**
 * Whether a player may prompt the agent (13, "Allowed players"): listed by UUID or by name
 * (names compare case-insensitively, as the game does), or the singleplayer host.
 */
export function promptAllowed(player: PlayerRef, list: readonly string[], hello: ModHello | undefined): boolean {
  if (hello?.singleplayer && hello.host && hello.host.uuid.toLowerCase() === player.uuid.toLowerCase()) return true;
  const uuid = player.uuid.toLowerCase(), name = player.name.toLowerCase();
  return list.some((e) => {
    const v = e.trim().toLowerCase();
    return v === uuid || v === name;
  });
}

export class InGameRequests implements InGameReplies {
  readonly stream: ActivityStream;
  /**
   * The request mode rule (B6): a call hook for `Session.callHooks` (the entry point installs it)
   * and the write guard it attaches to the linked document. Refuses with `request_mode`.
   */
  readonly modeRule: RequestModeRule;
  private readonly offs: (() => void)[] = [];
  /** The latest scan probe (B4); open while it is still the session's document. */
  private probe?: Probe;
  /**
   * The read-only request whose mode is in force (B6): set on delivery, ended only by the player
   * (`prompt.close`, the next delivered request) or a disconnect, never by the agent's `done`.
   */
  private held?: ModeRequest;

  constructor(
    private readonly link: WorldLink,
    private readonly opts: InGameRequestsOptions,
  ) {
    this.stream = new ActivityStream({ subscribe: opts.subscribe, send: (m) => link.bridge.send(m), linked: () => link.state === "linked" || this.probeOpen() !== undefined, activityMs: opts.activityMs, idleMs: opts.idleMs });
    this.modeRule = new RequestModeRule(
      () => this.held,
      () => (link.state === "linked" ? link.doc : undefined),
    );
    this.offs.push(link.bridge.on("prompt", (m) => void this.onPrompt(m)));
    this.offs.push(link.bridge.on("prompt.close", (m) => this.onClose(m)));
    // The activity stream listens only while a game is connected, so an unlinked session pays nothing.
    this.offs.push(
      link.bridge.onConnection((s) => {
        if (s === "up") return this.stream.start();
        this.stream.stop();
        this.held = undefined;
      }),
    );
    if (link.bridge.connected) this.stream.start();
  }

  get connected(): boolean {
    return this.link.bridge.connected;
  }

  get current(): OpenRequest | undefined {
    return this.stream.current;
  }

  reply(lines: string[], opts: { done?: boolean; request?: number } = {}): { request: OpenRequest | undefined; open: boolean; held?: RequestMode } {
    const r = this.stream.reply(lines, opts);
    return this.held ? { ...r, held: this.held.mode } : r;
  }

  /** The read-only request whose mode is in force, if any (B6). */
  get heldRequest(): ModeRequest | undefined {
    return this.held;
  }

  /**
   * The player ran `/autosketch done` (`prompt.close`, B6): ends the open read-only request, so its
   * mode no longer holds. The answer goes on that player's action bar as a `notice`: the MCP owns
   * the request state, so it is the side that knows whether one was open.
   */
  onClose(m: PromptClose): void {
    const tell = (text: string) => this.link.bridge.send({ type: "notice", text, player: m.player.uuid });
    if (!promptAllowed(m.player, this.opts.promptPlayers, this.link.bridge.hello)) {
      this.opts.log?.(`in-game done from ${m.player.name} refused: not_allowed`);
      return tell("Autosketch: you aren't allowed to send requests (world.promptPlayers), so you can't end one either.");
    }
    const r = this.held;
    if (!r) return tell("Autosketch: no ask, plan or scan request is open.");
    this.held = undefined;
    if (this.stream.current?.id === r.id) this.stream.closeRequest();
    this.opts.log?.(`in-game ${r.mode} request ${r.id} ended by ${m.player.name}`);
    tell(`Autosketch: ${r.mode} request ${r.id} ended; the agent may edit again.`);
  }

  /** Opens a delivered request's stream and, for a read-only mode, holds the mode (replacing any held one). */
  open(r: OpenRequest): void {
    const mode = modeOf(r);
    this.held = READ_ONLY_MODES.has(mode) ? { id: r.id, player: r.player, mode } : undefined;
    this.stream.open({ id: r.id, player: r.player, mode });
  }

  /** The scan probe while it is the session's open document. */
  probeOpen(): Probe | undefined {
    const p = this.probe;
    return p && this.opts.host?.doc === p.doc ? p : undefined;
  }

  async setVolumes(work: PublicBox, context?: ContextArg): Promise<string> {
    const p = this.probeOpen();
    let frame: VolumesFrame | undefined;
    if (p) frame = { origin: p.origin, dimension: p.dimension, label: "probe" };
    else if (this.link.state === "linked" && this.link.volumes) frame = { origin: this.link.volumes.origin, dimension: this.link.volumes.dimension, label: "local" };
    if (!this.link.bridge.connected) throw refusal("world_disconnected", "No game is connected, so there are no volumes to set.");
    if (!frame)
      throw refusal("world_no_document", "world_volumes takes coordinates in the scan probe or the linked document, and neither is open. Ask the player to run /autosketch scan, or link with doc_open({world: true}).");
    return setVolumes(this.link.bridge, frame, work, context, this.opts.autoLink ?? true);
  }

  close(): void {
    for (const off of this.offs.splice(0)) off();
    this.stream.stop();
  }

  /** Handles one `prompt`; resolves once `prompt.result` is sent. */
  async onPrompt(m: PromptMessage): Promise<void> {
    const refuse = (reason: PromptRefusal) => {
      this.opts.log?.(`in-game request ${m.id} from ${m.player.name} refused: ${reason}`);
      this.link.bridge.send({ type: "prompt.result", id: m.id, delivered: false, reason });
    };
    if (!promptAllowed(m.player, this.opts.promptPlayers, this.link.bridge.hello)) return refuse("not_allowed");
    if (!this.link.bridge.modes.includes(m.mode ?? "build")) return refuse("unsupported_mode");
    if (m.mode === "scan") return this.onScan(m, refuse);
    if (this.link.state !== "linked") await this.link.ensureLinked?.();
    const doc = this.link.doc, volumes = this.link.volumes;
    if (this.link.state !== "linked" || !doc || !volumes) return refuse("no_link");
    if (!this.opts.listening()) return refuse("no_listener");
    const text = requestText(doc, volumes, m);
    this.opts.touch?.();
    try {
      await this.opts.notify(text, { request: String(m.id), player: m.player.name });
    } catch (e) {
      this.opts.log?.(`channel notification failed: ${(e as Error).message}`);
      return refuse("no_listener");
    }
    this.modeRule.attach(doc);
    this.link.bridge.send({ type: "prompt.result", id: m.id, delivered: true });
    this.open({ id: m.id, player: m.player, mode: modeOf(m) });
  }

  /**
   * A scan request (B4): no link needed. The probe is read from the grant and opened as the
   * session's temporary document before the event is sent; when it can't be, the event says why
   * and the request is delivered anyway (the agent can still answer).
   */
  private async onScan(m: PromptMessage, refuse: (reason: PromptRefusal) => void): Promise<void> {
    if (!this.opts.listening()) return refuse("no_listener");
    let note: string;
    const palettes = this.opts.palettes?.();
    if (!m.scan) note = "No probe: the mod sent no scan grant (its hello doesn't list the scan feature; update the Autosketch mod).";
    else if (!this.opts.host) note = "No probe: this server can't open one.";
    else {
      try {
        const probe = await loadProbe(this.link.bridge, { ...m, scan: m.scan }, { dataVersion: this.link.bridge.hello?.game.dataVersion ?? 0, ...(palettes ? { palettes } : {}) });
        await this.opts.host.adoptTemporary(probe.doc);
        this.probe = probe;
        note = probeText(probe) + " " + scanHandles(probe, m);
      } catch (e) {
        note = `The probe couldn't be loaded: ${(e as Error).message}`;
      }
    }
    const text = [`In-game scan request from ${m.player.name}: ${JSON.stringify(m.text)}.`, MODE_ALLOWS.scan, note, `Answer the player with world_reply (request ${m.id}); pass done: true when finished.`].join(" ");
    try {
      await this.opts.notify(text, { request: String(m.id), player: m.player.name });
    } catch (e) {
      this.opts.log?.(`channel notification failed: ${(e as Error).message}`);
      return refuse("no_listener");
    }
    this.link.bridge.send({ type: "prompt.result", id: m.id, delivered: true });
    this.open({ id: m.id, player: m.player, mode: "scan" });
  }
}

/** The scan event's handle line: which of target, focus and the player camera the probe holds. */
function scanHandles(p: Probe, m: PromptMessage): string {
  const ctx = m.context, doc = p.doc;
  const out: string[] = [];
  if (ctx.target) out.push(doc.selections.has("target") ? `Looking at ${ctx.target.state} (${ctx.target.face} face), saved as "target".` : `Looking at ${ctx.target.state} outside the scanned columns, so not saved.`);
  else out.push("Not looking at a block within reach.");
  if (ctx.focus) out.push(doc.selections.has("focus") ? `Focus box ${size(ctx.focus)}, saved as "focus".` : "The focus box reaches outside the scanned columns, so not saved.");
  out.push(`Standing at ${pt(sub(ctx.position.map(Math.floor) as Vec3, p.origin))} facing ${ctx.facing}; your view is saved as camera "player".`);
  return out.join(" ");
}

// -- the event text ------------------------------------------------------------------------------

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const size = (b: WireBox) => `${b.max[0] - b.min[0] + 1}×${b.max[1] - b.min[1] + 1}×${b.max[2] - b.min[2] + 1}`;
const inBox = (b: WireBox, p: readonly number[]) => p.every((v, i) => v >= b.min[i]! && v <= b.max[i]!);
const boxIn = (outer: WireBox, inner: WireBox) => inBox(outer, inner.min) && inBox(outer, inner.max);
const meets = (a: WireBox, b: WireBox) => [0, 1, 2].every((i) => a.min[i]! <= b.max[i]! && a.max[i]! >= b.min[i]!);
const pt = (p: readonly number[]) => `(${p.join(", ")})`;

type Where = "work" | "context" | "outside";

/**
 * Saves the request's context on the document and returns the channel event text (13, the fixed
 * shape): who asked and what, the handoff facts, the target, the focus box, where the player stands.
 */
export function requestText(doc: Document, v: LinkVolumes, m: PromptMessage): string {
  const ctx = m.context;
  const sameDim = ctx.dimension === v.dimension;
  const mode = modeOf(m);
  const out: string[] = [`In-game ${mode} request from ${m.player.name}: ${JSON.stringify(m.text)}.`, MODE_ALLOWS[mode], handoff(v)];
  out.push(saveTarget(doc, v, ctx, sameDim));
  const focus = saveFocus(doc, v, ctx, sameDim);
  if (focus) out.push(focus);
  out.push(saveView(doc, v, ctx, sameDim));
  out.push(`Answer the player with world_reply (request ${m.id}); pass done: true when finished.`);
  return out.join(" ");
}

/** `Work volume 32×24×32, context +3 and 1 reference box (scope "base").` */
export function handoff(v: LinkVolumes): string {
  const ext = v.extended;
  const work = boxIn(v.work, ext) ? `Work volume ${size(v.work)}` : `Work volume ${size(ext)} (your ${size(v.work)} extended to whole blocks)`;
  let grow: number | undefined;
  let refs = 0;
  for (const b of v.context) {
    const k = growth(ext, b);
    if (k !== undefined && grow === undefined) grow = k;
    else refs++;
  }
  const r = `${refs} reference box${refs === 1 ? "" : "es"}`;
  const context = grow !== undefined ? `context +${grow}${refs ? ` and ${r}` : ""}` : `context ${r}`;
  return `${work}, ${context} (scope "base").`;
}

/** How far `b` is `work` grown on every side (vertical sides may be clipped to build height), or undefined. */
function growth(work: WireBox, b: WireBox): number | undefined {
  const k = work.min[0] - b.min[0];
  if (k < 0) return undefined;
  const lo = [work.min[0] - b.min[0], work.min[2] - b.min[2], b.max[0] - work.max[0], b.max[2] - work.max[2]];
  const hi = [work.min[1] - b.min[1], b.max[1] - work.max[1]];
  return lo.every((d) => d === k) && hi.every((d) => d >= 0 && d <= k) ? k : undefined;
}

function where(v: LinkVolumes, box: WireBox): { where: Where; partly: boolean } {
  if (boxIn(v.extended, box)) return { where: "work", partly: false };
  const covered = v.context.some((c) => boxIn(c, box));
  if (meets(v.extended, box)) return { where: "context", partly: true };
  if (v.context.some((c) => meets(c, box))) return { where: "context", partly: !covered };
  return { where: "outside", partly: false };
}

function saveTarget(doc: Document, v: LinkVolumes, ctx: GameContext, sameDim: boolean): string {
  const t = ctx.target;
  if (!t) {
    doc.selections.delete("target");
    return "Not looking at a block within reach.";
  }
  const looking = `Looking at ${t.state} (${t.face} face)`;
  const w = sameDim ? where(v, { min: t.pos, max: t.pos }).where : "outside";
  if (w === "outside") {
    doc.selections.delete("target");
    return `${looking} at world ${pt(t.pos)}, outside both volumes, so not saved.`;
  }
  const local = sub(t.pos, v.origin);
  doc.selections.set("target", { min: local, max: local });
  doc.revision++;
  return `${looking}, saved as "target"${w === "context" ? " (in the context volume, read-only)" : ""}.`;
}

function saveFocus(doc: Document, v: LinkVolumes, ctx: GameContext, sameDim: boolean): string | undefined {
  const f = ctx.focus;
  if (!f) {
    doc.selections.delete("focus");
    return undefined;
  }
  const clipped = ctx.focusClipped ? ", clipped to the volumes in-game" : "";
  const w = sameDim ? where(v, f) : { where: "outside" as const, partly: false };
  if (w.where === "outside") {
    doc.selections.delete("focus");
    return `Focus box ${size(f)} at world ${pt(f.min)}–${pt(f.max)}, outside both volumes, so not saved.`;
  }
  doc.selections.set("focus", { min: sub(f.min, v.origin), max: sub(f.max, v.origin) });
  doc.revision++;
  const note = w.where === "context" ? (w.partly ? " (partly in the context volume, read-only there)" : " (in the context volume, read-only)") : "";
  return `Focus box ${size(f)}${clipped}, saved as "focus"${note}.`;
}

function saveView(doc: Document, v: LinkVolumes, ctx: GameContext, sameDim: boolean): string {
  if (!sameDim) {
    removeCamera(doc, "player");
    return `Standing in ${ctx.dimension}, not the linked ${v.dimension}, so the view is not saved.`;
  }
  const feet = sub(ctx.position.map(Math.floor) as Vec3, v.origin);
  // Camera positions are document-local with integers at block centres (06, *Cameras*).
  const eye = sub(ctx.eye, v.origin).map((c) => c - 0.5) as Vec3;
  saveCamera(doc, "player", { eye, target: lookTarget(eye, ctx.yaw, ctx.pitch) });
  return `Standing at ${pt(feet)} facing ${ctx.facing}; your view is saved as camera "player".`;
}
