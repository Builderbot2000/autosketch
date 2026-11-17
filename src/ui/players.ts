import { promptAllowed } from "../world/prompt.js";
import type { ModHello, PlayerRef } from "../world/protocol/messages.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Who sees the in-game UI (`13`, *In-game UI*, "Players" and "One player set for the overlays"):
 * the allowlist `world.promptPlayers` plus the singleplayer host (*Allowed players*), the same rule
 * in-game requests use (`promptAllowed`). Overlays go to the players on it whose UUID is known: the
 * host, entries written as UUIDs, and names matched to a UUID by a request that player sent.
 */
export class UiPlayers {
  /** Lowercase name → UUID, learned from requests (names compare case-insensitively, as the game does). */
  private readonly known = new Map<string, string>();

  constructor(
    private readonly list: () => readonly string[],
    private readonly hello: () => ModHello | undefined,
  ) {}

  /** Whether the player may use the UI; a player seen here is remembered for the overlay set. */
  allowed(p: PlayerRef): boolean {
    this.known.set(p.name.toLowerCase(), p.uuid.toLowerCase());
    return promptAllowed(p, this.list(), this.hello());
  }

  /** The overlay player set, sorted (so a change in it is a change in the string). */
  overlay(): string[] {
    const out = new Set<string>();
    const h = this.hello();
    if (h?.singleplayer && h.host) out.add(h.host.uuid.toLowerCase());
    for (const raw of this.list()) {
      const v = raw.trim().toLowerCase();
      if (UUID.test(v)) out.add(v);
      else {
        const u = this.known.get(v);
        if (u) out.add(u);
      }
    }
    return [...out].sort();
  }

  /** Forgets learned names (a new connection may be a different server). */
  reset(): void {
    this.known.clear();
  }
}
