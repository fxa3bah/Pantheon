---
description: Hand a generic non-visual task to Grok Build. For image/video use /grok:imagine; for a multi-perspective review use /grok:review.
argument-hint: '<task for Grok> [--background]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---
Hand `$ARGUMENTS` to the local authenticated Grok Build CLI.

- **This is a hand-off.** Do not do the task yourself.
- **Pass the request through verbatim.** Do not rewrite, narrow, or summarize it.
- **Do not pick a model or effort.** The router does that.
- Wrong command? Image/video → `/grok:imagine`. Multi-perspective review → `/grok:review`.
- Runs read-only (`read_file,list_dir,grep`) unless `GROK_BRIDGE_ALLOW_WRITES=1`.

Foreground (default):
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/grok-companion.mjs" task "$ARGUMENTS"
```

If the arguments contain `--background`, run the same command with `run_in_background: true`
and tell the user to check `/grok:status`.

Print the companion's stdout **verbatim**. No preamble, no summary, no commentary.
