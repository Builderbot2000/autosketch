import { afterEach, describe, expect, it } from "vitest";
import type { Vec3 } from "../../../src/core/region.js";
import { worldCandidate } from "../../../src/server/world-candidate.js";
import { candidateFill } from "../../../src/ui/candidate-outline.js";
import { UiFeed } from "../../../src/ui/feed.js";
import { Bridge } from "../../../src/world/bridge.js";
import { DEFAULT_VOLATILE } from "../../../src/world/protocol/hash.js";
import { CANDIDATE_FILL, REQUEST_MODES, type GameContext, type PlayerRef, type UiMcpMessage, type UiState } from "../../../src/world/protocol/messages.js";
import { WorldSelect } from "../../../src/world/select/select.js";
import { WorldView } from "../../../src/world/view.js";
import { FakeHost } from "../../support/fake-host.js";
import { fakeRegistry } from "../../helpers/registry.js";

/**
 * The candidate in the world (18, piece 8; step P3): after world_fill and world_expand (the fake
 * host's fill), the feed sends the world view's candidate as a fill record, rebuilt on each change,
 * and removes it when the request ends.
 */

const OW = "minecraft:overworld";
const KEV: PlayerRef = { name: "Kev", uuid: "3f2504e0-4f89-41d3-9a0c-0305e82c3301" };
const BRICK = "minecraft:stone_bricks";
const registry = fakeRegistry([{ id: BRICK }]);

let host: FakeHost | undefined;
let bridge: Bridge | undefined;
let view: WorldView | undefined;
let feed: UiFeed | undefined;
afterEach(async () => {
  feed?.close();
  view?.close();
  bridge?.close();
  await host?.close();
  host = bridge = view = feed = undefined;
});

describe("the candidate through the UI feed (18, piece 8)", () => {
  it("draws the fill, redraws it after an expand, and clears it when the request ends", async () => {
    host = await FakeHost.start({ selectChunks: 8 });
    bridge = new Bridge({ instanceDir: host.instanceDir, volatile: DEFAULT_VOLATILE, reconnect: false, modes: [...REQUEST_MODES] });
    let request: number | undefined;
    let context: GameContext | undefined;
    bridge.on("prompt", (m) => ((request = m.id), (context = m.context)));
    await bridge.connect();
    const v = (view = new WorldView({ bridge, request: () => request, dimension: () => OW }));
    const select = new WorldSelect({ bridge, request: () => request, context: () => context, dimension: () => OW, view: () => v });
    // A wall along x from 10 to 40 at z 8, y 64..66 (three chunks).
    for (let x = 10; x <= 40; x++) for (let y = 64; y <= 66; y++) host.set([x, y, 8], BRICK);
    void host.playerAsk(KEV, "the wall", { position: [8.5, 64, 8.5] as unknown as Vec3, eye: [8.5, 65.62, 8.5] as unknown as Vec3 }, { mode: "select" });
    await host.waitFor(() => context);

    const sent: UiMcpMessage[] = [];
    feed = new UiFeed({ bridge: { ui: true, send: (m) => void sent.push(m), onConnection: () => () => {} }, frame: () => undefined, players: () => [KEV.uuid], request: () => null, candidate: () => worldCandidate(v), intervalMs: 1e9 });
    const states = () => sent.filter((m): m is UiState => m.type === "ui.state");

    await select.fill({ seed: [12, 65, 8], match: [BRICK], area: 0 }, { registry });
    feed.tick();
    const first = states().at(-1)!.fills![0]!;
    // Columns 10 to 15 (the read area's edge): one section's shell, the 6×3×1 slab's 12 edges.
    expect(first).toEqual(candidateFill(worldCandidate(v)!.mask(), OW));
    expect(first.faces).toHaveLength(6);
    expect(first.edges).toContainEqual([10, 64, 8, 16, 64, 8]);

    await select.expand({ by: { direction: "east", chunks: 2 } });
    feed.tick();
    const grown = states().at(-1)!.fills![0]!;
    expect(grown.id).toBe(CANDIDATE_FILL);
    expect(grown.edges).toContainEqual([10, 64, 8, 41, 64, 8]); // merged across the sections
    expect(grown.faces).toContainEqual([0, 64, 0, 48, 64, 16]); // three sections' floor, one rectangle

    request = (request ?? 0) + 1000; // the request ended: the view empties
    feed.tick();
    expect(states().at(-1)).toMatchObject({ full: false, fillsRemoved: [CANDIDATE_FILL] });
  });
});
