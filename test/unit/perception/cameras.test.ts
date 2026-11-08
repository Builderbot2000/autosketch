import { describe, expect, it } from "vitest";
import { Mask } from "../../../src/core/mask.js";
import type { Vec3 } from "../../../src/core/region.js";
import { getCamera, listCameras, lookTarget, removeCamera, saveCamera } from "../../../src/document/cameras.js";
import { Document } from "../../../src/document/document.js";
import { decodeNative, encodeNative } from "../../../src/document/native.js";
import { fill } from "../../../src/ops/edit.js";
import { getRender, raycast } from "../../../src/perception/render/cameras.js";
import { pickRect } from "../../../src/perception/render/pick.js";
import { renderDocument, type View } from "../../../src/perception/render/render.js";
import { ScopeManager } from "../../../src/scope/scopes.js";
import { at, B, COLOURS, decode, fixture, INSIDE, near, room, shaded, type RGB } from "./camera-fixture.js";


describe("perspective camera (06, Cameras)", () => {
  it("shows a closed room's inside walls from an eye inside it", async () => {
    const baker = await fixture();
    const doc = room();
    const look = async (target: Vec3) => decode((await renderDocument(doc, baker, { views: [{ eye: [4, 4, 4], target }], size: 128, style: "flat" })).png);
    expect(near(at(await look([7, 4, 4]), 64, 64), INSIDE.east)).toBe(true);
    expect(near(at(await look([1, 4, 4]), 64, 64), INSIDE.west)).toBe(true);
    expect(near(at(await look([4, 4, 1]), 64, 64), INSIDE.north)).toBe(true);
    expect(near(at(await look([4, 4, 7]), 64, 64), INSIDE.south)).toBe(true);
    expect(near(at(await look([4, 1, 4.01]), 64, 64), INSIDE.floor)).toBe(true);
    expect(near(at(await look([4, 7, 4.01]), 64, 64), INSIDE.ceiling)).toBe(true);
    // Looking east with a 120° fov: the left edge of the image sees the north wall, the right the south wall.
    const east = decode((await renderDocument(doc, baker, { views: [{ eye: [4, 4, 4], target: [7, 4, 4], fov: 120 }], size: 128, style: "flat" })).png);
    expect(near(at(east, 2, 64), INSIDE.north)).toBe(true);
    expect(near(at(east, 125, 64), INSIDE.south)).toBe(true);
    expect(near(at(east, 64, 20), INSIDE.ceiling)).toBe(true); // below the view label
    expect(near(at(east, 64, 125), INSIDE.floor)).toBe(true);
  });

  it("draws no artifacts with the eye a block from a wall, or right against it", async () => {
    const baker = await fixture();
    const doc = room();
    const bg = (c: RGB) => c[0] > 150 && c[2] > c[0] + 10; // the pale sky-blue background gradient
    // Block units: [1,4,4] is half a block from the west wall's face, [0.6,4,4] a tenth of a block.
    for (const eye of [[2, 4, 4], [1, 4, 4], [0.6, 4, 4]] as Vec3[]) {
      // Facing the west wall: the whole image is that wall, nothing inverted or smeared.
      const facing = decode((await renderDocument(doc, baker, { views: [{ eye, target: [0, 4, 4] }], size: 96, style: "flat" })).png);
      for (let y = 16; y < 96; y += 5) for (let x = 0; x < 96; x += 5) expect(near(at(facing, x, y), INSIDE.west, 8), `${eye} facing (${x},${y})`).toBe(true);
      // Looking along the wall, wide enough that floor, ceiling and wall quads cross the near plane:
      // the closed room shows no background anywhere.
      const along = decode((await renderDocument(doc, baker, { views: [{ eye, target: [eye[0], 4, 0], fov: 120 }], size: 96, style: "flat" })).png);
      for (let y = 0; y < 96; y++) for (let x = 0; x < 96; x++) expect(bg(at(along, x, y)), `${eye} along (${x},${y})`).toBe(false);
      // The wall to the left fills the left edge.
      expect(near(at(along, 1, 48), INSIDE.west, 8)).toBe(true);
    }
  });

  it("culls faces from the eye: a block seen from inside the room shows its near faces", async () => {
    const baker = await fixture();
    const doc = room();
    doc.edit("t", "pillar", (tx) => tx.set(4, 1, 2, "test:red"));
    // From the south of the pillar, looking north at it: its south face (red × 0.8) is in the middle.
    const p = decode((await renderDocument(doc, baker, { views: [{ eye: [4, 1, 5], target: [4, 1, 2] }], size: 96, style: "flat" })).png);
    expect(near(at(p, 48, 48), shaded(COLOURS.red!, 0.8))).toBe(true);
  });

  it("captions eye, target and fov, mixes with orthographic views and frames a selection", async () => {
    const baker = await fixture();
    const doc = room();
    const r = await renderDocument(doc, baker, { views: ["iso_se", { eye: [4, 4, 4], target: [7, 4, 4] }], size: 256 });
    expect(r.caption).toMatch(/iso_se \d+\.\d px\/block · perspective: eye \(4,4,4\) target \(7,4,4\) fov 70°/);
    expect(r.caption).toMatch(/Ticks label block coordinates/);
    const p = await renderDocument(doc, baker, { views: [{ eye: [4, 4, 4.5], target: [7, 4, 4], fov: 90 }], size: 128 });
    expect(p.caption).toMatch(/eye \(4,4,4\.5\) target \(7,4,4\) fov 90°/);
    expect(p.caption).toMatch(/Perspective views carry no ticks/);
    // A small far box, framed: the fov narrows below the default.
    const framed = await renderDocument(doc, baker, { views: [{ eye: [30, 4, 4], target: [8, 4, 4], frame: B([8, 3, 3], [8, 5, 5]) }], size: 128 });
    const fov = Number(/fov ([\d.]+)°/.exec(framed.caption)![1]);
    expect(fov).toBeLessThan(15);
    expect(fov).toBeGreaterThan(5);
  });

  it("raycasts a perspective pixel to the block and face it shows", async () => {
    const baker = await fixture();
    const doc = room();
    const r = await renderDocument(doc, baker, { views: [{ eye: [4, 4, 4], target: [7, 4, 4], fov: 120 }], size: 128, style: "flat" });
    const rec = getRender(doc, r.id)!;
    expect(raycast(doc, rec, 64, 64)).toMatchObject({ pos: [8, 4, 4], face: "west", state: "test:green" });
    // Left edge: the north wall, hit on its south face.
    const left = raycast(doc, rec, 1, 64)!;
    expect(left.pos![2]).toBe(0);
    expect(left.face).toBe("south");
    // Bottom middle: the floor's top face.
    const down = raycast(doc, rec, 64, 127)!;
    expect(down.pos![1]).toBe(0);
    expect(down.face).toBe("up");
  });

  it("picks view_box selections on a perspective render, visible and through", async () => {
    const baker = await fixture();
    const doc = room();
    const r = await renderDocument(doc, baker, { views: [{ eye: [4, 4, 4], target: [7, 4, 4] }], size: 128 });
    const rec = getRender(doc, r.id)!;
    // A small rectangle around the centre: on the east wall, 4 blocks away, a block is ~16 px wide.
    const vis = pickRect(doc, rec, [60, 60, 67, 67], "visible");
    expect(vis.mask.positions()).toEqual([[8, 4, 4]]);
    const through = pickRect(doc, rec, [60, 60, 67, 67], "through");
    const got = through.mask.positions().map((p) => p.join(","));
    for (const p of ["5,4,4", "6,4,4", "7,4,4", "8,4,4"]) expect(got).toContain(p);
    // Nothing behind or beside the eye.
    expect(got.filter((p) => Number(p.split(",")[0]) <= 4)).toEqual([]);
  });
});

describe("saved cameras", () => {
  it("survive save and reopen, and render the same as the inline camera", async () => {
    const baker = await fixture();
    const doc = room();
    saveCamera(doc, "x", { eye: [4, 4, 4], target: [7, 3.5, 5] });
    expect(getCamera(doc, "x")).toEqual({ eye: [4, 4, 4], target: [7, 3.5, 5], fov: 70 });
    const back = decodeNative(encodeNative(doc));
    expect(listCameras(back)).toEqual([["x", { eye: [4, 4, 4], target: [7, 3.5, 5], fov: 70 }]]);
    const saved = await renderDocument(back, baker, { views: [{ camera: "x" }], size: 128 });
    const inline = await renderDocument(back, baker, { views: [{ eye: [4, 4, 4], target: [7, 3.5, 5], label: "camera x" }], size: 128 });
    expect(saved.png.equals(inline.png)).toBe(true);
    expect(saved.caption).toMatch(/camera x: eye \(4,4,4\) target \(7,3\.5,5\) fov 70°/);
    await expect(renderDocument(back, baker, { views: [{ camera: "nope" } as View] })).rejects.toThrow(/no saved camera "nope" \(have: x\)/);
    expect(removeCamera(back, "x")).toBe(true);
    expect(removeCamera(back, "x")).toBe(false);
    expect(() => saveCamera(doc, "1bad", { eye: [0, 0, 0], target: [1, 0, 0] })).toThrow(/camera name/);
    expect(() => saveCamera(doc, "same", { eye: [1, 1, 1], target: [1, 1, 1] })).toThrow(/differ/);
  });

  it("move with the document on a re-origin", () => {
    const doc = room();
    saveCamera(doc, "x", { eye: [4, 4, 4], target: [7, 4, 4], fov: 60 });
    doc.origin = [2, 0, -1]; // local coordinates shift by minus this, as they do for blocks
    expect(getCamera(doc, "x")).toEqual({ eye: [2, 4, 5], target: [5, 4, 5], fov: 60 });
    expect(doc.getState(6, 4, 5)).toBe("test:green"); // the wall the camera looks at moved the same way
  });

  it("save a player's view from yaw and pitch (Minecraft conventions)", () => {
    const t = lookTarget([0, 0, 0], 0, 0); // yaw 0 faces south (+Z)
    expect(t.map((v) => Math.round(v))).toEqual([0, 0, 16]);
    expect(lookTarget([0, 0, 0], 90, 0).map((v) => Math.round(v))).toEqual([-16, 0, 0]); // 90 faces west
    expect(lookTarget([0, 0, 0], 0, 90).map((v) => Math.round(v))).toEqual([0, -16, 0]); // positive pitch looks down
  });

  it("come along into a fork when their eye lies in its volumes, translated into its frame", () => {
    const doc = Document.create({ name: "base", dataVersion: 3955, seed: 1, size: [32, 16, 32] });
    fill(doc, {}, B([0, 0, 0], [31, 0, 31]), "test:grey");
    const scopes = new ScopeManager(() => doc);
    scopes.attach(doc);
    saveCamera(doc, "inside", { eye: [12, 3, 12], target: [15, 3, 15] });
    saveCamera(doc, "context", { eye: [8.25, 2, 12], target: [12, 2, 12], fov: 50 }); // in the default 3-block context
    saveCamera(doc, "far", { eye: [28, 3, 28], target: [12, 3, 12] });
    const sb = scopes.fork("base", { work: Mask.fromBox(B([10, 1, 10], [17, 8, 17])), brief: "job", env: {} }).scope.doc;
    expect(listCameras(sb)).toEqual([
      ["context", { eye: [-1.75, 1, 2], target: [2, 1, 2], fov: 50 }],
      ["inside", { eye: [2, 2, 2], target: [5, 2, 5], fov: 70 }],
    ]);
    expect(listCameras(doc)).toHaveLength(3);
  });
});

