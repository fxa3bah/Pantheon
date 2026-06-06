---
description: Show running and recent Grok Build jobs (from the bridge) for the current workspace.
argument-hint: '[job-id] [--json]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/grok-companion.mjs" status "$ARGUMENTS"
```
Return the output verbatim. Supports optional job-id and --json.
