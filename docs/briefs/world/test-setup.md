# In-game test setup (for silo R)

Steps the user runs once before silo R starts. Silos L to Q need none of this. Status: **ready** (2026-11-08). Steps 1 and 2 are done; step 3 comes after silo R.

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

6. When silo R's automated scenarios pass, it hands over the mod jar and a checklist.
7. Copy the jar into the Craftoria instance's `mods/` folder, open a test world with cheats on, and check the wand, region outline, action-bar notices, and a hand edit with Axiom.
