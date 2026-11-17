import type { PublicBox, Vec3 } from "../core/region.js";

/** The smallest inclusive box holding both. */
export function unionPublic(a: PublicBox, b: PublicBox): PublicBox {
  return {
    min: [Math.min(a.min[0], b.min[0]), Math.min(a.min[1], b.min[1]), Math.min(a.min[2], b.min[2])],
    max: [Math.max(a.max[0], b.max[0]), Math.max(a.max[1], b.max[1]), Math.max(a.max[2], b.max[2])],
  };
}

export function translatePublic(b: PublicBox, d: Vec3): PublicBox {
  return { min: [b.min[0] + d[0], b.min[1] + d[1], b.min[2] + d[2]], max: [b.max[0] + d[0], b.max[1] + d[1], b.max[2] + d[2]] };
}

const boxKey = (b: PublicBox) => `${b.min.join(",")},${b.max.join(",")}`;

/**
 * At most `max` boxes covering every input box (`13`, *In-game UI*, Flash: "beyond that the MCP
 * merges them into fewer, larger boxes"). Duplicates are dropped first;
 * if still too many, the boxes are ordered along x, then z, then y, and consecutive runs are joined,
 * so neighbouring edits merge with each other rather than across the build. Deterministic.
 */
export function mergeBoxes(boxes: PublicBox[], max: number): PublicBox[] {
  const seen = new Set<string>();
  let list = boxes.filter((b) => {
    const k = boxKey(b);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  if (list.length <= max) return list;
  list = list.slice().sort((a, b) => a.min[0] - b.min[0] || a.min[2] - b.min[2] || a.min[1] - b.min[1]);
  const out: PublicBox[] = [];
  const per = Math.ceil(list.length / max);
  for (let i = 0; i < list.length; i += per) out.push(list.slice(i, i + per).reduce(unionPublic));
  return out;
}
