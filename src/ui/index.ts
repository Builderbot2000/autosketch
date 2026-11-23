import type { EventListener } from "../core/fanout.js";
import type { LoggedEvent } from "../core/events.js";
import type { Settings } from "../core/settings.js";
import type { StateOverride } from "../core/rotate.js";
import type { Candidates } from "../library/candidates.js";
import type { Choices } from "../core/choices.js";
import { Library } from "../library/index.js";
import { loadPrefab, type LoadedPrefab, type Prefab } from "../library/prefabs.js";
import type { Document } from "../document/document.js";
import type { ScopeManager } from "../scope/scopes.js";
import type { BridgeConnection } from "../world/bridge.js";
import type { ModeRequest } from "../world/modes.js";
import type { OpenRequest } from "../world/chat-stream.js";
import type { UiRequestInfo } from "../world/protocol/messages.js";
import { UiFeed } from "./feed.js";
import type { WorldFrame } from "./frame.js";
import { CandidateRequests, type CandidatesHost } from "./candidates.js";
import { ChoiceRequests } from "./choices.js";
import { GhostRegions } from "./ghosts.js";
import { LibraryRequests, type LibraryHost } from "./library.js";
import { UiPlayers } from "./players.js";
import { UiRequests } from "./requests.js";
import { SettingsRows } from "./settings.js";

/**
 * The in-game UI's MCP side (docs/design/16-in-game-ui.md, *MCP side*), wired to the bridge: the
 * feed, ghosts and request handlers, started once by the entry point (`server/index.ts`). Nothing is
 * sent unless both hellos list `ui` (`BridgeConnection.ui`); the bridge lists `ui` in this MCP's
 * hello only when the entry point passes it, which it does because this module answers requests.
 *
 * Events come from the session's fan-out (`Session.subscribe`, live even with observability off),
 * except Claude Code's telemetry (`otel`), which only the observability bus carries.
 */

export interface UiOptions {
  bridge: BridgeConnection;
  /** The session's event fan-out. */
  subscribe(fn: EventListener): () => void;
  /** The observability bus, for `otel` records. */
  bus?: { subscribe(fn: (e: LoggedEvent) => void): () => void };
  workspace: string;
  /** The live session id (its log folders' name). */
  sessionId: string;
  settings: Settings;
  /** config.toml, which the settings screen edits. */
  configPath: string;
  /** `world.promptPlayers`, read on each use. */
  promptPlayers(): readonly string[];
  library: LibraryHost;
  /** The session's candidates lists (`17`, piece 3), which `candidates.*` requests read. */
  candidates?: Pick<Candidates, "get">;
  /** The session's questions asked with choices (`18`, piece 7), which `choices.pick` answers. */
  choices?: Pick<Choices, "get">;
  /** Plugin block-state overrides for turning blocks (`09`), so a rotated candidate ghost matches `stamp`. */
  stateOverrides?(): readonly StateOverride[];
  baseDoc(): Document | undefined;
  scopes: Pick<ScopeManager, "scopes" | "baseOffset">;
  /** The link's frame while the base document is linked. */
  linkFrame(): WorldFrame | undefined;
  /** The open in-game request (the activity stream's), and the read-only one whose mode holds. */
  inGame?(): { current: OpenRequest | undefined; heldRequest: ModeRequest | undefined; candidatesAnswer?: CandidatesHost["answer"] } | undefined;
  log?(msg: string): void;
  /** Coalescing window override for tests. */
  intervalMs?: number;
}

export interface UiCore {
  readonly feed: UiFeed;
  readonly ghosts: GhostRegions;
  readonly requests: UiRequests;
  readonly players: UiPlayers;
  close(): void;
}

/** Longest request text in `ui.state` (`13`: "possibly shortened"). */
const REQUEST_TEXT = 200;

export function startUi(o: UiOptions): UiCore {
  const players = new UiPlayers(o.promptPlayers, () => o.bridge.hello);
  // Prompt texts by id, for the HUD's open request (the activity stream keeps only id, player and mode).
  const texts = new Map<number, string>();
  const offs: (() => void)[] = [];
  offs.push(
    o.bridge.on("prompt", (m) => {
      texts.set(m.id, m.text.length > REQUEST_TEXT ? m.text.slice(0, REQUEST_TEXT - 1) + "…" : m.text);
      if (texts.size > 64) texts.delete(texts.keys().next().value!);
    }),
  );
  const request = (): UiRequestInfo | null => {
    const g = o.inGame?.();
    const r = g?.current ?? g?.heldRequest;
    return r ? { id: r.id, mode: r.mode ?? "build", text: texts.get(r.id) ?? "" } : null;
  };
  // A request is open while its activity stream is, or while its read-only mode holds (B6).
  const openRequest = (id: number): boolean => {
    const g = o.inGame?.();
    return g?.current?.id === id || g?.heldRequest?.id === id;
  };
  // `candidates.submit`'s and `choices.pick`'s text goes to the agent through the in-game requests (`17`, piece 5; `18`, piece 7).
  const answer: NonNullable<CandidatesHost["answer"]> = async (a) => {
    const g = o.inGame?.();
    if (!g?.candidatesAnswer) throw new Error("in-game requests aren't served here");
    await g.candidatesAnswer(a);
  };
  const intervalMs = o.intervalMs !== undefined ? { intervalMs: o.intervalMs } : {};
  const ghosts = new GhostRegions({
    bridge: o.bridge,
    linkFrame: o.linkFrame,
    players: () => players.overlay(),
    baseDoc: o.baseDoc,
    scope: (id) => o.scopes.scopes.get(id),
    baseOffset: (id) => o.scopes.baseOffset(id),
    scopeIds: () => [...o.scopes.scopes.keys()],
    ...intervalMs,
  });
  const feed = new UiFeed({ bridge: o.bridge, frame: () => ghosts.frame(), linked: () => o.linkFrame() !== undefined, players: () => players.overlay(), request, ...intervalMs });
  const settings = new SettingsRows(o.settings, o.configPath, o.log);
  settings.watch();
  const requests = new UiRequests({
    bridge: o.bridge,
    players,
    feed,
    ghosts,
    settings,
    library: new LibraryRequests(o.library, settings),
    ...(o.choices ? { choices: new ChoiceRequests({ questions: o.choices, answer }) } : {}),
    ...(o.candidates ? { candidates: new CandidateRequests({ lists: o.candidates, openRequest, ghosts, answer, load: (id) => loadCandidate(o.library, id), registry: () => o.library.registry?.(), ...(o.stateOverrides ? { stateOverrides: o.stateOverrides } : {}) }) } : {}),
    workspace: o.workspace,
    live: () => ({ session: o.sessionId, doc: o.baseDoc()?.meta.name }),
    linked: () => o.linkFrame() !== undefined,
    ...(o.log ? { log: o.log } : {}),
  });
  offs.push(
    o.subscribe((e, doc) => {
      const ev = { ...e, doc } as LoggedEvent;
      feed.onEvent(ev);
      ghosts.onEvent(ev);
    }),
  );
  if (o.bus) offs.push(o.bus.subscribe((e) => e.kind === "otel" && feed.onEvent(e)));
  offs.push(o.bridge.on("ui.request", (m) => void requests.handle(m)));
  offs.push(
    o.bridge.onConnection((s) => {
      if (s === "down") {
        requests.reset();
        ghosts.anchor = undefined;
        players.reset();
      }
    }),
  );
  return {
    feed,
    ghosts,
    requests,
    players,
    close() {
      for (const off of offs.splice(0)) off();
      feed.close();
      ghosts.close();
      settings.close();
    },
  };
}

/** A library prefab by id, with its blocks, for the candidate ghost (`17`, piece 3). */
async function loadCandidate(lib: LibraryHost, id: string): Promise<{ prefab: Prefab; loaded: LoadedPrefab }> {
  const registry = lib.registry?.();
  const prefab = await new Library({ roots: lib.roots(), ...(registry ? { registry } : {}) }).resolve(id);
  return { prefab, loaded: await loadPrefab(prefab, registry) };
}
