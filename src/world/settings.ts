import { parseInt0, parseList, parseText, setting, type Settings } from "../core/settings.js";

/** Live world link settings (docs/design/13-live-world.md). */

/**
 * The game folder holding `config/autosketch-bridge.toml`. Empty: the located instance (`02`), or
 * its `.minecraft` / `minecraft` subfolder when that is where the pairing file is. Set it for a
 * dedicated server, whose folder isn't the client instance.
 */
export const WORLD_GAME_DIR = setting("world.gameDir", "", "a folder path", parseText);

/**
 * How long a tool call waits, after its body returns, for the acks of the patches it sent, so the
 * `world:` line lands in its own result (13, *Agent → world*). Later acks go to the next result.
 */
export const WORLD_ACK_WAIT_MS = setting("world.ackWaitMs", 1500, "milliseconds 0..60000", parseInt0(0, 60_000));

export interface WorldSettings {
  gameDir?: string;
  ackWaitMs: number;
}

export function worldSettings(s: Settings): WorldSettings {
  const dir = s.get(WORLD_GAME_DIR);
  return { ...(dir ? { gameDir: dir } : {}), ackWaitMs: s.get(WORLD_ACK_WAIT_MS) };
}

/**
 * Players allowed to prompt the agent from the game (13, *Prompting from the game*, "Allowed
 * players"): UUIDs or names, comma-separated. The singleplayer host is always allowed as well; on a
 * dedicated server the list starts empty, so every request is refused until players are added.
 * Prefer UUIDs: a name can be reused, or claimed by anyone on an offline-mode server.
 */
export const WORLD_PROMPT_PLAYERS = setting<string[]>("world.promptPlayers", [], "a comma-separated list of player UUIDs or names", parseList);

/** An in-game request's stream closes after this long with no tool calls (13, "Which requests stream"). */
export const WORLD_PROMPT_IDLE_MS = setting("world.promptIdleMs", 300_000, "milliseconds 1000..86400000", parseInt0(1000, 86_400_000));

/** At most one activity `chat` message per this interval; calls in between are coalesced into it (13, "Activity"). */
export const WORLD_ACTIVITY_MS = setting("world.activityMs", 2000, "milliseconds 0..60000", parseInt0(0, 60_000));

export interface PromptSettings {
  promptPlayers: string[];
  idleMs: number;
  activityMs: number;
}

export function promptSettings(s: Settings): PromptSettings {
  return { promptPlayers: s.get(WORLD_PROMPT_PLAYERS), idleMs: s.get(WORLD_PROMPT_IDLE_MS), activityMs: s.get(WORLD_ACTIVITY_MS) };
}
