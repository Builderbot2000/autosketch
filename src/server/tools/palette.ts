import { z } from "zod";
import { describePalette, pickPalette } from "../../palette/pick.js";
import { fail, image, text, type ToolDeps } from "./shared.js";

/** Palette sheets, picking and named palettes (03). */
export function registerPaletteTools({ tool, session }: ToolDeps): void {
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
      return image(s.png, s.caption);
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
      if (session.doc) {
        session.doc.revision++; // palettes are saved with the document
        session.touch();
      }
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
}
