/**
 * Sheet determinism (docs/design/10-testing.md, tier 2; docs/design/03-palette.md): the same
 * instance, loaded twice from scratch, gives the same cell map, and that map matches its golden.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { columnLabel, layoutSheet, SheetRenderer, type Cell, type SheetLayout } from "../../src/palette/sheet.js";
import { expectJsonGolden, expectPngGolden } from "./harness.js";
import { loadSynthetic, type Synthetic } from "./instance.js";

let a: Synthetic, b: Synthetic;
beforeAll(async () => {
  [a, b] = await Promise.all([loadSynthetic(), loadSynthetic()]);
});
afterAll(async () => {
  await a?.dispose();
  await b?.dispose();
});

const SPECS = ["overview", "all", "category:stone", "category:colored", "family:minecraft:stone_bricks", "series:minecraft:*_wool", "filter:marble"];

const cellName = (c: Cell) => (c.kind === "variant" ? `variant ${c.block}` : `${c.kind} ${c.id}${c.kind === "family" && c.similar ? ` +${c.similar.join(",")}` : ""}`);

/** Cell id → content, e.g. { "A1": "family minecraft:stone_bricks" }. */
function cellMap(l: SheetLayout): Record<string, string> {
  const out: Record<string, string> = {};
  l.cells.forEach((row, r) => row.forEach((c, col) => c && (out[`${columnLabel(col)}${l.rowOffset + r}`] = cellName(c))));
  return out;
}

describe("sheet determinism", () => {
  for (const sheet of SPECS) {
    it(`${sheet}: same input, same cell map`, async () => {
      const la = layoutSheet(a.palette, { sheet });
      const lb = layoutSheet(b.palette, { sheet });
      expect(lb).toEqual(la);
      expect(layoutSheet(a.palette, { sheet })).toEqual(la);
      await expectJsonGolden(`sheets/${sheet.replace(/[:*]/g, "_")}`, { columns: la.columns, rows: la.rows, pages: la.pages, bands: la.bands, cells: cellMap(la) });
    });
  }

  it("renders the overview identically and matches its golden", async () => {
    const ra = await new SheetRenderer(a.palette, a.stack).render({ sheet: "overview" });
    const rb = await new SheetRenderer(b.palette, b.stack).render({ sheet: "overview" });
    expect(rb.png.equals(ra.png)).toBe(true);
    expect(rb.caption).toBe(ra.caption);
    await expectPngGolden("sheets/overview", ra.png);
    await expectPngGolden("sheets/all", (await new SheetRenderer(a.palette, a.stack).render({ sheet: "all" })).png);
  });
});
