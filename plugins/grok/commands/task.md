---
description: Hand a generic non-visual task to Grok Build (Claude -> Grok generic leg of Pantheon). For image/video work use /grok-imagine; for a multi-agent review use /grok-review.
argument-hint: '<task for Grok> [--background|--wait]'
disable-model-invocation: true
allowed-tools: Read, Glob, Grep, Bash(node:*), Bash(git:*), AskUserQuestion
---
Run a generic (non-visual) task through the local authenticated Grok Build CLI (headless).

Raw slash-command arguments:
`$ARGUMENTS`

Core rules:
- This is a hand-off. Do not do the task yourself — Grok executes it.
- This command is for **generic, non-visual** work. If the request is image/video generation or editing, tell the user to use `/grok-imagine` instead. If the request is explicitly a multi-agent/multi-perspective review or investigation, tell the user to use `/grok-review` instead.
- Preserve the user's full request exactly — do not rewrite or narrow the intent.
- The companion script (and Pantheon's model router) picks the model/effort automatically (routes to `grok-build` @ medium for generic tasks) — do not choose it yourself.

Execution mode:
- If raw arguments contain `--background`, launch via Bash with run_in_background: true and tell the user to check `/grok:status`.
- If `--wait`, run in foreground.
- Otherwise estimate (foreground for anything quick, recommend background for longer tasks) and use AskUserQuestion once with the recommended option first.

Forwarding:
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/grok-companion.mjs" task "$ARGUMENTS"
```

Background:
```typescript
Bash({
  command: `node "${CLAUDE_PLUGIN_ROOT}/scripts/grok-companion.mjs" task "$ARGUMENTS"`,
  description: "Grok generic task",
  run_in_background: true
})
```

Return the companion stdout **verbatim**. Do not paraphrase, summarize, or add commentary before or after.
