import { formatEdit } from "../format.js";
import { fail, text, type ToolDeps } from "./shared.js";

/**
 * Live world link tools (docs/design/13-live-world.md). They reach the link through
 * `session.world`, never by importing `world/` (ARCHITECTURE.md, *Dependency rules*).
 */
export function registerWorldTools({ tool, session }: ToolDeps): void {
  tool(
    "world_sync",
    {
      title: "Sync from the world",
      description:
        "Linked document only: replaces the cache with the world (sections whose hashes differ are re-read), picking up the player's hand edits, contents-only changes and anything missed. " +
        "One history entry; pushes nothing, so it is always safe. Runs automatically before calls when the player edits. Text, <100 tokens.",
      inputSchema: {},
      readOnly: false,
      doc: false, // always the linked base document
    },
    async () => {
      const link = session.world;
      if (!link || link.state !== "linked")
        return fail(`No linked world document${link ? ` (link: ${link.state})` : ""}. Open the base document with the world link, and set a work volume in-game with the /autosketch wand.`);
      const r = await link.syncNow("manual");
      const doc = link.doc ?? session.require();
      if (!r) return text("ok · world_sync · the cache already matches the world");
      session.touch();
      const drift = (r as { components?: { id: string; changed: number }[] }).components ?? [];
      return text(formatEdit(doc, r, drift.length ? [`components changed: ${drift.map((c) => `${c.id} ${c.changed}`).join(", ")}`] : []));
    },
  );
}
