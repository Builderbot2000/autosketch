import type { Vec3 } from "../core/region.js";
import type { EventListener } from "../core/fanout.js";
import { lookTarget, removeCamera, saveCamera } from "../document/cameras.js";
import type { Document } from "../document/document.js";
import { ActivityStream, type OpenRequest } from "./chat-stream.js";
import type { LinkVolumes, WorldLink } from "./link.js";
import type { GameContext, ModHello, PlayerRef, PromptMessage, PromptRefusal, WireBox } from "./protocol/messages.js";
import type { PromptSettings } from "./settings.js";

/**
 * In-game requests, MCP side (docs/design/13-live-world.md, *Prompting from the game*, W11).
 *
 * A `prompt` from the mod goes through, in order:
 * 1. **The allowlist** (`world.promptPlayers`, plus the singleplayer host the mod's `hello` names).
 *    It runs before anything else, so a player who isn't allowed learns nothing and nothing reaches
 *    the channel: refused `not_allowed`.
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
 * 5. **One channel event** with the fixed text shape `13` shows, opening with the handoff facts,
 *    then `prompt.result` delivered, and the request's chat stream opens.
 */

/** Claude Code's channel notification (Claude Code docs, *Channels reference*). */
export const CHANNEL_METHOD = "notifications/claude/channel";
/** The experimental capability that declares the server a Claude Code channel. */
export const CHANNEL_CAPABILITY = "claude/channel";
/** Appended to the server instructions when the channel is declared (Claude Code recommends saying what events mean and how to answer). */
export const CHANNEL_INSTRUCTIONS =
  'In-game requests from the linked Minecraft world arrive as <channel source="autosketch" request="…" player="…">: the player\'s words, the work volume, and handles for what they point at ' +
  '(selections "focus" and "target", camera "player"). Do the work on the linked document as usual, and answer the player with world_reply (done: true when finished); they only see what you send through it.';

/** Answers to in-game requests, as the `world_reply` tool reaches them (through `Session.inGame`). */
export interface InGameReplies {
  /** Whether a game is connected to send to. */
  readonly connected: boolean;
  /** The open request stream, if any. */
  readonly current: OpenRequest | undefined;
  /** Sends reply lines; `done` closes the request's stream. `open` says whether the request answered was the open one. */
  reply(lines: string[], opts?: { done?: boolean; request?: number }): { request: OpenRequest | undefined; open: boolean };
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
  private readonly offs: (() => void)[] = [];

  constructor(
    private readonly link: WorldLink,
    private readonly opts: InGameRequestsOptions,
  ) {
    this.stream = new ActivityStream({ subscribe: opts.subscribe, send: (m) => link.bridge.send(m), linked: () => link.state === "linked", activityMs: opts.activityMs, idleMs: opts.idleMs });
    this.offs.push(link.bridge.on("prompt", (m) => void this.onPrompt(m)));
    // The activity stream listens only while a game is connected, so an unlinked session pays nothing.
    this.offs.push(link.bridge.onConnection((s) => (s === "up" ? this.stream.start() : this.stream.stop())));
    if (link.bridge.connected) this.stream.start();
  }

  get connected(): boolean {
    return this.link.bridge.connected;
  }

  get current(): OpenRequest | undefined {
    return this.stream.current;
  }

  reply(lines: string[], opts: { done?: boolean; request?: number } = {}): { request: OpenRequest | undefined; open: boolean } {
    return this.stream.reply(lines, opts);
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
    this.link.bridge.send({ type: "prompt.result", id: m.id, delivered: true });
    this.stream.open({ id: m.id, player: m.player });
  }
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
  const out: string[] = [`In-game request from ${m.player.name}: ${JSON.stringify(m.text)}.`, handoff(v)];
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
