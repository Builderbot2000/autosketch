import { describe, expect, it } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { join } from "node:path";
import type { Candidate, Discovery } from "../../../src/assets/discover/index.js";
import { readConfig } from "../../../src/core/config.js";
import { EventBus } from "../../../src/observe/bus.js";
import { ObserveHttp } from "../../../src/observe/http.js";
import { LogTables } from "../../../src/observe/states.js";
import type { InstanceContext } from "../../../src/server/context.js";
import { makeInstanceHost } from "../../../src/server/instance-host.js";
import { Session } from "../../../src/server/session.js";
import { smallContext } from "../../helpers/context.js";
import { makeZip, tempDir, writeTree } from "../../helpers/fixtures.js";

/** The Instance tab's endpoints and the setup wizard's server side (docs/design/15-management-ui.md, U4). */

function send(url: string, opts: { method?: string; headers?: Record<string, string>; body?: unknown } = {}): Promise<{ status: number; json: () => any }> { // eslint-disable-line @typescript-eslint/no-explicit-any
  const data = opts.body === undefined ? undefined : JSON.stringify(opts.body);
  return new Promise((ok, fail) => {
    const req = request(url, { method: opts.method ?? "GET", headers: { ...(data ? { "content-type": "application/json" } : {}), ...opts.headers } }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        ok({ status: res.statusCode ?? 0, json: () => JSON.parse(body) });
      });
    });
    req.on("error", fail);
    req.end(data);
  });
}

/** A plain game folder the locator accepts: one installed version and its jar. */
async function gameFolder(): Promise<string> {
  const dir = await tempDir("autosketch-inst-");
  await writeTree(dir, { "versions/1.21.1/1.21.1.jar": makeZip({ "version.json": { id: "1.21.1" } }), "mods/a.jar": makeZip({}) });
  return dir;
}

const candidate = (id: string, folder: string): Candidate => ({
  id,
  name: id === "a" ? "Pack A" : id,
  mcVersion: "1.21.1",
  launcher: "vanilla",
  folder,
  gameDir: folder,
  version: "1.21.1",
  via: "record",
  check: { ok: true, mods: 1, detail: "Minecraft 1.21.1, 1 mod jar" },
  warnings: [],
});

async function setup(opts: { argv?: string[]; loaded?: boolean } = {}) {
  const home = await tempDir("autosketch-home-");
  const path = join(home, "config.toml");
  const a = await gameFolder();
  const b = await gameFolder();
  const session = new Session(await tempDir("autosketch-ws-"));
  const loads: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  session.setup = {
    load: async (p) => {
      loads.push(p);
      await gate;
      return smallContext();
    },
    notConfigured: async () => "not configured",
  };
  if (opts.loaded) session.setInstance(smallContext() as Promise<InstanceContext>);
  const found: Discovery = { candidates: [candidate("a", a)], warnings: ["Prism Launcher: no instances folder"] };
  let runs = 0;
  const host = makeInstanceHost({ session, argv: opts.argv?.map((x) => x.replace("$A", a)) ?? [], env: {}, file: readConfig(path), configPath: path, discover: async () => (runs++, found) });
  const http = new ObserveHttp({ bus: new EventBus(), tables: new LogTables(() => {}), sessionId: "s", dirFor: () => home, docFor: () => undefined, port: 0, configPath: path, instance: host });
  const page = await http.start();
  const base = page.replace(/#.*$/, "");
  const write = { origin: base.replace(/\/$/, ""), "x-autosketch-token": /#t=(.+)$/.exec(page)![1]! };
  return { path, a, b, session, loads, release, http, base, write, runs: () => runs };
}

const until = async (fn: () => Promise<boolean>) => {
  const end = Date.now() + 5000;
  while (!(await fn()) && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
};

describe("Instance tab endpoints (15, U4)", () => {
  it("is the wizard with nothing remembered; the first choice is saved, then loaded in place; another choice needs a restart; unlink removes it", async () => {
    const t = await setup();
    const url = `${t.base}api/instance`;
    let v = (await send(url)).json();
    expect(v).toMatchObject({ wizard: true, saved: null, launch: null, current: { state: "none" }, restartNeeded: false, link: null, discoveryWarnings: ["Prism Launcher: no instances folder"] });
    expect(v.candidates.map((c: Candidate) => c.id)).toEqual(["a"]);

    // Writes are guarded like every other.
    expect((await send(url, { method: "PUT", body: { id: "a" }, headers: { origin: t.write.origin } })).status).toBe(403);
    expect((await send(`${url}?id=a`, { headers: t.write })).status).toBe(200); // a GET changes nothing
    expect(readConfig(t.path).exists).toBe(false);
    // Unknown ids and folders the locator can't load are refused, and nothing is saved.
    const bad = await send(url, { method: "PUT", headers: t.write, body: { id: "nope" } });
    expect(bad.status).toBe(400);
    expect(bad.json().error).toMatch(/no instance with id "nope"/);
    const empty = await tempDir();
    expect((await send(url, { method: "PUT", headers: t.write, body: { path: empty } })).status).toBe(400);
    expect(readConfig(t.path).exists).toBe(false);

    const chose = await send(url, { method: "PUT", headers: t.write, body: { id: "a", hash: v.hash } });
    expect(chose.status).toBe(200);
    expect(chose.json()).toMatchObject({ saved: { folder: t.a, version: "1.21.1" }, name: "Pack A", loading: true, restartNeeded: false });
    expect(readConfig(t.path).config).toMatchObject({ instance: t.a, version: "1.21.1" });
    expect(t.loads).toEqual([t.a]);
    v = (await send(url)).json();
    expect(v).toMatchObject({ wizard: false, current: { state: "loading", folder: t.a } });
    t.release();
    await until(async () => (await send(url)).json().current.state === "loaded");
    v = (await send(url)).json();
    expect(v.current).toMatchObject({ state: "loaded", folder: t.a, mcVersion: expect.any(String) });
    expect(t.session.hasInstance).toBe(true);

    // A stale hash is refused, and the file stays.
    expect((await send(url, { method: "PUT", headers: t.write, body: { path: t.b, hash: "stale" } })).status).toBe(409);
    // Another instance while one is loaded: saved, not loaded; the page says a restart switches.
    const other = await send(url, { method: "PUT", headers: t.write, body: { path: t.b, hash: v.hash } });
    expect(other.json()).toMatchObject({ saved: { folder: t.b }, loading: false, restartNeeded: true });
    expect(t.loads).toEqual([t.a]);
    expect((await send(url)).json()).toMatchObject({ restartNeeded: true, current: { folder: t.a } });

    const unlinked = await send(url, { method: "DELETE", headers: t.write });
    expect(unlinked.json()).toMatchObject({ saved: null });
    expect(readConfig(t.path).config.instance).toBeUndefined();
    expect(readConfig(t.path).config.version).toBeUndefined();
    expect((await send(url)).json()).toMatchObject({ wizard: true, current: { state: "loaded" } });

    // Discovery is cached; ?refresh runs it again.
    const runs = t.runs();
    await send(url);
    expect(t.runs()).toBe(runs);
    await send(`${url}?refresh=1`);
    expect(t.runs()).toBe(runs + 1);
    await t.http.close();
  });

  it("offers a launch --instance first, marked as the launch value; keeping it needs no restart", async () => {
    const t = await setup({ argv: ["--instance", "$A"], loaded: true });
    const url = `${t.base}api/instance`;
    await until(async () => (await send(url)).json().current.state === "loaded");
    const v = (await send(url)).json();
    expect(v).toMatchObject({ wizard: true, launch: { folder: t.a, label: "--instance", loaded: true }, current: { state: "loaded", folder: t.a, source: { label: "--instance" } } });
    const kept = await send(url, { method: "PUT", headers: t.write, body: { path: t.a } });
    expect(kept.json()).toMatchObject({ saved: { folder: t.a }, loading: false, restartNeeded: false });
    expect(t.loads).toEqual([]);
    expect((await send(url)).json()).toMatchObject({ wizard: false, restartNeeded: false });
    await t.http.close();
  });

  it("refuses to rewrite a config.toml with problems", async () => {
    const t = await setup();
    writeFileSync(t.path, "instance = [\n");
    const r = await send(`${t.base}api/instance`, { method: "PUT", headers: t.write, body: { id: "a" } });
    expect(r.status).toBe(409);
    expect(readFileSync(t.path, "utf8")).toBe("instance = [\n");
    expect(t.loads).toEqual([]);
    await t.http.close();
  });
});
