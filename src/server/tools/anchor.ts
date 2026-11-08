import { z } from "zod";
import type { Vec3 } from "../../core/region.js";
import { componentAnchors, resolveAnchor, type AtSpec } from "../../ops/anchors.js";
import { editWith, env, text, vec3, type ToolDeps } from "./shared.js";

/** Anchors and relative placement (05, Anchors & relative placement): geometry only, no building parts. */

export const atSchema = z
  .union([
    vec3,
    z.string(),
    z.object({ anchor: z.string(), offset: vec3.optional() }),
    z.object({ face: z.string(), u: z.union([z.number(), z.string()]).optional(), v: z.union([z.number(), z.string()]).optional(), offset: vec3.optional() }),
  ])
  .describe(
    '[x,y,z] · "comp.anchor" (named, or implicit min/max/center/bottom/top/front/back/left/right) · {anchor:"gate.top", offset:[0,0,3]} · ' +
      '{face:"keep.front", u:0.5, v:3} (u left→right, v bottom→up; 0..1 = fraction, larger = blocks, negative = from the far end)',
  );

export function registerAnchorTools({ tool, session }: ToolDeps): void {
  tool(
    "anchor",
    {
      title: "Anchors",
      description:
        'Resolves an at: form to coordinates (at), lists a component\'s anchors (component), or sets a named anchor on it (component + name + at; delete:true removes it). ' +
        "Names are yours to choose. Setting is one undo step. Text, <100 tokens.",
      inputSchema: { at: atSchema.optional(), component: z.string().optional(), name: z.string().optional(), delete: z.boolean().optional() },
      readOnly: false,
    },
    (c, a) => {
      const doc = session.require();
      if (a.component && a.name) {
        const comp = doc.componentLocal(a.component);
        if (!comp) throw new Error(`no component "${a.component}"`);
        if (!/^[a-z0-9_:.-]+$/i.test(a.name)) throw new Error("anchor name must be letters, digits, _ : . or -");
        const anchors = { ...comp.anchors };
        let desc: string;
        if (a.delete) {
          if (!anchors[a.name]) throw new Error(`component "${a.component}" has no named anchor "${a.name}"`);
          delete anchors[a.name];
          desc = `removed anchor ${a.component}.${a.name}`;
        } else {
          if (a.at === undefined) throw new Error("give at to set the anchor");
          const r = resolveAnchor(doc, a.at as AtSpec, env(c));
          anchors[a.name] = r.pos;
          desc = `anchor ${a.component}.${a.name} = ${r.pos.join(",")}${Array.isArray(a.at) ? "" : ` (from ${r.desc})`}`;
        }
        return editWith(session, () => {
          doc.edit("anchor", desc, (tx) => tx.setComponent({ ...comp, anchors }));
          return desc;
        });
      }
      if (a.component) {
        const all = componentAnchors(doc, a.component);
        const named = new Set(Object.keys(doc.componentLocal(a.component)!.anchors));
        return text(`${a.component}: ${Object.entries(all).map(([k, v]) => `${k}${named.has(k) ? "*" : ""} (${(v as Vec3).join(",")})`).join(" · ")}\n* = named`);
      }
      if (a.at === undefined) throw new Error("give at, or component");
      return text(resolveAnchor(doc, a.at as AtSpec, env(c)).desc);
    },
  );
}
