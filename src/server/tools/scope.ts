import { z } from "zod";
import { formatBox, intersectBox, type Box } from "../../core/region.js";
import { resolveSelection, type SelExpr } from "../../ops/selection.js";
import { diffSince, formatDiff } from "../../perception/diff.js";
import { renderDocument } from "../../perception/render/render.js";
import { BASE, type ScopeSpec } from "../../scope/scopes.js";
import { bakerFor, env, image, selSchema, text, vec3, type Result, type ToolDeps } from "./shared.js";

/**
 * Scoped sessions (docs/design/11-scoped-sessions.md): fork a sandbox for a subagent job, merge it
 * back as one undo step, abandon it, list open jobs. All logic is in src/scope/; addressing (the
 * `scope` argument of every document tool) is in the tool wrapper and Session.
 */

const age = (ms: number) => (ms < 60_000 ? `${Math.round(ms / 1000)}s` : ms < 3_600_000 ? `${Math.round(ms / 60_000)}m` : `${(ms / 3_600_000).toFixed(1)}h`);
const n = (v: number) => v.toLocaleString("en-US");

export function registerScopeTools({ tool, session }: ToolDeps): void {
  tool(
    "scope_fork",
    {
      title: "Fork scoped job",
      description:
        "For very large builds only: when the region in work is too big to keep in mind, hands one distinct part to a subagent in an isolated sandbox holding just its work volume (editable) " +
        "and a context volume (read-only surroundings, default: work grown by 3). Below that size, just build directly; build repeated parts once and copy them instead of forking each. " +
        "Locks the work volume here until scope_merge or scope_abandon. Whole multi-blocks (doors, beds, double chests) cut by the selection are added. " +
        "Returns the scope id and a handoff block to paste into the subagent's prompt (its own local frame, brief, spec). Refused when the job is most of your own work, " +
        "very small, too deeply nested, or overlaps another job's lock. Text, ~250 tokens.",
      inputSchema: {
        work: selSchema.describe("Work volume: the region the job may change (any selection, in this document's coordinates)"),
        context: z
          .union([z.object({ padding: z.number().int().min(0).max(32) }).strict(), selSchema])
          .optional()
          .describe("Context volume: {padding:n} is the work volume plus n blocks all round (default 3), or any selection (e.g. a distant reference)"),
        brief: z.string().min(1).max(4000).describe("The job: what to build and how it must fit in"),
        spec: z
          .object({
            palette: z.string().optional().describe("Palette to build with"),
            levels: z.record(z.string(), z.number().int()).optional().describe('Named heights in this document\'s y, e.g. {"floor2":5,"cornice":12}; translated for the job'),
            anchors: z.record(z.string(), vec3).optional().describe("Named points in this document's coordinates; translated for the job"),
            values: z.record(z.string(), z.union([z.string(), z.number()])).optional().describe('Shared values that aren\'t coordinates, e.g. {"wall_thickness":2}'),
          })
          .optional()
          .describe("Shared design data the job must match"),
      },
      readOnly: false,
    },
    (c, a) => {
      const parent = session.scope;
      const doc = session.require();
      const ctx = { doc, registry: c.registry, index: c.palette };
      const work = resolveSelection(a.work as SelExpr, ctx).mask;
      const cin = a.context as { padding?: unknown; expand?: unknown } | string | undefined;
      const only = (k: string) => typeof cin === "object" && cin !== null && Object.keys(cin).length === 1 && k in cin;
      if (only("expand")) throw new Error('context {"expand": n} was renamed {"padding": n} (01, Terminology)');
      const context = cin === undefined ? undefined : only("padding") && typeof (cin as { padding?: unknown }).padding === "number" ? { padding: (cin as { padding: number }).padding } : resolveSelection(cin as SelExpr, ctx).mask;
      const f = session.scopes.fork(parent, { work, ...(context ? { context } : {}), brief: a.brief, ...(a.spec ? { spec: a.spec as ScopeSpec } : {}), env: env(c) });
      const s = f.scope;
      const cb = s.context.bbox();
      const lines = [
        `forked ${s.id} from ${parent} (depth ${s.depth}) · work ${formatBox(s.workBox)}, ${n(s.work.count())} blocks, locked here · context ${cb ? formatBox(cb) : "none"} (read-only copy)`,
      ];
      if (!f.extension.isEmpty()) lines.push(`extended the work volume by ${n(f.extension.count())} block${f.extension.count() === 1 ? "" : "s"} in ${formatBox(f.extension.bbox()!)} to keep multi-blocks whole`);
      if (f.contextClipped) lines.push(`context clipped by ${n(f.contextClipped)} blocks to stay inside your own volumes`);
      for (const st of f.stale) lines.push(`stale context: ${formatBox(st.box)} is in open job ${st.scope}'s work volume ("${st.brief.slice(0, 50)}"); the sandbox shows it as it is now. Merge ${st.scope} first, or tell the subagent it is still changing.`);
      lines.push("", "Handoff (paste into the subagent's prompt):", "---", f.handoff, "---");
      return text(lines.join("\n"));
    },
  );

  tool(
    "scope_merge",
    {
      doc: false,
      title: "Merge scoped job",
      description:
        "Applies a finished job's changes inside its work volume to the document it was forked from, as one undo step, recomputes fence/wall/stair connections along the seam, " +
        "and releases the lock. report is the subagent's short summary, passed through. Returns the report, change counts by family and the changed box in that document's coordinates " +
        "(never the sandbox's history). render:true adds a view of the merged area (~350 tokens). Text.",
      inputSchema: {
        scope: z.string().describe("The job's scope id"),
        report: z.string().max(4000).describe("The subagent's report: what was built and anything you must know"),
        render: z.boolean().optional(),
      },
      readOnly: false,
    },
    async (c, a): Promise<Result> => {
      const m = session.scopes.merge(a.scope, a.report, env(c));
      const parent = session.scopes.docOf(m.parent);
      if (m.parent === BASE) session.touch();
      const lines = [`merged ${a.scope} into ${m.parent}${m.edit.changed ? ` as op #${m.edit.seq} (one undo step)` : ""} · lock released`, `report: ${a.report}`];
      let mask;
      if (m.edit.changed) {
        const d = diffSince(parent, "op:-1");
        mask = d.mask;
        lines.push(...formatDiff(d, { registry: c.registry, index: c.palette }).replace(/^diff since the last op \(1 op\): /, "changes: ").split("\n"));
      } else lines.push("no blocks changed");
      if (m.seam) lines.push(`seam: ${n(m.seam)} connection${m.seam === 1 ? "" : "s"} recomputed`);
      if (m.synced) {
        const shown = m.synced.slice(0, 8).map((p) => `(${p.join(",")})`).join(" ");
        lines.push(`kept from the world: ${n(m.synced.length)} position${m.synced.length === 1 ? "" : "s"} changed in-game since the fork (hand edits win): ${shown}${m.synced.length > 8 ? " …" : ""}`);
      }
      if (m.components.written.length || m.components.removed.length)
        lines.push(`components: ${[m.components.written.length ? `written ${m.components.written.join(", ")}` : "", m.components.removed.length ? `removed ${m.components.removed.join(", ")}` : ""].filter(Boolean).join("; ")}`);
      if (!a.render) return text(lines.join("\n"));
      const wb = m.scope.workBox;
      const around: Box = { min: [wb.min[0] - 2, wb.min[1] - 2, wb.min[2] - 2], max: [wb.max[0] + 2, wb.max[1] + 2, wb.max[2] + 2] };
      const b = parent.localBounds();
      const r = await renderDocument(parent, await bakerFor(c), { views: ["iso_se"], size: 512, region: b ? intersectBox(around, b) : around, ...(mask ? { highlight: mask } : {}) });
      return { content: [{ type: "text", text: lines.join("\n") }, ...image(r.png, r.caption).content] };
    },
  );

  tool(
    "scope_abandon",
    {
      doc: false,
      title: "Abandon scoped job",
      description: "Discards a job's sandbox (and any jobs forked from it) and releases its lock. Nothing is merged. Text.",
      inputSchema: { scope: z.string().describe("The job's scope id") },
      readOnly: false,
    },
    (_c, a) => {
      const ids = session.scopes.abandon(a.scope, "call");
      return text(`abandoned ${ids.join(", ")} · lock${ids.length === 1 ? "" : "s"} released, nothing merged`);
    },
  );

  tool(
    "scope_list",
    {
      doc: false,
      title: "List scoped jobs",
      description: "Open scoped jobs: id, parent, depth, age, locked work box (in the parent's coordinates), op count, brief. Use it to recover after losing context. Text, ~30 tokens per job.",
      inputSchema: {},
    },
    () => {
      const list = session.scopes.list();
      if (!list.length) return text("No scoped jobs are open.");
      return text(
        list
          .map((s) => `${s.id} · from ${s.parent} · depth ${s.depth} · open ${age(s.ageMs)} · lock ${formatBox(s.lock)} (${n(s.workBlocks)} blocks) · ${s.ops} op${s.ops === 1 ? "" : "s"}${s.children.length ? ` · children ${s.children.join(", ")}` : ""} · "${s.brief.slice(0, 80)}"`)
          .join("\n"),
      );
    },
  );
}
