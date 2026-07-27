# Pantheon Research Report

> Complete research findings from the Pantheon optimization review — July 2026.
> This document contains the raw research that informed `PANTHEON-OPTIMIZATION-REVIEW.md`.

---

## Part 1: Codebase Architecture Analysis

### Architecture Overview

Pantheon is a local, OAuth-only delegation mesh connecting three AI coding agents (Claude Code, Grok Build, Codex) on a single machine. It supports all six bidirectional delegation paths, with no API keys — every leg shells the already-authenticated local CLI binary in headless mode.

### End-to-End Flow

```
User Command (slash command or skill)
  → Command .md (frontmatter defines allowed-tools, delegates to Bash)
  → Companion Script (grok/claude/codex-companion.mjs)
    → parsePantheonInput()    -- detect structured packet vs plain prompt
    → classifyTask()          -- lane + subcommand -> taskClass
    → resolveModel()          -- taskClass + direction -> model/effort/args
    → withCompliance()        -- prepend operating-context header
    → assertHopAllowed()      -- loop guard check
    → sanitize*Args()         -- write gate (strip dangerous flags)
  → child_process.spawn(bin, args, { env: childEnv() })
    → BRIDGE_HOP incremented, armTimeout(), startHeartbeat()
  → Result Collection (parse stdout, extract media, copy to gallery)
  → State Persistence (upsertJob via state.mjs, .grok-bridge/<job-id>.json)
```

### Six Delegation Directions

| Direction | Entry Point | Companion | Binary |
|---|---|---|---|
| Claude → Grok (visual) | `/grok:imagine` | grok-companion `imagine` | `grok -p ... --always-approve` |
| Claude → Grok (review) | `/grok:review` | grok-companion `review` | same |
| Claude → Grok (generic) | `/grok:task` | grok-companion `task` | same |
| Claude → Codex | `/grok:codex` | codex-companion | `codex exec -m ...` |
| Grok → Claude | `claude-delegate` skill | claude-companion | `claude --model ... -p ...` |
| Grok → Codex | `codex-delegate` skill | codex-companion | same as Claude→Codex |
| Codex → Claude | `codex-to-claude` skill | claude-companion | same |
| Codex → Grok | `codex-to-grok` skill | grok-companion | same as Claude→Grok |

---

### Module Analysis

#### `lib/model-routing.mjs` (316 lines)

Single source of truth for all model-ID strings. Contains routing table, model tiers, task classification, and model resolution with escalation logic.

**Public API:** `MODEL_TIERS`, `ROUTING_TABLE`, `classifyTask()`, `resolveModel()`

**Design:** Deep-frozen structures, pure functions, multi-tier precedence (explicit > packet > env > table > binary-default), security-review force-pinned to deepest tier.

**Issues:** Duplicated packet extractors with pantheon-packet.mjs, `nonEmptyString()` duplicated, regex-per-call in `keywordHit()`.

#### `lib/state.mjs` (46 lines)

Ultra-light file-based job ledger. Single writer for all directions.

**Public API:** `ensureDataDir()`, `upsertJob(id, patch)`, `readJob(id)`, `listJobs(limit)`

**Issues:** No file locking, silent `catch {}` on JSON parse in `upsertJob`, NO error handling in `readJob` (crashes on corrupted JSON), bare `catch {}` in `listJobs`, O(n) file reads, no cleanup mechanism.

#### `lib/pantheon-packet.mjs` (131 lines)

Structured handoff protocol. Detects JSON packets with `pantheon_packet: true`.

**Public API:** `parsePantheonInput()`, `packetModel()`, `packetEffort()`, `packetBestOfN()`, `packetJobFields()`

**Issues:** Duplicated extractors in model-routing.mjs, bare `catch {}` on line 40.

#### `lib/bridge-guard.mjs` (254 lines)

Safety layer: loop guard, write gate, timeout.

**Public API:** `MAX_HOPS`, `DEFAULT_TIMEOUT_MS`, `currentHop()`, `assertHopAllowed()`, `childEnv()`, `writesAllowed()`, `sanitizeClaudeArgs()`, `sanitizeCodexArgs()`, `armTimeout()`, `startHeartbeat()`

**Issues:** Module-level env reads stale after import, SIGTERM only (no SIGKILL fallback).

#### `lib/compliance.mjs` (68 lines)

Injects operating-context header into delegated prompts. Clean module, no significant issues.

#### `lib/args.mjs` (26 lines)

Unused arg parser. Dead code — no companion uses it.

---

### Companion Script Comparison

| Feature | grok-companion (679 lines) | claude-companion (289 lines) | codex-companion (292 lines) |
|---|---|---|---|
| Subcommands | 8 (setup, imagine, review, task, status, result, cancel, health) | Single delegate | Single delegate |
| Output parsing | JSON + media + cost | JSON + session_id + cost | JSONL + last-message file |
| Write gate | None (initiator) | `sanitizeClaudeArgs()` | `sanitizeCodexArgs()` |

### 10 Duplicated Patterns Across Companions

1. `generateJobId()` — all three
2. `splitRawArgumentString()` — claude + codex (character-for-character identical)
3. `normalizeArgv()` — claude + codex (identical)
4. `splitRequestAndExtra()` — claude + codex (nearly identical)
5. `hasFlag()` — three different implementations
6. `routingFieldsFor()` — codex + grok (identical)
7. `saveJob` one-liner — all three
8. Binary resolution pattern — all follow which → fallbacks → bare name
9. Spawn + collect + persist flow — all identical structure
10. Compliance injection — all call `withCompliance()` at spawn

### State Management — Job Lifecycle

1. Generate ID: `<agent>-<base36-ts>-<random6>`
2. Initial save: `upsertJob(id, { direction, status: 'running', ... })`
3. PID tracking: `upsertJob(id, { pid, hop })`
4. On success: `upsertJob(id, { result, status: 'complete' })`
5. On failure: `upsertJob(id, { status: 'failed', error })`
6. On cancel: `upsertJob(id, { status: 'cancelled' })`

**Race risks:** PID vs completion race, cancel during completion, stale `running` with no watchdog.

### Test Coverage (103 tests, all passing)

| Test File | Count | What's Tested |
|---|---|---|
| model-routing.test.mjs | 38 | Routing table, precedence, escalation, [1m], immutability |
| bridge-guard.test.mjs | 17 | Hop counter, loop guard, write gate, 10 bypass variants |
| codex-guard.test.mjs | 27 | Codex write gate, parseCodexEvents, parseCodexOutput |
| compliance.test.mjs | 7 | All agent headers, opt-out |
| pantheon-packet.test.mjs | 4 | Plain prompt, valid packet, missing fields |
| media-extract.test.mjs | 5 | BRIDGE_MEDIA lines, fallback, dedup |
| companion-imports.test.mjs | 4 | Shared symbol imports |
| health-command.test.mjs | 1 | Static health JSON shape |

**Critical gaps:** state.mjs (0 tests), binary resolution, splitRequestAndExtra, cmdImagine, cmdCancel, normalizeArgv, full delegation integration.

---

## Part 2: Official Platform Documentation

### Claude Code (Anthropic)

**Headless Mode:**
- `claude -p "prompt"` — non-interactive
- `--bare` — skips hooks, skills, plugins, MCP, memory, CLAUDE.md. **Will become default for `-p`.**
- `--continue` / `--resume <session-id>` — session continuation
- `--allowedTools`, `--permission-mode` — tool approval
- `--agents <json>` — pass subagent definitions at launch
- `--mcp-config`, `--plugin-dir`, `--settings` — programmatic config

**Output:** `text`, `json` (with `total_cost_usd`, per-model cost), `stream-json`, `--json-schema` for structured output

**Model:** `--model` flag (sonnet, opus, haiku). Subagents can specify own model.

**Memory:** CLAUDE.md files, auto memory (200 lines/25KB), `.claude/rules/`, `@import` syntax, AGENTS.md support

**Multi-Agent:**
- Built-in subagents: Explore, Plan, General-purpose
- Custom subagents via `.claude/agents/` markdown files
- **Agent SDK** (Python + TypeScript): `npm install @anthropic-ai/claude-agent-sdk`
- Background agents, agent teams, `--agents` JSON flag

**Limitations:** 10MB stdin cap, 5s background task grace, 10-min background agent cap, `--bare` skips OAuth

### OpenAI Codex CLI

**Headless Mode:**
- `codex exec "prompt"` — non-interactive
- `codex exec resume` — resume sessions
- `--ephemeral`, `--ignore-user-config`, `--skip-git-repo-check`

**Output:** text, `--json` (NDJSON), `--output-last-message -o <path>`, `--output-schema`

**Model:** `--model, -m` (default: `gpt-5.5`). `--oss` for local Ollama.

**Security:** Sandbox (read-only/workspace-write/danger), approval modes (untrusted/on-request/never), macOS Seatbelt, Linux Landlock

**Multi-Agent:** Subagents via `[agents]` in config.toml, `codex mcp-server` (experimental), plugin system (experimental)

**Deprecated:** `--full-auto` → `--sandbox workspace-write`, `on-failure` → `on-request`/`never`, `--json` = `--experimental-json`

### Grok Build (xAI)

**Headless Mode:**
- `grok -p "prompt"` — headless
- `-m, --model`, `-s, --session-id`, `-r, --resume`, `-c, --continue`
- `--always-approve`, `--no-alt-screen`, `--no-auto-update`
- `grok agent stdio` — ACP protocol (JSON-RPC over stdin/stdout)

**Output:** `plain`, `json`, `streaming-json`

**Memory:** Sessions in `~/.grok/sessions`, `/remember`, `/memory`, `/dream` (consolidation), `/flush`

**Claude Compatibility:** **Automatically reads** CLAUDE.md, `.claude/` plugins, skills, agents, hooks — zero config

**Security:** `--always-approve`, hooks with fail-open behavior (only exit 2 = deny)

**Multi-Agent:** Subagents, `/fork`, ACP protocol, `/tasks`, `/loop`

### Qoder (IDE Platform)

**Custom Agents:** Markdown in `~/.qoder/agents/` or `.qoder/agents/`, frontmatter with name/description/tools/model/skills/mcpServers

**Skills:** `SKILL.md` in `~/.qoder/skills/` or `.qoder/skills/`, auto-trigger or `/skill-name`, third-party via `npx skills add`

**Plugins:** Bundles Skills + MCP + Agents + Commands + Rules + Hooks, marketplace, user/project level

---

## Part 3: Cross-Platform Comparison

### Headless Capability Matrix

| Feature | Claude Code | Codex CLI | Grok Build |
|---------|------------|-----------|------------|
| Headless | `-p "prompt"` | `exec "prompt"` | `-p "prompt"` |
| JSON output | `json` | `--json` | `json` |
| Streaming | `stream-json` | NDJSON | `streaming-json` |
| Structured output | `--json-schema` | `--output-schema` | N/A |
| Session resume | `--continue`/`--resume` | `exec resume` | `-r`/`-c`/`-s` |
| Cost tracking | `total_cost_usd` in JSON | No | No |
| Agent SDK | Python + TypeScript | None | None |
| Native subagents | Yes | Yes | Yes |
| Bare mode | `--bare` | `--ignore-user-config` | `--no-auto-update` |

### 7 Leverage Points Pantheon Doesn't Use

1. **Claude `--json-schema`** — Enforce packet format at CLI level
2. **Claude `total_cost_usd`** — Cost-aware routing from JSON output
3. **Claude Agent SDK** — Library-based access replacing spawn
4. **Grok ACP protocol** — Richer JSON-RPC bidirectional communication
5. **Codex `--output-schema`** — Enforce structured Codex responses
6. **Cross-agent session threading** — Thread session IDs across agents
7. **Grok native CLAUDE.md reading** — Simplify compliance for Grok legs

### 7 Risks and Incompatibilities

1. **Claude `--bare` becoming default** — Breaks OAuth-only auth (requires `ANTHROPIC_API_KEY`)
2. **Codex `--full-auto` deprecated** — Must migrate to `--sandbox workspace-write`
3. **Codex `on-failure` deprecated** — Must migrate to `on-request`/`never`
4. **Codex `--json` = experimental** — Name may change
5. **Claude 10MB stdin cap** — Large context must be file-referenced
6. **Claude background limits** — 5s grace, 10-min cap
7. **Grok fail-open hooks** — Safety must be enforced at companion level

### What's Now Native

All three platforms have native subagents, shared config (CLAUDE.md/AGENTS.md), and session resume. Pantheon's unique value remains **cross-agent delegation** — no platform does this natively.

---

## Part 4: Quality Audit Summary

The document quality audit found and corrected:
- Test count inaccuracies (4 of 8 areas had wrong counts)
- Missing `readJob()` crash bug (worse than silent reset)
- Missing `pantheon-packet.mjs` bare `catch {}` mention
- "Four lib modules" text vs six listed in table
- Future State speculative claims without caveats
- Missing concurrency and conflict resolution discussion

All findings were applied to `PANTHEON-OPTIMIZATION-REVIEW.md`.

---

## Key Files Reference

| File | Lines | Role |
|---|---|---|
| `plugins/grok/scripts/lib/model-routing.mjs` | 316 | Routing table + model resolution |
| `plugins/grok/scripts/lib/bridge-guard.mjs` | 254 | Safety layer |
| `plugins/grok/scripts/lib/pantheon-packet.mjs` | 131 | Structured handoff protocol |
| `plugins/grok/scripts/lib/compliance.mjs` | 68 | Operating-context injection |
| `plugins/grok/scripts/lib/state.mjs` | 46 | Job ledger |
| `plugins/grok/scripts/lib/args.mjs` | 26 | Unused arg helpers |
| `plugins/grok/scripts/grok-companion.mjs` | 679 | Grok leg companion |
| `plugins/grok/scripts/claude-companion.mjs` | 289 | Claude leg companion |
| `plugins/grok/scripts/codex-companion.mjs` | 292 | Codex leg companion |
| `tests/` | 8 files, 103 tests | All passing |
