import { describe, expect, it } from "vitest";
import { Mask } from "../../../src/core/mask.js";
import { getRender, raycast } from "../../../src/perception/render/cameras.js";
import { pickRect } from "../../../src/perception/render/pick.js";
import { renderDocument, type RenderOptions, type View } from "../../../src/perception/render/render.js";
import { at, B, COLOURS, decode, fixture, INSIDE, near, room, shaded } from "./camera-fixture.js";

describe("near clip and section box (06, Cameras)", () => {
  it("a section box without one octant of a hollow cube shows the inside corner", async () => {
    const baker = await fixture();
    const doc = room();
    const section = Mask.fromBox(B([0, 0, 0], [8, 8, 8])).subtract(Mask.fromBox(B([5, 5, 5], [8, 8, 8])));
    // Looking down the cube's diagonal from the removed corner, at the cube's centre.
    const view: View = { yaw: 135, pitch: 35.26 };
    const whole = await renderDocument(doc, baker, { views: [view], size: 200, style: "flat" });
    expect(raycast(doc, getRender(doc, whole.id)!, 100, 100)!.pos).toEqual([8, 8, 8]); // the outer corner
    const r = await renderDocument(doc, baker, { views: [view], size: 200, style: "flat", section });
    expect(r.caption).toMatch(/section selection in \(0,0,0\)–\(8,8,8\)/);
    const rec = getRender(doc, r.id)!;
    // Around the image centre the camera sees the three inside faces meeting at (1,1,1).
    const faces = new Set<string>();
    for (let dy = -12; dy <= 12; dy += 4)
      for (let dx = -12; dx <= 12; dx += 4) {
        const h = raycast(doc, rec, 100 + dx, 100 + dy)!;
        faces.add(`${h.face} ${h.state} ${h.pos!.join(",")}`);
      }
    for (const f of ["up test:grey 1,0,1", "east test:red 0,1,1", "south test:blue 1,1,0"]) expect(faces).toContain(f);
    expect(near(at(decode(r.png), 100, 112), INSIDE.floor)).toBe(true);
  });

  it("draws the cut faces of a section closed", async () => {
    const baker = await fixture();
    const doc = room();
    // Keep the west half of the room and look at the cut from the east: the cut edges of floor,
    // ceiling and the north and south walls show their (east) faces, solid, not the room behind.
    const r = await renderDocument(doc, baker, { views: ["right"], size: 180, style: "flat", section: B([0, 0, 0], [4, 8, 8]) });
    const p = decode(r.png);
    const rec = getRender(doc, r.id)!;
    const mid = raycast(doc, rec, 90, 90)!; // through the open middle: the west wall's inside
    expect(mid).toMatchObject({ face: "east", state: "test:red" });
    expect(near(at(p, 90, 90), INSIDE.west)).toBe(true);
    // The floor's cut edge: grey, east face (shade 0.6), at x=4.
    const floorHit = [...Array(180).keys()].map((y) => raycast(doc, rec, 90, y)!).find((h) => h.state === "test:grey")!;
    expect(floorHit).toMatchObject({ face: "east" });
    expect(floorHit.pos![0]).toBe(4);
  });

  it("composes a section with region and cutaway", async () => {
    const baker = await fixture();
    const doc = room();
    const drew = async (opts: RenderOptions) => /drew (\d+) blocks in (\S+)/.exec((await renderDocument(doc, baker, { views: ["top"], size: 128, ...opts })).caption)!.slice(1);
    const half = B([0, 0, 0], [8, 8, 4]);
    expect(await drew({ section: half })).toEqual(await drew({ region: half }));
    expect(await drew({ section: half, region: B([0, 0, 2], [8, 8, 8]) })).toEqual(await drew({ region: B([0, 0, 2], [8, 8, 4]) }));
    expect(await drew({ section: half, cutaway: { maxY: 3 } })).toEqual(await drew({ region: B([0, 0, 0], [8, 3, 4]) }));
    expect(await drew({ section: Mask.fromBox(half), region: B([0, 0, 2], [8, 8, 8]) })).toEqual(await drew({ region: B([0, 0, 2], [8, 8, 4]) }));
  });

  it("near clip drops the front of an orthographic view, and picks follow it", async () => {
    const baker = await fixture();
    const doc = room();
    const r = await renderDocument(doc, baker, { views: ["front"], size: 200, style: "flat", near: 1 });
    expect(r.caption).toMatch(/near clip 1/);
    const rec = getRender(doc, r.id)!;
    // The south wall (z=8, the front) is gone: the middle of the image is the north wall's inside face.
    expect(raycast(doc, rec, 100, 100)).toMatchObject({ face: "south", state: "test:blue" });
    expect(raycast(doc, rec, 100, 100)!.pos![2]).toBe(0);
    expect(near(at(decode(r.png), 100, 100), INSIDE.north)).toBe(true);
    const through = pickRect(doc, rec, [90, 90, 110, 110], "through").mask.positions();
    expect(through.some((p) => p[2] === 8)).toBe(false);
    expect(through.some((p) => p[2] === 0)).toBe(true);
    // near: 2 also drops the z=7 layer (nothing there but the side walls' ends).
    const two = await renderDocument(doc, baker, { views: ["front"], size: 200, style: "flat", near: 2 });
    expect(pickRect(doc, getRender(doc, two.id)!, [0, 0, 199, 199], "through").mask.positions().some((p) => p[2] >= 7)).toBe(false);
  });

  it("near clip from a perspective eye outside the room shows its inside", async () => {
    const baker = await fixture();
    const doc = room();
    const view: View = { eye: [4, 4, 14], target: [4, 4, 4] };
    const plain = await renderDocument(doc, baker, { views: [view], size: 128, style: "flat" });
    expect(near(at(decode(plain.png), 64, 64), shaded(COLOURS.yellow!, 0.8))).toBe(true); // the south wall's outside
    const r = await renderDocument(doc, baker, { views: [view], size: 128, style: "flat", near: 7 });
    expect(near(at(decode(r.png), 64, 64), INSIDE.north)).toBe(true);
    const rec = getRender(doc, r.id)!;
    expect(raycast(doc, rec, 64, 64)).toMatchObject({ pos: [4, 4, 0], face: "south" });
    expect(pickRect(doc, rec, [62, 62, 65, 65], "visible").mask.positions()).toEqual([[4, 4, 0]]);
  });
});
