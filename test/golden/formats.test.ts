/**
 * Format round-trips (docs/design/10-testing.md, tier 2; docs/design/08-formats.md).
 *
 * The committed files in test/fixtures/formats/ were written by Autosketch from the original
 * `cottage` build (test/golden/builds.ts), which carries an unknown mod block, block-entity NBT
 * using every tag type, and an entity. For each format:
 *   - decoding the committed file gives the golden content (old files keep reading the same),
 *   - read → write → read is identical,
 *   - encoding the build today gives the same NBT as the committed file (writer stability).
 * `npm run golden:update` rewrites the files and goldens after an intentional format change.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import nbt from "prismarine-nbt";
import { PNG } from "pngjs";
import { describe, expect, it } from "vitest";
import { decodeBlueprint, encodeBlueprint, splitBlueprint } from "../../src/formats/axiom.js";
import { readNbt } from "../../src/formats/nbt.js";
import { snapshotOf, type Snapshot } from "../../src/formats/snapshot.js";
import { decodeSponge, encodeSponge, type DecodeOptions } from "../../src/formats/sponge.js";
import { decodeStructure, encodeStructure } from "../../src/formats/structure.js";
import { fakeRegistry } from "../helpers/registry.js";
import { cottage, STATES } from "./builds.js";
import { expectJsonGolden, golden, UPDATE } from "./harness.js";

const FIXTURES = join(fileURLToPath(new URL(".", import.meta.url)), "..", "fixtures", "formats");
/** Fixed so the files are reproducible. */
const DATE = Date.UTC(2026, 0, 1);
const THUMB = (() => {
  const p = new PNG({ width: 4, height: 4 });
  p.data.fill(200);
  return PNG.sync.write(p);
})();

interface Format {
  file: string;
  encode: (s: Snapshot) => Buffer;
  decode: (b: Buffer, o?: DecodeOptions) => { snapshot: Snapshot; warnings: string[] };
  /** The parts that must match between today's writer and the committed file. */
  trees: (b: Buffer) => unknown;
  /** .bp leaves block entities and entities out (08: unverified layout, warn and point to .schem). */
  dropsNbt?: boolean;
}

const nbtTree = (b: Buffer) => readNbt(b);
const FORMATS: Format[] = [
  { file: "cottage.v3.schem", encode: (s) => encodeSponge(s, { version: 3, date: DATE }), decode: decodeSponge, trees: nbtTree },
  { file: "cottage.v2.schem", encode: (s) => encodeSponge(s, { version: 2, date: DATE }), decode: decodeSponge, trees: nbtTree },
  { file: "cottage.nbt", encode: (s) => encodeStructure(s), decode: decodeStructure, trees: nbtTree },
  {
    file: "cottage.bp",
    encode: (s) => encodeBlueprint(s, { thumbnail: THUMB, author: "autosketch-golden", tags: ["golden"] }),
    decode: decodeBlueprint,
    trees: (b) => {
      const p = splitBlueprint(b);
      return { header: nbt.parseUncompressed(p.header), data: readNbt(p.data), thumbnail: p.thumbnail.toString("base64") };
    },
    dropsNbt: true,
  },
];

/** Everything observable in a snapshot, independent of palette order. */
function content(s: Snapshot) {
  const blocks: string[] = [];
  const [w, h, l] = s.size;
  for (let y = 0; y < h; y++)
    for (let z = 0; z < l; z++)
      for (let x = 0; x < w; x++) {
        const p = s.blocks[x + z * w + y * w * l]!;
        if (p) blocks.push(`${x},${y},${z} ${s.palette[p]}`);
      }
  const byPos = (a: { pos: number[] }, b: { pos: number[] }) => a.pos.join(",").localeCompare(b.pos.join(","));
  return {
    size: s.size,
    dataVersion: s.dataVersion,
    palette: [...new Set(s.palette.slice(1))].sort(),
    blocks,
    blockEntities: [...s.blockEntities].sort(byPos).map((b) => ({ pos: b.pos, nbt: b.nbt })),
    entities: [...s.entities].sort(byPos).map((e) => ({ pos: e.pos, nbt: e.nbt })),
  };
}

const source = () => snapshotOf(cottage({ nbt: true }));

describe("format round-trips", () => {
  for (const f of FORMATS) {
    describe(f.file, () => {
      const path = join(FIXTURES, f.file);
      /** The committed file; in update mode, writes it and returns undefined. */
      const committed = () => golden(path, f.encode(source()));

      it("decodes the committed file to the golden content", async () => {
        const buf = await committed();
        if (UPDATE) await expectJsonGolden(`formats/${f.file}`, content(f.decode(f.encode(source())).snapshot));
        if (!buf) return;
        const dec = f.decode(buf);
        await expectJsonGolden(`formats/${f.file}`, content(dec.snapshot));
        // Same blocks as the build itself; NBT too unless the format leaves it out.
        const want = content(source());
        const got = content(dec.snapshot);
        expect(got.blocks).toEqual(want.blocks);
        expect(got.blocks.join("\n")).toContain(STATES.gizmo);
        if (f.dropsNbt) expect([got.blockEntities, got.entities]).toEqual([[], []]);
        else expect([got.blockEntities, got.entities]).toEqual([want.blockEntities, want.entities]);
      });

      it.skipIf(UPDATE)("read → write → read is identical", async () => {
        const first = f.decode(await readFixture(f.file)).snapshot;
        const second = f.decode(f.encode(first)).snapshot;
        expect(content(second)).toEqual(content(first));
      });

      it.skipIf(UPDATE)("today's writer produces the committed file", async () => {
        expect(f.trees(f.encode(source()))).toEqual(f.trees(await readFixture(f.file)));
      });
    });
  }

  it.skipIf(UPDATE)("keeps unknown blocks verbatim when a registry is given", async () => {
    const registry = fakeRegistry([{ id: "minecraft:stone" }]);
    const dec = decodeSponge(await readFixture("cottage.v3.schem"), { registry });
    expect(dec.warnings).toContain("unknown block othermod:gizmo (kept)");
    expect(dec.snapshot.palette).toContain(STATES.gizmo);
  });

  it.skipIf(UPDATE)("a one-block change breaks the comparison", async () => {
    const file = await readFixture("cottage.v3.schem");
    const golden = content(decodeSponge(file).snapshot);
    // Reader side: one block of the decoded file changes.
    const dec = decodeSponge(file).snapshot;
    const i = dec.blocks.findIndex((p) => p !== 0);
    dec.blocks[i] = dec.blocks[i] === 1 ? 2 : 1;
    expect(content(dec)).not.toEqual(golden);
    // Writer side: one block of the build changes.
    const doc = cottage({ nbt: true });
    doc.edit("test", "one block", (tx) => tx.set(4, 3, 8, STATES.lampOff));
    expect(nbtTree(encodeSponge(snapshotOf(doc), { version: 3, date: DATE }))).not.toEqual(nbtTree(file));
  });
});

const readFixture = (file: string) => readFile(join(FIXTURES, file));
