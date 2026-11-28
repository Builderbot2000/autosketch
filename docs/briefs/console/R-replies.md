# Silo R: Whole replies

**Wave 1** (R1).

**Specs:** `21` Part C (all), *Wire* ("the wire doesn't change"); `13` (`chat`, *What streams back*); `17` piece 3 (clickable lines); `18` piece 7 (choice lines).

## Deliverables (R1)

1. **`world_reply` `text`** (`src/server/tools/world-prompt.ts`): one string ≤4000 characters, paragraphs separated by blank lines; `lines` still accepted and shown the same way. Exactly one of the two. The description asks for `text` with short paragraphs and names the formatting (`-` bullets, `**bold**`, `` `code` ``), with its token hint. The result line counts paragraphs.
2. **The MCP sends paragraphs as `chat` lines.** A paragraph longer than the wire's per-line limit is split at a sentence or word boundary into consecutive lines of the same paragraph; check the limit in `src/world/protocol/` and keep the frozen vectors unchanged. Choices, questions and the candidates line keep their current shape.
3. **`ReplyText`** in mod common (README contract): parse, the three formats, and the chat fallback's single `Component` (`Agent: ` once, paragraphs joined with line breaks, markers stripped, Minecraft wrapping by pixels). Clickable lines and each choice stay their own chat message.
4. **`InGamePrompts`' reply print** uses it: one message per reply. `ChatRules.wrap`/`WRAP` stay for activity lines only.
5. Unit tests both sides: `text` and `lines` give the same `chat` frame for the same paragraphs; a 4000-character reply; the format parser (nested markers, an unclosed `**`, a bullet with code); the chat message has one `Agent: ` and no markers. GameTest: a three-paragraph reply is one chat message.
6. The skills and knowledge that tell the agent how to reply (`library/knowledge/`, regenerated into packaging) mention `text` where they show `world_reply` calls.

## Files you own

`src/server/tools/world-prompt.ts`, `src/world/chat-stream.ts` (if needed), their unit tests, `ReplyText.java` (new, mod common), the reply-print and `format` parts of `InGamePrompts.java`, `ChatRules.java`, `PromptRulesTest`, the reply cases in `PromptGameTests`; `13`'s *What streams back* (replies); `21`'s R1 row.

## Done when

- The same reply via `text` and via `lines` reaches the fake mod as identical frames, and the GameTest sees one chat message.
