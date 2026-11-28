import { z } from "zod";
import { resolveSelection } from "../../ops/selection.js";
import { boxSchema, fail, text, type ToolDeps } from "./shared.js";

/**
 * Setting the player's volumes from the agent (docs/design/13-live-world.md, *Backlog* B4). The
 * agent sets the work and context volumes here in the linked document's coordinates; the mod sets
 * them as if the player had marked them, and linking follows. It reaches the game through
 * `session.inGame`, never by importing `world/`. Allowed with no request open, and in select and
 * build requests; the request mode rule (`world/modes.ts`) refuses it in ask and plan.
 *
 * `from` confirms a shape of the world view instead (docs/design/18-select.md, piece 9): the work
 * volume is its box, the context that box grown by `margin`, in world coordinates, so it needs no
 * linked document; the logic is `session.worldSelect`'s.
 *
 * With a canvas (docs/design/19-canvas-and-requests.md, *Placing and moving the brush*), a `work`
 * box inside it moves the brush in every request mode (`InGameRequests.setVolumes`, `LiveLink`).
 */
export function registerWorldVolumesTools({ tool, session }: ToolDeps): void {
  tool(
    "world_volumes",
    {
      title: "Set the in-game volumes",
      description:
        "Sets the player's work volume (where the build may change) and context volume (what you see around it) in the game, as if they had marked them with the wand. " +
        "Either work: a box in the linked document's coordinates, with context: boxes, {padding:n} (work grown by n), or omitted for the default (+3); " +
        'or from:"candidate" to confirm the world view\'s candidate (after world_fill, in a select request): work = its bounding box, context = that box grown by margin (default 8), and the shape comes along as the named selection "candidate" in the linked document, a guide (only the box is enforced). ' +
        "from may also name a part kept in the world view (select({view:\"world\", …, name})); a shape whose context would pass the mod's contextCap is confirmed as a selection but sets no volumes, and the result suggests a part or sandboxes. " +
        "The player sees the outlines; linking follows. No accept step: the player refines or moves on. " +
        "With a canvas, a work box inside it moves the brush, in any request mode: it waits for patches in flight, keeps coordinates, history and selections, and reports both boxes and the time taken; undo of an edit outside the brush is refused until you move back. Text, <150 tokens.",
      inputSchema: {
        work: boxSchema.optional().describe("The work volume, in the linked document's coordinates (not with from)"),
        context: z
          .union([z.object({ padding: z.number().int().min(1).max(32) }).strict(), z.array(boxSchema).min(1).max(16)])
          .optional()
          .describe("Context boxes, or {padding:n}; omitted: the default context (work grown by 3). Not with from"),
        from: z.string().min(1).optional().describe('"candidate" (or a part named in the world view): confirm that shape as the volumes'),
        margin: z.number().int().min(1).max(32).optional().describe("With from: the context is the work box grown by this (default 8)"),
      },
      readOnly: false,
      doc: false,
    },
    async (_c, a) => {
      if (a.from !== undefined) {
        if (a.work || a.context) return fail("Give either from (a shape in the world view) or work and context, not both.");
        session.inGame?.checkVolumeMode?.();
        const sel = session.worldSelect, view = session.worldView;
        if (!sel || !view) return fail("The live world link isn't available in this server.");
        const named = (name: string) => (view.doc.selections.has(name) ? resolveSelection(name, { doc: view.doc }).mask : undefined);
        const shape = named(a.from);
        if (!shape)
          return fail(
            a.from === "candidate"
              ? 'There is no "candidate" in the world view for this request: grow one with world_fill first.'
              : `There is no selection "${a.from}" in the world view: keep one with select({view:"world", sel, name:"${a.from}"}) first.`,
          );
        const candidate = a.from === "candidate" ? undefined : named("candidate");
        return text(await sel.confirm({ from: a.from, shape, ...(candidate ? { candidate } : {}), ...(a.margin !== undefined ? { margin: a.margin } : {}) }));
      }
      if (!a.work) return fail('Give work (a box), or from:"candidate" to confirm the world view\'s candidate.');
      if (a.margin !== undefined) return fail("margin goes with from; with work, give context:{padding:n}.");
      const g = session.inGame;
      if (!g) return fail("The live world link isn't available in this server.");
      return text(await g.setVolumes(a.work, a.context));
    },
  );
}
