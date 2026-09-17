---
description: Inventory installed coding harnesses from the current host (Claude, Grok, Codex, OMP, OpenCode, Agy, Hermes, UltraCode, Qoder). The scan is not Grok-primary. It marks the harness you are in, then lists what else can take the job.
argument-hint: '[--from <host>] [--json]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---
Inventory installed agent CLIs from the current session. Do not guess from memory. Do not treat Grok as the default host.

Pass `--from <host>` when the current harness is not obvious. Example: `--from claude`, `--from omp`, `--from grok`.

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/grok-companion.mjs" scan --from claude $ARGUMENTS
```

Print the companion's stdout **verbatim**.
