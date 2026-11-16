/**
 * One-off check of the upgrade path against a running server (docs/design/14, *Schematics from other
 * versions*): imports a synthetic 1.20.1 `.schem` holding `minecraft:grass` and an old-layout sign
 * through the game's data fixer, and prints the result. Not a pass/fail test.
 *
 *   npx tsx test/e2e/world/upgrade-check.ts <server dir>
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { importFile } from "../../../src/formats/index.js";
import { encodeSponge } from "../../../src/formats/sponge.js";
import { Bridge } from "../../../src/world/bridge.js";
import { bridgeUpgrader } from "../../../src/world/upgrade.js";

const serverDir = process.argv[2];
if (!serverDir) throw new Error("usage: upgrade-check.ts <server dir>");
const bridge = new Bridge({ instanceDir: serverDir, volatile: {}, reconnect: false });
const hello = await bridge.connect();
const upgrader = bridgeUpgrader(bridge);
console.log(`connected: protocol ${hello.protocol}, features ${hello.features?.join(", ")}, upgrader ${upgrader ? "yes" : "no"}`);
const str = (value: string) => ({ type: "string" as const, value });
const file = join(mkdtempSync(join(tmpdir(), "autosketch-upgrade-check-")), "old.schem");
writeFileSync(
  file,
  encodeSponge({
    name: "old",
    front: "south",
    dataVersion: 3337,
    size: [2, 1, 1],
    offset: [0, 0, 0],
    palette: ["minecraft:air", "minecraft:grass", "minecraft:oak_sign[rotation=4,waterlogged=false]"],
    blocks: Uint16Array.of(1, 2),
    blockEntities: [{ pos: [1, 0, 0], nbt: { type: "compound", value: { id: str("minecraft:sign"), Text1: str('{"text":"North"}'), Text2: str('""'), Text3: str('""'), Text4: str('""') } } }],
    entities: [],
  }),
);
const imp = await importFile(file, { name: "old", ...(upgrader ? { upgrader } : {}), dataVersion: hello.game.dataVersion });
imp.doc.voxels.forEach((x, y, z, id) => console.log(`${x},${y},${z} ${imp.doc.states.get(id)}`));
console.log("sign:", JSON.stringify(imp.doc.blockEntities.get("1,0,0")?.value.front_text));
console.log("warnings:", imp.warnings);
bridge.close();
