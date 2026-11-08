import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Document } from "../../src/document/document.js";
import { renderDocument } from "../../src/perception/render/render.js";
import { configFromEnv, loadInstanceContext, type InstanceContext } from "../../src/server/context.js";
import { bakerFor } from "../../src/server/tools/shared.js";
import { readWorkspaceEvents } from "../../src/observe/reader.js";
import type { ServerHost, StdioServerSpec } from "./runner.js";

/**
 * The real server host for `npm run eval`: the Autosketch server as a stdio child process, run
 * from source with tsx, one process per run with its own workspace. Needs a Minecraft instance
 * (`AUTOSKETCH_INSTANCE` or `--instance`), like the server itself.
 */

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

export class StdioHost implements ServerHost {
  constructor(
    private readonly instance: string,
    private readonly extraArgs: string[] = [],
  ) {}

  spec(workspace: string, hiddenTools: string[]): StdioServerSpec {
    // An absolute loader path, so the child resolves tsx whatever its working directory.
    const tsx = join(REPO, "node_modules", "tsx", "dist", "loader.mjs");
    if (!existsSync(tsx)) throw new Error(`tsx not found at ${tsx} (npm install)`);
    const args = [
      "--import",
      pathToFileURL(tsx).href,
      join(REPO, "src", "server", "index.ts"),
      "--instance",
      this.instance,
      "--workspace",
      workspace,
      "--set",
      "observe.log=true",
      ...(hiddenTools.length ? ["--set", `server.hideTools=${hiddenTools.join(",")}`] : []),
      ...this.extraArgs,
    ];
    // The server needs no API key; keep it out of the child's environment.
    const { ANTHROPIC_API_KEY: _key, ...env } = process.env as Record<string, string>;
    return { command: process.execPath, args, cwd: REPO, env: { ...env, AUTOSKETCH_WORKSPACE: workspace } };
  }

  /** Starts the server once over stdio and lists its tools. No model involved. */
  async listTools(): Promise<string[]> {
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
    const ws = await mkdtemp(join(tmpdir(), "autosketch-eval-probe-"));
    const s = this.spec(ws, []);
    const client = new Client({ name: "autosketch-eval", version: "0" });
    try {
      await client.connect(new StdioClientTransport({ command: s.command, args: s.args, ...(s.env ? { env: s.env } : {}), ...(s.cwd ? { cwd: s.cwd } : {}), stderr: "ignore" }));
      return (await client.listTools()).tools.map((t) => t.name);
    } finally {
      await client.close().catch(() => {});
      await rm(ws, { recursive: true, force: true });
    }
  }

  /** The SDK closes the server's stdin at the end of a run; wait (≤ 10 s) until every opened document is saved and closed in the log. */
  async settle(workspace: string): Promise<void> {
    for (let i = 0; i < 50; i++) {
      const { events } = await readWorkspaceEvents(workspace);
      const opens = events.filter((e) => e.kind === "session.open").length;
      if (opens && events.filter((e) => e.kind === "session.close").length >= opens) return;
      if (!events.length && i > 10) return; // nothing was ever opened
      await new Promise((r) => setTimeout(r, 200));
    }
  }
}

/** The instance named by `--instance` / `AUTOSKETCH_INSTANCE`, loaded in-process for judge renders and analysis. */
export async function loadInstance(argv: string[], log: (m: string) => void): Promise<{ instance: string; ctx: InstanceContext } | undefined> {
  const cfg = configFromEnv(argv);
  if (!cfg) return undefined;
  return { instance: cfg.instance, ctx: await loadInstanceContext(cfg, log) };
}

/** Judge renders: the south-east isometric view and the front elevation, 768 px. */
export function judgeRenderer(ctx: InstanceContext): (doc: Document) => Promise<Buffer[]> {
  return async (doc) => {
    const baker = await bakerFor(ctx);
    const out: Buffer[] = [];
    for (const view of ["iso_se", "front"] as const) out.push((await renderDocument(doc, baker, { views: [view], size: 768 })).png);
    return out;
  };
}
