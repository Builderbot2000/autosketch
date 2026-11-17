import { ConfigConflictError } from "../core/config.js";
import { LibraryError } from "../library/manage.js";
import type { UiError } from "../world/protocol/messages.js";

/** A refused `ui.request`: one of `13`'s error codes and one line for the player (*In-game UI*, `ui.result`). */
export class UiRequestError extends Error {
  constructor(
    readonly code: UiError,
    message: string,
  ) {
    super(message);
    this.name = "UiRequestError";
  }
}

/** The code for an error thrown while serving a request; `internal` for anything not meant for the player. */
export function uiErrorOf(e: unknown): { code: UiError; message: string } {
  if (e instanceof UiRequestError) return { code: e.code, message: e.message };
  if (e instanceof ConfigConflictError) return { code: "conflict", message: "config.toml changed since it was read; reload and try again" };
  // The library's 409s are taken names and read-only roots, which the player's input caused; stale
  // hashes are checked here before the library is called, as `conflict`.
  if (e instanceof LibraryError) return { code: e.status === 404 ? "not_found" : "bad_request", message: e.message };
  return { code: "internal", message: `The MCP failed serving this: ${(e as Error)?.message ?? String(e)}` };
}
