import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Mask } from "../../../src/core/mask.js";
import { fromPublic, type Vec3 } from "../../../src/core/region.js";
import { Settings } from "../../../src/core/settings.js";
import { Document } from "../../../src/document/document.js";
import { startObserve } from "../../../src/observe/index.js";
import { fill } from "../../../src/ops/edit.js";
import { ScopeManager } from "../../../src/scope/scopes.js";
import { loadReplayLog, ReplaySession } from "../../../src/ui/replay-frames.js";
import type { ReplayFrame } from "../../../src/world/protocol/messages.js";
import { vanillaRegistry } from "../../helpers/vanilla.js";

/** Replay frames (16, *Replay in the world*; 13, `replay.frame`): keyframe plus deltas equal the replayed grid at every step. */

const env = { registry: vanillaRegistry() };
const B = (min: Vec3, max: Vec3) => fromPublic({ min, max });
const FRAME = { dimension: "minecraft:overworld", origin: [100, 64, -200] as Vec3 };
const P1 = "00000000-0000-4000-8000-000000000001";

const roots: string[] = [];
afterAll(() => roots.forEach((d) => rmSync(d, { recursive: true, force: true })));

/** A recorded session: content before opening, base edits, an undo, a job with edits merged, a refusal, a checkpoint. */
async function recorded(set: string[] = ["observe.deltas=on"]) {
  const workspace = mkdtempSync(join(tmpdir(), "autosketch-replay-frames-"));
  roots.push(workspace);
  const doc = Document.create({ name: "keep", dataVersion: 3955, seed: 1 });
  fill(doc, env, B([0, 0, 0], [19, 0, 19]), "stone");
  const obs = startObserve({ workspace, settings: Settings.from(["observe.http=false", ...set].flatMap((s) => ["--set", s]), {}), sessionId: "20261117T000000000Z-test", flushMs: 5, getDoc: () => doc, getScopeDoc: (id) => scopes.scopes.get(id)?.doc });
  const scopes = new ScopeManager(() => doc, { events: (d) => obs.sink(d) });
  scopes.attach(doc);
  obs.bus.publish("base", { kind: "session.open", name: "keep", bounds: { min: [0, 0, 0], max: [19, 0, 19] } });
  doc.events = obs.sink();
  fill(doc, env, B([0, 1, 0], [0, 3, 0]), "oak_log");
  fill(doc, env, B([9, 1, 9], [9, 1, 9]), "glass");
  doc.checkpoint("posts");
  fill(doc, env, B([5, 1, 5], [5, 1, 5]), "dirt");
  doc.undo();
  const f = scopes.fork("base", { work: Mask.fromBox(B([2, 1, 2], [9, 8, 9])), brief: "tower", env });
  fill(f.scope.doc, env, B([0, 0, 0], [3, 0, 3]), "oak_planks");
  fill(f.scope.doc, env, B([0, 1, 0], [0, 1, 0]), "air");
  obs.bus.publish("base", { kind: "call.refused", call: 9, tool: "fill", code: "lock_overlap", message: "locked" });
  scopes.merge(f.scope.id, "done", env);
  fill(doc, env, B([0, 0, 0], [0, 0, 0]), "air");
  await obs.close();
  return { doc, log: await loadReplayLog(join(workspace, "keep", "observe", "20261117T000000000Z-test")) };
}

/** A client: what it holds after applying frames, as world "x,y,z" → state (air left out). */
class Client {
  blocks = new Map<string, string>();
  step = -1;
  apply(f: ReplayFrame) {
    if (f.keyframe) {
      this.blocks.clear();
      for (const r of f.regions) {
        let i = 0;
        for (let y = r.box.min[1]; y <= r.box.max[1]; y++)
          for (let z = r.box.min[2]; z <= r.box.max[2]; z++)
            for (let x = r.box.min[0]; x <= r.box.max[0]; x++, i++) {
              const s = f.palette[r.states[i]!]!;
              if (s !== "minecraft:air") this.blocks.set(`${x},${y},${z}`, s);
            }
      }
    } else {
      expect(f.from).toBe(this.step);
      for (const b of f.blocks) {
        if (b.state === "minecraft:air") this.blocks.delete(b.pos.join(","));
        else this.blocks.set(b.pos.join(","), b.state);
      }
    }
    this.step = f.step;
  }
}

describe("replay frames", () => {
  it("keyframe plus forward deltas equal a keyframe at every step, and the last step equals the document", async () => {
    const { doc, log } = await recorded();
    const play = new ReplaySession("r1", P1, log, FRAME);
    const steps = play.stepCount;
    expect(steps).toBeGreaterThan(6);
    const client = new Client();
    const first = play.frameFor(0);
    expect(first.keyframe).toBe(true);
    client.apply(first);
    for (let s = 1; s <= steps; s++) {
      const d = play.frameFor(s);
      expect(d.keyframe).toBe(false);
      client.apply(d);
      const fresh = new ReplaySession("r2", P1, log, FRAME);
      const k = new Client();
      k.apply(fresh.frameFor(s));
      expect([...client.blocks].sort()).toEqual([...k.blocks].sort());
    }
    const want: string[] = [];
    doc.voxels.forEach((x, y, z, v) => {
      const [lx, ly, lz] = doc.toLocal(x, y, z);
      want.push(`${lx + 100},${ly + 64},${lz - 200}=${doc.states.get(v)}`);
    });
    expect([...client.blocks].map(([k, v]) => `${k}=${v}`).sort()).toEqual(want.sort());
    // A backward seek is a keyframe.
    const back = play.frameFor(2);
    expect(back.keyframe).toBe(true);
  });

  it("gives the volume, jobs, flashes in job colours, HUD text and markers", async () => {
    const { log } = await recorded();
    const play = new ReplaySession("r1", P1, log, FRAME);
    const k = play.frameFor(0);
    if (!k.keyframe) throw new Error("expected a keyframe");
    expect(k.regions[0]!.box).toEqual({ min: [100, 64, -200], max: [119, 67, -181] });
    expect(k.markers.map((m) => m.kind)).toEqual(["checkpoint", "fork", "refusal", "merge"]);
    const forkStep = play.steps.findIndex((s) => s.kind === "scope.fork") + 1;
    expect(k.markers[1]!.step).toBe(forkStep);
    const sandboxEdit = play.frameFor(forkStep + 1);
    expect(sandboxEdit.jobs.map((j) => [j.id, j.brief, j.work])).toEqual([["s1", "tower", { min: [102, 65, -198], max: [109, 72, -191] }]]);
    expect(sandboxEdit.flashes).toEqual([{ job: "s1", colour: expect.stringMatching(/^#[0-9a-f]{6}$/), dimension: "minecraft:overworld", boxes: [{ min: [102, 65, -198], max: [105, 65, -195] }] }]);
    expect(sandboxEdit.hud).toEqual({ call: expect.stringContaining("fill"), brief: "tower" });
    expect(sandboxEdit.time).toMatch(/^\d{4}-\d\d-\d\dT/);
    const last = play.frameFor(play.stepCount);
    expect(last.jobs).toEqual([]);
  });

  it("reports the nearest time-lapse snapshot as HUD text where steps have no deltas", async () => {
    const { log } = await recorded([]);
    const evs = [...log.events, { v: 1 as const, seq: 1e6, t: 0, doc: "base", kind: "render.produced" as const, view: "iso_ne", size: [512, 512] as [number, number], source: "snapshot" as const, path: "snapshots/3.png" }];
    const play = new ReplaySession("r1", P1, { ...log, events: evs }, FRAME);
    const f = play.frameFor(play.stepCount);
    expect(f.hud.note).toMatch(/^No block data from step 0 on/);
    expect(f.hud.note).toContain("snapshots/3.png");
  });
});
