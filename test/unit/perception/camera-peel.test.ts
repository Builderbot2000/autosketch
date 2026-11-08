import { describe, expect, it } from "vitest";
import { getRender, raycast } from "../../../src/perception/render/cameras.js";
import { pickRect } from "../../../src/perception/render/pick.js";
import { renderDocument, type View } from "../../../src/perception/render/render.js";
import { at, COLOURS, decode, fixture, INSIDE, near, room, shaded } from "./camera-fixture.js";

describe("depth peeling (06, Cameras)", () => {
  /** The room with a green block just inside the south wall (z=8), in the middle of it. */
  const furnished = () => {
    const doc = room();
    doc.edit("t", "block", (tx) => tx.set(4, 4, 7, "test:green"));
    return doc;
  };
  const SOUTH_FACE = (c: keyof typeof COLOURS) => shaded(COLOURS[c]!, 0.8);
  const bg = (c: number[]) => c[0]! > 150 && c[2]! > c[0]! + 10;

  it("peel 1 is today's render; peel 2 shows the block just inside the wall", async () => {
    const baker = await fixture();
    const doc = furnished();
    const plain = await renderDocument(doc, baker, { views: ["front"], size: 180, style: "flat" });
    const one = await renderDocument(doc, baker, { views: ["front"], size: 180, style: "flat", peel: 1 });
    expect(one.png.equals(plain.png)).toBe(true);
    // Centre of the front elevation: the middle of block (4,4,8).
    const rec = getRender(doc, plain.id)!;
    const c = raycast(doc, rec, 90, 90)!;
    expect(c.pos).toEqual([4, 4, 8]);
    const px = (r: { png: Buffer }) => at(decode(r.png), 90, 90);
    expect(near(px(plain), SOUTH_FACE("yellow"))).toBe(true);

    const two = await renderDocument(doc, baker, { views: ["front"], size: 180, style: "flat", peel: 2 });
    expect(two.caption).toMatch(/peel 2: the 2nd surface along each ray/);
    expect(near(px(two), SOUTH_FACE("green"))).toBe(true);
    const rec2 = getRender(doc, two.id)!;
    expect(raycast(doc, rec2, 90, 90)).toMatchObject({ pos: [4, 4, 7], state: "test:green", face: "south" });
    expect(pickRect(doc, rec2, [89, 89, 90, 90], "visible").mask.positions()).toEqual([[4, 4, 7]]);
    // Beside the block, the second surface is the north wall's inside.
    const beside = raycast(doc, rec2, 90 - 40, 90)!;
    expect(beside.pos![2]).toBe(0);
    expect(near(at(decode(two.png), 90 - 40, 90), INSIDE.north)).toBe(true);

    // Third surface behind the block: the north wall; the fourth: nothing (background).
    expect(near(px(await renderDocument(doc, baker, { views: ["front"], size: 180, style: "flat", peel: 3 })), INSIDE.north)).toBe(true);
    expect(bg(px(await renderDocument(doc, baker, { views: ["front"], size: 180, style: "flat", peel: 4 })))).toBe(true);
    await expect(renderDocument(doc, baker, { peel: 0 })).rejects.toThrow(/peel must be an integer 1\.\.8/);
  });

  it("peels perspective views too", async () => {
    const baker = await fixture();
    const doc = furnished();
    const view: View = { eye: [4, 4, 14], target: [4, 4, 4] };
    const two = await renderDocument(doc, baker, { views: [view], size: 128, style: "flat", peel: 2 });
    expect(near(at(decode(two.png), 64, 64), SOUTH_FACE("green"))).toBe(true);
    expect(raycast(doc, getRender(doc, two.id)!, 64, 64)).toMatchObject({ pos: [4, 4, 7] });
  });
});
