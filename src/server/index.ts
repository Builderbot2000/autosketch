#!/usr/bin/env node
/**
 * Autosketch MCP server (stdio).
 *
 *   autosketch --instance "/path/to/instance" [--version 1.21.1] [--base-jar client.jar] [--workspace ~/autosketch]
 *   (or AUTOSKETCH_INSTANCE / AUTOSKETCH_VERSION / AUTOSKETCH_BASE_JAR / AUTOSKETCH_WORKSPACE);
 *   ~/.autosketch/config.toml (instance, workspace, [settings]) beats all of these, see core/config.ts
 *   settings: --set observe.log=false (or AUTOSKETCH_OBSERVE_LOG=false), see core/settings.ts
 *   --set server.hideTools=analyze,render hides tools (eval ablations, docs/design/10)
 *
 *   With no instance anywhere the server still starts: tools answer not_configured (with the
 *   discovered instances and a setup command for each) until one is chosen (docs/design/14, *Setup*).
 *   Every operation's UI is in the game (docs/design/16); the command line only starts and configures.
 *
 *   autosketch instances | setup --instance <id|path> … | config set|unset <key> [value]
 *   command-line setup, see src/cli/index.ts.
 *
 * stdout carries the protocol; all logging goes to stderr.
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Settings } from "../core/settings.js";
import type { StateOverride } from "../core/rotate.js";
import { startObserve, type Observer } from "../observe/index.js";
import type { PaletteBook } from "../palette/pick.js";
import { scopeLimits } from "../scope/settings.js";
import { readConfig } from "../core/config.js";
import { configFromEnv, launchOptions, loadInstanceContext, startupArgNotes } from "./context.js";
import { createServer, SERVER_VERSION } from "./server.js";
import { SERVER_HIDE_TOOLS } from "./settings.js";
import { defaultWorkspace, Session } from "./session.js";
import { makeInstanceSetup } from "./setup.js";
import { CLI_COMMANDS, runCli } from "../cli/index.js";
import { bakerFor } from "./tools/shared.js";
import { LiveLink } from "../world/live-link.js";
import { watchGameReport } from "../assets/report.js";
import { bridgeUpgrader } from "../world/upgrade.js";
import { promptSettings, WORLD_PROMPT_PLAYERS, worldSettings } from "../world/settings.js";
import { CHANNEL_INSTRUCTIONS, CHANNEL_METHOD, InGameRequests } from "../world/prompt.js";
import { autoSyncHook, syncLink } from "../world/sync.js";
import { WorldView } from "../world/view.js";
import { MCP_FEATURES } from "../world/protocol/messages.js";
import { startUi } from "../ui/index.js";
import type { LibraryHost as UiLibraryHost } from "../ui/library.js";
import type { InstanceContext } from "./context.js";
import { libraryFor, rootsFor } from "./tools/library-context.js";

const log = (msg: string) => process.stderr.write(`[autosketch] ${msg}\n`);

async function main(): Promise<void> {
  // The user's saved choices come first (core/config.ts; 15, *Settings tab*), read once here.
  const file = readConfig();
  const argv = process.argv.slice(2);
  let settings: Settings;
  let cfg: ReturnType<typeof configFromEnv>;
  let launch: ReturnType<typeof launchOptions>;
  try {
    settings = Settings.from(argv, process.env, file);
    cfg = configFromEnv(argv, process.env, file);
    launch = launchOptions(argv, process.env, file);
  } catch (e) {
    // An invalid launch value stops the server (a mistake in the MCP client's config); invalid
    // config.toml values were already skipped with a note (15, *Settings tab*).
    log((e as Error).message);
    process.exit(2);
  }
  // One line per launch value config.toml overrides, and per problem in the file: logged, never in a tool result.
  for (const line of [...settings.notes(), ...startupArgNotes(argv, process.env, file)]) log(line);
  const workspace = cfg?.workspace ?? launch.workspace ?? defaultWorkspace();
  let session: Session;
  try {
    session = new Session(workspace, log, { scopeLimits: scopeLimits(settings) });
  } catch (e) {
    log((e as Error).message);
    process.exit(2);
  }
  // Observability (12): the process entry point is the one place that wires observe/ in; the
  // session, documents and tool wrapper only see the EventSink.
  let observer: Observer;
  let hideTools: string[];
  try {
    hideTools = settings.get(SERVER_HIDE_TOOLS);
    // Snapshots need the baker, which exists once an instance is loaded (12).
    const getBaker = () => session.instance?.then(bakerFor) ?? Promise.reject(new Error("no instance loaded"));
    observer = startObserve({ workspace, settings, version: SERVER_VERSION, getDoc: () => session.doc, getScopeDoc: (id) => session.scopes.scopes.get(id)?.doc, getBaker, log });
  } catch (e) {
    log((e as Error).message);
    process.exit(2);
  }
  // First-run setup (14, *Setup*; 16, *Command line*): the server starts with or without an
  // instance. With none saved, it picks one when exactly one candidate is found (preferring games
  // the mod has run in) and says so; otherwise tools answer not_configured with the candidates
  // until `autosketch setup` chooses one, which then loads in place. No wizard.
  const setup = makeInstanceSetup({ launch, log });
  session.setup = setup;
  if (cfg) {
    const ctx = loadInstanceContext(cfg, log);
    ctx.catch((e: Error) => log(`failed to load instance: ${e.message}`));
    session.setInstance(ctx);
  } else void setup.autoChoose(session);
  session.events = observer.sink("base");
  session.eventsFor = (doc) => observer.sink(doc);
  // The live world link (13), wired in here like observe/: tools reach it only through the session.
  // It connects on its own once the instance is loaded (world.autoLink), or on doc_open({world: true});
  // its call hook runs before the auto-sync hook.
  let link: LiveLink;
  let autoLink: boolean;
  try {
    const ws = worldSettings(settings);
    autoLink = ws.autoLink;
    // `ui` in the hello: src/ui/ answers the in-game UI's requests (16).
    link = new LiveLink(session, { ...ws, features: [...MCP_FEATURES], log });
  } catch (e) {
    log((e as Error).message);
    process.exit(2);
  }
  link.setSync(syncLink);
  session.world = link;
  session.upgrader = () => bridgeUpgrader(link.bridge);
  session.callHooks.push(autoSyncHook(() => session.world));
  const server = createServer(session.instance, { session, hideTools, log, channel: { instructions: CHANNEL_INSTRUCTIONS } });
  // In-game requests (13, *Prompting from the game*): pushed into the session as Claude Code channel
  // events. Whether the session loaded the server as a channel can't be seen from here, so delivery
  // is optimistic once a client has initialized.
  let inGame: InGameRequests;
  let book: PaletteBook | undefined;
  void session.whenInstance().then((c) => (book = c.book));
  try {
    inGame = new InGameRequests(link, {
      ...promptSettings(settings),
      subscribe: (fn) => session.subscribe(fn),
      notify: (content, meta) => server.server.notification({ method: CHANNEL_METHOD, params: { content, meta } } as never),
      listening: () => server.server.getClientCapabilities() !== undefined,
      touch: () => session.touch(),
      // The scan probe (13, B4) opens as the session's temporary document, with the instance's palettes.
      host: session,
      palettes: () => book,
      autoLink,
      componentSet: session.componentSet,
      log,
    });
  } catch (e) {
    log((e as Error).message);
    process.exit(2);
  }
  session.inGame = inGame;
  // The world view (18, piece 5): beside the open document, per in-game request (held or open).
  session.worldView = new WorldView({
    bridge: link.bridge,
    request: () => inGame.heldRequest?.id ?? inGame.current?.id,
    dimension: () => link.volumes?.dimension,
    dataVersion: () => link.bridge.hello?.game.dataVersion ?? 0,
    palettes: () => book,
  });
  // The in-game UI (16): overlays, ghosts, replay and the player's requests, over the bridge.
  const ui = startUi({
    bridge: link.bridge,
    subscribe: (fn) => session.subscribe(fn),
    bus: observer.bus,
    workspace,
    sessionId: observer.sessionId,
    settings,
    configPath: file.path,
    promptPlayers: () => settings.get(WORLD_PROMPT_PLAYERS),
    library: uiLibraryHost(session),
    candidates: session.candidates,
    stateOverrides: candidateStateOverrides(session),
    baseDoc: () => session.doc,
    scopes: session.scopes,
    linkFrame: () => (link.volumes ? { dimension: link.volumes.dimension, origin: link.volumes.origin } : undefined),
    inGame: () => inGame,
    log,
  });
  // The flash on save (17, piece 8): prefab_save's box, sent only while linked.
  session.saveFlash = (box, doc) => ui.feed.saveFlash(box, doc);
  // Request modes (13, B6): while an ask, plan or scan request is open, edits on the linked document are refused.
  session.callHooks.push(inGame.modeRule);
  // Once an instance loads (at startup, or later in place).
  if (autoLink) void session.whenInstance().then((c) => link.autoLink({ instanceDir: c.info.root, plugins: c.plugins, palettes: c.book }));
  // The game's registry report on each connection (14, *Version-specific data lives in the mod*), when the
  // mod serves it: the file read at startup may be from another modset, or out of reach (WSL).
  watchGameReport(link.bridge, () => session.whenInstance().then((c) => c.registry), log);
  const transport = new StdioServerTransport();
  // Save the open document before exiting, so a closed client never loses the last op.
  let closing = false;
  const shutdown = async (code: number) => {
    if (closing) return;
    closing = true;
    ui.close();
    inGame.close();
    link.close();
    await session.close();
    await observer.close();
    process.exit(code);
  };
  transport.onclose = () => void shutdown(0);
  process.stdin.on("end", () => void shutdown(0));
  process.on("SIGINT", () => void shutdown(130));
  process.on("SIGTERM", () => void shutdown(143));
  await server.connect(transport);
  log(`listening on stdio; workspace ${workspace}`);
}

/**
 * The in-game library screen's view of the library (16, *Library screen*): the same roots the tools
 * use (`rootsFor`: `library.*` settings read now, the loaded instance's Axiom folder), and
 * thumbnails through the same `Library` (cached, embedded, or rendered with the instance).
 */
function uiLibraryHost(session: Session): UiLibraryHost {
  let loaded: InstanceContext | undefined;
  void session.whenInstance().then((c) => (loaded = c));
  return {
    roots: () => rootsFor(session, loaded),
    async thumbnail(p) {
      if (loaded) return libraryFor(loaded, session).thumbnail(p);
      const { prefabThumbnail } = await import("../library/prefabs.js");
      const { defaultCacheDir } = await import("../assets/cache.js");
      return prefabThumbnail(p, { cacheDir: defaultCacheDir() });
    },
    registry: () => loaded?.registry,
    paletteIndex: () => loaded?.palette,
  };
}

/** The loaded instance's plugin state overrides, for turning a candidate ghost as `stamp` turns blocks (09). */
function candidateStateOverrides(session: Session): () => StateOverride[] {
  let loaded: InstanceContext | undefined;
  void session.whenInstance().then((c) => (loaded = c));
  return () => (loaded?.plugins ?? []).flatMap((pl) => (pl.rotate ? [pl.rotate.bind(pl)] : []));
}

const command = process.argv[2];
const run = command && CLI_COMMANDS.has(command) ? runCli(command, process.argv.slice(3)).then((code) => process.exit(code)) : main();
run.catch((e: Error) => {
  log(`fatal: ${e.stack ?? e.message}`);
  process.exit(1);
});
