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

Silo R's automated scenarios pass on the headless Craftoria server (2026-11-13; `docs/design/13-live-world.md`, *Implementation status*). Since 2026-11-17 the headless client harness (`mod/clienttest.sh`, `16`, *Testing*, silo H of the in-game UI set) runs part of this checklist in a real client against a fake MCP: suite `basics` covers air mode's left click setting corner 1, sneak+scroll distance, the outline being drawn while the wand is held and not otherwise, and `/autosketch done` sending `prompt.close` and showing the MCP's answer; suite `link` covers the client's link state (connected, offline, too old). Those parts are marked *(automated)* below; check them by hand only if the harness fails or can't run. What only a player can check:

**Setup**
1. Build the jar (`cd mod && JAVA_HOME=/usr/lib/jvm/java-21-openjdk-amd64 ./gradlew build`) and copy `mod/neoforge/versions/1.21.1/build/libs/autosketch-neoforge-1.21.1-0.1.0.jar` into the Craftoria instance's `mods/` folder (`C:\Users\kevin\curseforge\minecraft\Instances\Craftoria\mods`), with Cloth Config (already in Craftoria).
2. Start Craftoria, create or open a test world (Creative, cheats on), and check that `config/autosketch-bridge.toml` appears in the instance folder.
3. In WSL, start Claude Code with the Autosketch server as a development channel, from the repository (the server must be configured as `autosketch` in `claude mcp` / `.mcp.json`, with the Craftoria instance):
   ```
   claude --dangerously-load-development-channels server:autosketch
   ```
   **Shared memory** (`13`, B5). Claude Code keys its auto memory by the folder a session is launched from, so a session started anywhere else begins with no memory of earlier builds. Point every building session at one store by adding to `~/.claude/settings.json` (or the settings of the folder you launch the in-game session from):
   ```json
   { "autoMemoryDirectory": "~/.autosketch/memory" }
   ```
   Autosketch adds no memory tools: the agent reads and writes the store with its ordinary file tools. Limits: auto memory isn't passed to subagents, except forks, so a `scope_fork` subagent sees only what its handoff quotes; and the store is local to this machine.

**Checks**
4. **Wand and modes.** Hold any blaze rod (the wand, B1; there is no `/autosketch wand`). Left-click a block, then right-click another: the action bar shows the corners, then `work volume W×H×D (link N)`. Press F (swap hands) with the wand: the mode cycles work → context → focus, shown on the action bar. `/autosketch mode context` sets it directly.
5. **Outline particles.** *(Drawn with the wand and not without: automated, `basics`. Colours by kind and `/autosketch show`: by hand.)* While holding the wand, the work volume is outlined in green, context boxes in blue, the focus box in gold. Put the wand away: the outlines stop; `/autosketch show` brings them back.
6. **Link and action bar.** After marking a work volume, the server links on its own (no `doc_open` needed). Ask the agent to fill a few blocks: the blocks appear, and the action bar shows `Autosketch: N placed, 0 skipped`. `/autosketch status` shows `MCP connected`, the link and the last patch. *(The client's link state following the MCP connecting and going: automated, `link`.)*
7. **Hand edit with Axiom.** With Axiom, change a few blocks inside the work volume (a fill or paste), then ask the agent for any call on the document (e.g. `history`). It should show a `world sync` entry with your edit, within about a second (the default tracker is `both`; Axiom is believed to bypass the hook, so the scan finds it). Then ask the agent to fill over the area: your Axiom blocks are replaced only where the agent saw them, never silently. Also edit a chest's contents by hand and ask the agent to fill over the chest: the result says `1 skipped (hand-edited)`.
8. **In-game request.** Mark a focus box (wand in focus mode), look at a block, and type `/autosketch build put a lantern on top of this`. The action bar says it was delivered; the Claude Code session receives the request; activity lines (dimmed) and the agent's `world_reply` (prominent) appear in chat. Ask the agent to `render({views: [{camera: "player"}]})`: the image should show roughly what you were looking at.
   Then the modes (`13`, B6): `/autosketch ask what is this block?` gets an answer, and asking the agent in that request to place a block shows a dimmed `… refused: request_mode` line and changes nothing. The agent's answer (`world_reply` with `done`) doesn't lift the mode: asking it at the terminal to place the block is still refused, and the agent says that only you can end the request. Run `/autosketch done` *(sending `prompt.close` and showing the answer: automated, `basics`; the mode lifting against the real MCP: by hand)* (and once more with the alias, e.g. `/as done`, after a new `ask`): the action bar says `Autosketch: ask request N ended; the agent may edit again.`, and the same edit then goes through; run it again with nothing open and the action bar says no ask, plan or select request is open. A `/autosketch build …` request also ends an open `ask` and its edit goes through.
   **Air mode** (`13`, B2; the mod's jar is on the client too, as in singleplayer). `/autosketch air on`, hold the rod, look into open sky: a white line box sits 5 blocks ahead and follows the look; sneak+scroll moves it nearer or farther (the action bar shows the distance); left click into the air sets corner 1, right click corner 2. *(Sneak+scroll distance and the left click: automated, `basics`; the right click and the box following the look: by hand.)*
   **Select** (`18`; replaces `/autosketch scan`, removed in protocol 4). Stand near a build with a distinctive material (a mossy stone brick house, say) and type `/autosketch select the mossy stone brick house` (with no text, the block under the crosshair is the seed). The agent searches, then asks in chat with one clickable line per choice (hover: *Click to answer with this*); click one, or type its number (`/autosketch select 2`) or your own answer. The candidate it grows shows in the world as a tinted shell, outline edges within 64 blocks and faces beyond, through blocks; its proposed hits pulse a few times. Once you agree it's the right shape, the agent confirms it: the work volume becomes the shape's box and the context that box plus 8, drawn as wide lines visible at distance (particles only for a client without the mod), with a notice that the agent set them. Nothing in the world changes. `/autosketch done` ends the request and the candidate outline goes away; the volumes stay. *(Search, choices, fill, expand, the faded render and the confirmed volumes against the real mod: automated, e2e world tier `select.test.ts`, with the player stood in for at the MCP's edge; the choice click, the outline near and far and the volume lines: automated against the fake MCP, client suites `candidates` and `overlay`; the command-to-`prompt` path, the click through to the real MCP and how the outline reads in a real world: by hand.)*
9. **Vanilla client join.** Install a plain NeoForge 21.1.249 server with only this jar in `mods/` (accept that server's EULA yourself; the Craftoria server pack can't be used here, since its other mods are required on the client), start it (`test/e2e/world/server.sh start <its folder>` works for any NeoForge server folder), and join it with a vanilla 1.21.1 client (no NeoForge). The mod registers no content, so the join should succeed, and a blaze rod in that client's hand works as the wand. Note any disconnect message.

10. **Axiom and an older blueprint** (for `docs/design/14-distribution.md`; recorded, not yet scheduled). Put a `.bp` marked `DataVersion` 3465 (1.20.1) that holds `minecraft:grass` into Axiom's blueprint folder (`config/axiom/blueprints`; Autosketch can write one on request), open it in Axiom on Craftoria, and note whether it places `short_grass` (upgraded), nothing, or an error.

Report anything that looks wrong with the step number.
