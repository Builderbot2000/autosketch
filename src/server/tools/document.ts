import { basename } from "node:path";
import { z } from "zod";
import type { Vec3 } from "../../core/region.js";
import { dataVersionFor } from "../../core/version.js";
import { importFile } from "../../formats/index.js";
import { formatHistory, formatInfo, shiftLine, sizeLine } from "../format.js";
import { editWith, text, vec3, type ToolDeps } from "./shared.js";

/** Document lifecycle (04): new, open/import, list, info. */
export function registerDocumentTools({ tool, session }: ToolDeps): void {
  tool(
    "doc_new",
    {
      doc: false,
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
      doc: false,
      title: "Open document",
      description:
        "Opens a saved document by name and makes it current (the previous one is saved and closed). With path, imports a schematic file instead " +
        "(.schem v1–v3, Axiom .bp, Create/structure .nbt, Litematica .litematic, legacy MCEdit .schematic, .autosketch) as a new workspace document named name (default: the file name). Unknown blocks and block-entity NBT are kept. " +
        "Undo history of a saved document continues where it left off; an imported file starts fresh. Text.",
      inputSchema: {
        name: z.string().optional().describe("Workspace document name (required unless path is given)"),
        path: z.string().optional().describe("Schematic file to import"),
        front: z.enum(["north", "south", "east", "west"]).optional().describe("Front facade for an imported file (default south)"),
        overwrite: z.boolean().optional().describe("Replace an existing workspace document of that name when importing"),
      },
      readOnly: false,
    },
    async (c, a) => {
      if (!a.path) {
        if (!a.name) throw new Error("Give name (a workspace document) or path (a file to import).");
        const doc = await session.open(a.name, c.book);
        return text(formatInfo(doc, c.registry, session.path));
      }
      const name = a.name ?? basename(a.path).replace(/\.[^.]*$/, "").replace(/[^a-z0-9_-]+/gi, "_").replace(/^_+|_+$/g, "").slice(0, 64);
      const dataVersion = dataVersionFor(c.info.mcVersion);
      const imp = await importFile(a.path, {
        name: name || "imported",
        registry: c.registry,
        palettes: c.book,
        plugins: c.plugins,
        ...(dataVersion ? { dataVersion } : {}),
        ...(a.front ? { front: a.front } : {}),
      });
      await session.adopt(imp.doc, a.overwrite ? { overwrite: true } : {});
      return text([`imported ${a.path} (${imp.format})`, formatInfo(imp.doc, c.registry, session.path), ...imp.warnings.map((w) => `warning: ${w}`)].join("\n"));
    },
  );

  tool(
    "doc_list",
    { doc: false, title: "List documents", description: "Lists documents saved in the workspace, newest first. Text.", inputSchema: {} },
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
}

/** Live world link (13, *World undo and restore*): crosses the sync barrier and forces the patch. */
const overwriteHandEdits = z
  .boolean()
  .optional()
  .describe("Linked document only: step past a world sync and force the world to the result, erasing the player's hand edits. Only when the player asked to discard them.");
const stepOpts = (a: { overwriteHandEdits?: boolean | undefined }) => (a.overwriteHandEdits ? { overwriteHandEdits: true } : {});

/** Journal (04): undo, redo, checkpoints, history. */
export function registerHistoryTools({ tool, session }: ToolDeps): void {
  const steps = (dir: "undo" | "redo", n: number, opts: { overwriteHandEdits?: boolean }): string => {
    const doc = session.require();
    const done: string[] = [];
    let net: Vec3 = [0, 0, 0];
    for (let i = 0; i < n; i++) {
      const r = dir === "undo" ? doc.undo(opts) : doc.redo(opts);
      if (!r) break;
      done.push(`#${r.entry.seq} ${r.entry.summary}`);
      if (r.shift) net = [net[0] + r.shift[0], net[1] + r.shift[1], net[2] + r.shift[2]];
    }
    if (!done.length) return dir === "undo" ? "Nothing to undo." : "Nothing to redo.";
    const verb = dir === "undo" ? "undid" : "redid";
    return [`${verb} ${done.length}: ${done.join("; ")}`, shiftLine(net.some((v) => v) ? net : undefined), sizeLine(doc)].filter(Boolean).join("\n");
  };

  tool(
    "undo",
    { title: "Undo", description: "Undoes the last op (or several). Text.", inputSchema: { steps: z.number().int().min(1).max(1000).optional(), overwriteHandEdits }, readOnly: false },
    (_c, a) => editWith(session, () => steps("undo", a.steps ?? 1, stepOpts(a))),
  );

  tool(
    "redo",
    { title: "Redo", description: "Redoes undone ops. Text.", inputSchema: { steps: z.number().int().min(1).max(1000).optional(), overwriteHandEdits }, readOnly: false },
    (_c, a) => editWith(session, () => steps("redo", a.steps ?? 1, stepOpts(a))),
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
      inputSchema: { name: z.string(), overwriteHandEdits },
      readOnly: false,
    },
    (_c, a) =>
      editWith(session, (doc) => {
        const r = doc.restore(a.name, stepOpts(a));
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
}
