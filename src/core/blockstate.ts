import type { Registry } from "../assets/registry.js";

/**
 * Block identity (docs/design/01-conventions.md): `namespace:path[prop=value,...]`, properties
 * sorted, namespace defaulting to minecraft. With a registry, omitted properties take the block's
 * defaults and invalid values are rejected; unknown blocks are kept verbatim.
 */

export interface ParsedState {
  id: string;
  props: Record<string, string>;
}

export const AIR = "minecraft:air";
const AIRS = new Set(["minecraft:air", "minecraft:cave_air", "minecraft:void_air"]);

export function isAir(state: string): boolean {
  const i = state.indexOf("[");
  return AIRS.has(i < 0 ? state : state.slice(0, i));
}

export function parseState(text: string): ParsedState {
  const s = text.trim();
  const m = /^(#?[a-z0-9_.\-]+(?::[a-z0-9_.\-/]+)?)(?:\[([^\]]*)\])?$/i.exec(s);
  if (!m) throw new Error(`bad block "${text}" (expected e.g. oak_stairs[facing=east,half=top])`);
  const raw = m[1]!.toLowerCase();
  const id = raw.includes(":") ? raw : `minecraft:${raw}`;
  const props: Record<string, string> = {};
  if (m[2]?.trim()) {
    for (const part of m[2].split(",")) {
      const kv = part.split("=");
      if (kv.length !== 2 || !kv[0]!.trim() || !kv[1]!.trim()) throw new Error(`bad block property "${part.trim()}" in "${text}" (expected name=value)`);
      props[kv[0]!.trim().toLowerCase()] = kv[1]!.trim().toLowerCase();
    }
  }
  return { id, props };
}

export function formatState(id: string, props: Record<string, string>): string {
  const keys = Object.keys(props).sort();
  return keys.length ? `${id}[${keys.map((k) => `${k}=${props[k]}`).join(",")}]` : id;
}

export interface CanonicalResult {
  state: string;
  /** Set when the block is not in the registry (kept verbatim, see 01). */
  unknown?: boolean;
}

/**
 * Canonical state string. With a registry the result lists every property of the block (defaults
 * filled in), so equal blocks always intern to the same id.
 */
export function canonicalState(text: string, registry?: Registry): CanonicalResult {
  const { id, props } = parseState(text);
  if (id.startsWith("#")) throw new Error(`"${text}" is a tag; give a block id`);
  if (AIRS.has(id)) return { state: AIR };
  const b = registry?.get(id);
  if (!registry) return { state: formatState(id, props) };
  if (!b) return { state: formatState(id, props), unknown: true };
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(props)) {
    const allowed = b.properties[k];
    if (!allowed) {
      const known = Object.keys(b.properties);
      throw new Error(`${id} has no property "${k}"${known.length ? `; properties: ${known.join(", ")}` : " (it has no properties)"}`);
    }
    if (!allowed.includes(v)) throw new Error(`${k}=${v} is invalid for ${id}; valid: ${allowed.join("|")}`);
    out[k] = v;
  }
  for (const [k, vs] of Object.entries(b.properties)) if (out[k] === undefined) out[k] = b.defaults[k] ?? vs[0]!;
  return { state: formatState(b.id, out) };
}

/** Block id of a canonical state ("minecraft:oak_stairs[facing=east]" → "minecraft:oak_stairs"). */
export function stateId(state: string): string {
  const i = state.indexOf("[");
  return i < 0 ? state : state.slice(0, i);
}

/** Properties of a canonical state. */
export function stateProps(state: string): Record<string, string> {
  return parseState(state).props;
}

/** Short display form: drops the minecraft namespace and properties equal to the registry default. */
export function shortState(state: string, registry?: Registry): string {
  const { id, props } = parseState(state);
  const b = registry?.get(id);
  const kept: Record<string, string> = {};
  for (const [k, v] of Object.entries(props)) if (!b || b.defaults[k] !== v) kept[k] = v;
  return formatState(id.startsWith("minecraft:") ? id.slice(10) : id, kept);
}
