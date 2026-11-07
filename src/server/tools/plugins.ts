import { z } from "zod";
import { formatActionList } from "../../plugins/actions.js";
import { text, type ToolDeps } from "./shared.js";

/** Mod-compat plugin discovery (09; 05 "Plugin ops"). */
export function registerPluginTools({ tool }: ToolDeps): void {
  tool(
    "ops_list",
    {
      title: "List plugin ops",
      description:
        'Lists ops added by mod-compat plugins (named "<plugin>.<op>", e.g. framed.camo) with their params and side effects. Filter by plugin id or mod namespace. Text, ~20 tokens per op.',
      inputSchema: { namespace: z.string().optional().describe('Plugin id or mod namespace, e.g. "framedblocks"') },
      readOnly: true,
    },
    (c, args) => text(formatActionList(c.plugins, args.namespace?.trim().toLowerCase() || undefined)),
  );
}
