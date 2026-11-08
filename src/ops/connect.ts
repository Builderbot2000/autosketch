import type { Registry } from "../assets/registry.js";
import { formatState, parseState, stateId } from "../core/blockstate.js";
import { Mask } from "../core/mask.js";
import type { Vec3 } from "../core/region.js";
import type { Document, Transaction } from "../document/document.js";
import type { AutosketchPlugin } from "../plugins/types.js";

/**
 * Auto-connection (docs/design/05-operations.md, Auto-connection). Fences, walls, panes and bars,
 * stair shapes, redstone wire, chests and plugin-declared connecting blocks take their connection
 * properties from their neighbours, as in the game. These properties are derived state: after
 * every non-raw op they are recomputed for the written blocks and their neighbours.
 *
 * The rules follow vanilla 1.21 (FenceBlock, IronBarsBlock, WallBlock, StairBlock,
 * RedStoneWireBlock, ChestBlock), simplified where the game tests exact collision shapes:
 * a "sturdy face" is a full block (registry shape "full") that isn't a connection exception, and a
 * wall side is tall when the block above is full, or a wall or pane with that side connected.
 */

export interface ConnectEnv {
  registry?: Registry;
  plugins?: readonly AutosketchPlugin[];
}

type Kind = "fence" | "pane" | "wall" | "stairs" | "wire" | "chest" | "plugin";

const H: [string, Vec3][] = [["north", [0, 0, -1]], ["east", [1, 0, 0]], ["south", [0, 0, 1]], ["west", [-1, 0, 0]]];
const DIR: Record<string, Vec3> = Object.fromEntries(H);
const OPP: Record<string, string> = { north: "south", south: "north", east: "west", west: "east" };
const CW: Record<string, string> = { north: "east", east: "south", south: "west", west: "north" };
const CCW: Record<string, string> = { north: "west", west: "south", south: "east", east: "north" };
const axisOf = (d: string) => (d === "north" || d === "south" ? "z" : d === "east" || d === "west" ? "x" : "y");

/** Neighbour offsets whose blocks can depend on a changed block (6 faces + vertical diagonals). */
const AROUND: Vec3[] = [
  [0, 0, 0], [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1],
  [1, 1, 0], [-1, 1, 0], [0, 1, 1], [0, 1, -1], [1, -1, 0], [-1, -1, 0], [0, -1, 1], [0, -1, -1],
];

const hasTag = (env: ConnectEnv, id: string, tag: string) => env.registry?.get(id)?.tags.includes(tag) ?? false;

function kindOf(state: string, env: ConnectEnv): Kind | null {
  if (state === "minecraft:air") return null;
  if (env.plugins?.some((p) => p.connection?.handles(state))) return "plugin";
  const id = stateId(state);
  if (id === "minecraft:redstone_wire") return "wire";
  const props = state.includes("[") ? parseState(state).props : {};
  const b = env.registry?.get(id)?.properties;
  const has = (k: string) => k in props || (b ? k in b : false);
  const vals = (k: string) => b?.[k] ?? (props[k] !== undefined ? [props[k]!] : []);
  if (has("type") && has("facing") && vals("type").includes("left") && /chest$/.test(id)) return "chest";
  if (has("shape") && has("facing") && has("half") && (vals("shape").includes("inner_left") || /_stairs$/.test(id))) return "stairs";
  if (/_wall$/.test(id) || hasTag(env, id, "minecraft:walls")) return has("north") || !b ? "wall" : null;
  if (/_fence$/.test(id) || hasTag(env, id, "minecraft:fences")) return "fence";
  if (/(_pane|_bars)$/.test(id) || id === "minecraft:glass_pane" || hasTag(env, id, "c:glass_panes")) return "pane";
  return null;
}

const PARTIAL = /(stairs|slab|fence|fence_gate|wall|pane|bars|door|trapdoor|button|torch|sign|rail|carpet|pressure_plate|lantern|chain|ladder|redstone_wire|bed|chest|banner|head|skull|flower|sapling|grass|fern|candle|lever|vine)$/;
const EXCEPTION = /(leaves|^minecraft:barrier|pumpkin|jack_o_lantern|^minecraft:melon|shulker_box)$/;

/** True when `state` shows a full face toward `face` (the side facing the asking block). */
function sturdy(state: string, face: string, env: ConnectEnv): boolean {
  if (state === "minecraft:air") return false;
  const id = stateId(state);
  if (EXCEPTION.test(id)) return false;
  const p = state.includes("[") ? parseState(state).props : {};
  if (/_slab$/.test(id)) return p.type === "double";
  if (/_stairs$/.test(id)) return p.facing === face && (p.shape === "straight" || p.shape?.startsWith("inner") === true);
  const info = env.registry?.get(id);
  if (info) return info.shape === "full";
  return !PARTIAL.test(id);
}

const isGate = (s: string, env: ConnectEnv) => /_fence_gate$/.test(stateId(s)) || hasTag(env, stateId(s), "minecraft:fence_gates");
/** A gate joins a fence/wall on direction d when the gate's facing is across d. */
const gateJoins = (s: string, d: string) => axisOf(parseState(s).props.facing ?? "north") !== axisOf(d);
const woodenFence = (id: string, env: ConnectEnv) => (env.registry?.get(id)?.tags.length ? hasTag(env, id, "minecraft:wooden_fences") : id !== "minecraft:nether_brick_fence");

const SIGNAL = /(redstone_torch|redstone_wall_torch|lever|_button|pressure_plate|redstone_block|daylight_detector|tripwire_hook|trapped_chest|comparator|target|lectern|sculk_sensor|detector_rail|redstone_wire)$/;

/** Wire rule: does `s` (in direction d from the wire) take a wire connection? */
function wireTakes(s: string, d: string): boolean {
  const id = stateId(s);
  if (id === "minecraft:repeater") return axisOf(parseState(s).props.facing ?? "") === axisOf(d);
  if (id === "minecraft:observer") return parseState(s).props.facing === d;
  return SIGNAL.test(id);
}

type Get = (x: number, y: number, z: number) => string;

/** New state for one connecting block, or the same string when nothing changes. */
function recompute(kind: Kind, state: string, x: number, y: number, z: number, get: Get, env: ConnectEnv, written?: Mask): string {
  const { id, props } = parseState(state);
  const at = (d: Vec3, dy = 0) => get(x + d[0], y + d[1] + dy, z + d[2]);
  const out = { ...props };
  switch (kind) {
    case "plugin": {
      const p = env.plugins!.find((q) => q.connection?.handles(state))!;
      return p.connection!.update(state, (dx, dy, dz) => get(x + dx, y + dy, z + dz));
    }
    case "fence":
      for (const [d, v] of H) {
        const n = at(v), nid = stateId(n);
        const join = (kindOf(n, env) === "fence" && (nid === id || (woodenFence(id, env) && woodenFence(nid, env)))) || (isGate(n, env) && gateJoins(n, d)) || sturdy(n, OPP[d]!, env);
        out[d] = String(join);
      }
      break;
    case "pane":
      for (const [d, v] of H) {
        const n = at(v), k = kindOf(n, env);
        out[d] = String(k === "pane" || k === "wall" || sturdy(n, OPP[d]!, env));
      }
      break;
    case "wall": {
      const above = at([0, 1, 0]);
      const ak = kindOf(above, env), ap = ak ? parseState(above).props : {};
      const aboveFull = sturdy(above, "down", env);
      for (const [d, v] of H) {
        const n = at(v), k = kindOf(n, env);
        const join = k === "wall" || k === "pane" || (isGate(n, env) && gateJoins(n, d)) || sturdy(n, OPP[d]!, env);
        const tall = aboveFull || (ak === "wall" && ap[d] !== undefined && ap[d] !== "none") || (ak === "pane" && ap[d] === "true");
        out[d] = join ? (tall ? "tall" : "low") : "none";
      }
      const none = (d: string) => out[d] === "none";
      let up: boolean;
      if ((none("north") && none("south") && none("east") && none("west")) || none("north") !== none("south") || none("east") !== none("west")) up = true;
      else if ((out.north === "tall" && out.south === "tall") || (out.east === "tall" && out.west === "tall")) up = false;
      else up = aboveFull || ak === "wall" || ak === "fence" || ak === "pane" || /(torch|sign|banner|pressure_plate|lantern|skull|head)$/.test(stateId(above)) || hasTag(env, stateId(above), "minecraft:wall_post_override");
      out.up = String(up);
      break;
    }
    case "stairs": {
      const dir = props.facing ?? "north", half = props.half ?? "bottom";
      const stair = (s: string) => kindOf(s, env) === "stairs" ? parseState(s).props : undefined;
      const canTake = (face: string) => {
        const n = stair(at(DIR[face]!));
        return !n || n.facing !== dir || n.half !== half;
      };
      let shape = "straight";
      const front = stair(at(DIR[dir]!));
      const back = stair(at(DIR[OPP[dir]!]!));
      if (front && front.half === half && front.facing && axisOf(front.facing) !== axisOf(dir) && canTake(OPP[front.facing]!)) shape = front.facing === CCW[dir] ? "outer_left" : "outer_right";
      else if (back && back.half === half && back.facing && axisOf(back.facing) !== axisOf(dir) && canTake(back.facing)) shape = back.facing === CCW[dir] ? "inner_left" : "inner_right";
      out.shape = shape;
      break;
    }
    case "wire": {
      const aboveSolid = sturdy(at([0, 1, 0]), "down", env);
      const isWire = (s: string) => stateId(s) === "minecraft:redstone_wire";
      for (const [d, v] of H) {
        const side = at(v);
        const sideSolid = sturdy(side, "up", env);
        if (!aboveSolid && sideSolid && isWire(at(v, 1))) out[d] = sturdy(side, OPP[d]!, env) ? "up" : "side";
        else if (isWire(side) || wireTakes(side, d) || (!sideSolid && isWire(at(v, -1)))) out[d] = "side";
        else out[d] = "none";
      }
      // A wire written by this op is a placement, which starts from a cross (as in the game); only
      // existing dots stay dots.
      const wasDot = !written?.has(x, y, z) && H.every(([d]) => (props[d] ?? "none") === "none");
      const con = (d: string) => out[d] !== "none";
      if (wasDot && !H.some(([d]) => con(d))) break;
      const ns = !con("north") && !con("south"), ew = !con("east") && !con("west");
      if (ns) for (const d of ["east", "west"]) if (!con(d)) out[d] = "side";
      if (ew) for (const d of ["north", "south"]) if (!con(d)) out[d] = "side";
      break;
    }
    case "chest":
      return state; // handled pairwise in chests()
  }
  return formatState(id, out);
}

/** Properties each kind derives from its neighbours (connection properties, 05). */
const DERIVED: Record<Exclude<Kind, "plugin">, readonly string[]> = {
  fence: ["north", "east", "south", "west"],
  pane: ["north", "east", "south", "west"],
  wall: ["north", "east", "south", "west", "up"],
  stairs: ["shape"],
  wire: ["north", "east", "south", "west"],
  chest: ["type"],
};

/**
 * A state with its connection properties removed: the block's content, which sandbox merge checks
 * and locks compare (11, Connection seams). A plugin-declared connecting block keeps only its id,
 * since the plugin doesn't say which properties it derives.
 */
export function connectionNeutral(state: string, env: ConnectEnv): string {
  const k = kindOf(state, env);
  if (!k) return state;
  const { id, props } = parseState(state);
  if (k === "plugin") return id;
  const out = { ...props };
  for (const p of DERIVED[k]) delete out[p];
  return formatState(id, out);
}

/**
 * Recomputes connection properties at exactly the given positions (silo F calls this at sandbox
 * seams, 11). Returns how many blocks changed. Block entities are kept.
 */
export function reconnectPositions(doc: Document, tx: Transaction, positions: Mask, env: ConnectEnv, written?: Mask): number {
  const kinds = new Map<number, Kind | null>();
  const kind = (id: number) => {
    let k = kinds.get(id);
    if (k === undefined) kinds.set(id, (k = kindOf(doc.states.get(id), env)));
    return k;
  };
  const todo: [number, number, number, Kind][] = [];
  positions.forEach((x, y, z) => {
    const k = kind(tx.getId(x, y, z));
    if (k) todo.push([x, y, z, k]);
  });
  // Top-down, so a wall reads the final sides of the wall above it.
  todo.sort((a, b) => b[1] - a[1]);
  const get: Get = (x, y, z) => tx.get(x, y, z);
  let changed = 0;
  const chests: Vec3[] = [];
  for (const [x, y, z, k] of todo) {
    if (k === "chest") {
      chests.push([x, y, z]);
      continue;
    }
    const cur = tx.get(x, y, z);
    const next = recompute(k, cur, x, y, z, get, env, written);
    if (next !== cur) {
      tx.set(x, y, z, next, doc.getBlockEntity(x, y, z));
      changed++;
    }
  }
  changed += pairChests(doc, tx, chests);
  return changed;
}

/**
 * Chests pair with a same-block, same-facing single chest on their left or right (ChestBlock:
 * type=left means the partner is clockwise of facing). Valid pairs are kept.
 */
function pairChests(doc: Document, tx: Transaction, list: Vec3[]): number {
  let changed = 0;
  const info = (p: Vec3) => {
    const s = tx.get(...p);
    if (!/chest$/.test(stateId(s))) return undefined;
    return { s, id: stateId(s), props: parseState(s).props };
  };
  const partnerOf = (p: Vec3, facing: string, type: string): Vec3 => {
    const d = DIR[type === "left" ? CW[facing]! : CCW[facing]!]!;
    return [p[0] + d[0], p[1], p[2] + d[2]];
  };
  const write = (p: Vec3, type: string) => {
    const c = info(p)!;
    if (c.props.type === type) return;
    tx.set(...p, formatState(c.id, { ...c.props, type }), doc.getBlockEntity(...p));
    changed++;
  };
  const valid = (p: Vec3) => {
    const c = info(p);
    if (!c || c.props.type === "single" || !c.props.facing || !c.props.type) return false;
    const q = info(partnerOf(p, c.props.facing, c.props.type));
    return !!q && q.id === c.id && q.props.facing === c.props.facing && q.props.type === (c.props.type === "left" ? "right" : "left");
  };
  for (const p of list) if (!valid(p) && info(p)?.props.type !== "single") write(p, "single");
  for (const p of list) {
    const c = info(p);
    if (!c || c.props.type !== "single" || !c.props.facing) continue;
    for (const type of ["left", "right"]) {
      const q = partnerOf(p, c.props.facing, type);
      const o = info(q);
      if (o && o.id === c.id && o.props.facing === c.props.facing && o.props.type === "single") {
        write(p, type);
        write(q, type === "left" ? "right" : "left");
        break;
      }
    }
  }
  return changed;
}

/** True when the document's state table holds any connecting block (a fast skip for most ops). */
const seen = new WeakMap<Document, { checked: number; any: boolean }>();
function anyConnecting(doc: Document, env: ConnectEnv): boolean {
  const all = doc.states.all();
  const c = seen.get(doc) ?? { checked: 0, any: false };
  if (!c.any) for (; c.checked < all.length && !c.any; c.checked++) c.any = kindOf(all[c.checked]!, env) !== null;
  seen.set(doc, c);
  return c.any;
}

/**
 * After an op: recomputes the written blocks and their neighbours (05). Called by every non-raw
 * op through `opEdit`.
 */
export function connectAfterEdit(doc: Document, tx: Transaction, env: ConnectEnv): number {
  if (!anyConnecting(doc, env)) return 0;
  const around = new Mask(), written = new Mask();
  tx.forEachTouched((x, y, z) => {
    written.add(x, y, z);
    for (const d of AROUND) around.add(x + d[0], y + d[1], z + d[2]);
  });
  return reconnectPositions(doc, tx, around, env, written);
}
