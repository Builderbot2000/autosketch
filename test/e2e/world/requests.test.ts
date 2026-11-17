import { connect } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Bridge } from "../../../src/world/bridge.js";
import { DEFAULT_VOLATILE } from "../../../src/world/protocol/hash.js";
import { decodeMessage, encodeMessage } from "../../../src/world/protocol/codec.js";
import { FrameReader } from "../../../src/world/protocol/frame.js";
import type { PlayerRef, PromptMessage, RequestMode, ScanGrant } from "../../../src/world/protocol/messages.js";
import { readPairing } from "../../../src/world/protocol/pairing.js";
import { InGameRequests } from "../../../src/world/prompt.js";
import { ENABLED, instanceContext, rcon, SERVER_DIR, setVolumes, startMcp, until, worldBlock, type Mcp, type Vec3 } from "./harness.js";
import type { Rcon } from "./rcon.js";

/**
 * End-to-end scenarios for in-game requests (docs/briefs/release/Z-requests-mcp.md, wave 3; 13,
 * B4 and B6) against the running server with the mod.
 *
 * A headless server has no player, and the mod sends `prompt` only for a player's command
 * (`/autosketch ask|plan|scan|build`), so these scenarios hand the MCP the `prompt` a player's
 * command would send (`InGameRequests.onPrompt`), and likewise the `prompt.close` of
 * `/autosketch done` (`InGameRequests.onClose`), and check everything after it against the real
 * mod: refused edits leave the world as it was, the probe is read with the mod's snapshots and
 * surface reads, `volumes.set` sets volumes that link, and the mod's refusals come back. The
 * command side (subcommands, the grant, `unsupported_mode` on the action bar) is silo Y's
 * GameTests and the user's in-client checklist.
 *
 * The scan grant only exists in the mod after a player's scan, so the scenario reads inside a
 * linked work volume instead (where the mod serves reads too; *Where the mod serves reads*), with a
 * grant that matches it.
 */

const X0 = 7008; // chunk-aligned, away from silo R's areas (scenarios x 1000–1600, measure 3000–3256, volatile 5000)
const Z0 = 1008;
const P: PlayerRef = { name: "E2E", uuid: "e2e00000-0000-4000-8000-000000000001" };
const OW = "minecraft:overworld";

describe.skipIf(!ENABLED)("e2e world: in-game requests (B4, B6)", () => {
  let r: Rcon;
  let mcp: Mcp;
  let inGame: InGameRequests;
  const events: string[] = [];
  let nextId = 9000;

  const prompt = async (mode: RequestMode, text: string, at: Vec3, scan?: ScanGrant) => {
    const m: PromptMessage = {
      type: "prompt",
      id: ++nextId,
      player: P,
      text,
      context: { dimension: OW, position: [at[0] + 0.5, at[1], at[2] + 0.5], eye: [at[0] + 0.5, at[1] + 1.62, at[2] + 0.5], yaw: 0, pitch: 30, facing: "south" },
      mode,
      ...(scan ? { scan } : {}),
    };
    const n = events.length;
    await inGame.onPrompt(m);
    expect(events.length).toBe(n + 1);
    return { id: m.id, text: events.at(-1)! };
  };

  beforeAll(async () => {
    const ctx = await instanceContext();
    r = await rcon();
    await r.command("autosketch clear");
    await r.command(`forceload add ${X0 - 16} ${Z0 - 16} ${X0 + 160} ${Z0 + 64}`);
    // Clear the area above the ground so reruns start from the same world (fill takes at most 32,768 blocks).
    for (let x = X0 - 4; x <= X0 + 140; x += 8) {
      const out = await r.command(`fill ${x} -60 ${Z0 - 4} ${x + 7} -20 ${Z0 + 60} minecraft:air`);
      if (/maximum|not loaded/i.test(out)) throw new Error(`clearing failed: ${out}`);
    }
    mcp = await startMcp();
    inGame = new InGameRequests(mcp.link, {
      promptPlayers: [P.name],
      idleMs: 600_000,
      activityMs: 0,
      subscribe: (fn) => mcp.session.subscribe(fn),
      notify: async (content) => void events.push(content),
      listening: () => true,
      host: mcp.session,
      palettes: () => ctx.book,
      log: () => {},
    });
    mcp.session.inGame = inGame;
    mcp.session.callHooks.push(inGame.modeRule);
    mcp.link.autoLink({ instanceDir: ctx.info.root, plugins: ctx.plugins, palettes: ctx.book });
    await until(() => mcp.link.bridge.connected, 30_000, "the bridge");
  }, 300_000);

  afterAll(async () => {
    inGame?.close();
    await mcp?.close();
    await r?.command("autosketch clear").catch(() => {});
    r?.close();
  }, 60_000);

  it("ask and plan requests refuse edits with request_mode and nothing reaches the world; world_reply done keeps the mode, the player's done or a new request ends it", async () => {
    const w = { min: [X0, -61, Z0] as Vec3, max: [X0 + 15, -50, Z0 + 15] as Vec3 };
    await setVolumes(r, w, undefined, mcp.link);
    await until(() => mcp.link.state === "linked", 20_000, "the automatic link");
    const at: Vec3 = [w.min[0] + 2, w.min[1] + 2, w.min[2] + 2];

    const ask = await prompt("ask", "what is this?", [X0 + 8, -60, Z0 + 8]);
    expect(ask.text).toMatch(/^In-game ask request from E2E: "what is this\?"\. Ask mode: read and look only/);
    const fill = await mcp.tryCall("fill", { box: { min: [2, 2, 2], max: [2, 2, 2] }, pattern: "minecraft:gold_block" });
    expect(fill.isError).toBe(true);
    expect(fill.text).toContain(`The open in-game ask request (request ${ask.id} from E2E) allows reading and looking only, so fill can't edit the linked document. Nothing was written.`);
    expect(await worldBlock(mcp.link, at)).toBe("minecraft:air");
    // Looking still works.
    expect(await mcp.call("query_block", { pos: [0, 0, 0] })).toContain("grass_block");
    await mcp.call("world_reply", { lines: ["It's grass."], done: true });
    // Answered, but only the player lifts the mode.
    const still = await mcp.tryCall("fill", { box: { min: [2, 2, 2], max: [2, 2, 2] }, pattern: "minecraft:gold_block" });
    expect(still.text).toContain(`The open in-game ask request (request ${ask.id} from E2E) allows reading and looking only`);
    expect(still.text).toContain("Only the player can end this request, in game with /autosketch done or by sending a new request; if the user at the terminal wants this edit, tell them so.");
    expect(await worldBlock(mcp.link, at)).toBe("minecraft:air");
    inGame.onClose({ type: "prompt.close", player: P }); // the player's /autosketch done
    expect(await mcp.call("fill", { box: { min: [2, 2, 2], max: [2, 2, 2] }, pattern: "minecraft:gold_block" })).toMatch(/world: 1 placed/);
    expect(await worldBlock(mcp.link, at)).toBe("minecraft:gold_block");

    const plan = await prompt("plan", "how would you roof this?", [X0 + 8, -60, Z0 + 8]);
    expect(plan.text).toContain("Plan mode: look, then propose");
    for (const [name, args] of [
      ["run_script", { source: 'fill({ box: { min: [3, 2, 2], max: [3, 2, 2] } }, "minecraft:stone");' }],
      ["undo", {}],
      ["clear", { box: { min: [2, 2, 2], max: [2, 2, 2] } }],
    ] as const) {
      const t = await mcp.tryCall(name, args);
      expect(t.isError, name).toBe(true);
      expect(t.text, name).toContain(`The open in-game plan request (request ${plan.id} from E2E) allows looking and proposing only`);
    }
    expect(await worldBlock(mcp.link, at)).toBe("minecraft:gold_block");
    expect(await worldBlock(mcp.link, [at[0] + 1, at[1], at[2]])).toBe("minecraft:air");
    const vol = await mcp.tryCall("world_volumes", { work: { min: [0, 0, 0], max: [3, 3, 3] } });
    expect(vol.text).toContain("so world_volumes can't change the volumes");
    expect(mcp.link.bridge.volumes?.work).toEqual({ min: w.min, max: w.max });
    await mcp.call("world_reply", { lines: ["A gable roof."], done: true });
    // A build request ends the plan request and edits.
    await prompt("build", "put stone next to it", [X0 + 8, -60, Z0 + 8]);
    expect(await mcp.call("set_blocks", { blocks: [{ pos: [3, 2, 2], block: "minecraft:stone" }] })).toMatch(/world: 1 placed/);
    expect(await worldBlock(mcp.link, [at[0] + 1, at[1], at[2]])).toBe("minecraft:stone");
    await mcp.call("world_reply", { lines: ["Done."], done: true });
  }, 120_000);

  it("a scan request opens the probe from the mod's reads, and world_volumes sets volumes that link", async () => {
    // A 3×3-chunk work volume, so the mod serves the probe's reads (see the file comment).
    const big = { min: [X0 + 64, -63, Z0] as Vec3, max: [X0 + 64 + 47, -40, Z0 + 47] as Vec3 };
    const tower = [X0 + 84, Z0 + 20] as const;
    await r.command(`fill ${tower[0]} -60 ${tower[1]} ${tower[0]} -55 ${tower[1]} minecraft:stone_bricks`);
    await setVolumes(r, big, undefined, mcp.link);
    await until(() => mcp.link.state === "linked" && mcp.link.volumes?.work.min[0] === big.min[0], 30_000, "the link over the big volume");
    const grant: ScanGrant = { radius: 1, columns: { min: [big.min[0], big.min[2]], max: [big.max[0], big.max[2]] }, box: { min: [big.min[0] + 8, -62, big.min[2] + 8], max: [big.max[0] - 8, -42, big.max[2] - 8] } };
    const scan = await prompt("scan", "the tower", [X0 + 88, -60, Z0 + 24], grant);
    expect(scan.text).toContain('The probe is open as the read-only document "probe" (nothing is linked yet): the surface of 3×3 chunks (48×48 columns, local x 0–47, z 0–47), and full blocks in local (8, 0, 8)–(39, 20, 39) (32×21×32).');
    expect(scan.text).not.toContain("You are covered");
    const probe = mcp.session.doc!;
    expect(probe.meta.name).toBe("probe");
    // Origin: world (big.min x, box.min y = -62, big.min z).
    const at = (x: number, y: number, z: number) => probe.states.get(probe.voxels.get(x - big.min[0], y + 62, z - big.min[2]));
    expect(at(tower[0], -55, tower[1])).toBe("minecraft:stone_bricks");
    expect(at(tower[0], -54, tower[1])).toBe("minecraft:air");
    expect(at(big.min[0] + 2, -61, big.min[2] + 2)).toBe("minecraft:grass_block[snowy=false]"); // a surface block outside the full-block box, as the game prints it
    const edit = await mcp.tryCall("fill", { box: { min: [8, 0, 8], max: [8, 0, 8] }, pattern: "minecraft:gold_block" });
    expect(edit.text).toContain("The probe (from scan request");
    expect(await mcp.call("render", { views: ["top"], size: 256 })).toBeDefined();

    const set = await mcp.call("world_volumes", { work: { min: [17, 1, 17], max: [23, 9, 23] } });
    const work = { min: [X0 + 81, -61, Z0 + 17] as Vec3, max: [X0 + 87, -53, Z0 + 23] as Vec3 };
    expect(set).toContain(`work 7×9×7 at probe (17,1,17)–(23,9,23) (world (${work.min.join(",")})–(${work.max.join(",")})), the default context (+3)`);
    expect(mcp.link.bridge.volumes).toMatchObject({ dimension: OW, work, context: [{ min: [X0 + 78, -64, Z0 + 14], max: [X0 + 90, -50, Z0 + 26] }] });
    await until(() => mcp.link.state === "linked" && mcp.session.doc?.meta.name === "world" && mcp.link.volumes?.work.min[0] === work.min[0], 30_000, "the link over the agent's volumes");
    expect(await mcp.call("query_block", { pos: [3, 1, 3] })).toContain("stone_bricks");
    // The scan request's mode holds on the new link.
    const refused = await mcp.tryCall("fill", { box: { min: [0, 1, 0], max: [0, 1, 0] }, pattern: "minecraft:gold_block" });
    expect(refused.text).toContain(`The open in-game scan request (request ${scan.id} from E2E) allows looking and setting the volumes only`);
    expect(await worldBlock(mcp.link, [work.min[0], -60, work.min[2]])).toBe("minecraft:air");
    await mcp.call("world_reply", { lines: ["Set the volumes around the tower."], done: true });
    inGame.onClose({ type: "prompt.close", player: P }); // the player's /autosketch done
    expect(inGame.heldRequest).toBeUndefined();
  }, 180_000);

  it("the mod refuses volumes.set with bad volumes, and the volumes stay as they were", async () => {
    const w = { min: [X0 + 128, -61, Z0] as Vec3, max: [X0 + 135, -55, Z0 + 7] as Vec3 };
    await setVolumes(r, w, undefined, mcp.link);
    await until(() => mcp.link.state === "linked" && mcp.link.volumes?.work.min[0] === w.min[0], 30_000, "the link");
    const before = structuredClone(mcp.link.bridge.volumes);
    const high = await mcp.tryCall("world_volumes", { work: { min: [0, 0, 0], max: [3, 500, 3] } });
    expect(high.isError).toBe(true);
    expect(high.text.toLowerCase()).toContain("build height");
    const huge = await mcp.tryCall("world_volumes", { work: { min: [0, 0, 0], max: [3, 3, 3] }, context: [{ min: [-200, -60, -200], max: [200, 100, 200] }] });
    expect(huge.isError).toBe(true);
    expect(huge.text).toMatch(/contextCap|cap/i);
    expect(mcp.link.bridge.volumes).toEqual(before);
  }, 60_000);

  it("pairs in protocol 3 with every feature listed; a protocol-2 hello is refused naming the MCP as older", async () => {
    inGame.close();
    await mcp.close();
    mcp = undefined as unknown as Mcp;
    const bridge = new Bridge({ instanceDir: SERVER_DIR, volatile: DEFAULT_VOLATILE, reconnect: false });
    const hello = await bridge.connect();
    expect(hello.protocol).toBe(3);
    expect(hello.features).toEqual(expect.arrayContaining(["modes", "scan", "volumes.set", "registry", "upgrade"]));
    expect(bridge.connected).toBe(true); // the mod accepted a hello listing the MCP's features (prompt.close)
    bridge.close();
    // The mod speaks only protocol 3 (N−1 support is the MCP's: it speaks 3 and 2, unit-tested against a protocol-2 fake host).
    const p = await readPairing(SERVER_DIR);
    const s = connect(p.port, p.host);
    await new Promise<void>((ok, fail) => (s.once("connect", () => ok()), s.once("error", fail)));
    const reader = new FrameReader();
    const reply = new Promise<ReturnType<typeof decodeMessage>>((ok) => s.on("data", (d) => { const f = reader.push(d)[0]; if (f) ok(decodeMessage(f, "mod")); }));
    s.write(encodeMessage({ type: "hello", protocol: 2, token: p.token, client: { name: "old", version: "0" }, volatile: {} }));
    const m = await reply;
    s.destroy();
    expect(m).toMatchObject({ type: "error", code: "protocol_mismatch", protocol: 3 });
  }, 60_000);
});
