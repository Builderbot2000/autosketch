import { readFile } from "node:fs/promises";
import { z } from "zod";
import { scriptApiDts } from "../../script/dts.js";
import type { ScriptOp } from "../../script/ops.js";
import { runScript, ScriptError, type ScriptRun } from "../../script/run.js";
import type { InstanceContext } from "../context.js";
import { formatEdit } from "../format.js";
import type { Session } from "../session.js";
import { env, fail, text, type Result, type ToolDeps } from "./shared.js";

/** Scripting (05 L4): run_script and the API reference resource. */

export const SCRIPT_API_URI = "autosketch://script/api.d.ts";

/** Extra script ops for an instance (plugin actions, 09). */
export function extraScriptOps(_c: InstanceContext): readonly ScriptOp[] {
  return [];
}

/** Runs a script on the open document and formats the result (shared with run_procedure). */
export async function runScriptTool(c: InstanceContext, session: Session, source: string, args: Record<string, unknown> | undefined, name: string, limits: { timeoutMs?: number } = {}): Promise<Result> {
  const doc = session.require();
  let run: ScriptRun;
  try {
    run = await runScript(doc, env(c), { source, ...(args ? { args } : {}), name, ops: extraScriptOps(c), ...limits });
  } catch (e) {
    if (e instanceof ScriptError) return fail([e.message, e.log ? `log:\n${e.log.trimEnd()}` : undefined].filter(Boolean).join("\n"));
    throw e;
  }
  session.touch();
  const extra = [
    `${run.edits} op${run.edits === 1 ? "" : "s"} changed blocks · ${run.ms} ms`,
    run.added.length ? `components added: ${run.added.join(", ")}` : undefined,
    run.value !== undefined ? `returned: ${run.value}` : undefined,
    run.log ? `log:\n${run.log.trimEnd()}` : undefined,
  ].filter((x): x is string => !!x);
  return text(formatEdit(doc, { ...run.result, op: name }, extra));
}

export function registerScriptTools({ tool, resource, session }: ToolDeps): void {
  tool(
    "run_script",
    {
      title: "Run script",
      description:
        "Runs JavaScript in a sandbox (QuickJS: no files, network or Node; 64 MB, 10 s) against the open document, for anything repetitive. The source is a function body: " +
        "args holds the arguments, return gives the result. API: sel.* builders (same trees as the tools), every op and generator (fill, replace, array, roof, tower, window…), " +
        `component(), anchor(), palette(), query() (read-only), select(), positions(), log(), seeded rand(). Full reference: resource ${SCRIPT_API_URI}. ` +
        "The whole run is one undo step; on an error or limit nothing changes. Returns the diff summary, the return value and the log. Text, <300 tokens.",
      inputSchema: {
        source: z.string().max(200_000),
        args: z.record(z.string(), z.unknown()).optional(),
        timeout_ms: z.number().int().min(100).max(60_000).optional().describe("Time limit (default 10000)"),
      },
      readOnly: false,
    },
    (c, a) => runScriptTool(c, session, a.source, a.args, "script", a.timeout_ms ? { timeoutMs: a.timeout_ms } : {}),
  );

  resource(
    "script-api",
    { title: "Script API", description: "TypeScript declarations of the run_script API, generated from the op registry (05).", uri: SCRIPT_API_URI, mimeType: "text/plain" },
    () => ({ text: scriptApiDts() }),
  );
}

/** Reads a procedure file and runs it as a script (07: procedures are saved scripts). */
export async function runProcedureFile(c: InstanceContext, session: Session, file: string, name: string, args: Record<string, unknown> | undefined): Promise<Result> {
  return runScriptTool(c, session, await readFile(file, "utf8"), args, `procedure ${name}`);
}
