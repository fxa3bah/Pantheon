---
description: Delegate a deep review or investigation to Grok Build, which runs multiple perspectives and returns one synthesized report.
argument-hint: '[focus] [--background]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---
Hand `$ARGUMENTS` to the local authenticated Grok Build CLI as a multi-perspective review.

- **This is a hand-off.** Do not perform the review yourself.
- The companion instructs Grok to run several perspectives (reviewer, critic, security/reliability,
  implementer) and synthesize one report.
- **Do not pick a model or effort.** The router does that.
- Runs read-only (`read_file,list_dir,grep`) unless `GROK_BRIDGE_ALLOW_WRITES=1`.
- With no focus given, Grok reviews the current git state.

Foreground (default):
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/grok-companion.mjs" review "$ARGUMENTS"
```

If the arguments contain `--background`, run the same command with `run_in_background: true`
and tell the user to check `/grok:status`.

Print the companion's stdout **verbatim**. No preamble, no summary, no commentary.
