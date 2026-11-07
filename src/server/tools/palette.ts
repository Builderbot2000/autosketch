import { z } from "zod";
import { findLibraryPalette, formatMissing, instantiatePalette, listLibraryPalettes, saveLibraryPalette } from "../../library/palettes.js";
import { describePalette, editPalette, pickPalette, type NamedPalette } from "../../palette/pick.js";
import type { InstanceContext } from "../context.js";
import { rootsFor } from "./library.js";
import { fail, image, text, type ToolDeps } from "./shared.js";

/** Palette sheets, picking and named palettes (03), and saved palettes in the library (07). */
export function registerPaletteTools({ tool, session }: ToolDeps): void {
  /** Stores a palette in the session book; palettes are saved with the document. */
  const keep = (c: InstanceContext, p: NamedPalette) => {
    c.book.set(p);
    if (session.doc) {
      session.doc.revision++;
      session.touch();
    }
  };

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
      keep(c, r.palette);
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

  const cells = z.union([z.string(), z.array(z.string()), z.object({ cells: z.union([z.string(), z.array(z.string())]), variant: z.string().optional(), weights: z.record(z.string(), z.number().positive()).optional() })]);

  tool(
    "palette_edit",
    {
      title: "Edit palette",
      description:
        "Changes a saved palette: add cells to a role, remove cells/blocks/families, swap a role's cells, reweight members, drop or rename roles. " +
        "Cell ids refer to sheet (default: the sheet the palette was picked from). Returns the updated summary. Text, <300 tokens.",
      inputSchema: {
        name: z.string(),
        sheet: z.string().optional(),
        page: z.number().int().min(1).optional(),
        add: z.record(z.string(), cells).optional().describe('e.g. {"wall":"G4"}'),
        remove: z.record(z.string(), z.union([z.string(), z.array(z.string())])).optional().describe('e.g. {"wall":["cobblestone","D5"]}'),
        swap: z.record(z.string(), cells).optional().describe("Replace a role's members with these cells"),
        weights: z.record(z.string(), z.record(z.string(), z.number().positive())).optional().describe('e.g. {"wall":{"stone_bricks":3,"mossy_stone_bricks":1}}'),
        drop: z.array(z.string()).optional(),
        rename: z.record(z.string(), z.string()).optional(),
      },
      readOnly: false,
    },
    (c, a) => {
      const p = c.book.get(a.name);
      if (!p) return fail(`No palette "${a.name}" (have: ${c.book.list().map((x) => x.name).join(", ") || "none"})`);
      const { name: _name, ...edit } = a;
      const r = editPalette(c.palette, p, edit);
      keep(c, r.palette);
      return text([r.summary, ...r.warnings.map((w) => `warning: ${w}`)].join("\n"));
    },
  );

  tool(
    "palette_list",
    {
      title: "List palettes",
      description: "Palettes in this session and saved in the library (name, roles, tags). palette_load brings a library palette in. Text.",
      inputSchema: { tags: z.array(z.string()).optional().describe("Library palettes with all these tags") },
    },
    async (c, a) => {
      const lines: string[] = [];
      const mine = c.book.list();
      lines.push(mine.length ? `session: ${mine.map((p) => `${p.name} (${Object.keys(p.roles).join(", ")})`).join("; ")}` : "session: none");
      const lib = await listLibraryPalettes(rootsFor(session, c), a.tags ? { tags: a.tags } : {});
      for (const p of lib) lines.push(`library ${p.name}${p.tags.length ? ` [${p.tags.join(", ")}]` : ""}: roles ${Object.keys(p.roles).join(", ") || "none"}${p.root !== "user" ? ` (${p.root})` : ""}${p.notes ? ` — ${p.notes}` : ""}`);
      if (!lib.length) lines.push(a.tags ? "library: none with those tags" : "library: none yet (palette_save stores one)");
      return text(lines.join("\n"));
    },
  );

  tool(
    "palette_save",
    {
      title: "Save palette to library",
      description: "Saves a session palette to the user library (palettes/<name>.json) with tags, so other documents can palette_load it. Text.",
      inputSchema: {
        name: z.string().describe("Session palette to save"),
        as: z.string().optional().describe("Library name (default: the same)"),
        tags: z.array(z.string()).optional().describe('e.g. ["medieval","warm"]'),
        notes: z.string().optional(),
        overwrite: z.boolean().optional(),
      },
      readOnly: false,
    },
    async (c, a) => {
      const p = c.book.get(a.name);
      if (!p) return fail(`No palette "${a.name}" (have: ${c.book.list().map((x) => x.name).join(", ") || "none"})`);
      const r = await saveLibraryPalette(rootsFor(session, c), c.palette, p, {
        ...(a.as ? { name: a.as } : {}),
        ...(a.tags ? { tags: a.tags } : {}),
        ...(a.notes ? { notes: a.notes } : {}),
        ...(a.overwrite ? { overwrite: true } : {}),
      });
      return text(`${r.replaced ? "replaced" : "saved"} library palette "${a.as ?? a.name}" at ${r.file}`);
    },
  );

  tool(
    "palette_load",
    {
      title: "Load palette from library",
      description:
        "Brings a library palette into this session. Families missing from this instance are reported with the nearest-colour family suggested, and left out unless substitute:true. Text, <300 tokens.",
      inputSchema: {
        name: z.string(),
        as: z.string().optional().describe("Session name (default: the same)"),
        substitute: z.boolean().optional().describe("Use the nearest-colour suggestions for missing families (still reported)"),
      },
      readOnly: false,
    },
    async (c, a) => {
      const file = await findLibraryPalette(rootsFor(session, c), a.name);
      const r = instantiatePalette(c.palette, file, { ...(a.as ? { name: a.as } : {}), ...(a.substitute ? { substitute: true } : {}) });
      if (!Object.keys(r.palette.roles).length) return fail([`None of "${a.name}"'s materials are in this instance.`, ...formatMissing(r.missing, false)].join("\n"));
      const replaced = c.book.get(r.palette.name) !== undefined;
      keep(c, r.palette);
      return text(
        [replaced ? `(replaced session palette "${r.palette.name}")` : "", describePalette(c.palette, r.palette), ...formatMissing(r.missing, !!a.substitute), ...r.warnings.map((w) => `warning: ${w}`)]
          .filter(Boolean)
          .join("\n"),
      );
    },
  );
}
