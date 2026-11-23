import { z } from "zod";
import { fromPublic, toPublic, type PublicBox } from "../../core/region.js";
import { refusal } from "../../scope/scopes.js";
import { boxSchema, image, text, vec3, type ToolDeps } from "./shared.js";

/**
 * The agent's select tools in the world (docs/design/18-select.md, pieces 2 to 4 and 9):
 * `world_search` (T1), `world_fill` and `world_expand` (T2). A thin adapter: the logic is `world/select/`, reached only through
 * `session.worldSelect` (ARCHITECTURE.md, *Dependency rules*).
 */
export function registerWorldSelectTools({ tool, session }: ToolDeps): void {
  tool(
    "world_search",
    {
      title: "Search the world for materials",
      description:
        "During an in-game select request (/autosketch select), finds where materials are around the player: the mod walks chunks in rings outward, nearest first, " +
        "counting the blocks of the given materials per chunk (covered or underground builds included), and stops once a cluster of matching chunks is closed (no match within 2 rings past it). " +
        'materials: block ids ("mossy_stone_bricks"), canonical states, "family:<id>" (every variant and shape of that material, e.g. "family:stone_bricks" for mossy, cracked, chiseled, stairs, slabs, walls) or "#tags"; ' +
        "turn the player's words into these with palette_sheet / block_info, never ask the player for ids. " +
        "radius: chunks (default and cap: the mod's selectChunks, 256); around: a world position to centre on instead of the player; stop: closed clusters to stop at (default 1). " +
        "continue:true walks on from where the last search stopped, for the next clusters. " +
        "Returns a heat map (one cell per chunk, north up, the player ringed, clusters numbered) and a list of clusters with distance, bearing, y range and counts. Image ≤480 px plus text, ~600–1,000 tokens.",
      inputSchema: {
        materials: z.array(z.string().min(1)).min(1).max(64).optional().describe('Block ids, canonical states, "family:<id>" or "#ns:tag"'),
        radius: z.number().int().min(0).max(1024).optional().describe("Chunks around the centre; default and cap: selectChunks"),
        around: vec3.optional().describe("World position whose chunk is the centre; default: the player's"),
        stop: z.number().int().min(1).max(64).optional().describe("Stop once this many more clusters are closed (default 1)"),
        continue: z.boolean().optional().describe("Walk on from where the last search stopped (give no materials, radius or around)"),
      },
      doc: false,
    },
    async (c, a) => {
      const sel = session.worldSelect;
      if (!sel) throw refusal("world_disconnected", "The live world link isn't available in this server.");
      const r = await sel.search(a, { registry: c.registry, index: c.palette });
      return image(r.map.png, r.text);
    },
  );

  tool(
    "world_fill",
    {
      title: "Fill a candidate shape in the world",
      description:
        "During an in-game select request, grows a shape from seed (a world position) through matching blocks, as the {connected} pick does, but in the mod, so it reaches unloaded chunks and never ships blocks it doesn't need. " +
        'match: "block" (the seed\'s block, any state), "family" (every variant and shape of the seed\'s material), or materials as world_search takes them (ids, "family:<id>", "#tags", "solid"). ' +
        "connectivity 6, 18 or 26 (default 26, so diagonal walls and stairs stay whole); budget: most blocks this step adds (default: the mod's contextCap); area: chunks around the seed's chunk the fill may read (default 1). " +
        'The result replaces the last fill and is the named selection "candidate" in the world view; its sections plus margin blocks (default 8) are read into the view, so render({view:"world"}) and the selection algebra work on it at once. ' +
        "The text gives box, count, sections, and whether the shape is cut off (a non-empty frontier: world_expand continues). Text, ~200 tokens.",
      inputSchema: {
        seed: vec3.describe("World position of a block of the shape"),
        match: z.union([z.enum(["block", "family"]), z.array(z.string().min(1)).min(1).max(64)]).describe('"block", "family", or materials (ids, "family:<id>", "#tags", "solid")'),
        connectivity: z.union([z.literal(6), z.literal(18), z.literal(26)]).optional().describe("Neighbours that connect: 6 faces, 18 with edges, 26 with corners (default 26)"),
        budget: z.number().int().min(1).optional().describe("Most blocks this step adds (default: the mod's contextCap)"),
        area: z.number().int().min(0).max(64).optional().describe("Chunks around the seed's chunk in the initial read area (default 1)"),
        margin: z.number().int().min(0).max(16).optional().describe("Blocks around the candidate's sections read into the world view (default 8)"),
      },
      doc: false,
    },
    async (c, a) => {
      const sel = session.worldSelect;
      if (!sel) throw refusal("world_disconnected", "The live world link isn't available in this server.");
      const r = await sel.fill(a, { registry: c.registry, index: c.palette });
      return text(r.text);
    },
  );

  tool(
    "world_expand",
    {
      title: "Expand the candidate's fill",
      description:
        "Grows the last world_fill's read area and resumes the fill from its frontier with a fresh budget, so a large build grows in rounds and you can stop as soon as the shape is clearly right. " +
        'by: "frontier" (the chunks the cut-off faces reach), {direction:"north|south|west|east", chunks}, or {box} (the chunks a world box touches). ' +
        'The changed sections update "candidate" in the world view and are re-read there with their margin (default 8). Text, ~200 tokens.',
      inputSchema: {
        by: z
          .union([z.literal("frontier"), z.object({ direction: z.enum(["north", "south", "west", "east"]), chunks: z.number().int().min(1).max(64) }), z.object({ box: boxSchema })])
          .describe('"frontier", {direction, chunks} or {box}'),
        budget: z.number().int().min(1).optional().describe("Most blocks this step adds (default: the mod's contextCap)"),
        margin: z.number().int().min(0).max(16).optional().describe("Blocks around the changed sections read into the world view (default 8)"),
      },
      doc: false,
    },
    async (_c, a) => {
      const sel = session.worldSelect;
      if (!sel) throw refusal("world_disconnected", "The live world link isn't available in this server.");
      const by = typeof a.by === "object" && "box" in a.by ? { box: toPublic(fromPublic(a.by.box as PublicBox)) } : a.by;
      const r = await sel.expand({ ...a, by });
      return text(r.text);
    },
  );
}
