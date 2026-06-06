---
description: Cancel an active background Grok Build job started via the bridge.
argument-hint: '[job-id] [--json]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/grok-companion.mjs" cancel "$ARGUMENTS"
```
Return the cancel report verbatim.
