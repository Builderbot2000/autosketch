import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { gameFolderHash } from "../../../src/assets/discover/pointer.js";
import { applyReport, parseReport, readReportFor, refreshFromGame, type RegistryReport } from "../../../src/assets/report.js";
import { canonicalState } from "../../../src/core/blockstate.js";
import { Bridge } from "../../../src/world/bridge.js";
import { FakeHost } from "../../support/fake-host.js";
import { fakeRegistry } from "../../helpers/registry.js";

/**
 * The companion mod's registry report on the MCP side (14, *Version-specific data lives in the mod*;
 * 13, the modded-state question): read from the file beside the pointer or over the link, and put on
 * top of the registry built from the instance's files. Synthetic reports only.
 */

const REPORT: RegistryReport = {
  format: 1,
  minecraft: "1.21.1",
  dataVersion: 3955,
  loader: "neoforge",
  loaderVersion: "21.1.249",
  blocks: {
    "examplemod:gear": { properties: { axis: ["x", "y", "z"], waterlogged: ["true", "false"] }, default: { axis: "y", waterlogged: "false" }, blockEntity: true },
    "examplemod:hidden": { properties: { lit: ["true", "false"] }, default: { lit: "false" } },
    "minecraft:stone": {},
  },
  tags: { "minecraft:mineable/pickaxe": ["examplemod:gear", "minecraft:stone"] },
};
const gz = (r: object) => new Uint8Array(gzipSync(Buffer.from(JSON.stringify(r))));
const hashOf = (r: object) => createHash("sha256").update(Buffer.from(JSON.stringify(r))).digest("hex").slice(0, 16);

/** A registry as the instance's files describe it: the gear's blockstate file lists only axis. */
const assetsRegistry = () =>
  fakeRegistry([
    { id: "examplemod:gear", properties: { axis: ["x", "y", "z"] }, defaults: { axis: "y" }, shape: "partial" },
    { id: "minecraft:stone", tags: ["old:tag"] },
    { id: "clientmod:lamp", properties: { on: ["true", "false"] }, defaults: { on: "false" } },
  ]);

const roots: string[] = [];
const temp = () => {
  const d = mkdtempSync(join(tmpdir(), "autosketch-report-"));
  roots.push(d);
  return d;
};
afterAll(() => roots.forEach((d) => rmSync(d, { recursive: true, force: true })));

describe("reading the report", () => {
  it("parses the gzip file, hashing the JSON as the protocol does", () => {
    const r = parseReport(gz(REPORT), "x");
    expect(r.report.blocks["examplemod:gear"]?.default).toEqual({ axis: "y", waterlogged: "false" });
    expect(r.hash).toBe(hashOf(REPORT));
    expect(() => parseReport(gz({ ...REPORT, format: 2 }), "x")).toThrow(/format 2/);
    expect(() => parseReport(gz({ format: 1 }), "x")).toThrow(/not a registry report/);
  });

  it("finds the file beside the pointer for the game folder or its minecraft subfolder", async () => {
    const home = temp(), instance = temp();
    mkdirSync(join(home, "games"));
    expect(await readReportFor(instance, [], home)).toBeUndefined();
    writeFileSync(join(home, "games", `${gameFolderHash(join(instance, "minecraft"))}.registry.json.gz`), gz(REPORT));
    const found = await readReportFor(instance, [], home);
    expect(found?.report.dataVersion).toBe(3955);
    expect(found?.source).toContain(".registry.json.gz");
    // A broken file is skipped with a warning.
    writeFileSync(join(home, "games", `${gameFolderHash(instance)}.registry.json.gz`), "not gzip");
    const warnings: string[] = [];
    expect((await readReportFor(instance, warnings, home))?.report.dataVersion).toBe(3955);
    expect(warnings[0]).toMatch(/skipped/);
  });
});

describe("order of trust: the report, then the instance's files", () => {
  it("without a report, a typed modded block gets only what its blockstate file lists (as before)", () => {
    expect(canonicalState("examplemod:gear", assetsRegistry()).state).toBe("examplemod:gear[axis=y]");
  });

  it("with the report, it gets the game's full state, including properties that don't change the model", () => {
    const registry = assetsRegistry();
    expect(applyReport(registry, parseReport(gz(REPORT), "file"))).toEqual({ corrected: 1, added: 1 });
    expect(canonicalState("examplemod:gear", registry).state).toBe("examplemod:gear[axis=y,waterlogged=false]");
    expect(canonicalState("examplemod:gear[waterlogged=true,axis=x]", registry).state).toBe("examplemod:gear[axis=x,waterlogged=true]");
    expect(() => canonicalState("examplemod:gear[waterlogged=maybe]", registry)).toThrow(/valid: true\|false/);
    const gear = registry.get("examplemod:gear")!;
    expect(gear).toMatchObject({ exactProperties: true, blockEntity: true, shape: "partial", tags: ["minecraft:mineable/pickaxe"] });
    // A block with no blockstate file is added; the game's tags replace the files'; asset-only blocks stay.
    expect(canonicalState("examplemod:hidden", registry)).toEqual({ state: "examplemod:hidden[lit=false]" });
    expect(registry.get("minecraft:stone")!.tags).toEqual(["minecraft:mineable/pickaxe"]);
    expect(registry.withTag("minecraft:mineable/pickaxe").map((b) => b.id).sort()).toEqual(["examplemod:gear", "minecraft:stone"]);
    expect(registry.get("clientmod:lamp")!.exactProperties).toBeUndefined();
    expect(registry.report).toMatchObject({ dataVersion: 3955, hash: hashOf(REPORT), source: "file" });
  });
});

describe("the report over the link (protocol 3, registry)", () => {
  let host: FakeHost | undefined, bridge: Bridge | undefined;
  afterEach(async () => {
    bridge?.close();
    await host?.close();
  });

  it("is fetched and applied when it differs from the one held, and not again when unchanged", async () => {
    host = await FakeHost.start({ registryReport: REPORT });
    bridge = new Bridge({ instanceDir: host.instanceDir, volatile: {}, reconnect: false });
    await bridge.connect();
    const registry = assetsRegistry();
    const ask = (have: string | undefined) => bridge!.request({ type: "registry", ...(have ? { have } : {}) });
    expect(await refreshFromGame(registry, ask)).toEqual({ corrected: 1, added: 1 });
    expect(registry.report?.source).toBe("the game");
    expect(canonicalState("examplemod:gear", registry).state).toBe("examplemod:gear[axis=y,waterlogged=false]");
    expect(await refreshFromGame(registry, ask)).toBeUndefined();
    expect(host.received.filter((m) => m.type === "registry")).toEqual([
      { type: "registry", id: 1 },
      { type: "registry", id: 2, have: hashOf(REPORT) },
    ]);
  });
});
