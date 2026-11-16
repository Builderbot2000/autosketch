import { z } from "zod";
import { boxSchema, fail, text, type ToolDeps } from "./shared.js";

/**
 * Setting the player's volumes from the agent (docs/design/13-live-world.md, *Backlog* B4). After
 * `/autosketch scan` the agent looks at the probe and sets the work and context volumes here; the
 * mod sets them as if the player had marked them, and linking follows. It reaches the game through
 * `session.inGame`, never by importing `world/`. Allowed with no request open, and in scan and build
 * requests; the request mode rule (`world/modes.ts`) refuses it in ask and plan.
 */
export function registerWorldVolumesTools({ tool, session }: ToolDeps): void {
  tool(
    "world_volumes",
    {
      title: "Set the in-game volumes",
      description:
        "Sets the player's work volume (where the build may change) and context volume (what you see around it) in the game, as if they had marked them with the wand. " +
        "Boxes are in the open document's coordinates: the scan probe after /autosketch scan, else the linked document. " +
        "context: boxes, {padding:n} (work grown by n), or omitted for the default (+3). The player sees the outlines; linking follows. No accept step: the player refines or moves on. Text, <80 tokens.",
      inputSchema: {
        work: boxSchema.describe("The work volume, in the open document's coordinates"),
        context: z
          .union([z.object({ padding: z.number().int().min(1).max(32) }).strict(), z.array(boxSchema).min(1).max(16)])
          .optional()
          .describe("Context boxes, or {padding:n}; omitted: the default context (work grown by 3)"),
      },
      readOnly: false,
      doc: false,
    },
    async (_c, a) => {
      const g = session.inGame;
      if (!g) return fail("The live world link isn't available in this server.");
      return text(await g.setVolumes(a.work, a.context));
    },
  );
}
