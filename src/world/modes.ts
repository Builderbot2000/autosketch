import type { Document, WriteGuard } from "../document/document.js";
import { refusal } from "../scope/scopes.js";
import type { PlayerRef, RequestMode } from "./protocol/messages.js";

/**
 * Request modes, enforced (docs/design/13-live-world.md, *Backlog* B6, *Request modes, enforced*).
 *
 * The player's subcommand names what the agent may do while the request is open. This is a
 * permission the player grants over their world, not advice, so the MCP refuses with
 * `request_mode` instead of warning:
 *
 * - **Edits** are journal entries on the linked document: every `doc.edit`, `group`, undo, redo and
 *   restore step that runs its write guards, whatever tool or script makes it (`world_sync` entries
 *   bring the world in and run no guards). They are refused in `ask`, `plan`, `scan` and `select`. Only
 *   journal entries on the linked document reach the world, so this is exactly "nothing happens to
 *   the world". Saved selections, cameras, checkpoints, exports and the library are not edits on it.
 * - **Drafts** are refused too (settled with the user 2026-11-16: read-only requests are text only):
 *   forking a sandbox, opening or creating another document (`DRAFT_TOOLS`), and any mutating call
 *   addressed to an existing sandbox. So `ask`, `plan`, `scan` and `select` answer in words (and
 *   `scan` and `select` with volumes); nothing is built anywhere, not even in a scratch copy.
 * - **Volume changes** are the volume tools (`VOLUME_TOOLS`, B4's `world_volumes`): refused in `ask`
 *   and `plan`, allowed in `scan`, `select` and `build`.
 *
 * Select (docs/design/18-select.md, piece 1) reads the world through the world view and the select
 * tools (`world_search`, `world_fill`, `world_expand`, `world_view_read`), none of which edits a
 * document, so the rule needs nothing new for it: it is read-only and volume-changing, as scan is.
 *
 * The rule holds while the read-only request is open (`InGameRequests.heldRequest`): from delivery
 * until the player ends it in game (`/autosketch done`, the mod's `prompt.close`), the next
 * delivered request, or the game disconnecting. The agent can't lift it: `world_reply` with `done`
 * answers the request but leaves the mode in force, since the mode is the player's permission over
 * their world, so only the player lifts it (settled with the user 2026-11-16). A read-only request
 * does not close on idle time either, so a slow turn can't outlast the permission.
 */

/** Modes that allow no edits on the linked document. */
export const READ_ONLY_MODES: ReadonlySet<RequestMode> = new Set(["ask", "plan", "scan", "select"]);
/** Modes that allow volume changes. */
export const VOLUME_MODES: ReadonlySet<RequestMode> = new Set(["scan", "build", "select"]);
/** Tools that start a draft away from the linked document: refused in read-only modes. */
export const DRAFT_TOOLS: ReadonlySet<string> = new Set(["scope_fork", "doc_new", "doc_open"]);
/** Tools that change the player's volumes (B4). */
export const VOLUME_TOOLS: ReadonlySet<string> = new Set(["world_volumes"]);

/** The line the channel event gives each mode, right after the request (B6). */
export const MODE_ALLOWS: Record<RequestMode, string> = {
  ask: "Ask mode: read and look only; edits, drafts (sandboxes, other documents) and volume changes are refused while this request is open.",
  plan: "Plan mode: look, then propose what you would build in words, in a world_reply; edits, drafts (sandboxes, other documents) and volume changes are refused while this request is open.",
  scan: "Scan mode: look around and set the volumes with world_volumes; edits and drafts (sandboxes, other documents) are refused while this request is open.",
  build: "Build mode: you may edit the linked document.",
  select:
    "Select mode: find what the player means in the world, agree on its extent with them, then set the volumes from it with world_volumes; reading the world (world_search, world_fill, world_expand, the world view) is allowed, edits and drafts (sandboxes, other documents) are refused while this request is open.",
};

/** What a mode allows, as the refusal names it. */
const ALLOWS: Record<RequestMode, string> = {
  ask: "reading and looking only",
  plan: "looking and proposing only",
  scan: "looking and setting the volumes only",
  build: "everything",
  select: "finding, reading the world and setting the volumes only",
};

/** An open request as the mode rule sees it. */
export interface ModeRequest {
  id: number;
  player: PlayerRef;
  mode: RequestMode;
}

/** The mode an open request runs in, for the rule: absent means `build`. */
export const modeOf = (r: { mode?: RequestMode } | undefined): RequestMode => r?.mode ?? "build";

/**
 * The `request_mode` refusal: names the mode, what it allows, the subcommand the player would use
 * instead, and that only the player ends the request (`/autosketch done` or a new request), so the
 * agent tells the user at the terminal rather than lifting it.
 */
export function requestModeRefusal(r: ModeRequest, attempt: { edit: string } | { volumes: string } | { draft: string }): Error & { refusal: string } {
  const head = `The open in-game ${r.mode} request (request ${r.id} from ${r.player.name}) allows ${ALLOWS[r.mode]}`;
  const what =
    "edit" in attempt
      ? `, so ${attempt.edit} can't edit the linked document. Nothing was written. To have it built, the player sends /autosketch build <text>.`
      : "draft" in attempt
        ? `, in words only, so ${attempt.draft} can't draft in a sandbox or another document either. Nothing was changed. Describe the idea in world_reply; to have it built, the player sends /autosketch build <text>.`
        : `, so ${attempt.volumes} can't change the volumes. Nothing was sent. To have the agent set them, the player sends /autosketch select [text].`;
  const close = " Answer with world_reply. Only the player can end this request, in game with /autosketch done or by sending a new request; if the user at the terminal wants this edit, tell them so.";
  return refusal("request_mode", head + what + close);
}

/**
 * The mode rule over the linked document and the tool calls (B6). `attach` installs the write guard
 * on a linked document (idempotent); `before` is the session call hook: it attaches the guard to
 * whatever document is linked now, so a relink during a request is covered, and refuses the volume
 * tools in modes without volume changes.
 */
export class RequestModeRule {
  private readonly attached = new WeakSet<Document>();

  constructor(
    private readonly current: () => ModeRequest | undefined,
    private readonly linkedDoc: () => Document | undefined,
  ) {}

  /** Installs the guard on `doc`, which refuses edits only while `doc` is the linked document. */
  attach(doc: Document): void {
    if (this.attached.has(doc)) return;
    this.attached.add(doc);
    const guard: WriteGuard = (_changes, op) => {
      const r = this.current();
      if (!r || !READ_ONLY_MODES.has(r.mode) || this.linkedDoc() !== doc) return;
      throw requestModeRefusal(r, { edit: op });
    };
    doc.guards.push(guard);
  }

  /** The call hook (`Session.callHooks`). */
  before(call: { tool: string; scope?: string; mutating?: boolean }): void {
    const doc = this.linkedDoc();
    if (doc) this.attach(doc);
    const r = this.current();
    if (!r) return;
    if (VOLUME_TOOLS.has(call.tool) && !VOLUME_MODES.has(r.mode)) throw requestModeRefusal(r, { volumes: call.tool });
    if (READ_ONLY_MODES.has(r.mode) && (DRAFT_TOOLS.has(call.tool) || (call.mutating && call.scope !== undefined && call.scope !== "base")))
      throw requestModeRefusal(r, { draft: call.tool });
  }
}
