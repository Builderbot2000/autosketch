import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { BufferByteSource, FileByteSource } from "../../../src/assets/bytes.js";
import { ZipArchive } from "../../../src/assets/zip.js";
import { makeZip, tempDir, writeTree } from "../../helpers/fixtures.js";

const files = {
  "assets/test/blockstates/a.json": { variants: { "": { model: "test:block/a" } } },
  "assets/test/textures/block/a.png": new Uint8Array([137, 80, 78, 71, 1, 2, 3]),
  "com/example/Foo.class": "binary",
  "big.txt": "x".repeat(100_000),
};

describe("ZipArchive", () => {
  for (const store of [false, true]) {
    it(`reads ${store ? "stored" : "deflated"} entries`, async () => {
      const z = await ZipArchive.open(new BufferByteSource(Buffer.from(makeZip(files, { store }))), "t");
      expect(z.entries.size).toBe(4);
      expect(JSON.parse((await z.read("assets/test/blockstates/a.json")).toString())).toEqual(files["assets/test/blockstates/a.json"]);
      expect([...(await z.read("assets/test/textures/block/a.png"))]).toEqual([137, 80, 78, 71, 1, 2, 3]);
      expect((await z.read("big.txt")).length).toBe(100_000);
    });
  }

  it("applies entry filters at index time", async () => {
    const z = await ZipArchive.open(new BufferByteSource(Buffer.from(makeZip(files))), "t", (n) => n.startsWith("assets/"));
    expect([...z.entries.keys()].sort()).toEqual(["assets/test/blockstates/a.json", "assets/test/textures/block/a.png"]);
    await expect(z.read("big.txt")).rejects.toThrow(/no entry/);
  });

  it("reads from files on disk", async () => {
    const dir = await tempDir();
    await writeTree(dir, { "x.jar": makeZip(files) });
    const z = await ZipArchive.open(await FileByteSource.open(join(dir, "x.jar")), "x.jar");
    expect((await z.read("com/example/Foo.class")).toString()).toBe("binary");
  });

  for (const store of [true, false]) {
    it(`opens ${store ? "stored" : "deflated"} nested jars`, async () => {
      const inner = makeZip({ "assets/inner/models/block/b.json": { parent: "block/cube_all" } });
      const outer = makeZip({ "META-INF/jarjar/inner.jar": inner, "assets/outer/x.json": "{}" }, { store });
      const z = await ZipArchive.open(new BufferByteSource(Buffer.from(outer)), "outer.jar");
      const n = await z.openNested("META-INF/jarjar/inner.jar");
      expect(n.label).toBe("outer.jar!/META-INF/jarjar/inner.jar");
      expect(JSON.parse((await n.read("assets/inner/models/block/b.json")).toString())).toEqual({ parent: "block/cube_all" });
    });
  }

  it("rejects non-zip data", async () => {
    await expect(ZipArchive.open(new BufferByteSource(Buffer.from("not a zip at all")), "bad")).rejects.toThrow(/not a zip/);
  });
});
