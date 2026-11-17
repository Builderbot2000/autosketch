import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Settings } from "../../../src/core/settings.js";
import { Document } from "../../../src/document/document.js";
import { ObserveHttp } from "../../../src/observe/http.js";
import { startObserve } from "../../../src/observe/index.js";

/** The OTLP receiver, the one HTTP endpoint left (16, *What goes, what stays, what moves*; 13, B3). */

const roots: string[] = [];
const tempWorkspace = () => {
  const d = mkdtempSync(join(tmpdir(), "autosketch-http-"));
  roots.push(d);
  return d;
};
afterAll(() => roots.forEach((d) => rmSync(d, { recursive: true, force: true })));

function send(url: string, opts: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<number> {
  return new Promise((ok, fail) => {
    const req = request(url, { method: opts.method ?? "GET", headers: opts.headers ?? {} }, (res) => {
      res.resume();
      res.on("end", () => ok(res.statusCode ?? 0));
    });
    req.on("error", fail);
    req.end(opts.body);
  });
}

describe("OTLP receiver (13, B3)", () => {
  it("serves only POST /v1/logs, to loopback hosts, from no Origin or its own", async () => {
    const got: unknown[] = [];
    const http = new ObserveHttp({ port: 0, publish: (e) => void got.push(e) });
    const url = await http.start();
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
    const json = { "content-type": "application/json" };
    const body = JSON.stringify({ resourceLogs: [{ scopeLogs: [{ logRecords: [{ body: { stringValue: "x" } }] }] }] });
    for (const path of ["", "index.html", "events", "info", "api/settings", "api/library", "doc/base/snapshot", "vendor/three/build/three.module.js"]) expect(await send(url + path), path).toBe(404);
    expect(await send(`${url}v1/logs`)).toBe(405);
    expect(await send(`${url}v1/logs`, { method: "POST", headers: { ...json, host: "evil.example:80" }, body })).toBe(403);
    expect(await send(`${url}v1/logs`, { method: "POST", headers: { ...json, origin: "http://evil.example" }, body })).toBe(403);
    expect(await send(`${url}v1/logs`, { method: "POST", headers: { ...json, origin: url.replace(/\/$/, "") }, body })).toBe(200);
    expect(await send(`${url}v1/logs`, { method: "POST", headers: json, body })).toBe(200);
    expect(got).toEqual([{ kind: "otel", record: { body: { stringValue: "x" } } }, { kind: "otel", record: { body: { stringValue: "x" } } }]);
    await http.close();
  });

  it("falls back to a free port when the default port is taken, but never for a port the user set", async () => {
    const { createServer } = await import("node:net");
    const blocker = createServer();
    await new Promise<void>((ok) => blocker.listen(0, "127.0.0.1", () => ok()));
    const taken = (blocker.address() as { port: number }).port;
    const make = (fallbackToFreePort: boolean) => new ObserveHttp({ port: taken, fallbackToFreePort, publish: () => {} });
    const fallback = make(true);
    await fallback.start();
    expect(fallback.port).not.toBe(taken);
    await fallback.close();
    const pinned = make(false);
    await expect(pinned.start()).rejects.toMatchObject({ code: "EADDRINUSE" });
    await new Promise<void>((ok) => blocker.close(() => ok()));
  });

  it("is on by default on a free port, with deltas on (auto); off with observe.http=false", async () => {
    const doc = Document.create({ name: "d", dataVersion: 3955 });
    const on = startObserve({ workspace: tempWorkspace(), settings: Settings.from(["--set", "observe.http=true"], {}), sessionId: "s", getDoc: () => doc });
    expect(on.http).toBeDefined();
    expect(on.deltas).toBeDefined();
    expect(await on.ready).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
    await on.close();
    const off = startObserve({ workspace: tempWorkspace(), settings: Settings.from(["--set", "observe.http=false"], {}), sessionId: "s", getDoc: () => doc });
    expect(off.http).toBeUndefined();
    expect(off.deltas).toBeUndefined();
    expect(await off.ready).toBeUndefined();
    await off.close();
  });
});
