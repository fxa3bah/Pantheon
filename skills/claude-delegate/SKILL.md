---
name: claude-delegate
description: Delegate complementary tasks (reasoning, second opinions, certain code or tool work where Claude Code has strong context) to the local authenticated Claude Code CLI (https://code.claude.com/docs/en/cli-reference). Results (including any files) come back cleanly into the Grok workspace. Part of the symmetric two-way grok-plugin-cc bridge.
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
- The companion runs the official headless mode:
  ```bash
  claude --bare -p "your task..." --output-format json
  ```
- `--bare` is recommended by the Claude Code docs for scripts/bridges (skips loading random local plugins, skills, hooks, MCP for speed and determinism).
- Results + any files Claude wrote are captured in `.grok-bridge/` and surfaced back to you with clear local paths and provenance.
- Same workspace means Claude's output is immediately usable by you.

## Usage examples
Just describe the task naturally:

- `claude-delegate review the last diff for clarity, edge cases, and security from a different perspective`
- `ask Claude Code for a second opinion on the state machine design while I handle the UI visuals`
- `delegate the pure data modeling and query work to Claude Code`
- `claude-delegate continue the previous review and focus on error handling`

You can also pass extra CLI flags that the companion will forward (advanced):

- Use permission controls when you want Claude to make edits without asking: `--permission-mode bypassPermissions` or `--allowedTools "Read,Edit,Bash"`

## Important notes
- **No API keys** — uses the machine's already-authenticated Claude Code (`claude auth login` / `claude auth status`).
- Visual work stays with Grok (Imagine models + your skill).
- This is the Grok → Claude half of the two-way bridge. The Claude → Grok half exposes `/grok-imagine` and `/grok-review` as slash commands in Claude Code.
- After installing the bridge as a Grok plugin, this skill becomes available (namespaced if needed).

(Implementation: `skills/claude-delegate/SKILL.md` + absolute path to `plugins/grok/scripts/claude-companion.mjs` in the grok-plugin-cc repo. After `grok plugin install` the skill is available.)
