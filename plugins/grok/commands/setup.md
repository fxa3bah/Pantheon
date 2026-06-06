---
description: Verify that the local authenticated Grok Build CLI is available and working (OAuth, no API keys). Optional smoke for the bridge.
argument-hint: '[--json]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---
Run the companion setup check.

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/grok-companion.mjs" setup "$ARGUMENTS"
```

It should report:
- Which `grok` binary was resolved (PATH / ~/.grok/bin/grok / downloads).
- That a trivial headless command succeeded using the existing local OAuth/login state.
- Clear guidance if the binary is missing or not logged in ("run grok login in your terminal").

Never surface or require XAI_API_KEY. The bridge only uses the already-authenticated local binary.

Return the output verbatim.
