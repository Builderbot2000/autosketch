import { BASE, refusal } from "../../scope/scopes.js";
import { image, type ToolDeps } from "./shared.js";

/**
 * `world_map` (docs/design/19-canvas-and-requests.md, *Seeing the whole canvas*; step M1): the
 * canvas from above before choosing where to put the brush. A thin adapter: the logic is
 * `world/map.ts`, reached only through `session.worldMap` (ARCHITECTURE.md, *Dependency rules*); the
 * open jobs come from the session's scopes (the linked document's, local).
 */
export function registerWorldMapTools({ tool, session }: ToolDeps): void {
  tool(
    "world_map",
    {
      title: "Map the canvas from above",
      description:
        "The whole in-game canvas from above, to see it before choosing where to put the brush (the work volume): one cell per chunk column, shaded by the highest surface block in the chunk (a surface read of every column, coarse past the mod's contextCap), " +
        "with the brush (white), its context (dashed yellow), open jobs (magenta, numbered) and the player (cyan ring) marked, and a chunk grid labelled in local coordinates. " +
        "Text: the canvas size and frame, what was read, the height range, the brush box, jobs and the player's position. Measurements only. Works in every mode while a canvas is set. Image ≤ ~520 px plus text, ~600–1,000 tokens.",
      inputSchema: {},
      doc: false,
    },
    async () => {
      const m = session.worldMap;
      if (!m) throw refusal("world_disconnected", "The live world link isn't available in this server.");
      const jobs = session.scopes
        .list()
        .filter((s) => s.parent === BASE)
        .map((s) => ({ id: s.id, box: s.lock, blocks: s.workBlocks }));
      const r = await m.map(jobs);
      return image(r.png, r.text);
    },
  );
}
