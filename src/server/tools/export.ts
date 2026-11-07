import { z } from "zod";
import type { PublicBox } from "../../core/region.js";
import { dataVersionFor } from "../../core/version.js";
import { exportDocument } from "../../formats/index.js";
import { renderDocument } from "../../perception/render/render.js";
import { formatExport } from "../format.js";
import { bakerFor, box, boxSchema, text, type ToolDeps } from "./shared.js";

/** Export to schematic files and instance targets (08). */
export function registerExportTools({ tool, session }: ToolDeps): void {
  tool(
    "export",
    {
      title: "Export",
      description:
        "Writes the document (or region) as a schematic file. The file's minimum corner is (0,0,0); the result gives the document-local offset. " +
        "target axiom → Axiom blueprint .bp (with a rendered thumbnail) in config/axiom/blueprints/, or .schem in schematics/ with format:\"schem\" · create → structure .nbt in schematics/, checked against Create's size limit, with a material list · " +
        "path → any file or folder (format from the extension) · omitted → the document's exports/ folder. Never overwrites outside exports/ without overwrite:true. " +
        "split:true tiles an over-limit Create export and writes a placement guide. Text.",
      inputSchema: {
        target: z.enum(["axiom", "create", "path"]).optional(),
        format: z.enum(["schem", "nbt", "native", "bp"]).optional().describe("Default: bp for axiom, nbt for create, from the extension for path, else schem. .bp leaves out block entities (use schem to keep chest contents etc.)"),
        path: z.string().optional().describe("File or folder for target path"),
        name: z.string().optional().describe("File name without extension (default: the document name)"),
        region: boxSchema.optional(),
        schem_version: z.union([z.literal(2), z.literal(3)]).optional().describe(".schem version (default 3)"),
        include_air: z.boolean().optional().describe(".nbt/.bp: write explicit air so placing clears the space"),
        split: z.boolean().optional(),
        overwrite: z.boolean().optional(),
      },
      readOnly: false,
    },
    async (c, a) => {
      const doc = session.require();
      await session.flush();
      const dataVersion = dataVersionFor(c.info.mcVersion);
      const r = await exportDocument(
        doc,
        {
          ...(a.target ? { target: a.target } : {}),
          ...(a.format ? { format: a.format } : {}),
          ...(a.path ? { path: a.path } : {}),
          ...(a.name ? { name: a.name } : {}),
          ...(a.region ? { region: box(a.region as PublicBox) } : {}),
          ...(a.schem_version ? { schemVersion: a.schem_version } : {}),
          ...(a.include_air ? { includeAir: true } : {}),
          ...(a.split ? { split: true } : {}),
          ...(a.overwrite ? { overwrite: true } : {}),
        },
        {
          defaultDir: session.exportsDir!,
          registry: c.registry,
          plugins: c.plugins,
          ...(c.info.root ? { instanceRoot: c.info.root } : {}),
          ...(dataVersion ? { dataVersion } : {}),
          thumbnail: async (region) => (await renderDocument(doc, await bakerFor(c), { views: ["iso_se"], size: 96, thumbnail: true, region })).png,
        },
      );
      return text(formatExport(r));
    },
  );
}
