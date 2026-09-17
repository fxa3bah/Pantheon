---
description: Auto-route a job to the best installed harness at a Good/Better/Best quality. Use for "plan this using ultracode" and any task where you should not pick the agent yourself.
argument-hint: '<task> [--quality good|better|best] [--harness <id>] [--lane plan|imagine|implement|review] [--background]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---
Hand `$ARGUMENTS` to Pantheon's auto-router.

- **This is a hand-off.** Do not do the task yourself.
- **Pass the request through verbatim.** Keep phrases like "using ultracode" or "via omp".
- **Do not pick a model.** The router picks Good/Better/Best from the live harness scan.
- Image/video still goes to Grok Imagine. ChatGPT Images 2.0 / `gpt-image-2` is not a CLI `-m` slug.
- Default quality is `better`. Add `--quality best` for the deepest present option.
- Mesh legs (Claude/Grok/Codex) stay read-only unless `GROK_BRIDGE_ALLOW_WRITES=1`. Extra harnesses only run when they have a verified read-only pin (agy `--mode plan`, hermes `--safe-mode`, omp `--plan`); otherwise the hop is refused.

Foreground (default):
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/grok-companion.mjs" auto "$ARGUMENTS"
```

If the arguments contain `--background`, run the same command with `run_in_background: true`
and tell the user to check `/grok:status`.

Print the companion's stdout **verbatim**.
