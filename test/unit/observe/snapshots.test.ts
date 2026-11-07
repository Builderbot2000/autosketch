import { afterAll, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PNG } from "pngjs";
import type { LoggedEvent } from "../../../src/core/events.js";
import { fromPublic } from "../../../src/core/region.js";
import { Settings } from "../../../src/core/settings.js";
import { Document } from "../../../src/document/document.js";
import { startObserve } from "../../../src/observe/index.js";
import { fill } from "../../../src/ops/edit.js";
import { TextureLoader } from "../../../src/palette/textures.js";
import { BlockBaker } from "../../../src/perception/render/bake.js";
import { solidPng } from "../../helpers/fixtures.js";
import { memStack, VANILLA_PARENTS } from "../../helpers/stack.js";

const roots: string[] = [];
afterAll(() => roots.forEach((d) => rmSync(d, { recursive: true, force: true })));

async function setup(mode: string) {
  const workspace = mkdtempSync(join(tmpdir(), "autosketch-snap-"));
  roots.push(workspace);
  const stack = await memStack([
    ["base", "base", {
      ...VANILLA_PARENTS,
      "assets/test/blockstates/red.json": { variants: { "": { model: "test:block/red" } } },
      "assets/test/models/block/red.json": { parent: "block/cube_all", textures: { all: "test:block/red" } },
      "assets/test/textures/block/red.png": solidPng([200, 30, 30]),
    }],
  ]);
  const baker = new BlockBaker(stack, new TextureLoader(stack), undefined);
  const doc = Document.create({ name: "keep", dataVersion: 3955 });
  let bakes = 0;
  const obs = startObserve({
    workspace,
    settings: Settings.from(["--set", `observe.snapshots=${mode}`], {}),
    sessionId: "s",
    flushMs: 5,
    debounceMs: 10,
    getDoc: () => doc,
    getBaker: async () => (bakes++, baker),
  });
  const seen: LoggedEvent[] = [];
  obs.bus.subscribe((e) => seen.push(e));
  obs.bus.publish("base", { kind: "session.open", name: "keep" });
  doc.events = obs.sink();
  return { workspace, doc, obs, seen, bakes: () => bakes };
}

describe("time-lapse snapshots (12, phase 2)", () => {
  it("renders the base document after a checkpoint into snapshots/<seq>.png, off the call path", async () => {
    const { workspace, doc, obs, seen } = await setup("checkpoint");
    const sink = obs.sink();
    sink.emit({ kind: "call.start", call: 1, tool: "fill" });
    fill(doc, {}, fromPublic({ min: [0, 0, 0], max: [3, 2, 3] }), "test:red");
    sink.emit({ kind: "call.end", call: 1, tool: "fill", ms: 1, ok: true, chars: 1, images: 0, pixels: 0 });
    sink.emit({ kind: "call.start", call: 2, tool: "checkpoint" });
    doc.checkpoint("one");
    // The checkpoint call is still in flight: nothing renders, even after the debounce.
    await new Promise((r) => setTimeout(r, 40));
    expect(seen.some((e) => e.kind === "render.produced")).toBe(false);
    sink.emit({ kind: "call.end", call: 2, tool: "checkpoint", ms: 1, ok: true, chars: 1, images: 0, pixels: 0 });
    await obs.snapshots!.idle();
    await obs.close();

    const dir = join(workspace, "keep", "observe", "s", "snapshots");
    const files = readdirSync(dir);
    expect(files).toEqual([`${seen.find((e) => e.kind === "call.end" && e.call === 2)!.seq}.png`]);
    const png = PNG.sync.read(readFileSync(join(dir, files[0]!)));
    expect([png.width, png.height]).toEqual([512, 512]);
    expect(seen.at(-1)).toMatchObject({ kind: "render.produced", doc: "base", view: "iso_ne", size: [512, 512], source: "snapshot", path: `snapshots/${files[0]}` });
    // The snapshot event reaches the log too.
    expect(readFileSync(join(workspace, "keep", "observe", "s", "events.ndjson"), "utf8")).toContain('"kind":"render.produced"');
  });

  it("debounces a burst of checkpoints into one render, and ignores sandboxes and other modes", async () => {
    const { workspace, doc, obs } = await setup("checkpoint");
    fill(doc, {}, fromPublic({ min: [0, 0, 0], max: [1, 1, 1] }), "test:red");
    for (const n of ["a", "b", "c"]) doc.checkpoint(n);
    obs.bus.publish("s1", { kind: "doc.checkpoint", name: "x", jseq: 1 }); // a scope's checkpoint
    await obs.snapshots!.idle();
    expect(readdirSync(join(workspace, "keep", "observe", "s", "snapshots"))).toHaveLength(1);
    await obs.close();

    const merge = await setup("merge");
    merge.doc.checkpoint("a");
    await new Promise((r) => setTimeout(r, 40));
    await merge.obs.close();
    expect(existsSync(join(merge.workspace, "keep", "observe", "s", "snapshots"))).toBe(false);
    expect(merge.bakes()).toBe(0);

    const off = await setup("off");
    expect(off.obs.snapshots).toBeUndefined();
    await off.obs.close();
  });
});
