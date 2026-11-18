import { z } from "zod";
import { canonicalEntries, knownEntries, type SetEntry } from "../../library/component-set.js";
import { readKit, writeKit } from "../../library/knowledge.js";
import { scanPrefabs } from "../../library/prefabs.js";
import { rootsFor } from "./library-context.js";
import { text, type ToolDeps } from "./shared.js";

const entrySchema = z.object({
  prefab: z.string().describe("Library prefab name (axiom/… included)"),
  label: z.string().optional().describe('What you and the player call it, e.g. "corner tower"'),
  notes: z.string().optional(),
});

/**
 * The session's component set and kits (docs/design/17-reusable-components.md, pieces 1 and 2).
 * The record lives on the session (`session.componentSet`); this module only adapts it.
 */
export function registerComponentTools({ tool, session }: ToolDeps): void {
  tool(
    "component_set",
    {
      doc: false,
      title: "Component set",
      description:
        "The session's component set: the library prefabs the player picked, with labels, used as your vocabulary for this session (advice, not a rule; it ends with the session). " +
        "No arguments shows it. add (replaces an entry with the same label or prefab), remove (labels or prefabs), clear; load replaces the set with a saved kit; " +
        "save_as keeps it as a kit pack (knowledge/kits/, only when the player asks). Applied in that order: load or clear, remove, add, save_as. " +
        "Unknown prefab names are refused with the nearest names. Every result shows the whole set. Text, ~15 tokens per entry.",
      inputSchema: {
        add: z.array(entrySchema).optional(),
        remove: z.array(z.string()).optional(),
        clear: z.boolean().optional(),
        load: z.string().optional().describe('Kit name, e.g. "gothic cathedral kit"'),
        save_as: z.string().optional().describe("Kit name; an existing kit of that name in your library gets the new entries and keeps its notes"),
      },
      readOnly: false,
    },
    async (c, a) => {
      const set = session.componentSet;
      if (a.load !== undefined && a.clear) throw new Error("give load or clear, not both");
      const roots = rootsFor(session, c);
      const needPrefabs = a.load !== undefined || !!a.add?.length;
      const all = needPrefabs ? await scanPrefabs(roots) : [];
      // Check everything before changing anything, so a refused call leaves the set as it was.
      const adds = a.add?.length ? canonicalEntries(all, a.add as SetEntry[]) : [];
      const notes: string[] = [];
      const loaded = a.load !== undefined ? await readKit(roots, a.load) : undefined;
      if (loaded) {
        const known = knownEntries(all, loaded.entries);
        set.replace(known.entries);
        notes.push(`loaded kit "${loaded.kit.title}" (${loaded.kit.name}, ${loaded.kit.root})`, ...known.warnings);
      }
      if (a.clear) {
        set.clear();
        notes.push("cleared");
      }
      if (a.remove?.length) {
        const missing = set.remove(a.remove);
        if (missing.length) notes.push(`not in the set: ${missing.join(", ")}`);
      }
      if (adds.length) set.add(adds);
      if (a.save_as !== undefined) {
        if (!set.size) notes.push("nothing saved: the set is empty");
        else {
          const w = await writeKit(roots, a.save_as, set.entries);
          notes.push(`${w.replaced ? "updated" : "saved"} kit "${a.save_as}" in ${w.file}`);
        }
      }
      return text([...notes, set.format()].join("\n"));
    },
  );
}
