import { parseInt0, parseText, setting, type Settings } from "../core/settings.js";

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
