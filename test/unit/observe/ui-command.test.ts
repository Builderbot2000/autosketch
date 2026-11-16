import { describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { readConfig } from "../../../src/core/config.js";
import { startUi } from "../../../src/server/ui-command.js";
import { makeZip, tempDir, writeTree } from "../../helpers/fixtures.js";

/** `autosketch ui` (docs/design/15-management-ui.md, U5): the management UI with no MCP session. */

function send(url: string, opts: { method?: string; headers?: Record<string, string>; body?: unknown } = {}): Promise<{ status: number; json: () => any }> { // eslint-disable-line @typescript-eslint/no-explicit-any
  const data = opts.body === undefined ? undefined : JSON.stringify(opts.body);
  return new Promise((ok, fail) => {
    const req = request(url, { method: opts.method ?? "GET", headers: { ...(data ? { "content-type": "application/json" } : {}), ...opts.headers } }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => ok({ status: res.statusCode ?? 0, json: () => JSON.parse(Buffer.concat(chunks).toString("utf8")) }));
    });
    req.on("error", fail);
    req.end(data);
  });
}

async function workspaceWithLog(): Promise<string> {
  const ws = await tempDir("autosketch-uiws-");
  const dir = join(ws, "keep", "observe", "20261116T000000000Z-abcd");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "events.ndjson"), JSON.stringify({ v: 1, seq: 1, t: 1, doc: "base", kind: "session.open", name: "keep" }) + "\n");
  return ws;
}

describe("autosketch ui (15, U5)", () => {
  it("serves settings, instance, library and session logs with no MCP session", async () => {
    const ws = await workspaceWithLog();
    const home = await tempDir();
    const configPath = join(home, "config.toml");
    const game = await tempDir();
    await writeTree(game, { "versions/1.21.1/1.21.1.jar": makeZip({ "version.json": { id: "1.21.1" } }) });
    const ui = await startUi(["--workspace", ws], { configPath, env: {}, discover: async () => ({ candidates: [], warnings: [] }) });
    const base = ui.url.replace(/#.*$/, "");
    const write = { origin: base.replace(/\/$/, ""), "x-autosketch-token": /#t=(.+)$/.exec(ui.url)![1]! };
    try {
      expect(ui.url).toMatch(/#t=[\w-]{32}$/);
      expect((await send(`${base}info`)).json()).toMatchObject({ live: false, standalone: true, settings: true, instance: true, library: true });

      // Settings: saved to config.toml; with no server running nothing is "restart needed".
      const put = await send(`${base}api/settings/observe.snapshots`, { method: "PUT", headers: write, body: { value: "merge" } });
      expect(put.json()).toMatchObject({ value: "merge", restartNeeded: false });
      expect(readConfig(configPath).config.settings["observe.snapshots"]).toBe("merge");

      // Instance: a choice is saved for the next start, never loaded here.
      expect((await send(`${base}api/instance`)).json()).toMatchObject({ standalone: true, wizard: true, current: { state: "none" } });
      const chose = await send(`${base}api/instance`, { method: "PUT", headers: write, body: { path: game } });
      expect(chose.json()).toMatchObject({ saved: { folder: game }, loading: false, restartNeeded: false, standalone: true });

      // Library: the starter root (the user root doesn't exist yet).
      const lib = (await send(`${base}api/library`)).json();
      expect(lib.roots.map((r: { label: string }) => r.label)).toEqual(["user", "starter", "axiom"]);

      // Observe: the workspace's logs, each opened in its own viewer (a write: token needed).
      const logs = (await send(`${base}api/logs`)).json().logs;
      expect(logs.map((l: { id: string }) => l.id)).toEqual(["keep/20261116T000000000Z-abcd"]);
      expect((await send(`${base}api/logs/open`, { method: "POST", body: { id: logs[0].id }, headers: { origin: write.origin } })).status).toBe(403);
      expect((await send(`${base}api/logs/open`, { method: "POST", body: { id: "../../etc" }, headers: write })).status).toBe(404);
      const opened = (await send(`${base}api/logs/open`, { method: "POST", body: { id: logs[0].id }, headers: write })).json();
      expect((await send(`${opened.url}info`)).json()).toMatchObject({ live: false, doc: "keep" });
      expect((await send(`${base}api/logs/open`, { method: "POST", body: { id: logs[0].id }, headers: write })).json().url).toBe(opened.url);
    } finally {
      await ui.close();
    }
  });

  it("runs as the ui subcommand: prints the URL and serves until interrupted", async () => {
    const repo = join(import.meta.dirname, "..", "..", "..");
    const env = { ...process.env, AUTOSKETCH_WORKSPACE: await workspaceWithLog() };
    const loader = pathToFileURL(join(repo, "node_modules", "tsx", "dist", "loader.mjs")).href;
    const child = spawn(process.execPath, ["--import", loader, join(repo, "src", "server", "index.ts"), "ui", "--no-open"], { env, stdio: ["ignore", "pipe", "pipe"] });
    try {
      const url = await new Promise<string>((ok, fail) => {
        let out = "";
        child.stdout.setEncoding("utf8").on("data", (c: string) => {
          out += c;
          const m = /^(http:\/\/127\.0\.0\.1:\d+\/#t=[\w-]+)$/m.exec(out);
          if (m) ok(m[1]!);
        });
        child.on("exit", (code) => fail(new Error(`exited ${code}`)));
      });
      expect((await send(url.replace(/#.*$/, "") + "info")).json()).toMatchObject({ standalone: true });
    } finally {
      child.kill("SIGINT");
    }
  }, 20_000);
});
