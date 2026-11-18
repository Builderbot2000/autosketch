import { join } from "node:path";
import { listSessionLogs } from "../observe/logs.js";
import type { Vec3 } from "../core/region.js";
import { UI_REQUEST_KINDS, type UiMcpMessage, type UiRequest, type UiRequestKind } from "../world/protocol/messages.js";
import { UiRequestError, uiErrorOf } from "./errors.js";
import type { UiFeed } from "./feed.js";
import type { WorldFrame } from "./frame.js";
import { DOC_GHOST, type GhostRegions } from "./ghosts.js";
import type { LibraryRequests } from "./library.js";
import type { UiPlayers } from "./players.js";
import { loadReplayLog, ReplaySession, type ReplayLog } from "./replay-frames.js";
import type { SettingsRows } from "./settings.js";

/**
 * Answers every `ui.request` (docs/design/16-in-game-ui.md, *MCP side*, Requests; `13`, *In-game
 * UI*, *Request kinds*) with exactly one `ui.result`, sent before anything it announces (the full
 * state and ghosts of a `resync` go first, as `13` says; the frame of a replay, the ghost of an
 * anchor follow it). A player not on the allowlist is refused `not_allowed` before anything else;
 * a second request of the same kind from the same player while the first runs is `busy`.
 */

export interface RequestsHost {
  readonly bridge: { send(m: UiMcpMessage): void };
  readonly players: UiPlayers;
  readonly feed: UiFeed;
  readonly ghosts: GhostRegions;
  readonly settings: SettingsRows;
  readonly library: LibraryRequests;
  readonly workspace: string;
  /** The live session: its id (the folder name of its logs) and the open document's name. */
  live(): { session: string; doc: string | undefined };
  /** Whether the base document is linked to the world (anchors are for unlinked documents). */
  linked(): boolean;
  /** Loads a session folder for replay (tests may stub it). */
  load?(dir: string): Promise<ReplayLog>;
  log?(msg: string): void;
}

type Args = Record<string, unknown>;
type Answer = { result: Record<string, unknown>; body?: Uint8Array; after?: () => void };

export class UiRequests {
  /** Open replays by player UUID: one per player. */
  private readonly replays = new Map<string, ReplaySession>();
  private readonly running = new Set<string>();
  private nextReplay = 1;

  constructor(private readonly host: RequestsHost) {}

  /** Serves one request. Resolves once its result (and whatever follows it) is sent. */
  async handle(m: UiRequest): Promise<void> {
    const player = m.player.uuid.toLowerCase();
    const reply = (r: { ok: true; result: Record<string, unknown>; body?: Uint8Array } | { ok: false; error: ReturnType<typeof uiErrorOf>["code"]; message: string }) =>
      this.host.bridge.send({ type: "ui.result", request: m.request, player: m.player.uuid, ...r } as UiMcpMessage);
    if (!this.host.players.allowed(m.player)) return reply({ ok: false, error: "not_allowed", message: "You aren't on this Autosketch's allowed players (world.promptPlayers)." });
    if (!(UI_REQUEST_KINDS as readonly string[]).includes(m.kind)) return reply({ ok: false, error: "bad_request", message: `Unknown request kind "${m.kind}".` });
    const key = `${player}\n${m.kind}`;
    if (this.running.has(key)) return reply({ ok: false, error: "busy", message: `Still serving your previous ${m.kind}; try again.` });
    this.running.add(key);
    try {
      const a = await this.serve(m.kind as UiRequestKind, m.args ?? {}, player);
      reply({ ok: true, result: a.result, ...(a.body ? { body: a.body } : {}) });
      a.after?.();
    } catch (e) {
      const err = uiErrorOf(e);
      if (err.code === "internal") this.host.log?.(`ui: ${m.kind} from ${m.player.name} failed: ${(e as Error)?.stack ?? String(e)}`);
      reply({ ok: false, error: err.code, message: err.message });
    } finally {
      this.running.delete(key);
    }
  }

  /** Forgets every open replay (a lost connection: the clients reset). */
  reset(): void {
    this.replays.clear();
  }

  private async serve(kind: UiRequestKind, a: Args, player: string): Promise<Answer> {
    const lib = this.host.library;
    switch (kind) {
      case "resync":
        this.replays.delete(player);
        this.host.feed.resync(player);
        this.host.ghosts.resync([player]);
        return { result: {} };
      case "settings.list":
        return { result: { ...this.host.settings.list() } };
      case "settings.set":
        return { result: { hash: this.host.settings.set(str(a, "key"), a.value, a.hash) } };
      case "settings.unset":
        return { result: { hash: this.host.settings.unset(str(a, "key"), a.hash) } };
      case "library.list":
        return { result: await lib.list() };
      case "library.entry":
        return { result: await lib.entry(a) };
      case "library.thumbnail":
        return lib.thumbnail(a);
      case "library.preview":
        return lib.preview(a);
      case "library.rename":
        return { result: await lib.rename(a) };
      case "library.duplicate":
        return { result: await lib.duplicate(a) };
      case "library.delete":
        return { result: await lib.delete(a) };
      case "library.trash":
        return { result: await lib.trash(a) };
      case "library.restore":
        return { result: await lib.restore(a) };
      case "library.hide":
        return { result: await lib.hide(a) };
      case "library.copy":
        return { result: await lib.copy(a) };
      case "library.empty_trash":
        return { result: await lib.emptyTrash(a) };
      case "logs.list":
        return { result: { logs: await this.logs() } };
      case "replay.open":
        return this.open(a, player);
      case "replay.seek": {
        const r = this.replay(a, player);
        const step = a.step;
        if (typeof step !== "number" || !Number.isInteger(step) || step < 0 || step > r.stepCount) throw new UiRequestError("bad_request", `step must be an integer from 0 to ${r.stepCount}`);
        return { result: { step }, after: () => this.host.bridge.send(r.frameFor(step)) };
      }
      case "replay.close":
        this.replay(a, player);
        this.replays.delete(player);
        return { result: {} };
      case "ghost.anchor": {
        const dimension = str(a, "dimension");
        const pos = a.pos;
        if (!Array.isArray(pos) || pos.length !== 3 || !pos.every((v) => Number.isInteger(v))) throw new UiRequestError("bad_request", "pos must be [x, y, z], integers");
        if (this.host.linked()) throw new UiRequestError("bad_request", "The document is linked to the world, so it is already there; ghosts are for unlinked documents.");
        if (!this.host.live().doc) throw new UiRequestError("not_found", "No document is open to show.");
        return { result: { ghost: DOC_GHOST }, after: () => void this.host.ghosts.anchorAt(dimension, pos as Vec3) };
      }
      case "ghost.clear": {
        const ghost = str(a, "ghost");
        if (ghost !== DOC_GHOST) throw new UiRequestError("not_found", `No anchored ghost "${ghost}" to clear (a job's ghost leaves when the job merges or is abandoned).`);
        if (!this.host.ghosts.anchor) throw new UiRequestError("not_found", "No anchored ghost to clear.");
        return { result: {}, after: () => void this.host.ghosts.clear(DOC_GHOST) };
      }
      // `17` piece 3: names and shapes frozen in `13` (*Request kinds*); silo Q serves them.
      case "candidates.open":
      case "candidates.ghost":
      case "candidates.ghost.clear":
      case "candidates.submit":
        throw new UiRequestError("bad_request", `This Autosketch doesn't serve ${kind} yet.`);
    }
  }

  private async logs(): Promise<Record<string, unknown>[]> {
    const live = this.host.live();
    return (await listSessionLogs(this.host.workspace)).map((l) => ({ id: l.id, doc: l.doc, session: l.session, modified: new Date(l.modified).toISOString(), live: l.session === live.session && l.doc === live.doc }));
  }

  private async open(a: Args, player: string): Promise<Answer> {
    if (!("log" in a) || (a.log !== null && typeof a.log !== "string")) throw new UiRequestError("bad_request", "log must be a log's id from logs.list, or null for the live session");
    const live = this.host.live();
    const id = a.log ?? (live.doc ? `${live.doc}/${live.session}` : undefined);
    const hit = id ? (await listSessionLogs(this.host.workspace, Infinity)).find((l) => l.id === id) : undefined;
    if (!hit) throw new UiRequestError("not_found", a.log === null ? "The live session has no log yet (is observe.log off, or no document open?)." : `No session log "${String(a.log)}".`);
    const frame: WorldFrame | undefined = this.host.ghosts.frame();
    if (!frame) throw new UiRequestError("bad_request", "Nowhere to replay it: link the world, or set a ghost anchor first (/autosketch ghost here).");
    const log = await (this.host.load ?? loadReplayLog)(join(this.host.workspace, hit.doc, "observe", hit.session));
    const r = new ReplaySession(`r${this.nextReplay++}`, player, log, frame);
    this.replays.set(player, r);
    return { result: { replay: r.id, steps: r.stepCount, step: 0, dimension: frame.dimension, volume: r.worldVolume }, after: () => this.host.bridge.send(r.frameFor(0)) };
  }

  private replay(a: Args, player: string): ReplaySession {
    const id = str(a, "replay");
    const r = this.replays.get(player);
    if (!r || r.id !== id) throw new UiRequestError("not_found", `No open replay "${id}".`);
    return r;
  }
}

function str(a: Args, key: string): string {
  const v = a[key];
  if (typeof v !== "string" || !v) throw new UiRequestError("bad_request", `${key} must be non-empty text`);
  return v;
}
