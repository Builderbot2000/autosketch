import type { PublicBox, Vec3 } from "../core/region.js";
import { choiceText, typedChoice, type Choices } from "../core/choices.js";
import type { EventListener } from "../core/fanout.js";
import { lookTarget, removeCamera, saveCamera } from "../document/cameras.js";
import type { Document } from "../document/document.js";
import { refusal } from "../scope/scopes.js";
import { ActivityStream, type OpenRequest } from "./chat-stream.js";
import type { LinkVolumes, WorldLink } from "./link.js";
import { MODE_ALLOWS, modeOf, READ_ONLY_MODES, RequestModeRule, type ModeRequest } from "./modes.js";
import { SELECT_CHUNKS, type ChatAction, type GameContext, type ModHello, type PlayerRef, type PromptClose, type PromptMessage, type PromptRefusal, type RequestMode, type WireBox } from "./protocol/messages.js";
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
 * A `select` request (`18`, piece 1) needs no link: it carries no grant, only the context, and the
 * event says where the select-mode reads reach (`selectText`).
 *
 * A read-only request (`ask`, `plan`, `select`) holds its mode until the player lifts it: the mode is
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
  '(selections "focus" and "target", camera "player"). The request names its mode (ask, plan, select or build), and edits the mode doesn\'t allow are refused while it is open. Do the work on the linked document as usual, and answer the player with world_reply (done: true when finished); they only see what you send through it.';

/** Answers to in-game requests, as the `world_reply` tool reaches them (through `Session.inGame`). */
export interface InGameReplies {
  /** Whether a game is connected to send to. */
  readonly connected: boolean;
  /** The open request stream, if any. */
  readonly current: OpenRequest | undefined;
  /**
   * Sends reply lines; `done` marks the request answered and closes its stream. `open` says whether
   * the request answered was the open one; `held` names the read-only mode still in force after it
   * (only the player ends that, B6). `action` makes one line clickable (`17`, piece 3); it is sent
   * only when both hellos list `ui` (`clickable`), else dropped and the line goes as plain text.
   */
  reply(lines: string[], opts?: { done?: boolean; request?: number; action?: ChatAction }): { request: OpenRequest | undefined; open: boolean; held?: RequestMode };
  /** Whether a reply line can be clickable now: both hellos list `ui` (`13`, `chat`). */
  readonly clickable: boolean;
  /** Sets the player's volumes (`world_volumes`, B4) in the linked document's coordinates; resolves with the result text. */
  setVolumes(work: PublicBox, context?: ContextArg): Promise<string>;
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
  /** Whether linking follows a volume change on its own (setting `world.autoLink`; default true), for `world_volumes`' result. */
  autoLink?: boolean;
  /** The session's component set (`Session.componentSet`): its reminder line ends each request's event text while it has entries (`17`, piece 1, *Reminders*). */
  componentSet?: { remind(text: string): string };
  /** The session's questions asked with choices (`Session.choices`, `18` piece 7): a typed number answers the open one. */
  choices?: Pick<Choices, "openOn">;
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
  /**
   * The read-only request whose mode is in force (B6): set on delivery, ended only by the player
   * (`prompt.close`, the next delivered request) or a disconnect, never by the agent's `done`.
   */
  private held?: ModeRequest;

  constructor(
    private readonly link: WorldLink,
    private readonly opts: InGameRequestsOptions,
  ) {
    this.stream = new ActivityStream({ subscribe: opts.subscribe, send: (m) => link.bridge.send(m), linked: () => link.state === "linked", activityMs: opts.activityMs, idleMs: opts.idleMs });
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

  reply(lines: string[], opts: { done?: boolean; request?: number; action?: ChatAction } = {}): { request: OpenRequest | undefined; open: boolean; held?: RequestMode } {
    const { action: _a, ...plain } = opts;
    const r = this.stream.reply(lines, this.clickable ? opts : plain);
    return this.held ? { ...r, held: this.held.mode } : r;
  }

  get clickable(): boolean {
    return this.link.bridge.ui;
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
    if (!r) return tell("Autosketch: no ask, plan or select request is open.");
    this.held = undefined;
    if (this.stream.current?.id === r.id) this.stream.closeRequest();
    this.opts.log?.(`in-game ${r.mode} request ${r.id} ended by ${m.player.name}`);
    tell(`Autosketch: ${r.mode} request ${r.id} ended; the agent may edit again.`);
  }

  /** Opens a delivered request's stream and, for a read-only mode, holds the mode (replacing any held one). */
  open(r: OpenRequest): void {
    const mode = modeOf(r);
    this.held = READ_ONLY_MODES.has(mode) ? { id: r.id, player: r.player, mode } : undefined;
    this.stream.open({ id: r.id, player: r.player, mode, ...(r.text !== undefined ? { text: r.text } : {}) });
  }

  async setVolumes(work: PublicBox, context?: ContextArg): Promise<string> {
    const frame: VolumesFrame | undefined = this.link.state === "linked" && this.link.volumes ? { origin: this.link.volumes.origin, dimension: this.link.volumes.dimension, label: "local" } : undefined;
    if (!this.link.bridge.connected) throw refusal("world_disconnected", "No game is connected, so there are no volumes to set.");
    if (!frame)
      throw refusal(
        "world_no_document",
        'world_volumes({work}) takes a box in the linked document\'s coordinates, and no document is linked. In a select request, confirm the shape with world_volumes({from:"candidate"}) (world coordinates, no link needed); otherwise link with doc_open({world: true}).',
      );
    return setVolumes(this.link.bridge, frame, work, context, this.opts.autoLink ?? true);
  }

  close(): void {
    for (const off of this.offs.splice(0)) off();
    this.stream.stop();
  }

  /**
   * The player's candidates picks as text (`17`, piece 5; the text is built by `ui/candidates.ts`):
   * one channel event on `request`, ending with the component set's reminder line as other request
   * events do. When that request is no longer open, it opens again as a new in-game request under
   * the same id, in `mode`, by the player who picked, with the list's question as its text: request
   * ids come from the mod's prompt counter, so the MCP has none of its own to give it (decided Q3).
   * A list that went to no request (`request` null) is answered with an event naming no request,
   * and nothing opens. Throws, opening nothing, when no agent session can receive the event.
   * A clicked choice (`18`, piece 7, `ui/choices.ts`) is delivered the same way.
   */
  async candidatesAnswer(a: { request: number | null; mode?: RequestMode; player: PlayerRef; question: string; text: string }): Promise<void> {
    if (!this.opts.listening()) throw new Error("no agent session is listening for in-game requests");
    const id = a.request;
    const open = id !== null && (this.stream.current?.id === id || this.held?.id === id);
    await this.opts.notify(this.remind(a.text), { ...(id !== null ? { request: String(id) } : {}), player: a.player.name });
    if (id === null || open) return;
    if (this.link.state === "linked" && this.link.doc) this.modeRule.attach(this.link.doc);
    this.open({ id, player: a.player, mode: a.mode ?? "build", text: a.question });
    this.opts.log?.(`in-game ${a.mode ?? "build"} request ${id} reopened by ${a.player.name}'s answer`);
  }

  /** A request event's text with the component set's reminder line appended while the set has entries (`17`, piece 1). */
  private remind(text: string): string {
    return this.opts.componentSet?.remind(text) ?? text;
  }

  /** Handles one `prompt`; resolves once `prompt.result` is sent. */
  async onPrompt(m: PromptMessage): Promise<void> {
    const refuse = (reason: PromptRefusal) => {
      this.opts.log?.(`in-game request ${m.id} from ${m.player.name} refused: ${reason}`);
      this.link.bridge.send({ type: "prompt.result", id: m.id, delivered: false, reason });
    };
    if (!promptAllowed(m.player, this.opts.promptPlayers, this.link.bridge.hello)) return refuse("not_allowed");
    if (!this.link.bridge.modes.includes(m.mode ?? "build")) return refuse("unsupported_mode");
    if (await this.onTypedChoice(m, refuse)) return;
    if (m.mode === "select") return this.onSelect(m, refuse);
    if (this.link.state !== "linked") await this.link.ensureLinked?.();
    const doc = this.link.doc, volumes = this.link.volumes;
    if (this.link.state !== "linked" || !doc || !volumes) return refuse("no_link");
    if (!this.opts.listening()) return refuse("no_listener");
    const text = this.remind(requestText(doc, volumes, m));
    this.opts.touch?.();
    try {
      await this.opts.notify(text, { request: String(m.id), player: m.player.name });
    } catch (e) {
      this.opts.log?.(`channel notification failed: ${(e as Error).message}`);
      return refuse("no_listener");
    }
    this.modeRule.attach(doc);
    this.link.bridge.send({ type: "prompt.result", id: m.id, delivered: true });
    this.open({ id: m.id, player: m.player, mode: modeOf(m), text: m.text });
  }

  /**
   * A typed number answering a question (`18`, piece 7): a player without the client half can't
   * click a choice line, so a request whose whole text is one digit, while the open (or held)
   * request has an unanswered question with that many choices, is that choice, not a new request.
   * The choice's text goes to the agent on the question's request, as a click would send it; the
   * prompt is delivered, opens nothing and leaves the held mode as it was. True when it was one.
   */
  private async onTypedChoice(m: PromptMessage, refuse: (reason: PromptRefusal) => void): Promise<boolean> {
    const n = typedChoice(m.text);
    if (n === undefined || !this.opts.choices) return false;
    const open = [this.stream.current?.id, this.held?.id].filter((id): id is number => id !== undefined);
    const q = open.map((id) => this.opts.choices!.openOn(id)).find((q) => q !== undefined);
    if (!q || n > q.choices.length) return false;
    if (!this.opts.listening()) {
      refuse("no_listener");
      return true;
    }
    q.answered = true;
    try {
      await this.opts.notify(this.remind(choiceText(m.player.name, q, n - 1)), { request: String(q.request), player: m.player.name });
    } catch (e) {
      q.answered = false;
      this.opts.log?.(`channel notification failed: ${(e as Error).message}`);
      refuse("no_listener");
      return true;
    }
    this.link.bridge.send({ type: "prompt.result", id: m.id, delivered: true });
    this.opts.log?.(`in-game request ${m.id} from ${m.player.name} taken as choice ${n} of ${q.id} (request ${q.request})`);
    return true;
  }

  /**
   * A select request (`18`, piece 1): no link needed and no grant to load. The event names the
   * player's words, the context in world coordinates (the world view's), where the select-mode
   * reads reach, and the tools in order. A linked document gets the mode's write guard as usual.
   */
  private async onSelect(m: PromptMessage, refuse: (reason: PromptRefusal) => void): Promise<void> {
    if (!this.opts.listening()) return refuse("no_listener");
    const text = this.remind(selectText(m, { served: this.link.bridge.supports("select") }));
    try {
      await this.opts.notify(text, { request: String(m.id), player: m.player.name });
    } catch (e) {
      this.opts.log?.(`channel notification failed: ${(e as Error).message}`);
      return refuse("no_listener");
    }
    if (this.link.state === "linked" && this.link.doc) this.modeRule.attach(this.link.doc);
    this.link.bridge.send({ type: "prompt.result", id: m.id, delivered: true });
    this.open({ id: m.id, player: m.player, mode: "select", text: m.text });
  }

}

// -- the select event ----------------------------------------------------------------------------

/**
 * The select event's text (`18`, piece 1 and *The workflow*): the player's words, or the crosshair
 * block as the starting point when there are none; the context in world coordinates (the world
 * view's, so positions here are positions the select tools take); the read grant's square, fixed
 * when the prompt arrived (`13`, *Where the mod serves reads*), stated with the default
 * `selectChunks` since the MCP isn't told the mod's value; and the tools in workflow order. Without
 * the mod's `select` feature the tools are refused, so the text says so instead (`13`, *Without a
 * feature*). It names no skill: skills are found through `knowledge_list` (`07`).
 */
export function selectText(m: PromptMessage, opts: { served: boolean }): string {
  const ctx = m.context;
  const words = m.text.trim();
  const out: string[] = [];
  if (words) out.push(`In-game select request from ${m.player.name}: ${JSON.stringify(words)}.`);
  else if (ctx.target) out.push(`In-game select request from ${m.player.name}, with no words: start from the block under the crosshair.`);
  else out.push(`In-game select request from ${m.player.name}, with no words and no block under the crosshair: ask the player what they mean.`);
  out.push(MODE_ALLOWS.select);
  const feet = ctx.position.map(Math.floor) as Vec3;
  out.push(`Standing at world ${pt(feet)} in ${ctx.dimension}, facing ${ctx.facing}.`);
  out.push(ctx.target ? `Looking at ${ctx.target.state} (${ctx.target.face} face) at world ${pt(ctx.target.pos)}.` : "Not looking at a block within reach.");
  if (ctx.focus) out.push(`Focus box ${size(ctx.focus)} at world ${pt(ctx.focus.min)}–${pt(ctx.focus.max)}.`);
  if (!opts.served) {
    out.push("The mod doesn't serve select reads (its hello doesn't list the select feature), so world_search, world_fill, world_expand and world_view_read are refused: tell the player to update the Autosketch mod.");
  } else {
    const r = SELECT_CHUNKS;
    const cx = feet[0] >> 4, cz = feet[2] >> 4;
    out.push(
      `Reads reach the chunks within ${r} of the player's chunk (${cx}, ${cz}) (${r} is the default selectChunks; the mod's config may set less): ` +
        `world x ${(cx - r) * 16}..${(cx + r) * 16 + 15}, z ${(cz - r) * 16}..${(cz + r) * 16 + 15}, full height, at most contextCap blocks per read. They stay where they are if the player moves.`,
    );
    out.push(
      "Steps: 1. Find: world_search({materials}) with the block ids, families (family:<id>) or tags the words name, worked out with palette_sheet and similar:, never by asking the player for ids" +
        (ctx.target ? "; or start from the crosshair block" : "") +
        ". 2. Propose: offer the likeliest clusters (nearest, densest) with world_reply({choices}). " +
        '3. Grow: world_fill({seed, match}) from a block of the chosen hit, then world_expand({by:"frontier"}) while its frontier is open. ' +
        '4. Look and trim: render({view:"world", region:{dilate:"candidate",by:8}, fade:"candidate"}), then cut "candidate" with the selection algebra. ' +
        '5. Confirm: ask "is this it?" with world_reply({choices}), then world_volumes({from:"candidate"}). ' +
        "For terrain, read a starter volume with world_view_read and cut it instead of filling.",
    );
  }
  out.push(`Answer the player with world_reply (request ${m.id}); pass done: true when finished.`);
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
