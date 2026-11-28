# 21 — The console: in-game prompt session, persistent mode, whole replies

Prompting from the game takes too much typing. Every request repeats its mode (`/autosketch plan <text>`), chat's input line is narrow and forgets the draft when it closes, and the agent's output fills the player's chat with activity lines, status lines and answers chopped into many `Agent:` messages. This spec adds **the console**, a Claude Code–style session in the client half: a transcript panel and an input line that the player expands, collapses and types into independently. All of the agent's output goes there instead of chat. The request mode becomes a setting the player switches.

Status: designed with the user 2026-11-28 (*Decisions*). Not built. Builds on `13` (in-game requests, modes B6, the wand), `16` (client half, HUD, key bindings, settings), `18` piece 7 (choices, mode switch) and `19` (status lines, stop, queue).

## Decisions

Settled with the user on 2026-11-28.

- **A dedicated console in the client half**, not chat capture and not shorter commands. A sticky "chat goes to the agent" mode was set aside: it is a hidden state, it sends talk meant for chat to the agent (or the reverse), and it competes with other mods that read chat.
- **The console works like a Claude Code session.** A transcript, an input line with the mode shown under it, Shift+Tab to cycle the mode, Enter to send (queued mid-turn), Ctrl+C to stop, ↑ for earlier prompts, and slash commands.
- **Showing it and typing into it are separate.** The panel can stay expanded while the player moves around and builds, so they can watch the agent work. The hotkey moves input onto the console as `T` does for chat, and Esc gives input back without hiding the panel. A second key expands or collapses it. Collapsed, only an icon shows.
- **The panel stays small.** It must not dominate the player's view (*Size*).
- **All agent output goes to the console** for a player whose client has the client half: replies, activity, status lines, choices and the MCP's notices. Their chat gets none of it. Chat stays the fallback for vanilla clients.
- **The hotkey defaults to `` ` `` (grave).**
- **Ctrl+C stops the running request.**
- **The mode is a per-player setting that lasts the session.** The server half keeps it in memory, so it resets to `build` when the server restarts.
- **`/autosketch mode` sets the request mode.** The wand mode is switched only by its key (swap-hands while holding the wand, as now). The `/autosketch mode work|context|focus|canvas` form is removed.
- **No command alias.** The `askAlias` config and its short root are removed.
- **A reply is one message** with paragraphs, not one message per 100-character piece (*Part C*).
- **The vanilla-client fallback is frozen.** A client without the client half keeps today's paths (chat commands, chat output, particle outlines, numbered choices), but new features aren't built for it. It changes only where shared code changes it anyway, such as *Part C*'s one-message replies, which the server half prints. Reason: the mod is one jar, so single-player and the user's own client always have the client half. A vanilla client only occurs when someone joins a dedicated server without the mod, which is outside the single-player focus. Making the client half required (and deleting the fallback) is the next step if keeping it working starts to cost real time.

## Principles

1. **Mirror Claude Code** (mirror-claude-code-ux). Where Claude Code has a convention for something the console does, the console follows it, unless Minecraft needs the key for something else (Esc, *Keys*).
2. **The mode is the player's permission** (`13`, B6). Only the player sets it: with `/autosketch mode`, Shift+Tab, `/mode`, or a choice they pick (`18` piece 7). The agent never changes it.
3. **Vanilla clients keep a working path.** Everything the console sends has an `/autosketch` command, and output falls back to chat. The console adds a better way in without taking the old one away.
4. **The world stays in front.** The console is an overlay beside play, not a screen that replaces it.
5. **No new MCP logic.** The MCP already takes `mode` on every `prompt`, queues and stops requests, and sends `chat` frames. Choosing the mode moves into the mod, and where output is shown is the mod's business.

## Part A — Persistent mode and commands

### Model

- The server half keeps a map from player UUID to `RequestMode` in memory (`ask | plan | select | build`). It starts empty, and a missing entry means `build`. Air mode (`AirMode`) is kept the same way.
- **`/autosketch mode <ask|plan|select|build>`** sets it. The command suggests only the modes the MCP's hello lists; any other mode is refused with `unsupported_mode`, and the setting doesn't change. `/autosketch mode` with no argument shows the current mode. A change is confirmed in the console, or on the action bar without it: `Mode: plan (read and propose only)`.
- **The wand mode** is cycled only by the swap-hands key while holding the wand (`WandControl`, unchanged). This works on a vanilla client because the server sees the key. The action bar still shows the wand mode, and `/autosketch status` lists it.

### Sending

- **From the console:** whatever the player types (that isn't a slash command) is sent in the current mode (*Part B*).
- **From chat** (vanilla clients, or by choice): `/autosketch ask|plan|select|build <text>` as now. It sends in that mode **for that request only** and leaves the setting as it is. There is no bare `/autosketch <text>`: next to the subcommands it would mean that a prompt starting with `stop`, `mode` or `clear` runs that subcommand.

### Changes to the read-only hold

This replaces `13`'s B6 rule ("a read-only request holds its mode until `/autosketch done`, the next delivered request or a disconnect").

- While the player's mode is `ask`, `plan` or `select`, every request they send is read-only. The MCP's mode rule is unchanged and still reads the mode of the open request.
- **Switching to `build` is how the player lifts it.** The next request carries `build`. The open read-only request keeps its mode until it ends, because a permission doesn't change halfway through a turn. Picking a choice with a `mode` (`18` piece 7) still switches the open request, and it now also sets the player's setting to that mode.
- **`/autosketch done` stays and keeps its job:** it ends the open read-only request (`prompt.close`) without changing the setting.
- The agent can't change either one. `world_reply` with `done` still leaves the request's mode in force.

### Removed

- `askAlias` (mod config) and the alias root it registered (`PromptModule.alias`), with its GameTests. The config key is ignored with a log line if it is still set.
- `/autosketch mode work|context|focus|canvas` (`VolumeCommands`). The new `mode` subcommand belongs to the prompt module.

## Part B — The console

### Three states

| State | What shows | Input |
|---|---|---|
| **Collapsed** | An icon only. | The game, as normal. |
| **Expanded** | The panel: recent transcript plus the input line, drawn as an overlay. | The game, as normal: the player moves, builds and uses the wand while watching. |
| **Focused** | The panel, taller and scrollable (*Size*), with a cursor in the input line. | The console, as chat takes input while open. The mouse is free and movement keys type. The game doesn't pause. |

- Focus and expansion are independent. Focusing a collapsed console expands it and focuses it. Esc from focus returns to whatever expansion state the console had before.
- Every state survives the others: the draft, the transcript's scroll position and the expansion stay.

### Keys

| Key | Where | Does |
|---|---|---|
| `` ` `` (default, `console_focus`) | in game | Focuses the console, expanding it if it was collapsed. |
| Shift+`` ` `` (default, `console_toggle`) | in game | Expands or collapses the console without focusing it. |
| Enter | focused | Sends the prompt in the current mode, or runs the slash command, then leaves focus (as chat closes after sending). A prompt sent while a request runs is queued (`19`, *Queueing*). Empty input: leaves focus. |
| Shift+Enter | focused | New line. |
| Shift+Tab | focused | Cycles the mode through the ones the MCP's hello lists: build → ask → plan → select → build. This sets the player's setting. |
| ↑ / ↓ | focused | On the first or last line of the input: earlier and later prompts from this session (client memory, at most 50). Otherwise moves the cursor. While a question is open: moves between its choices (*Questions*). |
| Ctrl+C | focused | With text selected: copies. With nothing selected: stops the running request (`19`, *Stop*), the same as `[Stop]` and `/autosketch stop`. With no request running: a line in the transcript, nothing else. |
| Ctrl+O | focused | Shows or hides activity detail in the transcript (*Transcript*), as Claude Code's transcript toggle does. |
| Scroll, PgUp/PgDn | focused | Scrolls the transcript. |
| Esc | focused | Leaves focus and keeps the draft. The panel stays expanded if it was. |

- Inside the input, keys type: grave and tilde are characters there, as in chat.
- **Why Esc doesn't stop the request** as it does in Claude Code: Esc is Minecraft's key for leaving every screen, and a player who presses it to get out of the console mustn't stop a build by accident. Ctrl+C stops.
- **Why Enter leaves focus:** in game the player usually sends and goes back to looking and building, as with chat. The panel stays expanded, so they keep watching. A setting (`console.keepFocus`, default off) keeps focus after sending.
- **Key conflicts.** NeoForge's key-binding screen already marks conflicts. `/autosketch status` and the install check (`14`) report when `console_focus` or `console_toggle` shares a key with another binding in the instance. Before building (step P3), check whether any of the Craftoria instance's mods binds grave by default.

### Size and place

- **Bottom-right corner, above the hotbar's height.** Vanilla leaves that corner empty in play; chat is bottom-left and the HUD (`16`) top-left. The settings screen can move it to the left (`console.side`).
- **Expanded:** at most 40% of the screen's width and 8 transcript lines (both settings: `console.width`, `console.lines`), on a translucent background (`console.opacity`, default 40%). The newest entries show. Older ones scroll out of view and stay in the transcript.
- **Focused:** the same width, and up to 50% of the screen's height, scrollable. The background is a little darker so the text is easy to read while typing.
- **Collapsed:** a 12 px icon in the same corner showing:
  - the current mode as a coloured letter: A ask, P plan, S select, B build;
  - a spinner while a request is `working` or `stopping`;
  - a queue badge (`2`) when prompts are queued;
  - a dot when there are new entries the player hasn't seen;
  - `?` when the agent is waiting on a question.
  It doesn't expand by itself. When a reply arrives while collapsed, its first line shows beside the icon for 5 seconds (`console.peek`, default on).
- It hides under F1, while another screen is open (menus, inventories, the library), and in replay (`16`).

### Input line and footer

- The input sits at the bottom of the panel. It is one line and grows to at most 6 lines as the text wraps or gets new lines. The draft is kept until it is sent, but not past leaving the world.
- **The footer**, under the input, mirrors Claude Code's status row: the mode and its meaning (`⏸ plan mode — look and propose only · shift+tab to cycle`), then `n queued`, then `ctrl+c to stop` while a request runs. It shows while expanded as well as focused, so the mode is always visible.
- Prompts can be up to the protocol's prompt length (`13`), not chat's 256 characters, because the console sends them as a `ui.request` and not as a typed command (*Wire*).

### Slash commands

The input runs slash commands as Claude Code does. A line starting with `/` is a command, not a prompt.

- **Every `/autosketch` subcommand is reachable without the prefix:** `/stop`, `/queue cancel 2`, `/mode plan`, `/done`, `/select …`, `/canvas …`, `/focus clear`, `/status`. The console sends `/autosketch <rest>` through the normal command path, so permissions and results are exactly the command's. The command's feedback lands in the transcript, not chat.
- **Completion:** typing `/` lists the subcommands. Arguments complete from the server's command tree (the same suggestions request chat uses, rooted at `/autosketch`), shown as a list above the input. Tab accepts.
- **Console-only commands:**
  - `/help`: lists the keys and commands.
  - `/cls`: clears the panel's view of the transcript. It changes nothing on the MCP or in the world. It is named `/cls` because `/clear` is the `/autosketch clear` subcommand (it clears the volumes).
- **Not game commands.** `/tp` or `/gamemode` typed here are refused with "game commands go in chat", and nothing is run. Reason: a second place to run any command would make the console another chat, and some names exist in both trees with different effects (vanilla `/clear` empties the inventory; `/autosketch clear` clears the volumes).
- **Locked states** (`16`, *Mod side*): with no MCP connected, or one too old, prompts aren't sent and the footer says why. `/status`, `/help` and `/cls` still work.

### Transcript

One transcript per player per session, in client memory (at most 500 entries), cleared on leaving the world. Entries, oldest first:

- **The player's prompt**, with its mode chip, and `queued #n` while it waits.
- **The request's status row** (`19`, *Status line*): `⏳ Working · 14 calls · 0:42 [Stop]`, `✔ Done …`, `■ Stopped … [Undo request]`, `⧗ Queued [Send now] [Cancel]`. It is updated in place, as the client half already updates the status line in chat.
- **Activity.** By default, a request's activity lines fold into its status row as its latest line, dimmed (`· fill 12×4×9 stone_bricks`). The panel then grows by one row per request, not one row per tool call. With Ctrl+O they show in full under the row, dimmed and italic, as in chat now.
- **The agent's replies**, as whole paragraphs wrapped to the panel's width, with `Agent` once at the top (*Part C*). Clickable lines (`17`, a candidates list) are underlined and clickable while focused.
- **Questions** (`18` piece 7): the question's text, then its choices as a list. While focused, ↑/↓ (or the digit) selects a choice and Enter answers. "Or type your own answer" means typing in the input, and Enter sends the text as the answer. Once answered, the list folds to the chosen line, as folding does in chat now. A question also sets the icon's `?`.
- **Notices** from the MCP (`notice`: stopped, cancelled, nothing running, refusals) and the delivery result of a prompt (`delivered`, `queued #2`, `not delivered: no_link`), as dim one-line entries. The action bar keeps only the wand's and the volumes' own messages.

## Output routing

- **A player whose client registered the UI channel, with the link `connected`:** the server half relays every frame for that player — `chat` of each kind (`activity`, `reply`, `status`), the choice replies, `choices.answered` and `notice` — to their client half (relay op 0, whole frames, as `status` and folded choices already are) and **prints nothing** to their chat. The client half adds them to the console.
- **Everyone else** (vanilla clients, an older client half without the console) gets chat as now, with replies as one message (*Part C*).
- **Other viewers.** A player with `/autosketch log all` sees other players' agent output in their own console if they have one, and in chat if not. `log off` still hides activity everywhere.
- **The relay is the mod's own.** Both halves ship in one jar, so this needs no MCP feature or protocol change. The server half learns that a client can take it from the channel registration it already tracks, plus a client-half feature marker `console` in the channel's version handshake, so a client half from before the console still gets chat.

## Part C — A reply is one message

### What happens now

1. `world_reply` takes `lines` (1–20 strings), and the agent puts one paragraph, often one sentence, in each.
2. The mod hard-wraps each line at 100 characters (`ChatRules.wrap`, `WRAP`) and prints **each piece as its own chat message**, each starting with `Agent: ` (`InGamePrompts.format`).

So one paragraph becomes several `Agent:` messages, broken at a character count unrelated to the chat's real width, and each one is a separate entry in chat's history.

### Change

- **One reply = one message.** `Agent` once, then the paragraphs. In the console, each paragraph is wrapped to the panel's width. In chat (the fallback), the paragraphs are joined with line breaks into one `Component`, so Minecraft wraps them to the chat width by pixels and treats them as one message (one history entry, one fade).
- **No hard wrap for replies.** `ChatRules.wrap` stays only for activity lines in chat.
- **Clickable lines and choices** keep their own message in chat, because a chat message carries one click action. In the console each is its own row.
- **Paragraphs, not lines.** `world_reply` gains `text`: one string of at most 4000 characters, with paragraphs separated by blank lines. `lines` stays accepted for older prompts and skills and is shown the same way, as paragraphs. The tool description asks for `text` and short paragraphs.
- **Simple formatting**, shown in the console and stripped in chat: `-` bullets, `**bold**`, `` `code` ``. Nothing else. The panel is small, so no headings or tables.
- **The wire doesn't change.** `chat` still carries `lines`, and the MCP sends the reply's paragraphs as its lines.

## Wire

All within the current protocol, no bump. None of it reaches the MCP.

| Direction | Message | Notes |
|---|---|---|
| client → server (op 1) | `ui.request` `console.prompt {text}` | The server half sends it as a `prompt` in the player's current mode, with the game context captured at that moment (position, look, focus), through the same checks as `/autosketch <mode> <text>` (`InGamePrompts.request`). Answers with `ui.result`: `delivered`, `queued` with its position, or the refusal. |
| client → server (op 1) | `ui.request` `console.mode {mode}` | Same as `/autosketch mode <mode>`. Answers with the mode now in force. |
| client → server (op 1) | `ui.request` `console.command {line}` | Runs `/autosketch <line>` as the player. The command's feedback comes back as a `ui.result` and as relayed lines, not in chat. |
| server → client (op 3) | action `mode <m>` | Mod-internal: on every change and on join, for the icon, the footer and the HUD's request line. |
| server → client (op 0) | relayed `chat`, `notice`, `choices.answered` | The existing relay, widened to every agent frame for a console client (*Output routing*). |

Until now the server half forwarded every `ui.request` to the MCP (`16`, *Mod side*). It now handles these three itself, because the mode is the mod's setting, the prompt goes out as an ordinary `prompt`, and commands run in the mod.

## Changes to other specs

- **`13`**: B6's read-only hold becomes *Part A*'s rule. M3 loses `/autosketch mode work|context|focus`, so the wand mode is the swap-hands key only. M13 loses the alias root. `mode` becomes the request mode. *What streams back*: replies are one message, and console clients get no agent output in chat.
- **`16`**: *Key bindings* adds `console_focus` (grave) and `console_toggle` (Shift+grave). *Settings* adds `console.side`, `console.width`, `console.lines`, `console.opacity`, `console.peek` and `console.keepFocus`. The HUD's request line reads the `mode` action. The HUD stays where it is. Its request line repeats the console's status for a player who keeps the console collapsed.
- **`19`**: *Status line* — for console clients the row lives in the console, not chat. *Stop* adds Ctrl+C.
- **`world_reply`** (`src/server/tools/world-prompt.ts`): `text` added, `lines` kept.

## Steps

1. **P1, mode and commands (mod, server half):**
   - the in-memory mode map and `/autosketch mode`;
   - remove the wand-mode command and `askAlias`;
   - the new hold rule;
   - the `mode` action.
   GameTests: each mode set and sent; a mode the MCP's hello doesn't list is refused; the per-request override leaves the setting; the swap-hands key still cycles the wand mode; the setting is gone after a restart.
2. **P2, whole replies:** `world_reply`'s `text`, the one-message chat format, the simple formatting stripped in chat. Unit tests on both sides; the frozen vectors are unchanged.
3. **P3, console (client half):**
   - the three states, keys, size and place, the icon and its peek;
   - input, footer, history and draft;
   - slash commands with completion;
   - the transcript (prompts, status rows, folded activity, Ctrl+O, replies, questions, notices);
   - the `console.*` requests and the widened relay.
   Check grave's conflicts on Craftoria first. Client tests (`16`, *Testing*) cover:
   - focus and toggle independently;
   - typing and sending in each mode, and Shift+Tab reaching the server;
   - a queued send, and Ctrl+C stopping;
   - Esc keeping the draft and the expansion;
   - a slash command's result in the transcript;
   - a question answered by keys;
   - no agent output in chat for a console client, chat for a client without one.
4. **Z, in game on Craftoria:**
   - the panel over a live world while walking and building;
   - its size at the user's GUI scale;
   - the mode reset after a server restart;
   - a long reply as one message;
   - grave, Shift+grave and Ctrl+C with the instance's real key bindings.

## Open

- **Shift+grave** for `console_toggle` is a guess. Check it on the user's keyboard layout during Z.
- **Activity folding.** Is one latest line per request, with Ctrl+O for the rest, enough to follow the agent's work while moving? Judge it in Z.
- Whether the transcript should be kept across a reconnect within the same server session (the MCP keeps the requests, and the client forgets on leaving the world).
