import type { PackStack } from "../assets/pack.js";
import type { Category } from "../plugins/types.js";
import { chroma, colorName, hue, type Lab, type RGB } from "./color.js";
import type { Family } from "./families.js";
import { Image, type RGBA } from "./image.js";
import { CATEGORY_ORDER, isArchitectural, type PaletteIndex } from "./index.js";
import { TextureLoader, Tinter } from "./textures.js";
import { BADGES, drawCube } from "./tile.js";
import { textWidth } from "./font.js";

/**
 * Tilemap sheets (docs/design/03-palette.md): deterministic grids of material tiles with
 * chessboard cell ids, so the agent can see many materials at once and pick by cell range.
 */

export type Cell =
  /** `similar`: near-identical families folded into this tile to keep the overview on one page. */
  | { kind: "family"; id: string; similar?: string[] }
  | { kind: "series"; id: string }
  | { kind: "variant"; family: string; block: string };

export interface SheetSpec {
  /** "overview" | "all" | "category:<c>" | "family:<id>" | "series:<id>" | "similar:<id>" | "filter:<query>" */
  sheet: string;
  page?: number; // 1-based
  /** Cell range to enlarge, e.g. "C4:H9" (64px tiles). */
  zoom?: string;
}

export interface SheetLayout {
  spec: Required<Pick<SheetSpec, "sheet" | "page">> & { zoom?: string };
  columns: number;
  rows: number;
  pages: number;
  /** cells[row][col], undefined = empty. Row/col are 0-based within the page. */
  cells: (Cell | undefined)[][];
  /** First row label on this page (1-based, continuous across pages). */
  rowOffset: number;
  bands: { category: string; fromRow: number; toRow: number }[]; // 1-based row labels
  total: number;
}

export const COLUMNS = 32;
export const ROWS_PER_PAGE = 32;
/** Sheets may widen to this many columns to stay on one page (~1210 px). */
export const MAX_COLUMNS = 40;

// ---------------------------------------------------------------------------------------------
// Cell ids
// ---------------------------------------------------------------------------------------------

export function columnLabel(i: number): string {
  let s = "";
  let n = i + 1;
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

export function parseCell(ref: string): { col: number; row: number } {
  const m = /^\s*([A-Za-z]+)(\d+)\s*$/.exec(ref);
  if (!m) throw new Error(`bad cell "${ref}" (expected e.g. C4)`);
  let col = 0;
  for (const ch of m[1]!.toUpperCase()) col = col * 26 + (ch.charCodeAt(0) - 64);
  return { col: col - 1, row: Number(m[2]) };
}

/** "C4:F6" / "B9" → list of {col,row} (row = 1-based label), row-major. */
export function parseRange(ref: string): { col: number; row: number }[] {
  const [a, b] = ref.split(":");
  const p = parseCell(a!);
  const q = b ? parseCell(b) : p;
  const out: { col: number; row: number }[] = [];
  for (let r = Math.min(p.row, q.row); r <= Math.max(p.row, q.row); r++)
    for (let c = Math.min(p.col, q.col); c <= Math.max(p.col, q.col); c++) out.push({ col: c, row: r });
  return out;
}

// ---------------------------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------------------------

interface Item {
  cell: Cell;
  category: string;
  lab: Lab;
  noise?: number;
  /** Shape coverage key; only families with the same key can fold together. */
  shapeKey?: string;
  richness?: number;
}

export function layoutSheet(index: PaletteIndex, spec: SheetSpec): SheetLayout {
  const page = Math.max(1, spec.page ?? 1);
  const [kind, ...rest] = spec.sheet.split(":");
  const arg = rest.join(":");
  let items: Item[];
  let banded = true;
  switch (kind) {
    case "overview":
      items = overviewItems(index);
      break;
    case "similar": {
      const hit = overviewItems(index).find((i) => i.cell.kind === "family" && (i.cell.id === arg || i.cell.similar?.includes(arg)));
      if (!hit || hit.cell.kind !== "family") throw new Error(`"${arg}" is not on the overview`);
      items = [hit.cell.id, ...(hit.cell.similar ?? [])].map((id) => ({ cell: { kind: "family", id }, category: "", lab: [0, 0, 0] }));
      banded = false;
      break;
    }
    case "all":
      items = materialItems(index, () => true);
      break;
    case "category":
      if (!CATEGORY_ORDER.includes(arg as Category)) throw new Error(`unknown category "${arg}" (one of ${CATEGORY_ORDER.join(", ")})`);
      items = materialItems(index, (f) => f.category === arg);
      break;
    case "filter":
      items = materialItems(index, compileFilter(index, arg));
      break;
    case "family":
      items = familyItems(index, arg);
      banded = false;
      break;
    case "series":
      items = seriesItems(index, arg);
      banded = false;
      break;
    default:
      throw new Error(`unknown sheet "${spec.sheet}"`);
  }

  let columns = banded ? COLUMNS : Math.min(8, Math.max(1, Math.ceil(Math.sqrt(items.length))));
  let allRows: { cells: (Cell | undefined)[]; category: string }[] = [];
  if (banded) {
    const build = (cols: number) => {
      const rows: typeof allRows = [];
      for (const cat of CATEGORY_ORDER) {
        const band = items.filter((i) => i.category === cat);
        if (band.length) rows.push(...bandRows(band, cols).map((cells) => ({ cells, category: cat })));
      }
      return rows;
    };
    allRows = build(columns);
    // Category bands round up to whole rows; widen (up to MAX_COLUMNS) before spilling onto a second page.
    while (allRows.length > ROWS_PER_PAGE && columns < MAX_COLUMNS) allRows = build(++columns);
    if (allRows.length > ROWS_PER_PAGE && columns > COLUMNS) allRows = build((columns = COLUMNS));
  } else {
    for (let i = 0; i < items.length; i += columns) allRows.push({ cells: items.slice(i, i + columns).map((x) => x.cell), category: "" });
  }

  const pages = Math.max(1, Math.ceil(allRows.length / ROWS_PER_PAGE));
  if (page > pages) throw new Error(`sheet "${spec.sheet}" has ${pages} page(s)`);
  const start = (page - 1) * ROWS_PER_PAGE;
  const pageRows = allRows.slice(start, start + ROWS_PER_PAGE);
  const bands: SheetLayout["bands"] = [];
  pageRows.forEach((r, i) => {
    const label = start + i + 1;
    const last = bands[bands.length - 1];
    if (last && last.category === r.category) last.toRow = label;
    else bands.push({ category: r.category, fromRow: label, toRow: label });
  });

  let layout: SheetLayout = {
    spec: { sheet: spec.sheet, page },
    columns,
    rows: pageRows.length,
    pages,
    cells: pageRows.map((r) => r.cells),
    rowOffset: start + 1,
    bands: banded ? bands : [],
    total: items.length,
  };
  if (spec.zoom) layout = zoomLayout(layout, spec.zoom);
  return layout;
}

/** Families not in a series, plus one item per series, filtered. */
function materialItems(index: PaletteIndex, keep: (f: Family) => boolean): Item[] {
  const items: Item[] = [];
  const seenSeries = new Set<string>();
  for (const f of index.buildable()) {
    if (!keep(f)) continue;
    const s = index.stats(f.id);
    if (!s) continue;
    if (f.series) {
      if (seenSeries.has(f.series)) continue;
      seenSeries.add(f.series);
      // Series sort as neutral (multi-coloured) within their first member's category.
      items.push({ cell: { kind: "series", id: f.series }, category: f.category, lab: [s.lab[0], 0, 0] });
    } else
      items.push({
        cell: { kind: "family", id: f.id },
        category: f.category,
        lab: s.lab,
        noise: s.noise,
        shapeKey: ["stairs", "slab", "wall"].map((k) => (f.shapes[k as keyof Family["shapes"]] ? 1 : 0)).join(""),
        richness: (f.namespace === "minecraft" ? 1000 : 0) + Object.keys(f.shapes).length * 10 + f.variants.length,
      });
  }
  return items;
}

/** Rows a banded layout needs at `columns` columns. */
function bandedRowCount(items: Item[], columns: number): number {
  let rows = 0;
  for (const cat of CATEGORY_ORDER) {
    const n = items.filter((i) => i.category === cat).length;
    rows += Math.ceil(n / columns);
  }
  return rows;
}

const overviewCache = new WeakMap<PaletteIndex, Item[]>();

/**
 * Overview items under a one-page budget. Any modpack can exceed a page (ATM10 adds 165 distinct
 * woods), so when the architectural families don't fit at MAX_COLUMNS, near-identical families
 * (same category and shape coverage, close colour and texture busyness) fold into one tile,
 * tightening until they fit. Folded members stay reachable via the similar:<id> sheet.
 */
export function overviewItems(index: PaletteIndex): Item[] {
  const cached = overviewCache.get(index);
  if (cached) return cached;
  const items = materialItems(index, (f) => isArchitectural(f));
  let result = items;
  for (let threshold = 3; bandedRowCount(result, MAX_COLUMNS) > ROWS_PER_PAGE && threshold <= 40; threshold += 1) {
    result = foldSimilar(items, threshold);
  }
  overviewCache.set(index, result);
  return result;
}

function foldSimilar(items: Item[], threshold: number): Item[] {
  const out: Item[] = [];
  const reps: Item[] = [];
  const ordered = [...items].sort((a, b) => (b.richness ?? 0) - (a.richness ?? 0) || (idOf(a) < idOf(b) ? -1 : 1));
  for (const it of ordered) {
    if (it.cell.kind !== "family") {
      out.push(it);
      continue;
    }
    const rep = reps.find(
      (r) =>
        r.category === it.category &&
        r.shapeKey === it.shapeKey &&
        Math.hypot(r.lab[0] - it.lab[0], r.lab[1] - it.lab[1], r.lab[2] - it.lab[2]) < threshold &&
        Math.abs((r.noise ?? 0) - (it.noise ?? 0)) < threshold / 2,
    );
    if (rep && rep.cell.kind === "family") {
      rep.cell.similar = [...(rep.cell.similar ?? []), it.cell.id];
    } else {
      const copy: Item = { ...it, cell: { kind: "family", id: it.cell.id } };
      reps.push(copy);
      out.push(copy);
    }
  }
  return out;
}

const idOf = (i: Item) => (i.cell.kind === "variant" ? i.cell.block : i.cell.id);

function familyItems(index: PaletteIndex, id: string): Item[] {
  const f = index.family(id) ?? index.familyOfBlock(id);
  if (!f) throw new Error(`no family "${id}"`);
  const lab: Lab = [0, 0, 0];
  return [f.base, ...f.variants.map((v) => v.base)].map((block) => ({ cell: { kind: "variant", family: f.id, block }, category: "", lab }));
}

function seriesItems(index: PaletteIndex, id: string): Item[] {
  const s = index.series.get(id);
  if (!s) throw new Error(`no series "${id}"`);
  return s.members.map((m) => ({ cell: { kind: "family", id: m }, category: "", lab: [0, 0, 0] }));
}

/**
 * Lays one category out as rows: neutrals first, then by hue across columns; within a column,
 * light to dark. Rectangular selections then give coherent palettes.
 */
function bandRows(band: Item[], columns: number): Cell[][] {
  const sorted = [...band].sort((a, b) => {
    const na = chroma(a.lab) < 12, nb = chroma(b.lab) < 12;
    if (na !== nb) return na ? -1 : 1;
    return na ? b.lab[0] - a.lab[0] : hue(a.lab) - hue(b.lab);
  });
  const rows = Math.ceil(sorted.length / columns);
  const grid: Cell[][] = Array.from({ length: rows }, () => []);
  const cols = Math.ceil(sorted.length / rows);
  for (let c = 0; c < cols; c++) {
    const col = sorted.slice(c * rows, (c + 1) * rows).sort((a, b) => b.lab[0] - a.lab[0]);
    col.forEach((it, r) => (grid[r]![c] = it.cell));
  }
  return grid;
}

function zoomLayout(base: SheetLayout, range: string): SheetLayout {
  const refs = parseRange(range);
  const rows = [...new Set(refs.map((r) => r.row))].sort((a, b) => a - b);
  const cols = [...new Set(refs.map((r) => r.col))].sort((a, b) => a - b);
  if (rows.length * cols.length > 64) throw new Error(`zoom range too large (${rows.length}×${cols.length}, max 64 cells)`);
  const cells = rows.map((r) => cols.map((c) => base.cells[r - base.rowOffset]?.[c]));
  return { ...base, spec: { ...base.spec, zoom: range }, columns: cols.length, rows: rows.length, cells, rowOffset: rows[0]!, bands: [], zoomCols: cols } as SheetLayout & { zoomCols: number[] };
}

/** Filter query: space-separated terms — mod:<ns> has:<shape> cat:<category> text:<substring> */
function compileFilter(index: PaletteIndex, query: string): (f: Family) => boolean {
  const terms = query.split(/\s+/).filter(Boolean);
  const preds = terms.map((t): ((f: Family) => boolean) => {
    const [k, v = ""] = t.includes(":") ? [t.slice(0, t.indexOf(":")), t.slice(t.indexOf(":") + 1)] : ["text", t];
    switch (k) {
      case "mod":
        return (f) => f.namespace === v || index.registry.modName(f.namespace).toLowerCase() === v.toLowerCase();
      case "has":
        return (f) => (v === "variants" ? f.variants.length > 0 : v === "extras" ? Object.keys(f.extras).length > 0 : !!f.shapes[v as keyof Family["shapes"]]);
      case "cat":
        return (f) => f.category === v;
      case "text":
        return (f) => f.id.includes(v);
      default:
        throw new Error(`unknown filter term "${t}" (use mod:, has:, cat:, text:)`);
    }
  });
  return (f) => preds.every((p) => p(f));
}

// ---------------------------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------------------------

const BG: RGBA = [24, 26, 30, 255];
const TILE_BG: RGBA = [40, 44, 52, 255];
const LABEL: RGBA = [200, 205, 215, 255];
const BAND: RGBA = [90, 96, 110, 255];

export interface RenderedSheet {
  layout: SheetLayout;
  png: Buffer;
  caption: string;
  width: number;
  height: number;
}

export class SheetRenderer {
  private readonly textures: TextureLoader;
  private readonly tinter: Tinter;
  private ready?: Promise<void>;

  constructor(
    private readonly index: PaletteIndex,
    stack: PackStack,
  ) {
    this.textures = new TextureLoader(stack);
    this.tinter = new Tinter(this.textures);
  }

  async render(spec: SheetSpec): Promise<RenderedSheet> {
    this.ready ??= this.tinter.init();
    await this.ready;
    const layout = layoutSheet(this.index, spec);
    const T = spec.zoom ? 64 : layout.columns <= 8 ? 48 : 32;
    const lm = 4 + textWidth(String(layout.rowOffset + layout.rows - 1)) + 4;
    const tm = 4 + 7 + 4;
    const width = lm + layout.columns * (T + 1) + 4;
    const height = tm + layout.rows * (T + 1) + 4;
    const img = new Image(width, height);
    img.fillRect(0, 0, width, height, BG);

    const colIds = (layout as SheetLayout & { zoomCols?: number[] }).zoomCols ?? Array.from({ length: layout.columns }, (_, i) => i);
    colIds.forEach((c, i) => {
      const label = columnLabel(c);
      img.text(label, lm + i * (T + 1) + Math.floor((T - textWidth(label)) / 2), 4, LABEL);
    });
    const rowLabels = this.rowLabels(layout);
    for (let r = 0; r < layout.rows; r++) {
      const label = String(rowLabels[r]);
      img.text(label, lm - 4 - textWidth(label), tm + r * (T + 1) + Math.floor((T - 7) / 2), LABEL);
    }
    // Category band separators.
    for (const b of layout.bands.slice(1)) {
      const y = tm + (b.fromRow - layout.rowOffset) * (T + 1) - 1;
      img.fillRect(lm - 2, y, layout.columns * (T + 1) + 2, 1, BAND);
    }

    await Promise.all(
      layout.cells.flatMap((row, r) =>
        row.map(async (cell, c) => {
          const x = lm + c * (T + 1);
          const y = tm + r * (T + 1);
          img.fillRect(x, y, T, T, TILE_BG);
          if (cell) await this.drawCell(img, cell, x, y, T);
        }),
      ),
    );

    return { layout, png: img.encodePng(), caption: this.caption(layout, width, height), width, height };
  }

  private rowLabels(layout: SheetLayout): number[] {
    if (layout.spec.zoom) return [...new Set(parseRange(layout.spec.zoom).map((r) => r.row))].sort((a, b) => a - b);
    return Array.from({ length: layout.rows }, (_, i) => layout.rowOffset + i);
  }

  private async drawCell(img: Image, cell: Cell, x: number, y: number, T: number): Promise<void> {
    const reg = this.index.registry;
    const pad = Math.round(T * 0.06);
    const size = T - pad * 2;
    let blockId: string;
    let family: Family | undefined;
    let seriesColors: RGB[] | undefined;
    if (cell.kind === "series") {
      const s = this.index.series.get(cell.id)!;
      blockId = this.index.family(s.members[0]!)!.base;
      seriesColors = s.members.map((m) => this.index.stats(m)?.rgb ?? [128, 128, 128]);
    } else if (cell.kind === "family") {
      family = this.index.family(cell.id);
      blockId = family?.base ?? cell.id;
    } else {
      blockId = cell.block;
      family = this.index.family(cell.family);
      if (cell.block !== family?.base) family = undefined; // badges describe the variant's own shapes below
    }
    const b = reg.get(blockId);
    if (!b) return;
    const tint = b.tinted ? this.tinter.tintFor(b.id) : undefined;
    const tintAll = !!tint && !/grass_block|_grass$|turf|sod/.test(b.id); // grass blocks tint only the top
    const [top, left, right] = await Promise.all([
      b.faceTextures.up ? this.textures.load(b.faceTextures.up) : undefined,
      this.textures.load(b.faceTextures.south ?? b.faceTextures.north ?? b.faceTextures.up ?? ""),
      this.textures.load(b.faceTextures.east ?? b.faceTextures.north ?? b.faceTextures.up ?? ""),
    ]);
    drawCube(img, x + pad, y + pad, size, { top, left, right, topTint: tint, sideTint: tintAll ? tint : undefined });

    // Badges: shape pips top-left, extras pip top-right, variant count bottom-right, series strip bottom.
    const shapes = family?.shapes ?? (cell.kind === "variant" ? this.variantShapes(cell) : {});
    const pip = Math.max(2, Math.round(T / 12));
    let px = x + 1;
    for (const k of ["stairs", "slab", "wall", "fence"] as const) {
      if (shapes[k]) img.fillRect(px, y + 1, pip, pip, BADGES[k]);
      px += pip + 1;
    }
    if (family && Object.keys(family.extras).length) img.fillRect(x + T - pip - 1, y + 1, pip, pip, BADGES.extras);
    const variants = family?.variants.length ?? 0;
    if (variants > 0 && cell.kind !== "variant") {
      const label = String(Math.min(99, variants + 1));
      const w = textWidth(label);
      img.fillRect(x + T - w - 2, y + T - 9, w + 2, 9, [0, 0, 0, 170]);
      img.text(label, x + T - w - 1, y + T - 8, [255, 255, 255, 255]);
    }
    if (cell.kind === "family" && cell.similar?.length) {
      const label = `+${Math.min(99, cell.similar.length)}`;
      const w = textWidth(label);
      img.fillRect(x, y + T - 9, w + 2, 9, [0, 0, 0, 170]);
      img.text(label, x + 1, y + T - 8, [90, 230, 255, 255]);
    }
    if (seriesColors) {
      const sw = Math.max(1, Math.floor(T / seriesColors.length));
      const h = Math.max(3, Math.round(T / 10));
      seriesColors.forEach((c, i) => img.fillRect(x + i * sw, y + T - h, sw, h, [c[0], c[1], c[2], 255]));
    }
  }

  private variantShapes(cell: Extract<Cell, { kind: "variant" }>): Family["shapes"] {
    const f = this.index.family(cell.family);
    if (!f) return {};
    if (f.base === cell.block) return f.shapes;
    return f.variants.find((v) => v.base === cell.block)?.shapes ?? {};
  }

  caption(layout: SheetLayout, width: number, height: number): string {
    const s = layout.spec;
    const lines: string[] = [];
    const where = `${s.sheet}${layout.pages > 1 ? ` page ${s.page}/${layout.pages}` : ""}${s.zoom ? ` zoom ${s.zoom}` : ""}`;
    lines.push(`sheet ${where}: ${layout.total} tiles, ${layout.columns}×${layout.rows} shown (${width}×${height}px).`);
    if (layout.bands.length) lines.push("rows: " + layout.bands.map((b) => `${b.fromRow}-${b.toRow} ${b.category}`).join(", ") + ".");
    if (!s.zoom && layout.bands.length) lines.push("Within a category: neutrals first, then hue left→right; light→dark top→bottom.");
    lines.push("Badges: top-left pips = stairs(yellow) slab(blue) wall(red) fence(green); top-right magenta = extra shapes (roof pieces etc.); bottom-right number = variant count; colour strip = dye series.");
    if (s.sheet === "overview") {
      const all = this.index.buildable().length;
      const folded = layout.cells.flat().reduce((n, c) => n + (c?.kind === "family" ? (c.similar?.length ?? 0) : 0), 0);
      lines.push(`Overview shows materials with stairs/slabs, variants or dye series; all ${all} buildable families are on category:<name> sheets.`);
      if (folded) lines.push(`To fit one page, ${folded} near-identical materials are folded into similar tiles (cyan +n, bottom-left); open similar:<family id> to see them.`);
    }
    if (s.zoom || s.sheet.startsWith("family:") || s.sheet.startsWith("series:") || s.sheet.startsWith("similar:")) lines.push(this.describeCells(layout));
    lines.push(`Pick with palette_pick({sheet:"${s.sheet}"${s.page > 1 ? `, page:${s.page}` : ""}, roles:{wall:"C4:F6", ...}}); enlarge with zoom:"C4:H9".`);
    return lines.join("\n");
  }

  /**
   * Small sheets (family, series, zoom) list their cells in text, compactly: grouped by namespace,
   * with the family's base name abbreviated to "~". Never used for full overview pages.
   */
  private describeCells(layout: SheetLayout): string {
    const zoomCols = (layout as SheetLayout & { zoomCols?: number[] }).zoomCols;
    const rowLabels = this.rowLabels(layout);
    const familyName = layout.spec.sheet.startsWith("family:") ? this.index.family(layout.spec.sheet.slice(7))?.base.split(":")[1] : undefined;
    const groups = new Map<string, string[]>();
    layout.cells.forEach((row, r) =>
      row.forEach((cell, c) => {
        if (!cell) return;
        const ref = `${columnLabel(zoomCols?.[c] ?? c)}${rowLabels[r]}`;
        let id: string;
        let extra = "";
        if (cell.kind === "variant") {
          id = cell.block;
          const shapes = Object.keys(this.variantShapes(cell)).filter((k) => ["stairs", "slab", "wall", "fence"].includes(k));
          if (shapes.length) extra = `[${shapes.join(",")}]`;
        } else if (cell.kind === "family") {
          id = cell.id;
          const f = this.index.family(cell.id);
          const st = this.index.stats(cell.id);
          const shapes = f ? Object.keys(f.shapes).filter((k) => ["stairs", "slab", "wall", "fence"].includes(k)) : [];
          extra = [st ? colorName(st.lab) : "", shapes.length ? `[${shapes.join(",")}]` : "", f?.variants.length ? `+${f.variants.length}v` : "", cell.similar?.length ? `≈${cell.similar.length} similar` : ""].filter(Boolean).join(" ");
        } else {
          id = cell.id;
          extra = `series of ${this.index.series.get(cell.id)?.members.length ?? 0}`;
        }
        const [ns, path] = [id.slice(0, id.indexOf(":")), id.slice(id.indexOf(":") + 1)];
        const name = familyName && path !== familyName ? path.split(familyName).join("~") : path;
        let l = groups.get(ns);
        if (!l) groups.set(ns, (l = []));
        l.push(`${ref} ${name}${extra ? ` ${extra}` : ""}`);
      }),
    );
    return [...groups].map(([ns, items]) => `${ns}: ${items.join(", ")}`).join("\n");
  }
}
