---
name: ingame-setup
description: Prepare a physical in-game test on the Craftoria client — check WSL mirrored networking, rebuild the MCP and the mod jar, replace the jar in the Craftoria instance's mods folder, and wait for the mod's bridge to open. Use when the user wants to set up, prep or start an in-game test.
---

# In-game test setup

Everything is in `scripts/ingame-setup.sh`. Run from the repo root:

1. `bash scripts/ingame-setup.sh prep`: checks `wslinfo --networking-mode` is `mirrored`, runs `npm run build`, builds the jar (`./gradlew build -x test` with Java 21), removes every `autosketch-*.jar` in the instance's `mods/`, and copies the new jar in. It skips the copy when the installed jar is identical. If the removal fails, Minecraft is running and holds the jar: ask the user to close the game, then run it again.
2. Tell the user to start Craftoria and open the test world (Creative, cheats on).
3. `bash scripts/ingame-setup.sh wait` (run it in the background; it can take minutes while the pack loads). It waits for `config/autosketch-bridge.toml` and checks that the game process in it is alive.
4. In-game requests only reach a Claude Code session started on the development channel, and this session can't restart itself on it. Tell the user to open a new terminal and run:
   ```
   bash scripts/ingame-setup.sh launch
   ```
   (or `claude --dangerously-load-development-channels server:autosketch` from the repo). Then they can check the link in game with `/autosketch status` (`MCP connected`).

From a plain terminal, `bash scripts/ingame-setup.sh` with no argument runs all of it: prep, wait, launch.

Report any failed step with its output. Don't work around a failed networking check or build.
