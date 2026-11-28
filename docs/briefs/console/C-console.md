# Silo C: The console, client half

**Wave 1** (C1), **wave 3** (C2, after C1, S1 and R1), **wave 4** (C3, after C2).

**Specs:** `21` Part B (all), *Decisions*, *Principles*; `16` (client half, *Key bindings*, *Settings*, HUD, F1/screens/replay hiding, *Testing*); `19` (*Status line*, *Stop*, *Queueing*); `18` piece 7 (questions, folding); `17` piece 3 (clickable lines). Claude Code's own prompt line is the reference for footer, history and Shift+Tab (`mirror-claude-code-ux`).

## Deliverables

**C1, the shell** (no server dependency; stub the sources with the README contracts)

1. `ConsoleModel` (README contract) and the HUD layer that draws it: collapsed icon, expanded panel, focused panel, all as `21` *Size and place* (bottom-right above the hotbar, `console.side`, 40% width, 8 lines, 50% height focused, opacity 40%, darker focused). Hidden under F1, while any other screen is open, and in replay.
2. **Focus** as chat takes input (mouse free, movement keys type, game not paused), without replacing the world: pick the smallest mechanism that meets that (a transparent `Screen` that draws nothing but the panel is acceptable) and record it in `21`.
3. Keys `console_focus` (`'`) and `console_toggle` (Shift+`'`) in `AutosketchKeys`; Enter, Shift+Enter, ↑/↓ history (first/last line only, 50 entries), Esc keeping draft and expansion, scroll and PgUp/PgDn, Shift+Tab cycling the modes the client knows (sending is C2: C1 only changes the footer). Input grows to 6 lines; draft and scroll survive every state change, not leaving the world.
4. **Footer** (`⏸ plan mode — look and propose only · shift+tab to cycle`, `n queued`, `ctrl+c to stop`) and **icon** (mode letter, spinner, queue badge, unseen dot, `?`), both reading the model; the `mode` action (M1) feeds the model's mode; the HUD's request line reads it too. Peek: a reply's first line beside the icon for 5 s (`console.peek`).
5. Settings `console.side|width|lines|opacity|peek|keepFocus` in `16`'s settings store and screen.
6. **Key-conflict report:** the client half lists a conflict of either console key with another binding (shown by the console's `/status` later; for now a line in the client's status output where `16` puts client checks), and the install check (`14`) reports it from the instance's `options.txt`.
7. Client test suite `console` (added to `mod/clienttest.sh`): focus and toggle independently, Esc keeping draft and expansion, history, input growth, the icon's states from a fed model, hidden under F1 and behind a screen.

**C2, sending and the transcript**

8. Enter sends `console.prompt` (S1); its result becomes the prompt's `delivered`/`queued #n`/refusal; Enter leaves focus unless `console.keepFocus`. Shift+Tab sends `console.mode` and the footer follows the answer. Ctrl+C: copy with a selection, else `request.stop` for the running request (`19`), else a transcript line.
9. **Entries:** prompt with mode chip; status row updated in place (move `StatusLineClient`'s in-place logic here for console clients); activity folded into its row as the latest dim line, full under Ctrl+O; replies via `ReplyText` wrapped to the panel width with `Agent` once and the formats drawn; questions with ↑/↓ or digit and Enter, typed answers, folding on `choices.answered`, the `?` flag; notices and delivery results as dim lines. Unseen dot and peek driven by new entries.
10. Turn on the client's `console` marker (README contract). Keep the chat paths (`StatusLineClient`, `ChoiceLinesClient`) for frames that still arrive as chat.
11. Client tests: typing and sending in each mode and Shift+Tab reaching the server; a queued send and Ctrl+C stopping; each entry kind; a question answered by keys; no agent output in chat for a console client, chat for one with the marker off. `19`'s *Stop* gains Ctrl+C.

**C3, slash commands**

12. A line starting with `/` is a command: `/autosketch` subcommands without the prefix via `console.command`, feedback into the transcript; completion listed above the input from the server's command tree rooted at `/autosketch` (the same suggestion request chat uses), Tab accepts; `/help` (keys and commands), `/cls` (clears the view only); any other game command refused locally with "game commands go in chat"; locked states (no MCP, too old) block prompts with the footer saying why, while `/status`, `/help`, `/cls` work. Clickable reply lines clickable while focused.
13. Client tests: a command's result in the transcript and not in chat, completion of `/mo` → `/mode` and of its argument, `/tp` refused, `/cls`, a locked state.

## Files you own

`mod/neoforge/.../client/ui/console/**` (new), `AutosketchKeys.java`, the `16` settings store and screen (console keys), `client/ui/hud/**` (mode), `client/ui/chat/**` (C2), `gametest/client/console/**`, `mod/clienttest.sh` (suite list), the install-check line for the keys; `16`'s *Key bindings*, *Settings*, HUD; `19`'s *Stop* (C2); `21`'s C rows.

## Done when

- **C1:** the `console` suite drives focus/toggle/Esc/history with a fed model, and the panel never covers the crosshair at GUI scale 2 and 4 (a client-test screenshot check of its bounds).
- **C2:** a client test sends a prompt in `plan`, sees the status row go working → done in place with folded activity, then the reply as one entry, and the player's chat stays empty.
- **C3:** `/mode build` from the console changes the footer and leaves chat empty.
