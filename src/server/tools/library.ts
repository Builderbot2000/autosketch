import { z } from "zod";
import { defaultCacheDir } from "../../assets/cache.js";
import { Mask } from "../../core/mask.js";
import { formatVec, type Box, type Vec3 } from "../../core/region.js";
import { dataVersionFor } from "../../core/version.js";
import { blockIndex, documentFromSnapshot, snapshotOf, type Snapshot } from "../../formats/snapshot.js";
import { Library } from "../../library/index.js";
import { formatKnowledgeList, listKnowledge, readKnowledge } from "../../library/knowledge.js";
import { loadPrefab, savePrefab, type Prefab } from "../../library/prefabs.js";
import { formatProcedureList, listProcedures } from "../../library/procedures.js";
import { libraryRoots, type LibraryRoot } from "../../library/roots.js";
import { stampPrefab, type StampAt } from "../../library/stamp.js";
import { renderDocument } from "../../perception/render/render.js";
import type { InstanceContext } from "../context.js";
import { formatEdit } from "../format.js";
import type { Session } from "../session.js";
import { bakerFor, boxSchema, editWith, env, image, regionOf, selSchema, text, vec3, type ToolDeps } from "./shared.js";

/** Library roots for this server: AUTOSKETCH_LIBRARY or <workspace>/library, the starter library, and the instance's Axiom blueprints. */
export function rootsFor(session: Session, c?: InstanceContext): LibraryRoot[] {
  return libraryRoots({ workspace: session.workspace, env: process.env, ...(c?.info.root ? { instanceRoot: c.info.root } : {}) });
}

const libraries = new WeakMap<InstanceContext, Library>();

/** One library per loaded instance (it remembers the last prefab sheet for cell refs). */
export function libraryFor(c: InstanceContext, session: Session): Library {
  let lib = libraries.get(c);
  if (!lib) {
    const dataVersion = dataVersionFor(c.info.mcVersion) ?? 0;
    lib = new Library({
      roots: rootsFor(session, c),
      registry: c.registry,
      cacheDir: defaultCacheDir(),
      thumbnail: async (snap) => {
        const doc = documentFromSnapshot(snap, { name: "thumbnail", dataVersion, source: "prefab" });
        return (await renderDocument(doc, await bakerFor(c), { views: ["iso_se"], size: 96, thumbnail: true })).png;
      },
    });
    libraries.set(c, lib);
  }
  return lib;
}

const footprintSchema = z.tuple([z.number().int().min(1), z.number().int().min(1)]).describe("Largest footprint [x, z]; either orientation fits");

async function describePrefab(lib: Library, p: Prefab): Promise<string> {
  const s = await lib.size(p).catch(() => undefined);
  const m = p.meta;
  const anchors = Object.entries(m.anchors).map(([k, v]) => `${k}${formatVec(v)}`);
  return [
    `${p.id}${m.name !== p.id ? ` "${m.name}"` : ""}${s ? ` ${s[0]}×${s[1]}×${s[2]}` : ""}`,
    m.tags.length ? `[${m.tags.join(", ")}]` : "",
    anchors.length ? `anchors ${anchors.join(" ")}` : "",
    Object.keys(m.roles).length ? `roles ${Object.keys(m.roles).join(", ")}` : "",
    p.root.label !== "user" ? `(${p.root.label})` : "",
    m.notes ? `— ${m.notes}` : "",
  ]
    .filter(Boolean)
    .join(" ");
}

/** Prefabs, procedures and knowledge packs (07). Saved palettes live with the palette tools. */
export function registerLibraryTools({ tool, resource, session }: ToolDeps): void {
  tool(
    "prefab_sheet",
    {
      title: "Prefab sheet",
      description:
        "Shows library prefabs as a tilemap of thumbnails with chessboard cell ids (≤24 per page, ~0.8k tokens) plus a caption with each cell's name and size. " +
        'Then stamp a cell: stamp({prefab:"B2", at:...}). Filters: query (words), tags, max_footprint.',
      inputSchema: {
        query: z.string().optional(),
        tags: z.array(z.string()).optional(),
        max_footprint: footprintSchema.optional(),
        page: z.number().int().min(1).optional(),
      },
    },
    async (c, a) => {
      const lib = libraryFor(c, session);
      const s = await lib.sheet({
        ...(a.query ? { query: a.query } : {}),
        ...(a.tags ? { tags: a.tags } : {}),
        ...(a.max_footprint ? { maxFootprint: a.max_footprint as [number, number] } : {}),
        ...(a.page ? { page: a.page } : {}),
      });
      if (!s) return text(`No prefabs match. Library roots: ${lib.roots.map((r) => `${r.label} ${r.path}`).join("; ")}. Save one with prefab_save.`);
      return image(s.png, s.caption);
    },
  );

  tool(
    "prefab_search",
    {
      title: "Search prefabs",
      description: "Text search over library prefabs by words, tags and footprint. At most 10 results: id, size (x×z×height), tags, anchors, roles. Text, <300 tokens.",
      inputSchema: {
        query: z.string().optional(),
        tags: z.array(z.string()).optional(),
        max_footprint: footprintSchema.optional(),
      },
    },
    async (c, a) => {
      const lib = libraryFor(c, session);
      const found = await lib.search({ ...(a.query ? { query: a.query } : {}), ...(a.tags ? { tags: a.tags } : {}), ...(a.max_footprint ? { maxFootprint: a.max_footprint as [number, number] } : {}) });
      if (!found.length) return text("No prefabs match. Try fewer words or tags, or prefab_sheet to browse.");
      const lines = await Promise.all(found.slice(0, 10).map((p) => describePrefab(lib, p)));
      if (found.length > 10) lines.push(`…${found.length - 10} more; narrow the query or browse with prefab_sheet.`);
      return text(lines.join("\n"));
    },
  );

  const atSchema = z
    .union([vec3, z.string(), z.object({ anchor: z.string(), offset: vec3.optional() }), z.object({ face: z.string(), u: z.union([z.number(), z.string()]).optional(), v: z.union([z.number(), z.string()]).optional(), offset: vec3.optional() })])
    .describe('[x,y,z], "component.anchor" (named anchors, or min/max/center/bottom/top/front/back/left/right/storey:n), {anchor:"gate.top", offset:[0,0,3]}, or {face:"keep.front", u:0.5, v:"storey:2"}');

  tool(
    "stamp",
    {
      title: "Stamp prefab",
      description:
        "Places a library prefab (by name, or a cell of the last prefab_sheet) so its anchor (default \"base\", else its minimum corner) lands on at. " +
        'palette_remap recolours prefab roles, keeping shapes and states: {"log":"palette:castle.trim"} or {"leaves":"spruce_leaves"}; a family or block in the prefab works as a key too. ' +
        "rotate/mirror orient it first (the anchor stays on at). Air in the prefab leaves existing blocks unless include_air. Registers a component (kind prefab:<id>) with the prefab's anchors. One undo step. Text.",
      inputSchema: {
        prefab: z.string().describe('Prefab id/name, or a cell like "B2" from the last prefab_sheet'),
        at: atSchema,
        anchor: z.string().optional().describe("Prefab anchor to place at `at`"),
        palette_remap: z.record(z.string(), z.string()).optional(),
        include_air: z.boolean().optional(),
        as: z.string().optional().describe("Component id (default: the prefab id, numbered if taken)"),
        rotate: z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)]).optional().describe("Degrees clockwise seen from above, after mirror; states, block entities and anchors turn too"),
        mirror: z.enum(["x", "z"]).optional().describe("Flip across the prefab's centre: x = east↔west, z = north↔south"),
      },
      readOnly: false,
    },
    async (c, a) => {
      const doc = session.require();
      const lib = libraryFor(c, session);
      const p = await lib.resolve(a.prefab);
      const loaded = await loadPrefab(p, c.registry);
      return editWith(session, () => {
        const r = stampPrefab(doc, env(c), p, loaded, {
          at: a.at as StampAt,
          ...(a.anchor ? { anchor: a.anchor } : {}),
          ...(a.palette_remap ? { remap: a.palette_remap } : {}),
          ...(a.include_air ? { includeAir: true } : {}),
          ...(a.as ? { as: a.as } : {}),
          ...(a.rotate ? { rotate: a.rotate } : {}),
          ...(a.mirror ? { mirror: a.mirror } : {}),
        });
        return formatEdit(doc, r, [`prefab ${p.id} at ${formatVec(r.at)} (min corner ${formatVec(r.origin)}) · component: ${r.component}`]);
      });
    },
  );

  tool(
    "prefab_save",
    {
      title: "Save prefab",
      description:
        "Saves part of the open document (sel/box, or a component) to the user library as prefabs/<name>/prefab.schem + prefab.json, so it can be stamped later. " +
        "Anchors are prefab-local (default: the component's anchors). Without roles, the most-used families become roles named after them. Text.",
      inputSchema: {
        name: z.string().describe("Prefab name (letters, digits, _ or -)"),
        sel: selSchema.optional(),
        box: boxSchema.optional(),
        component: z.string().optional().describe("Save this component's box"),
        tags: z.array(z.string()).optional(),
        notes: z.string().optional(),
        anchors: z.record(z.string(), vec3).optional().describe('Prefab-local points, e.g. {"base":[3,0,3]}'),
        roles: z.record(z.string(), z.array(z.string())).optional().describe('Role → block ids, e.g. {"log":["oak_log"]}'),
        overwrite: z.boolean().optional(),
      },
      readOnly: false,
    },
    async (c, a) => {
      const doc = session.require();
      let snap: Snapshot;
      let anchors: Record<string, Vec3> | undefined = a.anchors as Record<string, Vec3> | undefined;
      if (a.component) {
        if (a.sel !== undefined || a.box !== undefined) throw new Error("give component or sel/box, not both");
        const comp = doc.componentLocal(a.component);
        if (!comp) throw new Error(`no component "${a.component}" (have: ${[...doc.components.keys()].join(", ") || "none"})`);
        snap = snapshotOf(doc, comp.box);
        if (!anchors && Object.keys(comp.anchors).length)
          anchors = Object.fromEntries(Object.entries(comp.anchors).map(([k, v]) => [k, [v[0] - snap.offset[0], v[1] - snap.offset[1], v[2] - snap.offset[2]] as Vec3]));
      } else {
        const { region } = regionOf(c, doc, a);
        const bbox: Box = region instanceof Mask ? region.bbox()! : region;
        snap = snapshotOf(doc, bbox);
        if (region instanceof Mask && !region.isBox()) maskSnapshot(snap, region);
      }
      const r = await savePrefab(
        rootsFor(session, c),
        snap,
        {
          name: a.name,
          ...(a.tags ? { tags: a.tags } : {}),
          ...(a.notes ? { notes: a.notes } : {}),
          ...(anchors ? { anchors } : {}),
          ...(a.roles ? { roles: a.roles } : {}),
          front: doc.meta.front,
          ...(a.overwrite ? { overwrite: true } : {}),
        },
        c.palette,
      );
      const lib = libraryFor(c, session);
      const thumb = await lib.thumbnail(r.prefab).catch(() => undefined);
      return text(
        [
          `${r.replaced ? "replaced" : "saved"} prefab "${a.name}" in ${r.dir}`,
          await describePrefab(lib, r.prefab),
          thumb ? "thumbnail written" : "no thumbnail (renderer unavailable)",
          `Stamp it with stamp({prefab:"${a.name}", at:[x,y,z]}).`,
        ].join("\n"),
      );
    },
  );

  tool(
    "procedure_list",
    {
      title: "List procedures",
      description: "Saved scripts in the library (procedures/*.js) with their parameters from the header comment. Text.",
      inputSchema: { query: z.string().optional() },
    },
    async (c, a) => text(formatProcedureList(await listProcedures(rootsFor(session, c), a.query))),
  );

  tool(
    "run_procedure",
    {
      title: "Run procedure",
      description: "Runs a saved procedure with arguments as one undo step. Not available yet: it needs the script sandbox. Text.",
      inputSchema: { name: z.string(), args: z.record(z.string(), z.unknown()).optional() },
      readOnly: false,
    },
    async (c, a) => {
      const all = await listProcedures(rootsFor(session, c));
      const p = all.find((x) => x.name === a.name);
      if (!p) throw new Error(`no procedure "${a.name}"${all.length ? ` (have: ${all.map((x) => x.name).join(", ")})` : ""}`);
      // TODO(silo C): run p.file in the QuickJS sandbox as one journal entry once it merges.
      throw new Error(`run_procedure needs the script sandbox (silo C), which is not available yet. "${p.name}" is stored at ${p.file}; build its steps with the edit tools for now.`);
    },
  );

  tool(
    "knowledge_list",
    {
      title: "List knowledge packs",
      description: "Style, heuristic and technique packs in the library: names and one-line summaries only (cheap). Advice to weigh, not rules. Text.",
      inputSchema: {
        kind: z.string().optional().describe("style | heuristic | technique"),
        tags: z.array(z.string()).optional(),
      },
    },
    async (c, a) => text(formatKnowledgeList(await listKnowledge(rootsFor(session, c), { ...(a.kind ? { kind: a.kind } : {}), ...(a.tags ? { tags: a.tags } : {}) }))),
  );

  tool(
    "knowledge_read",
    {
      title: "Read knowledge pack",
      description: "Full text of one knowledge pack (markdown, usually 0.3–1k tokens). Also available as the MCP resource autosketch://knowledge/<name>.",
      inputSchema: { name: z.string().describe('e.g. "heuristics/roofs" or "roofs"') },
    },
    async (c, a) => text((await readKnowledge(rootsFor(session, c), a.name)).text),
  );

  resource(
    "knowledge",
    {
      title: "Knowledge pack",
      description: "A style, heuristic or technique pack from the Autosketch library (markdown with frontmatter).",
      uri: "autosketch://knowledge/{+name}",
      mimeType: "text/markdown",
      list: async () =>
        (await listKnowledge(rootsFor(session))).map((e) => ({ uri: `autosketch://knowledge/${e.name}`, name: e.name, title: e.title, description: e.summary, mimeType: "text/markdown" })),
    },
    async (_uri, vars) => ({ text: (await readKnowledge(rootsFor(session), decodeURIComponent(vars.name ?? ""))).text }),
  );
}

/** Clears snapshot positions outside a selection mask (the snapshot covers its bounding box). */
function maskSnapshot(s: Snapshot, mask: Mask): void {
  const [ox, oy, oz] = s.offset;
  for (let y = 0; y < s.size[1]; y++)
    for (let z = 0; z < s.size[2]; z++)
      for (let x = 0; x < s.size[0]; x++) if (!mask.has(ox + x, oy + y, oz + z)) s.blocks[blockIndex(s, x, y, z)] = 0;
  s.blockEntities = s.blockEntities.filter((b) => mask.has(ox + b.pos[0], oy + b.pos[1], oz + b.pos[2]));
  s.entities = s.entities.filter((e) => mask.has(ox + Math.floor(e.pos[0]), oy + Math.floor(e.pos[1]), oz + Math.floor(e.pos[2])));
}
