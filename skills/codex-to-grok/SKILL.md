---
name: codex-to-grok
description: Delegate visual/Imagine work, creative direction, assets, and multi-agent creative review to the local authenticated Grok Build CLI. Results (including any generated media) come back cleanly into the workspace. Part of Pantheon's Codex -> Grok leg.
user_invocable: true
---

# codex-to-grok (Codex -> Grok Build)

Use this skill to hand work **to the local Grok Build CLI** on the same machine.

> **Source-of-truth note:** this file lives in the Pantheon repo (`skills/codex-to-grok/SKILL.md`) as a
> **source definition only**. It does **not** install itself anywhere. It becomes available inside Codex
> only when the operator explicitly runs the Codex-side install (symlinking/copying it into `~/.codex/`,
> mirroring how the Grok-side skills are installed into `~/.grok/`). This skill must never write into
> `~/.codex/`, `~/.grok/`, or `~/.claude/` on its own — editing happens here, in the repo, only.

## When to use
- The task plays to Grok's strength: image/video generation and editing, creative direction, campaign or product assets, or a multi-agent/multi-perspective creative review.
- You want to keep implementation and build/test work on Codex itself, and offload the visual/creative part.
- Architecture, data modeling, or security-review reasoning does **not** belong here — use `codex-to-grok`'s sibling skill `codex-to-claude` instead.
- User says things like: "have Grok generate the product shot", "ask Grok for a multi-agent review of these three creative directions", "delegate the asset generation to Grok", "get Grok's take on the visual composition".

**Do not** use this for writing or running code — that stays on Codex. **Do not** use this for architecture/reasoning work — that goes to Claude via `codex-to-claude`.

## How the bridge works
- This skill calls the small `grok-companion.mjs` (in the Pantheon repo, `plugins/grok/scripts/grok-companion.mjs`), using either the generic `task` subcommand or the `imagine` subcommand for pure image/video work:
  ```bash
  # Generic (creative direction, assets, multi-agent review, drafts):
  node plugins/grok/scripts/grok-companion.mjs task "your request..."

  # Pure image/video generation or editing:
  node plugins/grok/scripts/grok-companion.mjs imagine "your visual request..."
  ```
  which shells local-OAuth-safe Grok headless mode:
  ```bash
  grok -p "your request..." --always-approve --output-format json --cwd <cwd>
  ```
  Model/effort are picked automatically by Pantheon's model router (`lib/model-routing.mjs`) — you don't choose them yourself. On the `codex-to-grok` direction: `imagine`/`assets` route to `grok-build` @ high; `creative-review` routes to `grok-build` @ xhigh with best-of-3; generic `task` routes to `grok-build` @ medium; `draft` routes to the cheaper `grok-composer-2.5-fast` @ medium.
- Generated images/videos are copied into the media gallery (`GROK_BRIDGE_MEDIA_DIR`, default `~/Pictures/grok-imagine`) and returned as clickable `file://` links plus ready-to-paste markdown embeds — never dumped into the raw session directory.
- Results are captured in the job ledger (`.grok-bridge/`) and surfaced back to you with clear local paths and provenance.

## Usage examples

### Plain-string handoff
```bash
node plugins/grok/scripts/grok-companion.mjs task "Generate three creative directions for a linen napkin product shot: warm morning light, cool marble studio, outdoor picnic. Return a synthesized recommendation."
```

### Pure image/video generation
```bash
node plugins/grok/scripts/grok-companion.mjs imagine "a cinematic product shot of a folded linen napkin on marble, soft window light, 3:2"
```

### Pantheon packet (structured handoff, preferred for anything non-trivial)
The router uses `from`/`to` to pick the direction and `lane` to classify the task (`visual`, `creative-review`, `assets`, `draft`):

```bash
node plugins/grok/scripts/grok-companion.mjs task '{"pantheon_packet":true,"from":"codex","to":"grok","lane":"creative-review","objective":"Review these three campaign concepts for the fall linen launch and recommend one, with reasoning.","context":"Concepts: A) warm morning light, B) cool marble studio, C) outdoor picnic. Target audience: DTC home-goods buyers.","return_format":"One recommended concept plus a short rationale for each option considered.","provenance":"Delegated by Codex via Pantheon."}'
```

## Important notes
- **No API keys** — uses the machine's already-authenticated Grok Build (`grok` on PATH or `~/.grok/bin/grok`, already logged in).
- Implementation/build/test work stays on Codex itself; architecture/reasoning work goes to Claude via `codex-to-claude`.
- This is the Codex -> Grok leg of Pantheon (six directions total: Claude<->Grok, Grok<->Codex, Codex<->Claude). Claude -> Grok uses `/grok-imagine`, `/grok-review`, and `/grok:task` from the Claude Code side; Grok -> Codex uses the `codex-delegate` skill.
- For the canonical routing and safety policy, see `docs/PANTHEON-OPTIMIZATION-PLAN.md` in the bridge repo, and `README.md` § Model routing for the full routing matrix.

See the canonical `docs/PANTHEON-OPTIMIZATION-PLAN.md` in the bridge repo.

(Implementation: `skills/codex-to-grok/SKILL.md` + `plugins/grok/scripts/grok-companion.mjs`. The system is called Pantheon.)
