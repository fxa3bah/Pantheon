---
description: Delegate to Grok Build and explicitly instruct it to use multiple agents / subagents / parallel perspectives for a deep review or investigation. Get a synthesized multi-perspective result back.
argument-hint: '[--background|--wait] [focus or implied git state]'
disable-model-invocation: true
allowed-tools: Read, Glob, Grep, Bash(node:*), Bash(git:*), AskUserQuestion
---
Run the task through local Grok Build with explicit multi-agent guidance.

Raw arguments:
`$ARGUMENTS`

Core rules:
- This is a delegation hand-off. Do not perform the review or analysis yourself.
- Grok is instructed (via the companion) to use multiple agents / subagents / best-of-n / different personas (reviewer, explorer/critic, security/reliability, implementer, etc.) and synthesize one clear report.
- Return Grok's output verbatim.
- Read-only from Claude's perspective for the analysis work.

Execution mode (same pattern as imagine):
- `--background` → host background Bash.
- `--wait` → foreground.
- Otherwise recommend background for anything non-trivial and AskUserQuestion.

Forwarding:
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/grok-companion.mjs" review "$ARGUMENTS"
```

Background launch uses the host `run_in_background: true` mechanism.

Return the companion stdout exactly (the synthesized multi-perspective report Grok produced). No extra commentary.

The result may reference workspace files or diffs that Grok inspected.
