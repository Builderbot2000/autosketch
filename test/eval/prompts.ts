import type { PublicBox, Vec3 } from "../../src/core/region.js";
import type { CheckSpec } from "./checks.js";
import type { SeedName } from "./seeds.js";

/**
 * The benchmark set (docs/design/10-testing.md, tier 3): 20 prompts from simple to
 * architectural. Small and medium prompts form the main suite, which runs once per ablation.
 * Large prompts are multi-part builds for the scoped-session comparison (10, 11), run
 * monolithically and with delegation allowed; their `consistency` check measures whether the
 * parts match.
 *
 * Every prompt names its document, so the runner knows what to score. Coordinates are
 * document-local; checks allow a little slack around the stated sizes. Checks only test what the
 * prompt asks for, so a run is never failed on a style choice the prompt left open.
 */

export type PromptSize = "small" | "medium" | "large";

export interface EvalPrompt {
  id: string;
  size: PromptSize;
  text: string;
  /** Document the build ends up in (created by the agent, or the seed it opens). */
  doc: string;
  /** Seed document written to the workspace under `doc` before the run. */
  seed?: SeedName;
  checks: CheckSpec[];
  /** Part of the reduced three-prompt suite (`--suite reduced`). */
  reduced?: boolean;
  /** Short style description for the model-graded rubric. */
  style: string;
}

const box = (min: Vec3, max: Vec3): PublicBox => ({ min, max });
const NEW = (name: string) => `Create a new document named "${name}" (front facing south) and build in it. `;
const OPEN = (name: string) => `Open the existing document "${name}" with doc_open. `;

export const PROMPTS: EvalPrompt[] = [
  // ---- small ----------------------------------------------------------------------------------
  {
    id: "s-hut",
    size: "small",
    reduced: true,
    doc: "hut",
    text: NEW("hut") + "Build a 5×5 oak plank hut, 4 blocks tall, standing on the ground at y=0 with its corner at (0,0,0), a door in the middle of the south wall, a window on each other side, and a flat roof.",
    style: "simple oak hut, flat roof",
    checks: [
      { kind: "minBlocks", n: 60 },
      { kind: "withinBox", box: box([-2, 0, -2], [6, 7, 6]) },
      { kind: "door", side: "south" },
      { kind: "roofWatertight" },
      { kind: "noFloating" },
      { kind: "material", where: "walls", ids: ["oak"], minShare: 0.6 },
    ],
  },
  {
    id: "s-wall",
    size: "small",
    doc: "wall",
    text: NEW("wall") + "Build a straight stone brick wall from (0,0,0) to (19,0,0): 20 long, 1 thick, 4 high, with crenellations on top.",
    style: "plain castle wall",
    checks: [
      { kind: "minBlocks", n: 70 },
      { kind: "withinBox", box: box([0, 0, -1], [19, 6, 1]) },
      { kind: "material", where: "all", ids: ["stone_brick"], minShare: 0.8 },
      { kind: "noFloating" },
    ],
  },
  {
    id: "s-well",
    size: "small",
    doc: "well",
    text: NEW("well") + "Build a village well: a 5×5 cobblestone ring 1 block high around a 3×3 water pool, four oak fence posts at the corners holding up a small oak slab roof 3 blocks above the ring. Footprint corner at (0,0,0).",
    style: "rustic village well",
    checks: [
      { kind: "minBlocks", n: 25 },
      { kind: "withinBox", box: box([-1, 0, -1], [5, 6, 5]) },
      { kind: "noFloating" },
      { kind: "material", where: "all", ids: ["cobblestone", "oak", "water"], minShare: 0.8 },
    ],
  },
  {
    id: "s-watchtower",
    size: "small",
    doc: "watchtower",
    text: NEW("watchtower") + "Build a round cobblestone watchtower centred on (0,0,0): radius 3, 12 blocks tall, hollow, with a ladder up the inside, a door on the south side and a floor at the top.",
    style: "round medieval watchtower",
    checks: [
      { kind: "minBlocks", n: 150 },
      { kind: "withinBox", box: box([-4, 0, -4], [4, 15, 4]) },
      { kind: "door", side: "south" },
      { kind: "noFloating" },
      { kind: "material", where: "walls", ids: ["cobblestone"], minShare: 0.6 },
    ],
  },
  {
    id: "s-bridge",
    size: "small",
    doc: "bridge",
    text: NEW("bridge") + "Build a 12-long, 3-wide spruce footbridge along x from (0,0,0) to (11,0,2), deck at y=0, with spruce fence railings on both long sides.",
    style: "wooden footbridge",
    checks: [
      { kind: "minBlocks", n: 50 },
      { kind: "withinBox", box: box([-1, 0, -1], [12, 3, 3]) },
      { kind: "material", where: "all", ids: ["spruce"], minShare: 0.8 },
    ],
  },
  {
    id: "s-fountain",
    size: "small",
    doc: "fountain",
    text: NEW("fountain") + "Build a 7×7 stone brick fountain basin (rim 1 high) with corner at (0,0,0), filled with water, and a 3-high central column topped by a lantern.",
    style: "town square fountain",
    checks: [
      { kind: "minBlocks", n: 30 },
      { kind: "withinBox", box: box([-1, 0, -1], [7, 6, 7]) },
      { kind: "noFloating" },
    ],
  },
  // ---- medium ---------------------------------------------------------------------------------
  {
    id: "m-cottage",
    size: "medium",
    reduced: true,
    doc: "cottage",
    text: NEW("cottage") + "Build a one-storey cottage with a 9×7 footprint (x 0..8, z 0..6): cobblestone floor at y=0, oak plank walls, a front door facing south, windows on all four sides, and a gable roof of oak stairs with the ridge running east–west.",
    style: "cosy cottage, gable roof",
    checks: [
      { kind: "storeys", min: 1 },
      { kind: "door", side: "south" },
      { kind: "windows", min: 4 },
      { kind: "roofType", types: ["gable"] },
      { kind: "roofWatertight" },
      { kind: "noFloating" },
      { kind: "withinBox", box: box([-2, 0, -2], [10, 14, 8]) },
    ],
  },
  {
    id: "m-tudor",
    size: "medium",
    doc: "tudor",
    text: NEW("tudor") + "Build a 2-storey Tudor house with a jettied upper floor (the upper storey overhangs the ground floor by one block on the front), a timber frame of dark oak logs over white plaster infill, a front door facing south, and a steep gable roof. Ground floor footprint about 9×7 with corner at (0,0,0).",
    style: "Tudor house, timber frame, jetty",
    checks: [
      { kind: "storeys", min: 2 },
      { kind: "door", side: "south" },
      { kind: "roofWatertight" },
      { kind: "noFloating" },
      { kind: "material", where: "walls", ids: ["dark_oak", "white", "calcite", "quartz", "birch"], minShare: 0.5 },
      { kind: "withinBox", box: box([-3, 0, -3], [12, 22, 11]) },
    ],
  },
  {
    id: "m-stone-house",
    size: "medium",
    doc: "stone_house",
    text: NEW("stone_house") + "Build a 2-storey stone brick house, 11×9 footprint with corner at (0,0,0), an oak floor between the storeys, windows on every side of both storeys, a front door facing south, and a hip roof of dark oak stairs.",
    style: "stone house, hip roof",
    checks: [
      { kind: "storeys", min: 2 },
      { kind: "door", side: "south" },
      { kind: "windows", min: 6 },
      { kind: "roofType", types: ["hip", "pyramid"] },
      { kind: "roofWatertight" },
      { kind: "material", where: "walls", ids: ["stone_brick"], minShare: 0.6 },
      { kind: "material", where: "roof", ids: ["dark_oak"], minShare: 0.6 },
      { kind: "noFloating" },
    ],
  },
  {
    id: "m-keep",
    size: "medium",
    doc: "keep",
    text: NEW("keep") + "Build a three-storey square keep, 9×9 with corner at (0,0,0), stone bricks, a floor every 5 blocks, arrow-slit windows on each storey, a door on the south side, and a flat roof with battlements.",
    style: "castle keep, battlements",
    checks: [
      { kind: "storeys", min: 3 },
      { kind: "door", side: "south" },
      { kind: "roofType", types: ["flat"] },
      { kind: "noFloating" },
      { kind: "material", where: "walls", ids: ["stone_brick"], minShare: 0.6 },
      { kind: "withinBox", box: box([-1, 0, -1], [9, 22, 9]) },
    ],
  },
  {
    id: "m-chapel",
    size: "medium",
    doc: "chapel",
    text: NEW("chapel") + "Build a small chapel, 7 wide (x) and 13 long (z), corner at (0,0,0): stone walls 6 high, tall arched windows along both long sides, a door in the south gable end, and a steep gable roof with the ridge running north–south.",
    style: "small stone chapel",
    checks: [
      { kind: "storeys", min: 1, max: 2 },
      { kind: "door", side: "south" },
      { kind: "windows", min: 4 },
      { kind: "roofType", types: ["gable"] },
      { kind: "roofWatertight" },
      { kind: "noFloating" },
    ],
  },
  {
    id: "m-barn",
    size: "medium",
    doc: "barn",
    text: NEW("barn") + "Build a red barn 11 wide and 15 long (corner at (0,0,0)): spruce frame, red-stained walls (e.g. red terracotta or red wool), large double doors in the east wall, and a gambrel roof.",
    style: "red farm barn, gambrel roof",
    checks: [
      { kind: "door", side: "east" },
      { kind: "roofWatertight" },
      { kind: "noFloating" },
      { kind: "material", where: "walls", ids: ["red", "spruce"], minShare: 0.6 },
    ],
  },
  {
    id: "m-palette",
    size: "medium",
    doc: "palette_house",
    text:
      NEW("palette_house") +
      'First save a palette named "house" with roles wall (andesite), trim (spruce logs or planks) and roof (spruce), using the palette tools. Then build a one-storey 9×9 house with corner at (0,0,0) using only "palette:house.<role>" materials: wall role for the walls, trim for corners, roof role for a gable roof. Door facing south.',
    style: "andesite and spruce house",
    checks: [
      { kind: "door", side: "south" },
      { kind: "material", where: "walls", ids: ["andesite", "spruce"], minShare: 0.7 },
      { kind: "material", where: "roof", ids: ["spruce"], minShare: 0.6 },
      { kind: "roofWatertight" },
    ],
  },
  {
    id: "m-porch",
    size: "medium",
    reduced: true,
    doc: "porch",
    seed: "cottage",
    text: OPEN("porch") + "It holds a small gable-roofed house (x 0..8, z 0..6) with its door on the south side. Add a covered porch in front of the door: a 5-wide, 3-deep oak deck with fence posts and a slab roof. Do not change the house itself.",
    style: "cottage with front porch",
    checks: [
      { kind: "preserved", box: box([0, 0, 0], [8, 4, 6]), minShare: 0.95 },
      { kind: "minBlocks", n: 320 },
      { kind: "door", side: "south" },
      { kind: "withinBox", box: box([-2, 0, -2], [10, 12, 11]) },
      { kind: "noFloating" },
    ],
  },
  {
    id: "m-gatehouse",
    size: "medium",
    doc: "gatehouse",
    seed: "curtainWall",
    text: OPEN("gatehouse") + "It holds a stone brick curtain wall along x (x 0..30, z 0..1, 6 high). Extend it with a gatehouse in the middle (around x=15): two small towers flanking an arched gate passage through the wall, taller than the wall. Keep the rest of the wall as it is.",
    style: "castle gatehouse in a curtain wall",
    checks: [
      { kind: "preserved", box: box([0, 0, 0], [8, 5, 1]), minShare: 0.95 },
      { kind: "preserved", box: box([22, 0, 0], [30, 5, 1]), minShare: 0.95 },
      { kind: "minBlocks", n: 500 },
      { kind: "material", where: "all", ids: ["stone", "cobble", "oak", "spruce", "iron"], minShare: 0.8 },
      { kind: "noFloating" },
    ],
  },
  {
    id: "m-second-storey",
    size: "medium",
    doc: "second_storey",
    seed: "flatHouse",
    text: OPEN("second_storey") + "It holds a one-storey flat-roofed house (x 0..8, z 0..8). Add a second storey on top in the same oak planks, with windows on every side, and replace the flat roof with a gable roof.",
    style: "two-storey oak house",
    checks: [
      { kind: "storeys", min: 2 },
      { kind: "preserved", box: box([0, 0, 0], [8, 4, 8]), minShare: 0.9 },
      { kind: "roofType", types: ["gable", "hip"] },
      { kind: "roofWatertight" },
      { kind: "noFloating" },
    ],
  },
  // ---- large (scoped-session comparison) --------------------------------------------------------
  {
    id: "l-castle",
    size: "large",
    doc: "castle",
    text:
      NEW("castle") +
      "Build a castle enclosure 41×41 (x 0..40, z 0..40). Four identical round corner towers, each fitting in a 9×9 square at the corners (x 0..8 or 32..40, z 0..8 or 32..40), 18 tall with conical roofs. Stone brick curtain walls 10 high joining the towers, with a walkway and battlements. A gatehouse in the middle of the south wall. All four towers must match.",
    style: "stone castle with four matching towers",
    checks: [
      { kind: "consistency", parts: [box([0, 0, 0], [8, 30, 8]), box([32, 0, 0], [40, 30, 8]), box([0, 0, 32], [8, 30, 40]), box([32, 0, 32], [40, 30, 40])], minJaccard: 0.6, maxHeightSpread: 1 },
      { kind: "noFloating" },
      { kind: "withinBox", box: box([-3, 0, -3], [43, 32, 43]) },
      { kind: "minBlocks", n: 3000 },
    ],
  },
  {
    id: "l-street",
    size: "large",
    doc: "street",
    text:
      NEW("street") +
      "Build a street of four matching 2-storey townhouses side by side, each on its own 9-wide plot: x 0..8, 10..18, 20..28 and 30..38, all z 0..10, fronts facing south. Same materials, storey heights, window rhythm and roof on all four; vary only the door colour. A cobblestone pavement along the south side (z 11..13).",
    style: "row of matching townhouses",
    checks: [
      { kind: "consistency", parts: [box([0, 1, 0], [8, 30, 10]), box([10, 1, 0], [18, 30, 10]), box([20, 1, 0], [28, 30, 10]), box([30, 1, 0], [38, 30, 10])], minJaccard: 0.6, maxHeightSpread: 1 },
      { kind: "noFloating" },
      { kind: "minBlocks", n: 2000 },
    ],
  },
  {
    id: "l-manor",
    size: "large",
    doc: "manor",
    text:
      NEW("manor") +
      "Build a symmetric manor: a central 3-storey hall 15×13 (x 15..29, z 0..12) and two matching 2-storey wings, west (x 0..14) and east (x 30..44), both z 2..12. Brick walls, stone quoins, a slate-coloured (deepslate) hip roof on each part, front entrance in the hall's south wall. The two wings must mirror each other.",
    style: "symmetric brick manor",
    checks: [
      { kind: "consistency", parts: [box([0, 0, 2], [14, 30, 12]), box([30, 0, 2], [44, 30, 12])], minJaccard: 0.7, maxHeightSpread: 1 },
      { kind: "door", side: "south" },
      { kind: "noFloating" },
      { kind: "minBlocks", n: 3000 },
    ],
  },
  {
    id: "l-harbour",
    size: "large",
    doc: "harbour",
    text:
      NEW("harbour") +
      "Build a harbour front: a stone quay along x 0..47 (z 0..5), three identical warehouses on it, each on a 13×9 plot (x 1..13, 17..29, 33..45; z 6..14), timber-framed with spruce and stone, gable roofs facing the water, and three matching wooden piers going south from the quay into the water (z −1..−12).",
    style: "harbour with matching warehouses",
    checks: [
      { kind: "consistency", parts: [box([1, 0, 6], [13, 30, 14]), box([17, 0, 6], [29, 30, 14]), box([33, 0, 6], [45, 30, 14])], minJaccard: 0.6, maxHeightSpread: 1 },
      { kind: "minBlocks", n: 2500 },
    ],
  },
];

export const promptById = (id: string): EvalPrompt | undefined => PROMPTS.find((p) => p.id === id);
