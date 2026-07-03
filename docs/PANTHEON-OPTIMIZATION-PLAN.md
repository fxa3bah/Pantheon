# Pantheon Optimization Plan

Pantheon is the project-agnostic local delegation system connecting Grok, Codex, and Claude on the same machine. This repo is the source of truth for the bridge behavior; agent homes should consume installed/synced instructions, not become the canonical copy.

Research basis:
- Codex models: https://developers.openai.com/codex/models
- Claude headless JSON: https://code.claude.com/docs/en/headless
- Claude model overview: https://platform.claude.com/docs/en/about-claude/models/overview
- xAI models: https://docs.x.ai/developers/models
- Grok Imagine: https://docs.x.ai/developers/model-capabilities/imagine

Reviewer input was gathered from Grok and Claude via Pantheon. Both identified the Grok -> Claude `--bare` auth failure as the highest-priority implementation defect.

## Canonical Routing Spec

Pantheon has three direct bidirectional legs:

| Leg | Primary use | Default route |
| --- | --- | --- |
| Claude -> Grok | visual generation, visual review, multi-agent Grok synthesis | `/grok-imagine`, `/grok-review`, `/grok:*` |
| Grok -> Claude | architecture, data modeling, orchestration, high-risk second opinions | `claude-delegate` / `claude-companion.mjs` |
| Grok -> Codex | implementation, code review, build/test verification | `codex-delegate` / Codex companion |
| Codex -> Grok | assets, creative direction, Imagine work, visual synthesis | `grok "..."` or `grok-delegate` |
| Codex -> Claude | architecture and reasoning second opinions | `claude "..."` or `claude-delegate` |
| Claude -> Codex | implementation and verification handoff | `codex "..."` or Codex plugin |

The default lane rules:
- Grok owns visual assets, image/video generation or editing, creative direction, marketing visuals, design synthesis, and Grok-specific multi-perspective creative review.
- Codex owns implementation, refactors, local builds/tests, simulator/device verification, code review, repo execution, and concrete integration.
- Claude owns architecture, orchestration, data modeling, formula/scope reasoning, security review, high-stakes second opinions, and broad conceptual review.

Do not auto-delegate destructive operations, sends, pushes, migrations, cross-agent-home edits, high-cost loops, or unclear ownership. Ask the user first.

## Handoff Packet

Plain prompt strings remain supported. A structured handoff is parsed only when the input is JSON with `pantheon_packet: true`.

Required fields:

```json
{
  "pantheon_packet": true,
  "from": "codex",
  "to": "grok",
  "lane": "visual",
  "objective": "Create three campaign image directions."
}
```

Recommended fields:

```json
{
  "context": "Relevant project/task facts.",
  "constraints": { "mode": "read-only", "style": "project design system" },
  "permissions": { "file_writes": false, "destructive": false },
  "budget": { "timeout_ms": 300000, "cost": "low" },
  "model": "grok-build",
  "return_format": "Concise findings plus local file paths.",
  "provenance": "Delegated by Codex via Pantheon.",
  "media": [
    { "path": "/absolute/path/to/asset.png", "type": "image/png", "label": "hero" }
  ]
}
```

Companions must store packet metadata in the job ledger and include `media[]` unchanged so generated assets can move across agents without brittle text parsing.

## Safety Contract

- Every companion must propagate `BRIDGE_HOP` and enforce the shared loop guard.
- One autonomous cross-agent hop is allowed. A second hop must be justified in the packet. Further hops require user confirmation.
- Default bridge calls are read-only. Write mode requires an explicit environment opt-in such as `GROK_BRIDGE_ALLOW_WRITES=1`.
- Unsafe flags such as `--permission-mode=bypassPermissions`, `--permission-mode acceptEdits`, `--dangerously-skip-permissions`, or caller-provided edit/Bash tool grants must be stripped unless the environment explicitly allows writes.
- If the write gate strips flags, the caller must receive a visible `pantheon_warning`, not only stderr.
- Do not write directly into `~/.grok`, `~/.codex`, or `~/.claude` from implementation work. Install/sync into those homes only when the user explicitly requests it.

## Model Defaults

| Agent | Default | Fast/cheap | High-stakes |
| --- | --- | --- | --- |
| Codex | `gpt-5.3-codex-spark` @ high reasoning (default) | `gpt-5.4-mini` | `gpt-5.5` @ xhigh for the deep tier; `codex-auto-review` for review |
| Claude | `claude-opus-4-8` | `claude-haiku-4-5-20251001` | `claude-opus-4-8` for architecture/security-review; `claude-sonnet-5` (balanced tier) for data-model/second-opinion, auto-escalating to `claude-opus-4-8` on risk keywords, `escalate:true`, `budget.cost:high`, or a retry — Fable is not used |
| Grok | `grok-build` (= Grok 4.3) | `grok-composer-2.5-fast` | `grok-build` @ xhigh, best-of-3 for deep-creative work; Imagine exclusively for image/video. `grok-build` IS xAI's Grok 4.3 coding agent (the CLI exposes no separate `grok-4.3` slug), so it covers general synthesis too |

The routing table in `plugins/grok/scripts/lib/model-routing.mjs` is canonical; this doc mirrors it.

Bridge invocations should record the model actually requested or used in the job ledger.

## Implementation Notes

- Grok -> Claude must default to non-bare local OAuth mode:
  `claude --model claude-opus-4-8 -p ... --output-format json --permission-mode plan`.
- Use `--bare` only when API-key/settings auth is explicitly configured. Local OAuth/keychain auth is skipped in bare mode and produces `Not logged in`.
- `/grok:health` should report binaries, versions, model defaults, write-gate status, hop status, configured legs, and optional live read-only handshakes.
- This plan is project-agnostic. Project-specific protocols such as Texpert stay in their own project docs.

## Verification

```bash
npm test
node --check plugins/grok/scripts/*.mjs
node plugins/grok/scripts/grok-companion.mjs health --json
node plugins/grok/scripts/grok-companion.mjs health --json --live
node plugins/grok/scripts/claude-companion.mjs "Pantheon smoke. Reply exactly OK" --max-turns 1
```

The live health command may call paid local CLIs. Use it intentionally.
