---
description: Show the final stored output + artifacts for a finished Grok Build job (images, video, report, markdown, local paths).
argument-hint: '[job-id] [--json]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/grok-companion.mjs" result "$ARGUMENTS"
```
Return verbatim (includes ready-to-use media markdown when the job produced images/video).
