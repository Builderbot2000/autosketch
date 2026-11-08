import { describe, expect, it } from "vitest";
import { bandOf, explodeAt, getRender, raycast, unexplode } from "../../../src/perception/render/cameras.js";
import { pickRect } from "../../../src/perception/render/pick.js";
import { renderDocument, type View } from "../../../src/perception/render/render.js";
import { at, decode, fixture, INSIDE, near, room } from "./camera-fixture.js";

describe("composite views (06, Cameras)", () => {
  it("a cubemap is one 3×2 sheet of six labelled faces from one point", async () => {
    const baker = await fixture();
    const doc = room();
    const r = await renderDocument(doc, baker, { views: [{ cubemap: [4, 4, 4] }], style: "flat" });
    expect([r.width, r.height]).toEqual([768, 512]);
    expect(r.views.map((v) => v.label)).toEqual(["cubemap north", "cubemap east", "cubemap south", "cubemap west", "cubemap up", "cubemap down"]);
    expect(r.caption).toMatch(/cubemap at \(4,4,4\): north, east, south \/ west, up, down \(90° each\)/);
    expect(r.caption).toMatch(/Perspective views carry no ticks/);
    const p = decode(r.png);
    const expected = [INSIDE.north, INSIDE.east, INSIDE.south, INSIDE.west, INSIDE.ceiling, INSIDE.floor];
    const rec = getRender(doc, r.id)!;
    const faces = ["south", "west", "north", "east", "down", "up"];
    expected.forEach((c, i) => {
      const cx = (i % 3) * 256 + 128, cy = Math.floor(i / 3) * 256 + 128;
      expect(near(at(p, cx, cy), c), `face ${i}`).toBe(true);
      expect(raycast(doc, rec, cx, cy)!.face).toBe(faces[i]);
    });
  });

  it("a turntable with 8 steps is one image within its cap, counting as one view", async () => {
    const baker = await fixture();
    const doc = room();
    const r = await renderDocument(doc, baker, { views: [{ turntable: [4, 4, 4] }], style: "flat" });
    expect([r.width, r.height]).toEqual([768, 384]);
    expect(r.views).toHaveLength(8);
    expect(r.views.map((v) => v.label)[2]).toMatch(/^yaw 90 pitch 30 dist [\d.]+$/);
    expect(r.caption).toMatch(/turntable around \(4,4,4\): 8 steps of 45° from north, pitch 30, [\d.]+ px\/block/);
    const big = await renderDocument(doc, baker, { views: [{ turntable: [4, 4, 4], steps: 12, pitch: 10 }], size: 4096 });
    expect([big.width, big.height]).toEqual([1024, 768]); // 4 per row, 3 rows, capped at 1024 wide
    // The yaw 0 view (from the north) sees the north wall's outside (blue, south... north face shade 0.8).
    const c = raycast(doc, getRender(doc, r.id)!, 96, 96)!;
    expect(c.state).toBe("test:blue");
    // Mixed with other views: still at most 4 entries, the composite fills one cell.
    const mixed = await renderDocument(doc, baker, { views: ["top", { turntable: [4, 4, 4], steps: 4 }, { cubemap: [4, 4, 4] }, "front"], size: 512 });
    expect([mixed.width, mixed.height]).toEqual([512, 512]);
    expect(mixed.views).toHaveLength(1 + 4 + 6 + 1);
    await expect(renderDocument(doc, baker, { views: [{ turntable: [4, 4, 4], steps: 13 }] })).rejects.toThrow(/steps must be an integer 2\.\.12/);
    await expect(renderDocument(doc, baker, { views: ["top", "top", "top", "top", { cubemap: [1, 1, 1] }] as View[] })).rejects.toThrow(/at most 4 views/);
  });

  it("explode splits the build into bands, draws cut faces closed and maps picks back", async () => {
    expect(bandOf({ axis: 1, at: [4, 6], gap: 3 }, 3)).toBe(0);
    expect(explodeAt({ axis: 1, at: [4, 6], gap: 3 }, 1, 6, 1)).toEqual([1, 12, 1]);
    expect(unexplode({ axis: 1, at: [4, 6], gap: 3 }, 1, 12, 1)).toEqual([1, 6, 1]);
    expect(unexplode({ axis: 1, at: [4, 6], gap: 3 }, 1, 5, 1)).toBeUndefined(); // in the first gap

    const baker = await fixture();
    const doc = room();
    const r = await renderDocument(doc, baker, { views: ["iso_se"], size: 300, style: "flat", explode: { axis: "y", at: [4] } });
    expect(r.caption).toMatch(/drew \d+ blocks in \(0,0,0\)–\(8,8,8\)/);
    expect(r.caption).toMatch(/exploded along y at 4, 4 blocks apart/);
    const rec = getRender(doc, r.id)!;
    // Scan the image: hits report real positions, and the lower band's cut top (y=3) shows up faces.
    const hits = [];
    for (let y = 0; y < 300; y += 3) for (let x = 0; x < 300; x += 3) hits.push(raycast(doc, rec, x, y)!);
    const solid = hits.filter((h) => h.pos);
    expect(solid.every((h) => h.pos!.every((c) => c >= 0 && c <= 8))).toBe(true);
    expect(solid.some((h) => h.face === "up" && h.pos![1] === 3 && h.state !== "test:grey")).toBe(true);
    expect(solid.some((h) => h.face === "down" && h.pos![1] === 4)).toBe(false); // underside of the upper band faces away from this camera
    const all = pickRect(doc, rec, [0, 0, 299, 299], "through").mask;
    expect(all.has(8, 8, 8) && all.has(0, 0, 0) && all.has(4, 4, 4)).toBe(true);
    expect(all.positions().every((p) => p.every((c) => c >= 0 && c <= 8))).toBe(true);
    // A perspective eye inside the upper band moves with it.
    const inside = await renderDocument(doc, baker, { views: [{ eye: [4, 5, 4], target: [7, 5, 4] }], size: 128, style: "flat", explode: { axis: "y", at: [4] } });
    expect(near(at(decode(inside.png), 64, 64), INSIDE.east)).toBe(true);
    expect(raycast(doc, getRender(doc, inside.id)!, 64, 64)!.pos).toEqual([8, 5, 4]);
    await expect(renderDocument(doc, baker, { explode: { axis: "y", at: [4], gap: 0 } })).rejects.toThrow(/gap must be an integer 1\.\.64/);
  });
});
