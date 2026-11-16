import type { Compound } from "prismarine-nbt";
import type { Registry } from "../assets/registry.js";
import { readNbt, writeGzipNbt } from "./nbt.js";
import { upgradeSnapshot } from "./renames.js";
import type { Snapshot } from "./snapshot.js";
import { decodeStructure } from "./structure.js";

/**
 * Upgrading a schematic made on another version (docs/design/14-distribution.md, *Schematics from
 * other versions: the established practice*; `08`, *Import*). Forward only, at load, through the
 * game's own data fixer when a game with the companion mod is linked (the `SchematicUpgrader`), with
 * the fix type that fits the format: the whole file as a structure for `.nbt`, per element (palette
 * states, block entities, entities) for `.schem`, `.bp` and `.litematic`. Unlinked, the rename table
 * upgrades renamed block ids only, and says the upgrade was partial. A file newer than the game is
 * never downgraded. Blocks the game doesn't know are kept verbatim and reported (`01`).
 */

export type UpgradePayload =
  | { kind: "elements"; states: string[]; blockEntities: Compound[]; entities: Compound[] }
  | { kind: "structure"; structure: Compound };

/** The game's data fixer, reached through the linked mod (`world/upgrade.ts`). */
export interface SchematicUpgrader {
  /** The running game's DataVersion. */
  readonly dataVersion: number;
  /** Upgrades `data` from `from` to `dataVersion`; same order and counts back. */
  upgrade(from: number, data: UpgradePayload): Promise<UpgradePayload & { to: number; failed?: number }>;
}

export type UpgradeFormat = "schem" | "nbt" | "bp" | "litematic" | "schematic";

/**
 * The DataVersion a file without one is read as, as the formats' own tools do: a Sponge v1
 * schematic as 1631 (1.13.2, as FAWE), a structure as 500 (as the game). Others stay unknown.
 */
export const MISSING_VERSION: Partial<Record<UpgradeFormat, number>> = { schem: 1631, nbt: 500 };

export interface UpgradeOptions {
  /** The DataVersion to upgrade to when no game is linked (the registry report's, else the instance's). */
  target?: number;
  upgrader?: SchematicUpgrader;
  registry?: Registry;
}

/**
 * Upgrades a decoded snapshot (states verbatim, as the decoders give them without a registry) and
 * canonicalises its palette against the registry, merging entries that became equal. `raw` is the
 * file, for the whole-file structure fix. Returns the snapshot to use and the warnings to show.
 */
export async function upgradeDecoded(format: UpgradeFormat, raw: Buffer, s: Snapshot, o: UpgradeOptions): Promise<{ snapshot: Snapshot; warnings: string[] }> {
  const warnings: string[] = [];
  let snap = s;
  let from = s.dataVersion;
  if (!from && MISSING_VERSION[format]) {
    from = MISSING_VERSION[format]!;
    snap.dataVersion = from;
    warnings.push(`the file names no DataVersion; read as ${from}, as the format's own tools do`);
  }
  const target = o.upgrader?.dataVersion ?? o.target;
  let renameTo: number | undefined;
  if (from && target && from > target)
    warnings.push(`the file is from a newer game (DataVersion ${from}) than this one (${target}): it isn't downgraded, and blocks this game doesn't know are kept verbatim`);
  else if (from && target && from < target) {
    if (o.upgrader) {
      try {
        const up = await viaGame(format, raw, snap, from, o.upgrader);
        snap = up.snapshot;
        warnings.push(`upgraded from DataVersion ${from} to ${up.to} through the game's data fixer${up.failed ? `; ${up.failed} element${up.failed === 1 ? "" : "s"} it couldn't upgrade ${up.failed === 1 ? "was" : "were"} kept as written` : ""}`);
      } catch (e) {
        warnings.push(`the game couldn't upgrade the file (${(e as Error).message}); used the rename table instead`);
        renameTo = target;
      }
    } else renameTo = target;
  }
  const c = upgradeSnapshot(snap, renameTo, o.registry);
  warnings.push(...c.warnings);
  if (renameTo)
    warnings.push(
      `partial upgrade from DataVersion ${from} to ${renameTo}: no game with the Autosketch mod is linked, so only renamed block ids were upgraded` +
        (c.renamed.length ? ` (${c.renamed.join(", ")})` : "") +
        "; property and block-entity changes weren't. Link the game for a full upgrade.",
    );
  return { snapshot: snap, warnings };
}

async function viaGame(format: UpgradeFormat, raw: Buffer, s: Snapshot, from: number, up: SchematicUpgrader): Promise<{ snapshot: Snapshot; to: number; failed: number }> {
  if (format === "nbt") {
    const root = readNbt(raw) as Compound;
    const r = await up.upgrade(from, { kind: "structure", structure: { type: "compound", value: root.value } });
    if (r.kind !== "structure") throw new Error("the game answered a structure upgrade with elements");
    const dec = decodeStructure(writeGzipNbt({ type: "compound", name: "", value: r.structure.value }));
    return { snapshot: { ...dec.snapshot, name: s.name, dataVersion: r.to }, to: r.to, failed: r.failed ?? 0 };
  }
  const r = await up.upgrade(from, { kind: "elements", states: s.palette.slice(1), blockEntities: s.blockEntities.map((b) => b.nbt), entities: s.entities.map((e) => e.nbt) });
  if (r.kind !== "elements" || r.states.length !== s.palette.length - 1 || r.blockEntities.length !== s.blockEntities.length || r.entities.length !== s.entities.length)
    throw new Error("the game's answer doesn't match the request");
  return {
    snapshot: {
      ...s,
      dataVersion: r.to,
      palette: [s.palette[0]!, ...r.states],
      blockEntities: s.blockEntities.map((b, i) => ({ pos: b.pos, nbt: r.blockEntities[i]! })),
      entities: s.entities.map((e, i) => ({ pos: e.pos, nbt: r.entities[i]! })),
    },
    to: r.to,
    failed: r.failed ?? 0,
  };
}
