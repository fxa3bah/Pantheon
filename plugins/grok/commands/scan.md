---
description: Scan this machine for installed coding harnesses (Claude, Grok, Codex, OMP, OpenCode, Agy, Hermes, UltraCode, Qoder, and others) and report which ones Pantheon can route to.
argument-hint: '[--json]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---
Inventory installed agent CLIs. Do not guess from memory.

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/grok-companion.mjs" scan "$ARGUMENTS"
```

Print the companion's stdout **verbatim**.
