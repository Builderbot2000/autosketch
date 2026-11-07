import { z } from "zod";
import { colorName } from "../../palette/color.js";
import { fail, text, type ToolDeps } from "./shared.js";

/** Instance and block lookup (02). */
export function registerInstanceTools({ tool }: ToolDeps): void {
  tool(
    "instance_info",
    {
      title: "Instance info",
      description: "What Minecraft instance Autosketch is reading: version, loader, block and material counts, load warnings. Text, <150 tokens.",
      inputSchema: {},
    },
    (c) => {
      const ns = [...c.registry.namespaces()].sort((a, b) => b[1] - a[1]);
      const lines = [
        `${c.info.name}: Minecraft ${c.info.mcVersion}${c.info.loader ? ` (${c.info.loader.name} ${c.info.loader.version})` : ""}, ${c.info.launcher} instance`,
        `${c.registry.size} blocks from ${ns.length} namespaces; ${c.palette.buildable().length} buildable material families, ${c.palette.series.size} dye series`,
        `largest mods: ${ns.slice(0, 8).map(([n, k]) => `${c.registry.modName(n)} (${k})`).join(", ")}`,
        `plugins active: ${c.plugins.map((p) => p.id).join(", ") || "none"}`,
      ];
      if (c.warnings.length) lines.push(`warnings (${c.warnings.length}): ${c.warnings.slice(0, 5).join("; ")}${c.warnings.length > 5 ? " …" : ""}`);
      return text(lines.join("\n"));
    },
  );
}

/** block_info is registered after the palette tools to keep the established tool order. */
export function registerBlockInfoTool({ tool }: ToolDeps): void {
  tool(
    "block_info",
    {
      title: "Block info",
      description:
        "Looks up a block id (properties, defaults, shape, family, shapes/variants, colour) or searches ids by substring when not exact (max 20 results). Text.",
      inputSchema: { query: z.string().describe('Block id like "minecraft:oak_stairs", or a search word like "marble"') },
    },
    (c, args) => {
      const q = args.query.trim().toLowerCase();
      const b = c.registry.get(q);
      if (b) {
        const fam = c.palette.familyOfBlock(b.id);
        const st = fam && c.palette.stats(fam.id);
        const props = Object.entries(b.properties).map(([k, vs]) => `${k}=${vs.join("|")} (default ${b.defaults[k]})`);
        const lines = [
          `${b.id}${b.displayName ? ` "${b.displayName}"` : ""} — ${c.registry.modName(b.namespace)}`,
          `shape: ${b.shape}; render: ${b.renderable}${b.light ? `; light ${b.light}` : ""}`,
          props.length ? `properties: ${props.join("; ")}${b.exactProperties ? "" : " (inferred from assets; may be incomplete)"}` : "properties: none",
        ];
        if (fam) {
          lines.push(`family: ${fam.id} (${fam.category}${st ? `, ${colorName(st.lab)}` : ""}${fam.buildable ? "" : `, excluded: ${fam.excludedBy}`})`);
          const shapes = Object.entries(fam.shapes).map(([k, v]) => `${k}=${v}`);
          if (shapes.length) lines.push(`shapes: ${shapes.join(", ")}`);
          if (fam.variants.length) lines.push(`variants: ${fam.variants.length} (see palette_sheet family:${fam.id})`);
          const extras = Object.entries(fam.extras).map(([ns, ids]) => `${ns}: ${ids.length}`);
          if (extras.length) lines.push(`extra shapes: ${extras.join(", ")}`);
          if (fam.series) lines.push(`series: ${fam.series}`);
        }
        return text(lines.join("\n"));
      }
      const hits: string[] = [];
      for (const x of c.registry.all()) if (x.id.includes(q)) hits.push(x.id);
      if (!hits.length) return fail(`No block matches "${args.query}".`);
      hits.sort((a, b) => a.length - b.length || (a < b ? -1 : 1));
      return text(`${hits.length} match${hits.length > 1 ? "es" : ""}${hits.length > 20 ? " (showing 20)" : ""}: ${hits.slice(0, 20).join(", ")}`);
    },
  );
}
