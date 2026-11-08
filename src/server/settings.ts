import { parseList, setting } from "../core/settings.js";

/**
 * Server settings (the settings system is described in docs/design/12-observability.md, *Settings*).
 *
 * `server.hideTools` leaves the named tools out of the tool list, for the agent evaluation tier's
 * ablations (docs/design/10-testing.md, *Ablations*): `--set server.hideTools=analyze,render`.
 */
export const SERVER_HIDE_TOOLS = setting<string[]>("server.hideTools", [], "a comma-separated list of tool names", parseList);
