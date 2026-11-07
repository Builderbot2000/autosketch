/**
 * Render snapshots (docs/design/10-testing.md, tier 2): fixture builds rendered with the
 * synthetic instance, compared to committed PNGs within a perceptual tolerance.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { canonicalState } from "../../src/core/blockstate.js";
import type { Document } from "../../src/document/document.js";
import { renderDocument, type RenderOptions } from "../../src/perception/render/render.js";
import { cottage, sampler, STATES } from "./builds.js";
import { diffImages, expectPngGolden, GOLDEN_DIR, imagesMatch, UPDATE } from "./harness.js";
import { loadSynthetic, type Synthetic } from "./instance.js";

let syn: Synthetic;
beforeAll(async () => {
  syn = await loadSynthetic();
});
afterAll(() => syn?.dispose());

const CASES: [string, () => Document, RenderOptions][] = [
  ["cottage-views", () => cottage(), { views: ["iso_se", "iso_nw", "front", "top"], size: 384 }],
  ["cottage-cutaway", () => cottage(), { views: ["iso_se"], size: 256, cutaway: { maxY: 2 } }],
  ["cottage-flat", () => cottage(), { views: ["iso_ne"], size: 256, style: "flat" }],
  ["cottage-thumbnail", () => cottage(), { views: ["iso_se"], size: 96, thumbnail: true }],
  ["sampler-iso", () => sampler(), { views: ["iso_se"], size: 384 }],
  ["sampler-top", () => sampler(), { views: ["top"], size: 256 }],
];

describe("render snapshots", () => {
  it("fixture builds use canonical states for the synthetic instance", () => {
    for (const build of [cottage(), sampler()])
      for (const s of build.states.all()) {
        if (s === "minecraft:air" || s === STATES.gizmo) continue;
        const c = canonicalState(s, syn.registry);
        expect(c.unknown, s).toBeUndefined();
        expect(c.state).toBe(s);
      }
  });

  for (const [name, build, opts] of CASES) {
    it(`${name} matches its golden`, async () => {
      const r = await renderDocument(build(), syn.baker, opts);
      await expectPngGolden(`render/${name}`, r.png);
    });
  }

  it("is deterministic and reports the unknown block", async () => {
    const a = await renderDocument(cottage(), syn.baker, { views: ["iso_se"], size: 192 });
    const b = await renderDocument(cottage(), syn.baker, { views: ["iso_se"], size: 192 });
    expect(a.png.equals(b.png)).toBe(true);
    expect(a.caption).toMatch(/no model for othermod:gizmo/);
  });

  it.skipIf(UPDATE)("fails when one visible block changes", async () => {
    const opts = CASES[0]![2];
    const base = await renderDocument(cottage(), syn.baker, opts);
    const changed = cottage();
    changed.edit("test", "one block", (tx) => tx.set(4, 3, 8, STATES.crate)); // lit lamp → crate
    const r = await renderDocument(changed, syn.baker, opts);
    expect(imagesMatch(diffImages(base.png, base.png))).toBe(true);
    expect(imagesMatch(diffImages(r.png, base.png))).toBe(false);
    expect(imagesMatch(diffImages(r.png, await readFile(join(GOLDEN_DIR, "render/cottage-views.png"))))).toBe(false);
  });
});
