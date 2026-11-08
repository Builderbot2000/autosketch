import { z } from "zod";
import { runPluginAction } from "../../ops/plugin-actions.js";
import { formatActionList } from "../../plugins/actions.js";
import { formatEdit } from "../format.js";
import { commonSchema, env, text, type ToolDeps } from "./shared.js";

/** Mod-compat plugin discovery and actions (09; 05 "Mod actions"). */
export function registerPluginTools({ tool, session }: ToolDeps): void {
  tool(
    "ops_list",
    {
      doc: false,
      title: "List plugin ops",
      description:
        'Lists ops added by mod-compat plugins (named "<plugin>.<op>", e.g. framed.camo) with their params and side effects. Filter by plugin id or mod namespace. Text, ~20 tokens per op.',
      inputSchema: { namespace: z.string().optional().describe('Plugin id or mod namespace, e.g. "framedblocks"') },
      readOnly: true,
    },
    (c, args) => text(formatActionList(c.plugins, args.namespace?.trim().toLowerCase() || undefined)),
  );

  tool(
    "op_run",
    {
      title: "Run plugin op",
      description:
        'Runs a plugin op from ops_list, e.g. op:"framed.shape", args:{sel:{"min":[0,0,0],"max":[3,0,0]}, shape:"slope", camo:"stone_bricks", state:"facing=east"} or op:"chisel.pattern", args:{sel:"walls", pattern:"bricks"}. ' +
        "One undo step, like any op. Text, <100 tokens.",
      inputSchema: {
        op: z.string().describe('"<plugin>.<op>" as ops_list shows it'),
        args: z.record(z.string(), z.unknown()).optional().describe("The op's params (see ops_list)"),
        raw: commonSchema.raw,
      },
      readOnly: false,
    },
    async (c, a) => {
      const doc = session.require();
      const r = await runPluginAction(doc, env(c), a.op.trim(), a.args ?? {}, a.raw ? { raw: true } : {});
      session.touch();
      return text(formatEdit(doc, r));
    },
  );
}
