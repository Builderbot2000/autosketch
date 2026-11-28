# Silo S: Console path and routing, server half

**Wave 2** (S1, after M1 and R1).

**Specs:** `21` *Wire*, *Output routing*, Part B *Slash commands* (the server side of `console.command`), *Locked states*; `16` (*Mod side*: today every `ui.request` is forwarded to the MCP); `19` (*Status line*, *Queueing*); `13` (*Relay*, `log`).

## Deliverables (S1)

1. **`console.prompt {text}`**: sent as a `prompt` in the player's setting (M1's store), context captured at that moment, through the same checks as `InGamePrompts.request`; answered with the README's `ui.result` shapes. Prompt length up to the protocol's limit, not chat's 256.
2. **`console.mode {mode}`**: as `/autosketch mode <mode>`; answers the mode in force.
3. **`console.command {line}`**: runs `/autosketch <line>` as the player through the normal dispatcher with a command source whose feedback is captured into `lines[]` instead of chat. Refuse a line that isn't an `/autosketch` subcommand (the client refuses game commands first; this is the server's guard).
4. **These three are handled in the server half** and never forwarded; every other `ui.request` is forwarded as now.
5. **The `console` marker**: parsed from the client half's version handshake and kept per player. Don't make the client send it (C2 does).
6. **Routing** for a console client with the link `connected`: every agent frame for that player (`chat` of each kind, choice replies, `choices.answered`, `notice`, prompt delivery results, M1's mode confirmation) relayed whole over op 0, and nothing printed in their chat or action bar except the wand's and volumes' own lines. Everyone else as now. `log all` viewers: console if they have one, chat if not; `log off` hides activity everywhere.
7. GameTests with a fake client (marker on and off): each `console.*` request and its result, a refusal, a queued prompt's position, a command's feedback captured and absent from chat, a console client receiving no chat for a reply, an activity line and a status line, a vanilla player still getting chat, a `log all` viewer of each kind.

## Files you own

A new `ConsoleRequests` (or similar) and the routing in `mod/common/.../ui/relay/**`, the print-or-relay decision in `InGamePrompts.java` (after M1 and R1), their GameTests; `13`'s *What streams back* (console clients), `19`'s *Status line* note; `21`'s S1 row.

## Done when

- A GameTest's console client sends `console.prompt`, the fake MCP sees a `prompt` in the player's mode, and the reply comes back relayed with the player's chat empty; the same test with the marker off sees one chat message.
