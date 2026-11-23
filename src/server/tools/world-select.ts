import { z } from "zod";
import { refusal } from "../../scope/scopes.js";
import { image, vec3, type ToolDeps } from "./shared.js";

/**
 * The agent's select tools in the world (docs/design/18-select.md, pieces 2 to 4 and 9):
 * `world_search` (T1). A thin adapter: the logic is `world/select/`, reached only through
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
}
