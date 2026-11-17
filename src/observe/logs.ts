import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";

/**
 * Finished session logs in a workspace (`<workspace>/<doc>/observe/<session>/events.ndjson`, docs/design/12-observability.md,
 * *Event stream*), newest first: the logs a player can replay in the game (docs/design/16-in-game-ui.md, `logs.list`;
 * formerly `autosketch ui`'s Observe tab, `15`).
 */

export interface SessionLogInfo {
  /** `<doc>/<session>`: how the page names a log. */
  id: string;
  doc: string;
  session: string;
  /** Epoch ms of the last write to its event log. */
  modified: number;
  bytes: number;
}

export async function listSessionLogs(workspace: string, limit = 50): Promise<SessionLogInfo[]> {
  const out: SessionLogInfo[] = [];
  const dirs = async (p: string) => (await readdir(p, { withFileTypes: true }).catch(() => [])).filter((e) => e.isDirectory() && !e.name.startsWith(".")).map((e) => e.name);
  for (const doc of await dirs(workspace))
    for (const session of await dirs(join(workspace, doc, "observe"))) {
      const s = await stat(join(workspace, doc, "observe", session, "events.ndjson")).catch(() => undefined);
      if (s) out.push({ id: `${doc}/${session}`, doc, session, modified: s.mtimeMs, bytes: s.size });
    }
  return out.sort((a, b) => b.modified - a.modified).slice(0, limit);
}

/** The folder of a listed log, or undefined for an id that isn't one (never a path given by the page). */
export async function sessionLogDir(workspace: string, id: string): Promise<string | undefined> {
  const hit = (await listSessionLogs(workspace, Infinity)).find((l) => l.id === id);
  return hit ? join(workspace, hit.doc, "observe", hit.session) : undefined;
}
