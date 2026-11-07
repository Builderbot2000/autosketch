import type { Registry } from "../assets/registry.js";
import { shortState } from "../core/blockstate.js";
import { boxSize, formatBox, formatVec, type Vec3 } from "../core/region.js";
import type { Document, EditResult } from "../document/document.js";
import type { ExportResult } from "../formats/index.js";
import { formatMaterialList } from "../formats/materials.js";

/** Terse op results (docs/design/05-operations.md, "Op result contract"). */

const n = (v: number) => v.toLocaleString("en-US");

export function shiftLine(shift: Vec3 | undefined): string | undefined {
  if (!shift) return undefined;
  const moved = shift.map((d, i) => (d ? `${d < 0 ? "+" : "-"}${Math.abs(d)} on ${"xyz"[i]}` : "")).filter(Boolean).join(", ");
  return `origin shifted by ${formatVec(shift)}: existing coordinates moved ${moved}`;
}

export function sizeLine(doc: Document): string {
  const b = doc.localBounds();
  if (!b) return "doc empty";
  const neg = b.min.some((v) => v < 0) ? ` · bounds ${formatBox(b)}` : "";
  return `doc ${boxSize(b).join("×")} (x×y×z), ${n(doc.blockCount())} blocks${neg}`;
}

export function formatEdit(doc: Document, r: EditResult, extra: string[] = []): string {
  const head = r.changed === 0 ? `ok · ${r.op} · nothing changed` : `ok · ${r.op} · ${n(r.changed)} block${r.changed === 1 ? "" : "s"} changed · box ${r.box ? formatBox(r.box) : "-"}`;
  return [head, ...extra, shiftLine(r.shift), sizeLine(doc), r.warnings.length ? `warnings: ${r.warnings.join("; ")}` : undefined].filter(Boolean).join("\n");
}

export function formatInfo(doc: Document, registry: Registry | undefined, path: string | undefined): string {
  const b = doc.localBounds();
  const lines = [
    `document "${doc.meta.name}" · front ${doc.meta.front} · seed ${doc.meta.seed} · DataVersion ${doc.meta.dataVersion}${doc.meta.source ? ` · from ${doc.meta.source}` : ""}`,
    b ? `bounds ${formatBox(b)} = ${boxSize(b).join("×")} (x×y×z) · ${n(doc.blockCount())} blocks` : "empty (no blocks, no size)",
  ];
  const hist = [...doc.voxels.histogram()].sort((a, c) => c[1] - a[1]);
  if (hist.length) {
    const top = hist.slice(0, 12).map(([id, c]) => `${shortState(doc.states.get(id), registry)} ${n(c)}`);
    lines.push(`blocks: ${top.join(", ")}${hist.length > 12 ? ` …+${hist.length - 12} more states` : ""}`);
  }
  if (doc.blockEntities.size) lines.push(`block entities: ${doc.blockEntities.size}`);
  if (doc.components.size) {
    const cs = [...doc.components.keys()].map((id) => {
      const c = doc.componentLocal(id)!;
      return `${id}${c.kind ? ` (${c.kind})` : ""} ${formatBox(c.box)}`;
    });
    lines.push(`components: ${cs.join("; ")}`);
  }
  const pals = doc.palettes.list();
  if (pals.length) lines.push(`palettes: ${pals.map((p) => `${p.name} [${Object.keys(p.roles).join(", ")}]`).join("; ")}`);
  const j = doc.journal;
  lines.push(`history: ${j.cursor} op${j.cursor === 1 ? "" : "s"}${j.canRedo ? `, ${j.entries.length - j.cursor} redoable` : ""}${j.checkpoints.size ? ` · checkpoints: ${[...j.checkpoints.keys()].join(", ")}` : ""}`);
  if (path) lines.push(`saved at ${path}`);
  return lines.join("\n");
}

export function formatHistory(doc: Document, limit: number): string {
  const j = doc.journal;
  if (j.entries.length === 0) return "No ops yet.";
  const cps = new Map<number, string[]>();
  for (const c of j.checkpoints.values()) cps.set(c.seq, [...(cps.get(c.seq) ?? []), c.name]);
  const lines: string[] = [];
  const start = Math.max(0, j.entries.length - limit);
  if (start > 0 || j.dropped > 0) lines.push(`… ${start + j.dropped} earlier op(s)`);
  if (start === 0 && cps.has(0)) lines.push(`  ◆ checkpoint ${cps.get(0)!.join(", ")} (start)`);
  j.entries.slice(start).forEach((e, k) => {
    const i = start + k;
    const mark = i < j.cursor ? " " : "↷";
    lines.push(`${mark} #${e.seq} ${e.summary} · ${n(e.before.length)} changed`);
    const names = cps.get(e.seq);
    if (names && i < j.cursor + 1) lines.push(`  ◆ checkpoint ${names.join(", ")}`);
  });
  if (j.canRedo) lines.push("↷ = undone (redo brings it back; a new edit discards it)");
  return lines.join("\n");
}

export function formatExport(r: ExportResult): string {
  const kb = (b: number) => `${Math.max(1, Math.ceil(b / 1024))} KB`;
  const files = r.files.filter((f) => !f.path.endsWith(".txt"));
  const lines =
    files.length === 1
      ? [`exported ${r.format} → ${files[0]!.path} (${kb(files[0]!.bytes)}${r.limitKb ? ` of ${r.limitKb} KB limit` : ""})`]
      : [`exported ${r.format} as ${files.length} pieces (each under ${r.limitKb} KB):`, ...files.map((f) => `  ${f.path} (${kb(f.bytes)}) at ${formatVec(f.at!)}`), `placement guide: ${r.files.find((f) => f.path.endsWith(".txt"))?.path}`];
  const off = r.offset.some((v) => v !== 0) ? ` · file (0,0,0) = document ${formatVec(r.offset)}` : "";
  lines.push(`size ${r.size.join("×")} (x×y×z) · ${n(r.blocks)} blocks${off}`);
  lines.push(r.hint);
  if (r.materials) lines.push(formatMaterialList(r.materials));
  for (const w of r.warnings) lines.push(`warning: ${w}`);
  return lines.join("\n");
}
