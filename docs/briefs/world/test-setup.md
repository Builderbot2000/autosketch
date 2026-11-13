# In-game test setup (for silo R)

Steps the user runs once before silo R starts. Silos L to Q need none of this. Status: **ready** (2026-11-08). Steps 1 and 2 are done; step 3, the in-client checklist, is ready for the user (2026-11-13).

The dev machine runs Minecraft (Craftoria) on Windows and the MCP in WSL2. v1 runs the MCP only on the same machine as the game.

## 1. WSL mirrored networking (needed for any link)

The mod accepts connections only from the machine it runs on. With WSL's default NAT networking, WSL can't reach a Windows-only connection.

1. Create `C:\Users\kevin\.wslconfig` containing:
   ```
   [wsl2]
   networkingMode=mirrored
   ```
   Needs Windows 11 22H2 or later.
2. Run `wsl --shutdown` in PowerShell, then reopen WSL.

## 2. Headless Craftoria server (automated end-to-end tests)

3. Download the Craftoria **server pack** from CurseForge ("Server Files" on the modpack page). Use the version that matches the client instance (check: the instance folder also contains a `Craftoria-1.21.2` folder).
4. Unzip it inside WSL, e.g. `~/servers/craftoria`, not under `/mnt/c` (slow).
5. Set `eula=true` in `eula.txt`. Leave the rest; silo R's script starts it. Expect about 8–10 GB of RAM; WSL has about 30 GB.

Tell silo R the server path and the Craftoria version.

Current install: `~/servers/craftoria`, Craftoria **1.37.0**, NeoForge **21.1.249**, Minecraft 1.21.1, 537 server-side mods. EULA accepted. The server needs Java 21: `openjdk-21-jdk-headless` from apt is installed and is the default `java` (`/usr/lib/jvm/java-21-openjdk-amd64`). Start it with:
```
cd ~/servers/craftoria && bash startserver.sh
```
Running `startserver.bat` on Windows inside the CurseForge Instances folder fails with "access denied"; use the WSL copy.

## 3. In-client check (last, by the user)

Silo R's automated scenarios pass on the headless Craftoria server (2026-11-13; `docs/design/13-live-world.md`, *Implementation status*). What only a player can check:

**Setup**
1. Build the jar (`cd mod && JAVA_HOME=/usr/lib/jvm/java-21-openjdk-amd64 ./gradlew build`) and copy `mod/build/libs/autosketch-0.1.0.jar` into the Craftoria instance's `mods/` folder (`C:\Users\kevin\curseforge\minecraft\Instances\Craftoria\mods`).
2. Start Craftoria, create or open a test world (Creative, cheats on), and check that `config/autosketch-bridge.toml` appears in the instance folder.
3. In WSL, start Claude Code with the Autosketch server as a development channel, from the repository (the server must be configured as `autosketch` in `claude mcp` / `.mcp.json`, with the Craftoria instance):
   ```
   claude --dangerously-load-development-channels server:autosketch
   ```

**Checks**
4. **Wand and modes.** `/autosketch wand` gives a blaze rod named "Autosketch wand". Left-click a block, then right-click another: the action bar shows the corners, then `work volume W×H×D (link N)`. Press F (swap hands) with the wand: the mode cycles work → context → focus, shown on the action bar. `/autosketch mode context` sets it directly.
5. **Outline particles.** While holding the wand, the work volume is outlined in green, context boxes in blue, the focus box in gold. Put the wand away: the outlines stop; `/autosketch show` brings them back.
6. **Link and action bar.** Ask the agent in the terminal to `doc_open({world: true})` and fill a few blocks: the blocks appear, and the action bar shows `Autosketch: N placed, 0 skipped`. `/autosketch status` shows `MCP connected`, the link and the last patch.
7. **Hand edit with Axiom.** With Axiom, change a few blocks inside the work volume (a fill or paste), then ask the agent for any call on the document (e.g. `history`). It should show a `world sync` entry with your edit, within about a second (the default tracker is `both`; Axiom is believed to bypass the hook, so the scan finds it). Then ask the agent to fill over the area: your Axiom blocks are replaced only where the agent saw them, never silently. Also edit a chest's contents by hand and ask the agent to fill over the chest: the result says `1 skipped (hand-edited)`.
8. **In-game request.** Mark a focus box (wand in focus mode), look at a block, and type `/autosketch ask put a lantern on top of this`. The action bar says it was delivered; the Claude Code session receives the request; activity lines (dimmed) and the agent's `world_reply` (prominent) appear in chat. Ask the agent to `render({views: [{camera: "player"}]})`: the image should show roughly what you were looking at.
9. **Vanilla client join.** Install a plain NeoForge 21.1.249 server with only this jar in `mods/` (accept that server's EULA yourself; the Craftoria server pack can't be used here, since its other mods are required on the client), start it (`test/e2e/world/server.sh start <its folder>` works for any NeoForge server folder), and join it with a vanilla 1.21.1 client (no NeoForge). The mod registers no content, so the join should succeed, and `/autosketch wand` gives that client an ordinary blaze rod. Note any disconnect message.

Report anything that looks wrong with the step number.
