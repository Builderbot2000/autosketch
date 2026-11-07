import { textWidth } from "../palette/font.js";
import { Image, type RGBA } from "../palette/image.js";
import { columnLabel, parseCell } from "../palette/sheet.js";
import type { Vec3 } from "../core/region.js";
import type { Prefab } from "./prefabs.js";

/**
 * prefab_sheet (docs/design/07-library.md, 03 sheet rules): a grid of prefab thumbnails with
 * chessboard cell ids (columns A…, rows 1…) and no per-tile text, plus a short caption listing
 * each cell's name and size. A page holds at most 6×4 cells so the caption stays small.
 */

export const SHEET_COLUMNS = 6;
export const SHEET_ROWS = 4;
export const PER_PAGE = SHEET_COLUMNS * SHEET_ROWS;
export const THUMB = 96;

export interface PrefabSheetLayout {
  /** Filter description, echoed in the caption. */
  spec: string;
  page: number;
  pages: number;
  total: number;
  columns: number;
  rows: number;
  /** Prefab ids on this page, row-major. */
  cells: string[];
}

export function layoutPrefabSheet(prefabs: readonly Prefab[], spec: string, page = 1): PrefabSheetLayout {
  const pages = Math.max(1, Math.ceil(prefabs.length / PER_PAGE));
  if (page < 1 || page > pages) throw new Error(`page ${page} is out of range (1–${pages})`);
  const cells = prefabs.slice((page - 1) * PER_PAGE, page * PER_PAGE).map((p) => p.id);
  const columns = Math.max(1, Math.min(SHEET_COLUMNS, cells.length));
  return { spec, page, pages, total: prefabs.length, columns, rows: Math.max(1, Math.ceil(cells.length / columns)), cells };
}

export const cellRef = (layout: PrefabSheetLayout, i: number) => `${columnLabel(i % layout.columns)}${Math.floor(i / layout.columns) + 1}`;

/** The prefab id at a cell ref ("B3") on a layout, or undefined when the ref isn't a cell. */
export function prefabAtCell(layout: PrefabSheetLayout, ref: string): string | undefined {
  if (!/^[A-Z]+\d+$/.test(ref.trim())) return undefined;
  const { col, row } = parseCell(ref.trim());
  if (col >= layout.columns || row < 1) throw new Error(`cell ${ref} is outside the last prefab sheet (${columnLabel(layout.columns - 1)}${layout.rows} is the last cell)`);
  const id = layout.cells[(row - 1) * layout.columns + col];
  if (!id) throw new Error(`cell ${ref} is empty on the last prefab sheet`);
  return id;
}

const BG: RGBA = [24, 26, 30, 255];
const LABEL: RGBA = [200, 205, 215, 255];
const LIGHT: RGBA = [62, 66, 76, 255];
const DARK: RGBA = [48, 52, 60, 255];

/** Draws the sheet; `thumbs[i]` is the PNG for `layout.cells[i]` (missing ones get a placeholder). */
export function renderPrefabSheet(layout: PrefabSheetLayout, thumbs: readonly (Buffer | undefined)[]): Buffer {
  const T = THUMB;
  const lm = 4 + textWidth(String(layout.rows)) + 4;
  const tm = 4 + 7 + 4;
  const width = lm + layout.columns * (T + 1) + 4;
  const height = tm + layout.rows * (T + 1) + 4;
  const img = new Image(width, height);
  img.fillRect(0, 0, width, height, BG);
  for (let c = 0; c < layout.columns; c++) {
    const label = columnLabel(c);
    img.text(label, lm + c * (T + 1) + Math.floor((T - textWidth(label)) / 2), 4, LABEL);
  }
  for (let r = 0; r < layout.rows; r++) {
    const label = String(r + 1);
    img.text(label, lm - 4 - textWidth(label), tm + r * (T + 1) + Math.floor((T - 7) / 2), LABEL);
  }
  for (let i = 0; i < layout.columns * layout.rows; i++) {
    const c = i % layout.columns, r = Math.floor(i / layout.columns);
    const x = lm + c * (T + 1), y = tm + r * (T + 1);
    // Chessboard cells, so neighbouring thumbnails with transparent backgrounds stay apart.
    img.fillRect(x, y, T, T, (c + r) % 2 ? DARK : LIGHT);
    if (i >= layout.cells.length) continue;
    const png = thumbs[i];
    let thumb: Image | undefined;
    try {
      thumb = png && fit(Image.decodePng(png), T);
    } catch {
      thumb = undefined;
    }
    if (thumb) img.draw(thumb, x + Math.floor((T - thumb.width) / 2), y + Math.floor((T - thumb.height) / 2));
    else img.text("?", x + Math.floor((T - textWidth("?", 3)) / 2), y + Math.floor((T - 21) / 2), LABEL, 3);
  }
  return img.encodePng();
}

/** Nearest-neighbour downscale to fit a square of `size` (never upscales). */
function fit(src: Image, size: number): Image {
  const s = Math.min(1, size / Math.max(src.width, src.height));
  if (s === 1) return src;
  const w = Math.max(1, Math.round(src.width * s)), h = Math.max(1, Math.round(src.height * s));
  const out = new Image(w, h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) out.blend(x, y, src.get(Math.floor(x / s), Math.floor(y / s)));
  return out;
}

/** ≈150 tokens: the spec, page, then "A1 name 7×7×12" per cell, and how to use a cell. */
export function prefabSheetCaption(layout: PrefabSheetLayout, prefabs: ReadonlyMap<string, Prefab>, sizes: readonly (Vec3 | undefined)[]): string {
  const head = `prefab sheet ${layout.spec}${layout.pages > 1 ? ` page ${layout.page}/${layout.pages}` : ""}: ${layout.total} prefab${layout.total === 1 ? "" : "s"}, ${layout.columns}×${layout.rows} cells. Size = footprint x×z×height.`;
  const cells = layout.cells.map((id, i) => {
    const s = sizes[i];
    const p = prefabs.get(id);
    const name = p && p.meta.name !== id ? `${id} "${p.meta.name}"` : id;
    return `${cellRef(layout, i)} ${name}${s ? ` ${s[0]}×${s[1]}×${s[2]}` : ""}`;
  });
  return [head, cells.join(" · "), `Stamp a cell: stamp({prefab:"${cellRef(layout, 0)}", at:[x,y,z] or "component.anchor"}); palette_remap recolours roles.`].join("\n");
}
