import type { ScriptOp } from "./ops.js";

/**
 * The JavaScript evaluated inside the sandbox before a script (docs/design/05-operations.md,
 * Scripting). It defines the `sel.*` builders, which compile to the same JSON expression trees the
 * tools take (05, Implementation status), a `Sel` wrapper with chainable ops, one global per
 * registry op (dotted names become namespace objects), `log()`, and a seeded `rand()` (which also
 * replaces `Math.random`, so runs are reproducible). Everything crosses the boundary as JSON
 * through one host function, so the sandbox holds no host object.
 */
export function prelude(ops: readonly ScriptOp[]): string {
  const table = JSON.stringify(ops.map((o) => [o.name, !!o.returnsSel]));
  return `"use strict";
(function () {
  const host = globalThis.__host;
  delete globalThis.__host;
  const call = (name, args) => {
    const r = host(name, JSON.stringify(args));
    return r === undefined ? undefined : JSON.parse(r);
  };
  class Sel {
    constructor(tree) { this.tree = tree; }
    toJSON() { return this.tree; }
    fill(m, o) { return globalThis.fill(this, m, o); }
    clear(o) { return globalThis.clear(this, o); }
    replace(f, t, o) { return globalThis.replace(this, f, t, o); }
    hollow(o) { return globalThis.hollow(this, o); }
    paint(m, o) { return globalThis.paint(this, m, o); }
    move(by, o) { return globalThis.move(this, by, o); }
    copy(by, o) { return globalThis.copy(this, by, o); }
    rotate(t, o) { return globalThis.rotate(this, t, o); }
    mirror(a, o) { return globalThis.mirror(this, a, o); }
    union(...b) { return sel.union(this, ...b); }
    subtract(...b) { return sel.subtract(this, ...b); }
    intersect(...b) { return sel.intersect(this, ...b); }
    expand(by) { return sel.expand(this, by); }
    contract(by) { return sel.contract(this, by); }
    offset(dx, dy, dz) { return sel.offset(this, dx, dy, dz); }
    shell(t, o) { return sel.shell(this, t, o); }
    layer(y) { return sel.layer(this, y); }
    filter(f) { return sel.filter(this, f); }
    every(n, o) { return sel.every(this, n, o); }
    perimeter() { return sel.perimeter(this); }
    info() { return globalThis.select(this); }
    count() { return globalThis.select(this).count; }
    positions() { return globalThis.positions(this); }
  }
  const T = (x) => (x instanceof Sel ? x.tree : x);
  const S = (t) => new Sel(t);
  const opt = (o) => { const r = {}; for (const k in o || {}) if (o[k] !== undefined) r[k] = k === "within" ? T(o[k]) : o[k]; return r; };
  const sel = {
    box: (min, max) => S({ min, max: max === undefined ? min : max }),
    named: (n) => S(n),
    component: (id) => S({ component: id }),
    kind: (k) => S({ kind: k }),
    tagged: (t) => S({ tagged: t }),
    cylinder: (center, radius, height, axis) => S({ cylinder: opt({ center, radius, height, axis }) }),
    sphere: (center, radius) => S({ sphere: { center, radius } }),
    ellipsoid: (center, radii) => S({ ellipsoid: { center, radii } }),
    polygon: (points, y0, y1) => S({ polygon: { points, y: [y0, y1 === undefined ? y0 : y1] } }),
    plane: (axis, at, within) => S({ plane: opt({ axis, at, within }) }),
    hull: (points) => S({ hull: points }),
    tube: (path, radius) => S({ tube: { path, radius } }),
    connected: (seed, o) => S({ connected: { seed, ...opt(o) } }),
    similar: (seed, o) => S({ similar: { seed, ...opt(o) } }),
    union: (...a) => S({ union: a.map(T) }),
    intersect: (...a) => S({ intersect: a.map(T) }),
    subtract: (...a) => S({ subtract: a.map(T) }),
    xor: (a, b) => S({ xor: [T(a), T(b)] }),
    invert: (a, within) => S({ invert: T(a), ...opt({ within }) }),
    expand: (a, by) => S({ expand: T(a), by: by === undefined ? 1 : by }),
    contract: (a, by) => S({ contract: T(a), by: by === undefined ? 1 : by }),
    offset: (a, dx, dy, dz) => S({ offset: T(a), by: Array.isArray(dx) ? dx : [dx, dy, dz] }),
    shell: (a, thickness, o) => S({ shell: T(a), ...opt({ thickness }), ...opt(o) }),
    layer: (a, y) => S({ layer: T(a), y }),
    surface: (a, o) => S({ surface: T(a), ...opt(o) }),
    bbox: (a) => S({ bbox: T(a) }),
    filter: (a, f) => S({ filter: T(a), ...(typeof f === "string" ? { block: f } : opt(f)) }),
    rotate: (a, turns, pivot) => S({ rotate: T(a), turns, ...opt({ pivot }) }),
    mirror: (a, axis, about) => S({ mirror: T(a), axis, ...opt({ about }) }),
    grow: (a, by, match) => S({ grow: T(a), ...opt({ by, match }) }),
    shrink: (a, by) => S({ shrink: T(a), ...opt({ by }) }),
    edges: (a) => S({ edges: T(a) }),
    slab: (a, axis, from, to) => S({ slab: T(a), axis, from, to }),
    convex: (a) => S({ convex: T(a) }),
    fill_holes: (a) => S({ fill_holes: T(a) }),
    checker: (a, o) => S({ checker: T(a), ...opt(o) }),
    random: (a, ratio, seed) => S({ random: T(a), ratio, ...opt({ seed }) }),
    every: (a, n, o) => S({ every: T(a), n, ...opt(o) }),
    freeze: (a) => S({ freeze: T(a) }),
    perimeter: (a) => S({ shell: T(a), walls_only: true }),
    from: (tree) => S(tree),
  };
  Object.defineProperty(sel, "all", { get: () => S("all"), enumerable: true });
  Object.defineProperty(sel, "last", { get: () => S("last"), enumerable: true });
  globalThis.sel = sel;
  globalThis.Sel = Sel;
  for (const [name, wrap] of ${table}) {
    const fn = (...a) => { const r = call(name, a); return wrap ? S(r) : r; };
    const parts = name.split(".");
    let o = globalThis;
    for (const p of parts.slice(0, -1)) o = o[p] = o[p] || {};
    o[parts[parts.length - 1]] = fn;
  }
  const comp = globalThis.component;
  globalThis.component = (id) => {
    const c = comp(id);
    if (!c) return null;
    c.region = S({ component: id });
    c.anchor = (n) => globalThis.anchor(id + "." + n);
    return c;
  };
  const arr = globalThis.array;
  globalThis.array = (s, o) => (o && o.along !== undefined ? S(call("arrayAlong", [s, o])) : arr(s, o));
  globalThis.log = (...a) => { call("__log", [a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ")]); };
  let st = call("__seed", []) >>> 0;
  const rand = () => {
    st = (st + 0x6d2b79f5) >>> 0;
    let t = st;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  globalThis.rand = rand;
  Math.random = rand;
})();
`;
}
