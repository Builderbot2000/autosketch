/**
 * The canonical block-state form on the wire (docs/design/13-live-world.md, *Wire format*,
 * *Block states*): `namespace:path[name=value,...]`, namespace always present, every property of
 * the block present and sorted by name, no whitespace, the air variants written as `minecraft:air`.
 * Whether every property is present needs the game's registry; this checks the rest.
 */

const RE = /^[a-z0-9_.-]+:[a-z0-9_./-]+(?:\[[a-z0-9_]+=[a-z0-9_]+(?:,[a-z0-9_]+=[a-z0-9_]+)*\])?$/;

export function isCanonicalForm(state: string): boolean {
  if (!RE.test(state)) return false;
  if (state === "minecraft:cave_air" || state === "minecraft:void_air") return false;
  const i = state.indexOf("[");
  if (i < 0) return true;
  const names = state
    .slice(i + 1, -1)
    .split(",")
    .map((p) => p.slice(0, p.indexOf("=")));
  for (let k = 1; k < names.length; k++) if (!(names[k - 1]! < names[k]!)) return false;
  return true;
}
