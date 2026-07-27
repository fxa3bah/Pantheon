---
description: Route a task to the best-fit Pantheon agent (Grok / Codex / Claude), always confirming before anything runs. Confirm-first, no autonomy.
argument-hint: '<task to route to another agent>'
disable-model-invocation: true
allowed-tools: Bash(node:*), AskUserQuestion
---
Route `$ARGUMENTS` to the best-fit agent — but never silently.

## Never route these
If the task involves sending (email, message, post), publishing, pushing, deleting, moving money,
running a migration, or editing another agent's config home: **stop**. Say why, and let the user do
it themselves. No confirmation prompt makes these routable.

## 1. Pick a target
| Task is mainly about | Agent | Lane |
|---|---|---|
| images, video, visual assets, design direction | **Grok** | `imagine` |
| creative or multi-perspective critique | **Grok** | `review` |
| writing/changing code, builds, tests, reproducing a failure | **Codex** | `implement` / `verify` |
| architecture, reasoning, planning, a second opinion on a design or diff | **Claude** | `architecture` / `second-opinion` |

## 2. Confirm (mandatory)
Call `AskUserQuestion` once. Put your recommended agent first. Include a one-line restatement of the
task, and note that delegated legs run read-only unless `GROK_BRIDGE_ALLOW_WRITES=1`. Choosing an
option is what authorizes execution — there is no "obvious enough to skip this" path.

## 3. Run the confirmed choice
Pass the task through verbatim. Never pick a model or effort; the router does that.

```bash
# Grok
node "${CLAUDE_PLUGIN_ROOT}/scripts/grok-companion.mjs" task "$ARGUMENTS" --lane review

# Codex
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" "$ARGUMENTS" --lane implement

# Claude
node "${CLAUDE_PLUGIN_ROOT}/scripts/claude-companion.mjs" "$ARGUMENTS" --lane architecture
```

Print the companion's stdout **verbatim**. If the user declined, do nothing and say so.
