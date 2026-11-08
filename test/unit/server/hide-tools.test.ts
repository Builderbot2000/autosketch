import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Settings } from "../../../src/core/settings.js";
import { Session } from "../../../src/server/session.js";
import { SERVER_HIDE_TOOLS } from "../../../src/server/settings.js";
import { connectServer, smallContext } from "../../helpers/context.js";

const workspace = mkdtempSync(join(tmpdir(), "autosketch-hide-"));
afterAll(() => rmSync(workspace, { recursive: true, force: true }));

describe("server.hideTools (10, Ablations)", () => {
  it("leaves hidden tools out of the list and names them in the instructions", async () => {
    const logs: string[] = [];
    const client = await connectServer(smallContext(), { session: new Session(workspace), hideTools: ["analyze", "render", "nope"], log: (m) => logs.push(m) });
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).not.toContain("analyze");
    expect(names).not.toContain("render");
    expect(names).toContain("fill");
    expect(client.getInstructions()).toMatch(/Not available in this session: analyze, nope, render\.$/);
    expect(logs).toEqual(["server.hideTools: no tool named nope"]);
    const r = await client.callTool({ name: "analyze", arguments: {} });
    expect(r.isError).toBe(true);
  });

  it("changes nothing when empty", async () => {
    const client = await connectServer(smallContext(), { session: new Session(workspace) });
    expect((await client.listTools()).tools.map((t) => t.name)).toContain("analyze");
    expect(client.getInstructions()).not.toMatch(/Not available/);
  });

  it("reads the setting as a list", () => {
    expect(Settings.from([]).get(SERVER_HIDE_TOOLS)).toEqual([]);
    expect(Settings.from(["--set", "server.hideTools=analyze, render"]).get(SERVER_HIDE_TOOLS)).toEqual(["analyze", "render"]);
    expect(new Settings(new Map(), { AUTOSKETCH_SERVER_HIDE_TOOLS: "palette_sheet" }).get(SERVER_HIDE_TOOLS)).toEqual(["palette_sheet"]);
  });
});
