---
description: Delegate implementation, build, test-verification, or code-review work to the local authenticated Codex CLI (Claude -> Codex leg of Pantheon). Claude builds a structured packet; Codex executes and returns the result.
argument-hint: '<coding/build/verify task> [--background|--wait]'
disable-model-invocation: true
allowed-tools: Read, Glob, Grep, Bash(node:*), Bash(git:*), AskUserQuestion
---
Run the task through the local authenticated Codex CLI (headless), via Pantheon's Claude -> Codex leg.

Raw slash-command arguments:
`$ARGUMENTS`

Core rules:
- This is a hand-off. Do not implement, build, test, or review the code yourself — Codex does the real work.
- Build a **Pantheon packet** (not a raw string) so the lane is explicit and the router picks the right model/effort precisely.
- Infer `lane` from the request:
  - default `implement` (writing code, adding a feature, fixing a bug)
  - `verify` if the task is about running builds/tests, reproducing a failure, or confirming something works
  - `review` if the task is reviewing existing code/diffs rather than changing anything
- Keep the user's intent verbatim in `objective` — do not paraphrase or narrow the request. JSON-escape it.
- Read-only by default: Codex runs `--sandbox read-only` unless the operator has set `GROK_BRIDGE_ALLOW_WRITES=1`. If the task clearly requires writing files, tell the user this up front rather than silently expecting writes.
- Model and effort are auto-picked by Pantheon's router (`lib/model-routing.mjs`) — do not choose them yourself. `implement`/`verify` route to `gpt-5.3-codex-spark` @ high; `review` routes to `codex-auto-review` @ high.

Execution mode:
- If raw arguments contain `--background`, launch via Bash with run_in_background: true and tell the user to check `/grok:status`.
- If `--wait`, run in foreground.
- Otherwise run in the foreground by default — Codex tasks aren't as long-running as video generation, so background is the exception here, not the rule.

Forwarding:
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" '{"pantheon_packet":true,"from":"claude","to":"codex","lane":"<implement|verify|review>","objective":"<the user task, JSON-escaped>","provenance":"Delegated by Claude Code via Pantheon."}'
```

Background:
```typescript
Bash({
  command: `node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" '{"pantheon_packet":true,"from":"claude","to":"codex","lane":"<implement|verify|review>","objective":"<the user task, JSON-escaped>","provenance":"Delegated by Claude Code via Pantheon."}'`,
  description: "Codex delegation task",
  run_in_background: true
})
```

Return the companion stdout **verbatim**. Do not paraphrase, summarize, or add commentary before or after.
