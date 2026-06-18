---
description: Show Pantheon bridge health across Grok, Claude, and Codex without changing files.
argument-hint: '[--json] [--live]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---
Run the Pantheon bridge health check.

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/grok-companion.mjs" health "$ARGUMENTS"
```

Use `--json` for machine-readable output.
Use `--live` only when you want read-only paid handshakes against the local Grok, Claude, and Codex CLIs.

Return the output verbatim.
