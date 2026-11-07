import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { colorName } from "../palette/color.js";
import { describePalette, pickPalette } from "../palette/pick.js";
import { fromPublic, type Box, type PublicBox, type Vec3 } from "../core/region.js";
import type { Document } from "../document/document.js";
import { clear, fill, replace, setBlocks, type OpEnv } from "../ops/edit.js";
import type { MaterialExpr } from "../ops/material.js";
import { viewSlice } from "../perception/slice.js";
import type { InstanceContext } from "./context.js";
import { formatEdit, formatHistory, formatInfo, shiftLine, sizeLine } from "./format.js";
import { INSTRUCTIONS } from "./instructions.js";
import { defaultWorkspace, Session } from "./session.js";

export const SERVER_NAME = "autosketch";
export const SERVER_VERSION = "0.1.0";

type Result = CallToolResult;
const text = (t: string): Result => ({ content: [{ type: "text", text: t }] });
const fail = (t: string): Result => ({ content: [{ type: "text", text: t }], isError: true });

/**
 * Builds the MCP server. The instance context is a promise so the server can answer the handshake
 * immediately while the instance loads (seconds on a warm cache, longer the first time).
 */
export interface ServerOptions {
  /** Document session; defaults to one over the default workspace (~/autosketch). */
  session?: Session;
}

export function createServer(ctx: Promise<InstanceContext>, opts: ServerOptions = {}): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION }, { instructions: INSTRUCTIONS });
  const session = opts.session ?? new Session(defaultWorkspace());

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

  registerDocumentTools(tool, session);
  return server;
}

// -------------------------------------------------------------------------------------------------
// Document and edit tools (docs/design/04-document.md, 05-operations.md, 06 view_slice)
// -------------------------------------------------------------------------------------------------

const vec3 = z.tuple([z.number().int(), z.number().int(), z.number().int()]);
const boxSchema = z
  .object({ min: vec3, max: vec3 })
  .describe("Inclusive box {min:[x,y,z], max:[x,y,z]}; corners in any order. {min:[0,0,0],max:[0,0,0]} is one block.");
const materialSchema = z
  .union([z.string(), z.record(z.string(), z.unknown())])
  .describe(
    'Material: "stone_bricks", "oak_stairs[facing=east]", "stone_bricks 70%, mossy_stone_bricks 30%", "palette:<name>.<role>", ' +
      '{"gradient":[...],"axis":"y","range":[0,12]}, {"noise":[...],"scale":6}, {"pattern":"checker|stripes_x|stripes_y|stripes_z","blocks":[...],"size":1}. Entries nest.',
  );

type ToolFn = <S extends z.ZodRawShape>(
  name: string,
  config: { title: string; description: string; inputSchema: S; readOnly?: boolean },
  run: (c: InstanceContext, args: z.infer<z.ZodObject<S>>) => Promise<Result> | Result,
) => unknown;

function registerDocumentTools(tool: ToolFn, session: Session): void {
  const env = (c: InstanceContext): OpEnv => ({ registry: c.registry, index: c.palette });
  const box = (b: PublicBox): Box => fromPublic(b as PublicBox);
  /** Runs an edit on the open document and schedules the autosave. */
  const edit = (run: (doc: Document) => string): Result => {
    const doc = session.require();
    const out = run(doc);
    session.touch();
    return text(out);
  };

  tool(
    "doc_new",
    {
      title: "New document",
      description:
        "Starts a new schematic document and makes it current (the previous one is saved and closed). Optional size declares the build volume up front; " +
        "the document grows anyway when you build outside it. Saved automatically under the workspace. Text.",
      inputSchema: {
        name: z.string().describe("Document name (letters, digits, _ or -)"),
        size: vec3.optional().describe("Declared size [x,y,z] in blocks"),
        front: z.enum(["north", "south", "east", "west"]).optional().describe("Facade that counts as the front (default south, +Z)"),
        seed: z.number().int().optional().describe("Seed for material mixes (default random)"),
        overwrite: z.boolean().optional().describe("Replace an existing document of that name"),
      },
      readOnly: false,
    },
    async (c, a) => {
      const doc = await session.create({
        name: a.name,
        mcVersion: c.info.mcVersion,
        palettes: c.book,
        ...(a.size ? { size: a.size as Vec3 } : {}),
        ...(a.front ? { front: a.front } : {}),
        ...(a.seed !== undefined ? { seed: a.seed } : {}),
        ...(a.overwrite ? { overwrite: true } : {}),
      });
      return text(`created "${doc.meta.name}" · front ${doc.meta.front} · seed ${doc.meta.seed}\n${sizeLine(doc)}\nsaved at ${session.path}`);
    },
  );

  tool(
    "doc_open",
    {
      title: "Open document",
      description: "Opens a saved document from the workspace and makes it current (the previous one is saved and closed). Undo history starts fresh. Text.",
      inputSchema: { name: z.string() },
      readOnly: false,
    },
    async (c, a) => {
      const doc = await session.open(a.name, c.book);
      return text(formatInfo(doc, c.registry, session.path));
    },
  );

  tool(
    "doc_list",
    { title: "List documents", description: "Lists documents saved in the workspace, newest first. Text.", inputSchema: {} },
    async () => {
      const docs = await session.list();
      if (!docs.length) return text(`No documents in ${session.workspace} yet. Start one with doc_new.`);
      return text(docs.map((d) => `${d.name}${session.doc?.meta.name === d.name ? " (open)" : ""} · ${d.modified.toISOString().slice(0, 16).replace("T", " ")} · ${Math.ceil(d.bytes / 1024)} KB`).join("\n"));
    },
  );

  tool(
    "doc_info",
    {
      title: "Document info",
      description: "The open document: bounds, block counts by state, components, palettes, history and checkpoints. Text, <300 tokens.",
      inputSchema: {},
    },
    (c) => text(formatInfo(session.require(), c.registry, session.path)),
  );

  tool(
    "set_blocks",
    {
      title: "Set blocks",
      description: "Places individual blocks: the escape hatch for details (doors, lanterns, single stairs). Use fill for anything box-shaped. One undo step. Text.",
      inputSchema: {
        blocks: z.array(z.object({ pos: vec3, block: materialSchema })).min(1).describe('e.g. [{"pos":[3,1,0],"block":"oak_door[facing=south]"}]'),
      },
      readOnly: false,
    },
    (c, a) => edit((doc) => formatEdit(doc, setBlocks(doc, env(c), a.blocks.map((b) => ({ pos: b.pos as Vec3, block: b.block as MaterialExpr }))))),
  );

  tool(
    "fill",
    {
      title: "Fill box",
      description:
        "Fills a box with a material. mode: fill (solid, default) · hollow (shell of the material, inside cleared to air) · outline (shell only, inside untouched) · " +
        "walls (four vertical sides only, no floor or ceiling). thickness sets the shell width. as:\"name\" registers the box as a component. One undo step. Text.",
      inputSchema: {
        box: boxSchema,
        material: materialSchema,
        mode: z.enum(["fill", "hollow", "outline", "walls"]).optional(),
        thickness: z.number().int().min(1).max(16).optional(),
        as: z.string().optional().describe("Component id to register for this box, e.g. \"keep\""),
        kind: z.string().optional().describe('Component kind, e.g. "tower", "wall", "floor"'),
      },
      readOnly: false,
    },
    (c, a) =>
      edit((doc) => {
        const r = fill(doc, env(c), box(a.box as PublicBox), a.material as MaterialExpr, {
          ...(a.mode ? { mode: a.mode } : {}),
          ...(a.thickness ? { thickness: a.thickness } : {}),
          ...(a.as ? { as: a.as } : {}),
          ...(a.kind ? { kind: a.kind } : {}),
        });
        return formatEdit(doc, r, a.as ? [`component: ${a.as}`] : []);
      }),
  );

  tool(
    "clear",
    { title: "Clear box", description: "Sets every block in a box to air. One undo step. Text.", inputSchema: { box: boxSchema }, readOnly: false },
    (_c, a) => edit((doc) => formatEdit(doc, clear(doc, box(a.box as PublicBox)))),
  );

  tool(
    "replace",
    {
      title: "Replace blocks",
      description:
        'Replaces matching blocks with a material inside a box (default: the whole document). from: "oak_planks" (any state), "oak_stairs[half=top]" (those states), ' +
        '"#minecraft:logs" (a tag), "*" (any non-air), "air" (fill empty space). keep_states copies facing/half/axis… onto the new block (e.g. oak_stairs → spruce_stairs). One undo step. Text.',
      inputSchema: {
        from: z.string(),
        to: materialSchema,
        box: boxSchema.optional(),
        keep_states: z.boolean().optional(),
      },
      readOnly: false,
    },
    (c, a) =>
      edit((doc) => {
        const b = a.box ? box(a.box as PublicBox) : doc.localBounds();
        if (!b) throw new Error("The document is empty; nothing to replace.");
        return formatEdit(doc, replace(doc, env(c), b, a.from, a.to as MaterialExpr, a.keep_states ? { keepStates: true } : {}));
      }),
  );

  tool(
    "undo",
    { title: "Undo", description: "Undoes the last op (or several). Text.", inputSchema: { steps: z.number().int().min(1).max(1000).optional() }, readOnly: false },
    (_c, a) =>
      edit((doc) => {
        const done: string[] = [];
        let net: Vec3 = [0, 0, 0];
        for (let i = 0; i < (a.steps ?? 1); i++) {
          const r = doc.undo();
          if (!r) break;
          done.push(`#${r.entry.seq} ${r.entry.summary}`);
          if (r.shift) net = [net[0] + r.shift[0], net[1] + r.shift[1], net[2] + r.shift[2]];
        }
        if (!done.length) return "Nothing to undo.";
        return [`undid ${done.length}: ${done.join("; ")}`, shiftLine(net.some((v) => v) ? net : undefined), sizeLine(doc)].filter(Boolean).join("\n");
      }),
  );

  tool(
    "redo",
    { title: "Redo", description: "Redoes undone ops. Text.", inputSchema: { steps: z.number().int().min(1).max(1000).optional() }, readOnly: false },
    (_c, a) =>
      edit((doc) => {
        const done: string[] = [];
        let net: Vec3 = [0, 0, 0];
        for (let i = 0; i < (a.steps ?? 1); i++) {
          const r = doc.redo();
          if (!r) break;
          done.push(`#${r.entry.seq} ${r.entry.summary}`);
          if (r.shift) net = [net[0] + r.shift[0], net[1] + r.shift[1], net[2] + r.shift[2]];
        }
        if (!done.length) return "Nothing to redo.";
        return [`redid ${done.length}: ${done.join("; ")}`, shiftLine(net.some((v) => v) ? net : undefined), sizeLine(doc)].filter(Boolean).join("\n");
      }),
  );

  tool(
    "checkpoint",
    {
      title: "Checkpoint",
      description: "Names the current state so restore can return to it. Make one before risky multi-step work. Cheap. Text.",
      inputSchema: { name: z.string() },
      readOnly: false,
    },
    (_c, a) => {
      const doc = session.require();
      doc.checkpoint(a.name);
      return text(`checkpoint "${a.name}" at op #${doc.journal.headSeq}`);
    },
  );

  tool(
    "restore",
    {
      title: "Restore checkpoint",
      description: "Undoes (or redoes) back to a named checkpoint. Text.",
      inputSchema: { name: z.string() },
      readOnly: false,
    },
    (_c, a) =>
      edit((doc) => {
        const r = doc.restore(a.name);
        const head = r.direction === "none" ? `already at checkpoint "${a.name}"` : `restored "${a.name}" (${r.direction === "undo" ? "undid" : "redid"} ${r.steps} op${r.steps === 1 ? "" : "s"})`;
        return [head, shiftLine(r.shift), sizeLine(doc)].filter(Boolean).join("\n");
      }),
  );

  tool(
    "history",
    {
      title: "History",
      description: "Recent ops (newest last) with checkpoints: use it to re-orient after losing context. Text.",
      inputSchema: { limit: z.number().int().min(1).max(200).optional() },
    },
    (_c, a) => text(formatHistory(session.require(), a.limit ?? 20)),
  );

  tool(
    "view_slice",
    {
      title: "View slice",
      description:
        "One layer of the build as a character grid with a legend: exact and cheap, the way to check a build. axis y = top-down plan at height at (north up); " +
        "axis z = elevation at that z looking north; axis x = elevation at that x looking east. Max 64×64; region limits the area. Text, ~0.1–1.5k tokens.",
      inputSchema: {
        axis: z.enum(["x", "y", "z"]),
        at: z.number().int(),
        region: boxSchema.optional().describe("Limit the slice to this box (its extent along axis is ignored)"),
      },
    },
    (c, a) => text(viewSlice(session.require(), c.registry, { axis: a.axis, at: a.at, ...(a.region ? { region: box(a.region as PublicBox) } : {}) })),
  );
}
