---
name: claude-delegate
description: Delegate complementary tasks (reasoning, second opinions, certain code or tool work where Claude Code has strong context) to the local authenticated Claude Code CLI (https://code.claude.com/docs/en/cli-reference). Results (including any files) come back cleanly into the Grok workspace. Part of Pantheon (three direct bidirectional legs: Grok↔Codex, Codex↔Claude, Grok↔Claude).
user_invocable: true
---

# claude-delegate (Grok → Claude Code)

Use this skill to hand work **to the local Claude Code CLI** on the same machine.

## When to use (the symmetric direction)
- You want a second opinion or complementary reasoning pass.
- The task plays to Claude Code's strengths (certain analysis styles, tool ecosystems, long-running code work, etc.).
- You want to keep visual/Imagine work for yourself (your superpower) and offload the non-visual part.
- User says things like: "ask Claude", "second opinion from Claude Code", "hand this to Claude", "let Claude take a look at the data model".

**Do not** use this for image/video generation or heavy visual consistency work — keep those on the Grok side via your Imagine tools.

## How the reverse bridge works
- This skill calls the small `claude-companion.mjs` (in the bridge repo).
- The companion runs local-OAuth-safe Claude headless mode:
  ```bash
  claude --model claude-opus-4-8 -p "your task..." --output-format json --permission-mode plan
  ```
- `--bare` is only used when API-key/settings auth is explicitly configured. Bare mode skips keychain/OAuth reads on this Mac.
- Results + any files Claude wrote are captured in `.grok-bridge/` and surfaced back to you with clear local paths and provenance.
- Same workspace means Claude's output is immediately usable by you.

## Usage examples
Just describe the task naturally:

- `claude-delegate review the last diff for clarity, edge cases, and security from a different perspective`
- `ask Claude Code for a second opinion on the state machine design while I handle the UI visuals`
- `delegate the pure data modeling and query work to Claude Code`
- `claude-delegate continue the previous review and focus on error handling`

You can also pass benign extra CLI flags that the companion will forward (advanced), such as `--model` or `--max-turns`.

Write/edit mode is not enabled by CLI flags. The operator must explicitly set `GROK_BRIDGE_ALLOW_WRITES=1`; otherwise the companion enforces read-only tools and strips unsafe permission grants.

## Important notes
- **No API keys** — uses the machine's already-authenticated Claude Code (`claude auth login` / `claude auth status`).
- Visual work stays with Grok (Imagine models + your skill).
- This is the Grok → Claude leg of Pantheon. Pantheon has three direct bidirectional legs (Grok↔Codex, Codex↔Claude, Grok↔Claude). The reverse on this leg (Claude → Grok) exposes `/grok-imagine`, `/grok-review`, etc. Codex side uses its own companions/skills for its legs.
- For the canonical routing and safety policy, see `docs/PANTHEON-OPTIMIZATION-PLAN.md` in the bridge repo.
- After installing the bridge as a Grok plugin, this skill becomes available (namespaced if needed).

See full patterns: ~/.grok/PANTHEON.md and the canonical `docs/PANTHEON-OPTIMIZATION-PLAN.md` in the bridge repo.

(Implementation: `skills/claude-delegate/SKILL.md` + companion. The system is called Pantheon.)
