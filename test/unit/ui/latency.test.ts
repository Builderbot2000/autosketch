import { afterEach, describe, expect, it } from "vitest";
import { join } from "node:path";
import { readConfig } from "../../../src/core/config.js";
import { fromPublic, type Vec3 } from "../../../src/core/region.js";
import { Settings } from "../../../src/core/settings.js";
import { Document } from "../../../src/document/document.js";
import { fill } from "../../../src/ops/edit.js";
import { Session } from "../../../src/server/session.js";
import { startUi, type UiCore } from "../../../src/ui/index.js";
import { LiveLink } from "../../../src/world/live-link.js";
import { FakeHost } from "../../support/fake-host.js";
import { tempDir } from "../../helpers/fixtures.js";
import { vanillaRegistry } from "../../helpers/vanilla.js";

/**
 * "Never slows the build" (16, *Principles* 5; briefs/ui/M, deliverable 2): an edit's latency with
 * the UI on and the mod's socket stalled (nothing read, so everything the UI sends piles up in the
 * socket's buffer) against the same edits with no UI. The UI does the most it can here: an anchored
 * document ghost whose sections are rebuilt and resent every 20 ms window, plus flashes and states.
 */

const env = { registry: vanillaRegistry() };
const B = (min: Vec3, max: Vec3) => fromPublic({ min, max });
const N = 300;
const sent = { ghosts: 0 };

let host: FakeHost | undefined;
let link: LiveLink | undefined;
let ui: UiCore | undefined;
afterEach(async () => {
  ui?.close();
  link?.close();
  await host?.close();
  host = link = ui = undefined;
});

const median = (xs: number[]) => xs.slice().sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
const p95 = (xs: number[]) => xs.slice().sort((a, b) => a - b)[Math.floor(xs.length * 0.95)]!;

/** N edits of an 8×8×8 box each, 2 ms apart (tool calls come with model time between them); ms per edit. */
async function edits(doc: Document): Promise<number[]> {
  const out: number[] = [];
  for (let i = 0; i < N; i++) {
    const x = (i % 8) * 8, z = (Math.floor(i / 8) % 8) * 8;
    const t = performance.now();
    fill(doc, env, B([x, 0, z], [x + 7, 7, z + 7]), i % 2 ? "stone" : "oak_planks");
    out.push(performance.now() - t);
    await new Promise((r) => setTimeout(r, 2));
  }
  return out;
}

async function run(withUi: boolean): Promise<number[]> {
  host = await FakeHost.start({ volumes: null });
  const session = new Session(await tempDir("autosketch-latency-"));
  link = new LiveLink(session, { gameDir: host.instanceDir, backoff: { minMs: 20, maxMs: 50 }, features: ["prompt.close", "ui"] });
  session.world = link;
  const doc = Document.create({ name: "big", dataVersion: 3955, seed: 1 });
  fill(doc, env, B([0, 0, 0], [63, 0, 63]), "stone");
  await session.adopt(doc);
  await link.bridge.connect();
  if (withUi) {
    const send = link.bridge.send.bind(link.bridge);
    link.bridge.send = (m) => {
      if (m.type === "ui.ghost") sent.ghosts++;
      send(m);
    };
    const configPath = join(session.workspace, "c.toml");
    ui = startUi({ bridge: link.bridge, subscribe: (fn) => session.subscribe(fn), workspace: session.workspace, sessionId: "s", settings: Settings.from([], {}, readConfig(configPath)), configPath, promptPlayers: () => [], library: { roots: () => [] }, baseDoc: () => session.doc, scopes: session.scopes, linkFrame: () => undefined, intervalMs: 20 });
    ui.ghosts.anchorAt("minecraft:overworld", [0, 70, 0], ["00000000-0000-4000-8000-000000000001"]);
    // Stall the mod: it stops reading, so every frame the UI sends stays in the MCP's socket buffer.
    (host as unknown as { socket: { pause(): void } }).socket.pause();
  }
  const times = await edits(session.doc!);
  ui?.close();
  link.close();
  await host.close();
  host = link = ui = undefined;
  return times;
}

describe("UI latency", () => {
  it("an edit takes as long with the UI on and the socket stalled as with no UI", async () => {
    await run(false); // warm-up (JIT)
    const off = await run(false);
    const on = await run(true);
    const report = `edit latency over ${N} edits of 512 blocks: no UI median ${median(off).toFixed(3)} ms, p95 ${p95(off).toFixed(3)} ms; UI on, socket stalled: median ${median(on).toFixed(3)} ms, p95 ${p95(on).toFixed(3)} ms (${sent.ghosts} ghost updates sent into the stalled socket)`;
    console.log(report);
    // Generous bounds: timing on a shared machine is noisy; the claim is "no added work on the edit's path".
    expect(sent.ghosts).toBeGreaterThan(1); // the UI really was sending all along
    expect(median(on)).toBeLessThan(median(off) * 1.5 + 0.5);
  }, 60_000);
});
