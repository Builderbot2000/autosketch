import type { SchematicUpgrader } from "../formats/upgrade.js";
import type { BridgeConnection } from "./bridge.js";

/**
 * The upgrade client (docs/design/14-distribution.md, *Schematics from other versions*): the game's
 * data fixer through the linked mod's `upgrade` request (`13`, *Wire format*, protocol 3), as the
 * `SchematicUpgrader` imports and prefab loads use. Undefined while no game is connected or the mod
 * doesn't list `upgrade`: those fall back to the rename table, with a warning.
 */
export function bridgeUpgrader(bridge: Pick<BridgeConnection, "supports" | "hello" | "request">): SchematicUpgrader | undefined {
  const hello = bridge.hello;
  if (!hello || !bridge.supports("upgrade")) return undefined;
  return {
    dataVersion: hello.game.dataVersion,
    upgrade: async (from, data) => {
      const { type: _type, id: _id, ...r } = await bridge.request({ type: "upgrade", from, ...data });
      return r;
    },
  };
}
