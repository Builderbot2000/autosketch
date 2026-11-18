import type { Vec3 } from "../core/region.js";
import type { Library } from "./index.js";
import { cellRef, type PrefabSheetLayout } from "./sheet.js";

/**
 * Candidates in a reply (docs/design/17-reusable-components.md, piece 3): the session's record of
 * the last prefab sheet's cells and of every candidates list the agent offered with `world_reply`.
 * The MCP session holds one (`Session.candidates`); `world_reply` adds lists and the in-game UI's
 * `candidates.*` handlers read them (`ui/candidates.ts`). In memory only, ending with the session.
 */

/** One offered prefab, as it was when the list was made. */
export interface CandidateItem {
  /** The cell id the player and the agent share: the last sheet's, the agent's own, or `#n`. */
  cell: string;
  /** The library id the agent uses (`axiom/…` for blueprints). */
  prefab: string;
  /** The entry's name in its root, which `library.thumbnail` and `library.preview` take. */
  name: string;
  /** The root's label. */
  root: string;
  size: Vec3;
  tags: string[];
  notes: string | null;
}

export interface CandidateList {
  id: string;
  /** The in-game request the reply went to, or null when it went to no request. */
  request: number | null;
  /** That request's text ("" without one). */
  question: string;
  /** That request's mode, when it had one other than `build` (piece 5: picks reopen a closed request in it). */
  mode?: "ask" | "plan" | "scan" | "build";
  entries: CandidateItem[];
  /** Set by a submit (piece 5): later opens answer `answered`. */
  answered: boolean;
}

/** One entry of `world_reply({candidates})`. */
export interface CandidateRef {
  prefab: string;
  cell?: string;
}

/** Most entries one `world_reply` offers (one sheet page, 6×4); the protocol's `CANDIDATES_MAX`, which tools may not import. */
export const MAX_CANDIDATES = 24;

const CELL = /^[A-Z]+[1-9]\d*$/;

export class Candidates {
  /** Prefab id → cell on the last `prefab_sheet` page. */
  private cells = new Map<string, string>();
  private readonly lists = new Map<string, CandidateList>();
  private next = 1;

  /** Records the cells of the sheet just shown (replacing the previous sheet's). */
  rememberSheet(layout: PrefabSheetLayout): void {
    this.cells = new Map(layout.cells.map((id, i) => [id, cellRef(layout, i)]));
  }

  /** The cell a prefab had on the last sheet. */
  cellOf(prefab: string): string | undefined {
    return this.cells.get(prefab);
  }

  /**
   * Resolves the agent's refs against the library and builds the entries, without storing them.
   * A prefab resolves as `stamp` resolves it (id, display name, last sheet cell). The cell defaults
   * to the prefab's cell on the last sheet, else `#n` (its place in the list), which no sheet uses.
   * Throws on an unknown prefab, a malformed cell, or a prefab or cell given twice.
   */
  async resolve(lib: Library, refs: readonly CandidateRef[]): Promise<CandidateItem[]> {
    const out: CandidateItem[] = [];
    for (const [i, ref] of refs.entries()) {
      if (ref.cell !== undefined && !CELL.test(ref.cell)) throw new Error(`candidate ${i + 1}: cell "${ref.cell}" isn't a sheet cell like "B2"`);
      const p = await lib.resolve(ref.prefab);
      const size = await lib.size(p).catch((): Vec3 => [0, 0, 0]);
      out.push({
        cell: ref.cell ?? this.cellOf(p.id) ?? `#${i + 1}`,
        prefab: p.id,
        name: p.root.kind === "axiom" ? p.id.slice("axiom/".length) : p.id,
        root: p.root.label,
        size,
        tags: [...p.meta.tags],
        notes: p.meta.notes ?? null,
      });
    }
    const twice = <T>(xs: T[]) => xs.find((x, i) => xs.indexOf(x) !== i);
    const prefab = twice(out.map((e) => e.prefab));
    if (prefab !== undefined) throw new Error(`candidate ${prefab} is listed twice`);
    const cell = twice(out.map((e) => e.cell));
    if (cell !== undefined) throw new Error(`cell ${cell} names two candidates (give each its own cell, or leave cells out to use the last sheet's)`);
    return out;
  }

  /** Stores a list under a new id (`c1`, `c2`, …), valid for the rest of the session. */
  add(list: Omit<CandidateList, "id" | "answered">): CandidateList {
    const stored: CandidateList = { id: `c${this.next++}`, ...list, answered: false };
    this.lists.set(stored.id, stored);
    return stored;
  }

  get(id: string): CandidateList | undefined {
    return this.lists.get(id);
  }
}
