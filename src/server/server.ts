import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { colorName } from "../palette/color.js";
import { describePalette, pickPalette } from "../palette/pick.js";
import type { InstanceContext } from "./context.js";
import { INSTRUCTIONS } from "./instructions.js";

export const SERVER_NAME = "autosketch";
export const SERVER_VERSION = "0.1.0";

type Result = CallToolResult;
const text = (t: string): Result => ({ content: [{ type: "text", text: t }] });
const fail = (t: string): Result => ({ content: [{ type: "text", text: t }], isError: true });

/**
 * Builds the MCP server. The instance context is a promise so the server can answer the handshake
 * immediately while the instance loads (seconds on a warm cache, longer the first time).
 */
export function createServer(ctx: Promise<InstanceContext>): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION }, { instructions: INSTRUCTIONS });

  const tool = <S extends z.ZodRawShape>(
    name: string,
    config: { title: string; description: string; inputSchema: S; readOnly?: boolean },
    run: (c: InstanceContext, args: z.infer<z.ZodObject<S>>) => Promise<Result> | Result,
  ) =>
    server.registerTool(
      name,
      { title: config.title, description: config.description, inputSchema: config.inputSchema, annotations: { readOnlyHint: config.readOnly ?? true, openWorldHint: false } },
      (async (args: z.infer<z.ZodObject<S>>) => {
        let c: InstanceContext;
        try {
          c = await ctx;
        } catch (e) {
          return fail(`The Minecraft instance failed to load: ${(e as Error).message}`);
        }
        try {
          return await run(c, args);
        } catch (e) {
          return fail((e as Error).message);
        }
      }) as never,
    );

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

  tool(
    "palette_sheet",
    {
      title: "Palette sheet",
      description:
        "Shows building materials as a tilemap image with chessboard cell ids, plus a short caption. Default: the one-page overview (~1.5k tokens). " +
        'Other sheets: "category:<stone|wood|metal|colored|glass|earth|organic|light|decor>", "family:<block id>" (variants), "series:<id>" (dye colours), "similar:<id>", "all", ' +
        '"filter:<terms>" (mod:<ns> has:<stairs|slab|wall|fence|variants|extras> cat:<c> text:<word>). zoom:"C4:H9" enlarges a range and lists names (~0.2k tokens).',
      inputSchema: {
        sheet: z.string().default("overview").describe('Sheet spec, e.g. "overview", "category:wood", "family:minecraft:andesite"'),
        page: z.number().int().min(1).optional().describe("Page for multi-page sheets (1-based)"),
        zoom: z.string().optional().describe('Cell range to enlarge, e.g. "C4:H9" (max 64 cells)'),
      },
    },
    async (c, args) => {
      const spec = { sheet: args.sheet, ...(args.page ? { page: args.page } : {}), ...(args.zoom ? { zoom: args.zoom } : {}) };
      const s = await c.sheets.render(spec);
      if (s.layout.total === 0)
        return text(`No materials match sheet "${args.sheet}". Loosen the filter (has:/cat:/mod:/text:), or look a block up with block_info.`);
      return {
        content: [
          { type: "image", data: s.png.toString("base64"), mimeType: "image/png" },
          { type: "text", text: s.caption },
        ],
      };
    },
  );

  const roleSchema = z.union([
    z.string(),
    z.array(z.string()),
    z.object({
      cells: z.union([z.string(), z.array(z.string())]).describe('Cell range(s), e.g. "C4:F6" or ["B2","D5"]'),
      variant: z.string().optional().describe('Prefer variants whose id contains this word, e.g. "chiseled"'),
      weights: z.record(z.string(), z.number().positive()).optional().describe('Relative weight per cell/range, e.g. {"C4": 3}'),
    }),
  ]);

  tool(
    "palette_pick",
    {
      title: "Pick palette",
      description:
        "Saves a named palette by assigning cell ranges of a sheet to roles. A range becomes a weighted mix; a dye-series tile adds all its colours. " +
        'Use the materials later as "palette:<name>.<role>". Returns per role: blocks, colours and shapes shared by all members. Text, <300 tokens.',
      inputSchema: {
        name: z.string().describe("Palette name (letters, digits, _ or -)"),
        sheet: z.string().default("overview").describe("The sheet the cell ids refer to"),
        page: z.number().int().min(1).optional(),
        roles: z.record(z.string(), roleSchema).describe('e.g. {"wall":"C4:F6","roof":"K2:K5","accent":{"cells":"R3","variant":"chiseled"}}'),
      },
      readOnly: false,
    },
    (c, args) => {
      const req = { name: args.name, sheet: args.sheet, roles: args.roles, ...(args.page ? { page: args.page } : {}) };
      const r = pickPalette(c.palette, req);
      if (Object.keys(r.palette.roles).length === 0) return fail(`Nothing selected.\n${r.warnings.join("\n")}`);
      const replaced = c.book.get(r.palette.name) !== undefined;
      c.book.set(r.palette);
      return text([replaced ? `(replaced existing palette "${r.palette.name}")` : "", r.summary, ...r.warnings.map((w) => `warning: ${w}`)].filter(Boolean).join("\n"));
    },
  );

  tool(
    "palette_show",
    {
      title: "Show palette",
      description: "Describes a saved palette (roles, blocks, colours, available shapes), or lists saved palettes when no name is given. Text.",
      inputSchema: { name: z.string().optional() },
    },
    (c, args) => {
      if (!args.name) {
        const all = c.book.list();
        if (!all.length) return text("No palettes yet. Use palette_sheet then palette_pick.");
        return text(all.map((p) => `${p.name}: roles ${Object.keys(p.roles).join(", ")}`).join("\n"));
      }
      const p = c.book.get(args.name);
      if (!p) return fail(`No palette "${args.name}" (have: ${c.book.list().map((x) => x.name).join(", ") || "none"})`);
      return text(describePalette(c.palette, p));
    },
  );

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

  return server;
}
