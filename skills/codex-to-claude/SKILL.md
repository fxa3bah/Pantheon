---
name: codex-to-claude
description: Delegate architecture, data-modeling, reasoning, security-review, and high-stakes second-opinion work to the local authenticated Claude Code CLI (https://code.claude.com/docs/en/cli-reference). Results (including any files) come back cleanly into the workspace. Part of Pantheon's Codex -> Claude leg.
user_invocable: true
---

# codex-to-claude (Codex -> Claude Code)

Use this skill to hand work **to the local Claude Code CLI** on the same machine.

> **Source-of-truth note:** this file lives in the Pantheon repo (`skills/codex-to-claude/SKILL.md`) as a
> **source definition only**. It does **not** install itself anywhere. It becomes available inside Codex
> only when the operator explicitly runs the Codex-side install (symlinking/copying it into `~/.codex/`,
> mirroring how the Grok-side skills are installed into `~/.grok/`). This skill must never write into
> `~/.codex/`, `~/.grok/`, or `~/.claude/` on its own — editing happens here, in the repo, only.

## When to use
- The task plays to Claude Code's strengths: architecture and system design, data modeling, ambiguous/strategic reasoning, security review, or a high-stakes second opinion before you commit to an implementation path.
- You want to keep implementation work on Codex itself (that's Codex's job) and offload the reasoning/judgment part.
- Visual work (image/video generation, creative direction) does **not** belong here — use `codex-to-grok` instead.
- User says things like: "ask Claude for a second opinion on this design", "have Claude review the data model", "get Claude's take on whether this migration is safe", "delegate the security review to Claude".

**Do not** use this for writing or running code — that stays on Codex. **Do not** use this for image/video work — that goes to Grok via `codex-to-grok`.

## How the bridge works
- This skill calls the small `claude-companion.mjs` (in the Pantheon repo, `plugins/grok/scripts/claude-companion.mjs`).
- The companion runs local-OAuth-safe Claude headless mode:
  ```bash
  node plugins/grok/scripts/claude-companion.mjs "your task..."
  ```
  which shells:
  ```bash
  claude --model <model> -p "your task..." --output-format json --permission-mode plan
  ```
  `<model>` is picked automatically by Pantheon's model router (`lib/model-routing.mjs`) — you don't choose it yourself. On the `codex-to-claude` direction: `architecture`/`reasoning`/`security-review` route to `claude-opus-4-8`; `second-opinion`/`data-model` route to `claude-sonnet-5` and auto-escalate to `claude-opus-4-8` on risk keywords (`security`, `auth`, `payment`, `credential`, `secret`, `data-loss`, `migration`, `destructive`, `production`). `security-review` is force-pinned to `claude-opus-4-8` and cannot be downgraded by the request itself.
  `--bare` is only used when API-key/settings auth is explicitly configured; bare mode skips keychain/OAuth reads on this Mac, so leave it off for normal local use.
- Results (and any files Claude wrote, if writes are enabled) are captured in the job ledger (`.grok-bridge/`) and surfaced back to you with clear local paths and provenance.
- Same workspace means Claude's output is immediately usable by you.

## Usage examples

### Plain-string handoff
Just describe the task naturally:

```
node plugins/grok/scripts/claude-companion.mjs "Review this data model for edge cases before I build the API around it: <paste model or path>"
```

### Pantheon packet (structured handoff, preferred)
For a precise handoff, pass a JSON Pantheon packet instead of a plain string. The router uses `from`/`to` to pick the direction and `lane` to classify the task (`architecture`, `second-opinion`, `data-model`, `security-review`):

```bash
node plugins/grok/scripts/claude-companion.mjs '{"pantheon_packet":true,"from":"codex","to":"claude","lane":"security-review","objective":"Review the new payment webhook handler for auth bypass risks.","context":"Handler lives in src/webhooks/payment.ts; recent diff adds a new signature-verification path.","constraints":{"mode":"read-only"},"return_format":"Findings ranked by severity, with concrete exploit scenarios.","provenance":"Delegated by Codex via Pantheon."}'
```

You can also pass benign extra CLI flags that the companion will forward (advanced), such as `--model` or `--max-turns`.

## Important notes — read-only by default
- **No API keys** — uses the machine's already-authenticated Claude Code (`claude auth login` / `claude auth status`).
- Claude runs **read-only** (`Read,Glob,Grep`) unless the operator has explicitly set `GROK_BRIDGE_ALLOW_WRITES=1`. Without that opt-in, the companion strips unsafe permission grants (`--dangerously-skip-permissions`, `--permission-mode bypassPermissions|acceptEdits`, any caller `--allowedTools`) and surfaces them back to you as a `pantheon_warning`.
- Visual/creative work stays with Grok via `codex-to-grok`; implementation stays on Codex itself.
- This is the Codex -> Claude leg of Pantheon (six directions total: Claude<->Grok, Grok<->Codex, Codex<->Claude). Claude -> Codex uses `/grok:codex` from the Claude Code side; Grok -> Claude uses the `claude-delegate` skill.
- For the canonical routing and safety policy, see `docs/PANTHEON-OPTIMIZATION-PLAN.md` in the bridge repo, and `README.md` § Model routing for the full routing matrix.

See the canonical `docs/PANTHEON-OPTIMIZATION-PLAN.md` in the bridge repo.

(Implementation: `skills/codex-to-claude/SKILL.md` + `plugins/grok/scripts/claude-companion.mjs`. The system is called Pantheon.)
