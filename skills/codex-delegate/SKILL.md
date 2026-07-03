---
name: codex-delegate
description: Delegate implementation, build, and verification tasks (writing code, running a build, running tests, reproducing a failure) to the local authenticated Codex CLI (https://developers.openai.com/codex/). Results (including any files) come back cleanly into the workspace. Part of Pantheon (three direct bidirectional legs: Grok↔Codex, Codex↔Claude, Grok↔Claude).
user_invocable: true
---

# codex-delegate (Grok → Codex)

Use this skill to hand implementation, build, and verification work **to the local Codex CLI** on the same machine.

## When to use
- The task plays to Codex's strengths: writing code, running a build, running the test suite, reproducing or diagnosing a failure, verifying a change actually works.
- You want to keep visual/Imagine work for yourself (your superpower) and offload the concrete build/verify part.
- User says things like: "have Codex implement this", "delegate the build to Codex", "get Codex to verify the fix", "codex-delegate run the test suite and report back".

**Do not** use this for image/video generation or visual review — keep those on the Grok side via your Imagine tools. For architecture, data-modeling, or second-opinion reasoning, use `claude-delegate` instead.

## How the bridge works
- This skill calls the small `codex-companion.mjs` (in the Pantheon repo, `plugins/grok/scripts/codex-companion.mjs`).
- The companion runs local-OAuth-safe Codex headless mode:
  ```bash
  node plugins/grok/scripts/codex-companion.mjs "your task..."
  ```
  which shells:
  ```bash
  codex exec -m <model> -c model_reasoning_effort=<effort> --sandbox read-only \
    --skip-git-repo-check -C <cwd> "your task..."
  ```
  `<model>` and `<effort>` are picked automatically by Pantheon's model router (`lib/model-routing.mjs`) — you don't choose them yourself.
- Results (and any files Codex wrote, if writes are enabled) are captured in `.grok-bridge/` and surfaced back to you with clear local paths and provenance.
- Same workspace means Codex's output is immediately usable by you.

## Usage examples
Just describe the task naturally:

- `codex-delegate implement the pagination helper described in the ticket and run its tests`
- `have Codex reproduce this build failure and report the root cause`
- `delegate running the test suite to Codex and summarize any failures`
- `codex-delegate continue the previous implementation and add error handling`

### Pantheon packet (structured handoff)

For a more precise handoff, pass a JSON Pantheon packet instead of a plain string. The router uses `from`/`to` to pick the direction and `lane` to help classify the task (`implement`, `review`, `verify`):

```json
{
  "pantheon_packet": true,
  "from": "grok",
  "to": "codex",
  "lane": "implement",
  "objective": "Add input validation to the /upload endpoint and cover it with tests.",
  "context": "Endpoint lives in src/api/upload.ts; existing tests in test/api/upload.test.ts.",
  "constraints": { "mode": "read-only" },
  "budget": { "cost": "medium" },
  "return_format": "Diff summary plus test output.",
  "provenance": "Delegated by Grok via Pantheon."
}
```

Pass this as the request string to `codex-companion.mjs` (or through this skill) exactly as you would a plain-text task — the companion detects the `pantheon_packet: true` shape automatically and builds a structured prompt from it.

You can also pass benign extra CLI flags that the companion will forward (advanced), such as `-m` or `-c model_reasoning_effort=high`.

## Important notes — read-only by default
- **No API keys** — uses the machine's already-authenticated Codex CLI (`codex login`).
- Codex runs **`--sandbox read-only`** unless the operator has explicitly set `GROK_BRIDGE_ALLOW_WRITES=1`. Without that opt-in, the companion strips any caller-supplied flag that would grant writes or bypass the sandbox — including `--dangerously-bypass-approvals-and-sandbox`, `--full-auto`, `--yolo`, an explicit `--sandbox`/`-s` override, `--ask-for-approval`/`-a`, and `-c`/`--config` or `--profile`/`-p` (both are config-override escape vectors that could otherwise smuggle sandbox-bypass settings past the gate). Stripped flags are surfaced back to you as a `pantheon_warning`.
- Visual work stays with Grok (Imagine models + your skill); architecture/reasoning work goes to Claude via `claude-delegate`.
- This is the Grok → Codex leg of Pantheon. Pantheon has three direct bidirectional legs (Grok↔Codex, Codex↔Claude, Grok↔Claude). Claude→Codex uses the same `codex-companion.mjs` from the Claude Code side.
- For the canonical routing and safety policy, see `docs/PANTHEON-OPTIMIZATION-PLAN.md` in the bridge repo, and `README.md` § Model routing for the full routing matrix.
- After installing the bridge as a Grok plugin, this skill becomes available (namespaced if needed).

See full patterns: ~/.grok/PANTHEON.md and the canonical `docs/PANTHEON-OPTIMIZATION-PLAN.md` in the bridge repo.

(Implementation: `skills/codex-delegate/SKILL.md` + `plugins/grok/scripts/codex-companion.mjs`. The system is called Pantheon.)
