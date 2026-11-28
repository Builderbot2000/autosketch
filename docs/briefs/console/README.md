# Work briefs: the console, persistent mode, whole replies (`21`)

One brief per silo of `21`, as of the commit that adds this folder (2026-11-28). Each team reads the main [briefs README](../README.md) first (branching, file ownership, code style and *Done means* all apply), then the [UI README](../ui/README.md)'s *Rules for this set* where it touches `mod/` or `src/ui/`, then this README, then its own brief, then `21` and the sections of `13`, `16`, `18` and `19` the brief cites. `21` is the source of truth. A brief only scopes, sequences and assigns files.

Letters are local to this set. Agents work one step at a time and are never resumed (*How to run this set*). Branches are named `silo/cs-<letter>-<slug>`, agents `cs-<step>`.

| Silo | Brief | `21` part | Wave | Side | Depends on |
|---|---|---|---|---|---|
| M | [Mode and commands](M-mode-commands.md) | A | 1 | mod (server half) | — |
| R | [Whole replies](R-replies.md) | C | 1 | MCP, mod | — |
| C | [The console, client half](C-console.md) | B | 1, then 3, then 4 | mod (client half) | C2: M1, R1, S1 · C3: C2 |
| S | [Console path and routing, server half](S-server-path.md) | *Wire*, *Output routing* | 2 | mod (server half) | M1, R1 |
| Z | [In game, close-out](Z-close-out.md) | *Steps* Z, *Open* | 5 | both | all |

```
wave 1                               wave 2                         wave 3                          wave 4                        wave 5
M1 mode map, /mode, removals ──┬──► S1 console.* requests,     ──┐
R1 world_reply text, one msg ──┘     mode action relay, routing  ├─► C2 sending + transcript ───► C3 slash commands ──────► Z1 restart, e2e, specs
C1 console shell (states, keys, ───────────────────────────────┘                                                         Z2 hands-on (lead + user)
   size, icon, input, footer)
```

**Why this split.** Part A (mode) and Part C (replies) share no files beyond `InGamePrompts.java`, where they touch different methods, so they run side by side with the console's shell, which is client-only and can be built against the contracts below before anything feeds it. The server-half path (S) needs the mode store to send in the player's mode and R's one-message format to print the fallback, so it waits for both. The transcript (C2) needs the shell, the path and the reply formatting. Slash commands (C3) come last because they change the same input handling C2 finishes.

**Nothing reaches the MCP except R1** (`world_reply` `text`) and, only if M1 finds it necessary, one optional field on `choices.answered` (*Cross-silo contracts*). Everything else is mod-internal: both halves ship in one jar.

## Cross-silo contracts

The owner lands the contract in its first merge, and the users code against it. C1 runs before its owners merge, so C1 codes against the shapes below and stubs the sources.

| Contract | Owner | Users | Shape |
|---|---|---|---|
| Player mode store | M1 | S1, Z1 | Server half, in memory: `PlayerModes.get(ServerPlayer) → RequestMode` (missing = `build`), `set(player, mode)` returning the mode in force or refusing `unsupported_mode` against the MCP's hello, and a change listener. Reset on server start |
| `mode` client action | M1 (sends), C1 (reads) | C1, C2, HUD | op 3 (`UiPayload.CLIENT_ACTION`) `mode <ask|plan|select|build>`, on join, on link `connected` and on every change. Mod-internal, unversioned |
| Choice switch sets the setting | M1 | — | When a picked choice switches its request's mode (`18` piece 7), the server half sets the player's setting to it. M1 first looks for the mode in frames the server half already sees (the relayed choice reply, the pick's `ui.request`); only if none carries it, add optional `mode` to `choices.answered` (vector, both codecs, MCP sends it on a switch) and record that in `21` |
| Reply text | R1 | S1, C2 | Mod common: `ReplyText.parse(List<String> lines) → List<Paragraph>`; each `lines` entry is one paragraph or more, split again on blank lines; a paragraph is a bullet item or plain text, made of spans (`plain`, `bold`, `code`). `ReplyText.chat(...) → Component` is the fallback's one message (`Agent: ` once, paragraphs joined by line breaks, markers stripped). Clickable lines and choices are not part of it |
| `console.*` requests | S1 | C2, C3 | Client → server op 1 `ui.request`, handled in the server half, never forwarded: `console.prompt {text}` → `ui.result` `{delivered:true}` · `{queued:true, request, position}` · error with the refusal reason as `InGamePrompts.request`'s; `console.mode {mode}` → `{mode}` or error `unsupported_mode`; `console.command {line}` → `{ok, lines[]}` (the command's feedback, which goes nowhere else) |
| Console marker | S1 (server reads), C2 (client sends) | — | The client half lists `console` in the UI channel's version handshake. S1 adds the parsing and routing; **C2 turns the client's marker on**, so between S1 and C2 every client still gets chat |
| Console model | C1 | C2, C3 | Client half: `ConsoleModel` holds the state (collapsed/expanded/focused), draft, history (50), transcript (500 entries) with `add(entry)` and `update(key, entry)` for in-place rows, the unseen-dot, the queue count and the question flag. Entries implement a small `ConsoleEntry` interface (wrapped rows for a width, optional click). C1 ships a plain-text entry; C2 adds the kinds |

## Contested files

| File | Who touches it | Protocol |
|---|---|---|
| `docs/design/21-console.md` | lead (the *Implementation status* table, already added), each silo its own row, Z2 the *Status* line | Edit only your rows |
| `docs/design/13-live-world.md` | M1 (B6, M3, M13), R1 (*What streams back*: replies), S1 (*What streams back*: console clients) | Edit only your sections |
| `docs/design/16-in-game-ui.md` | C1 (*Key bindings*, *Settings*, HUD request line) | C only |
| `docs/design/19-canvas-and-requests.md` | S1 (*Status line*), C2 (*Stop*: Ctrl+C) | Edit only your sections |
| `mod/common/.../prompt/InGamePrompts.java` | M1 (request path, `done`), R1 (`format` and the reply print), S1 (routing: print nothing for a console client) | M1 and R1 in different methods; S1 after both |
| `mod/common/.../prompt/PromptModule.java`, `ChatRules.java` | M1 (mode subcommand, alias removed), R1 (`wrap` only for activity) | M1 owns `PromptModule`, R1 `ChatRules` |
| `mod/common/.../command/VolumeCommands.java`, `AutosketchConfig.java` | M1 | M only |
| `mod/common/.../ui/relay/**` | M1 (sending the `mode` action, additive), S1 (routing, marker, `console.*` handling) | M1 one helper call; S1 owns the rest |
| `src/server/tools/world-prompt.ts`, `src/world/chat-stream.ts` | R1 | R only (M1 only for the optional `choices.answered` field) |
| `src/world/protocol/**`, `test/data/world-protocol/**`, `mod/common/.../protocol/**` | M1, only for the optional field | Frozen vectors otherwise unchanged |
| `mod/neoforge/.../client/ui/console/**` (new), `AutosketchKeys.java`, the `16` settings screen and store | C1, then C2, then C3 | C only, sequential |
| `mod/neoforge/.../client/ui/chat/**`, `client/ui/hud/**` | C1 (HUD reads `mode`), C2 (status and choice lines go to the console) | Sequential |
| `mod/clienttest.sh`, `gametest/client/console/**` (new suite `console`) | C1 adds the suite, C2 and C3 add to it | Sequential |

## Rules for this set

- **The mode is the player's permission.** Only the player changes it (command, Shift+Tab, `/mode`, a picked choice). Nothing the agent sends may change the setting.
- **The world stays in front.** The console never pauses the game, never opens a `Screen` that replaces play while expanded, and stays within `21` *Size*.
- **Mirror Claude Code** (footer, Shift+Tab, queued sends, Ctrl+C, ↑ history, `/` commands) except where `21` *Keys* says why not.
- **The vanilla fallback is frozen.** Keep it working (chat commands, chat output, numbered choices); build nothing new for it. R1's one-message replies are the only fallback change.
- **No opinions in code.** Console rows show what the frames say; nothing summarises or judges the agent's work.

## How to run this set

As in the canvas set: **one fresh agent per step, never resumed or messaged** (the hook blocks SendMessage to `cs-…`). Worktrees in `.claude/worktrees/cs-<letter>`, with `node_modules` linked to the main checkout. Review fixes are a new agent `cs-<step>-fix`; an interrupted step gets a WIP commit and a fresh agent `cs-<step>-r`. State lives in git, `21`'s *Implementation status* and [PROGRESS.md](PROGRESS.md).

| Silo | Steps (one merge each) |
|---|---|
| M | M1 the in-memory mode map and `/autosketch mode`, the new hold rule, the `mode` client action, a picked choice setting the mode; remove `/autosketch mode work|context|focus|canvas` and `askAlias` (ignored with a log line) |
| R | R1 `world_reply` `text` (≤4000, paragraphs; `lines` kept), the MCP sending paragraphs as lines, `ReplyText` (parse, simple formatting, the chat fallback's one message), `ChatRules.wrap` only for activity |
| C | C1 the console shell: three states, `console_focus`/`console_toggle` ('/Shift+'), size and place, icon and peek, input (multi-line, draft, history), footer, `console.*` settings, hiding rules, key-conflict report, HUD reads `mode` · C2 sending and the transcript: prompts, mode (Shift+Tab), Ctrl+C stop, every entry kind, Ctrl+O, questions by keys, chat/status/choice lines to the console, the client's `console` marker · C3 slash commands: `/autosketch` subcommands without the prefix, completion from the server's tree, `/help`, `/cls`, game commands refused, locked states, clickable lines |
| S | S1 `console.prompt`, `console.mode`, `console.command` in the server half; the `console` marker parsed; every agent frame relayed to a console client and nothing printed in its chat; `log all` viewers |
| Z | Z1 the mode reset after a restart and a long reply as one message on headless Craftoria; spec statuses; `test-setup.md` in-client checks · Z2 hands-on in game with the user, led by the lead (not a subagent) |

**Waves.** Wave 1: M1, R1, C1. Wave 2: S1 (M1, R1). Wave 3: C2 (C1, S1). Wave 4: C3 (C2). Wave 5: Z1, then Z2.

**Step prompt** (the whole prompt; add review notes or WIP instructions after it):

> You are agent `cs-<step>` in the autosketch repo, worktree `<path>`, branch `silo/cs-<letter>-<slug>`. Read `docs/briefs/README.md`, `docs/briefs/console/README.md` and `docs/briefs/console/<brief>.md`, then the spec sections the brief cites. Do step <step> only: <one line from the table>. Meet the *Done means* for what this step builds, commit only your own changes (check `git diff --stat main` first; attribution line from the main README), and don't merge or push. Use your own scratchpad subfolder `<scratch>/cs-<step>`. Write full test and build output to files and read only the summary or the failures; run clienttest under `timeout 1800`. Then stop with this report and nothing else:
> ```
> cs-<step> · branch <branch> · commits <first>..<last>
> tiers: typecheck <ok|fail> · npm test <n passed / n failed> · gradle <ok|fail|n/a> · clienttest <n steps ok|fail|n/a>
> decisions: <one line each, already recorded in the spec>
> questions for the lead: <one line each, or none>
> ```

The lead checks a step by running the tiers on the branch and reading `git log --stat main..<branch>`, then adds one line to `PROGRESS.md`.

## Done means (in addition to the main README's)

- `npm run typecheck`, `npm test`, `cd mod && JAVA_HOME=/usr/lib/jvm/java-21-openjdk-amd64 ./gradlew build test runGameTestServer` and `timeout 1800 mod/clienttest.sh` pass (the last two for silos touching `mod/`; a suite that times out under load is rerun alone before it counts as failed).
- `21`'s *Implementation status* row for the step is marked built, and the step's *Changes to other specs* are made in the specs they name.
