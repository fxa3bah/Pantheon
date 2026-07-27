---
description: Delegate implementation, build/test verification, or code review to the local authenticated Codex CLI.
argument-hint: '<coding/build/verify task> [--background]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---
Hand `$ARGUMENTS` to the local authenticated Codex CLI.

- **This is a hand-off.** Do not implement, build, test, or review the code yourself.
- **Pass the request through verbatim.** Do not rewrite, narrow, or summarize it.
- **Do not pick a model or effort.** The router does that.
- Runs `--sandbox read-only` unless `GROK_BRIDGE_ALLOW_WRITES=1`. If the task clearly needs to
  write files, say so before running rather than letting it fail silently.

Pick one lane and pass it with `--lane`; the companion builds the Pantheon packet:

| Lane | Use when the task is |
|---|---|
| `implement` | writing code, adding a feature, fixing a bug (**default**) |
| `verify` | running builds/tests, reproducing a failure, confirming something works |
| `review` | reviewing existing code or a diff without changing it |

Foreground (default):
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" "$ARGUMENTS" --lane implement
```

If the arguments contain `--background`, run the same command with `run_in_background: true`
and tell the user to check `/grok:status`.

Print the companion's stdout **verbatim**. No preamble, no summary, no commentary.
