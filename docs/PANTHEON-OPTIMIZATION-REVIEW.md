# Pantheon Optimization Review

> **Author:** Qoder AI
> **Date:** July 2026 (revised post-implementation)
> **Status:** H1–H6, M1, M2, L1 implemented in commit `c0294c4`. H7 reviewed and rejected. H8–H9 reviewed and rejected (see notes below).

---

This document reviews the original Pantheon Optimization Plan against the current codebase. It covers three things: what was **implemented** (H1–H6, M1, M2, L1 — shipped in commit `c0294c4`), what was **reviewed and rejected** (H7–H9, with detailed reasoning), and what **remains** as valid future work. Pantheon is an invoke-on-demand CLI mesh, not an always-on daemon — this architectural fact drives most of the rejection rationale below. Several bugs the original review missed were also discovered and fixed during implementation.

## Implementation Status

The following recommendations from the original review have been **implemented and merged** (commit `c0294c4`):

| Item | What Shipped | Evidence |
|------|-------------|----------|
| **H1** — Shared companion infrastructure | `lib/companion-common.mjs` extracted (63 lines): `makeJobId`, `splitRawArgumentString`, `normalizeArgv`, `splitRequestAndExtra`, `saveJob` | Imported by all three companions |
| **H2/H4** — state.mjs hardening | Atomic writes (tmp+rename), guarded reads in both `upsertJob` and `readJob` (warn + return null on corrupt), proper epoch-based sort in `listJobs` | `state.mjs` lines 24-28, 39-46, 56-68 |
| **H5** — Packet extractor dedup | `packetModelOf`/`packetEffortOf`/`packetBestOfNOf` removed from `model-routing.mjs`; now imports from `pantheon-packet.mjs` | Zero grep hits for `*Of` variants |
| **H6** — Test script fix | `package.json` test script is `"node --test tests/*.test.mjs"` — no `|| echo` fallback | `package.json` line 21 |
| **M1** — SIGKILL escalation | `armTimeout()` sends SIGTERM, then SIGKILL after configurable grace period (`GROK_BRIDGE_SIGKILL_GRACE_MS`, default 5s) | `bridge-guard.mjs` lines 229-243 |
| **M2** — Job archival | `pruneJobs(keep = 200)` added to `state.mjs`, keeps N most recent and deletes the rest | `state.mjs` lines 87-112 |
| **L1** — Dead code removal | `lib/args.mjs` deleted entirely | File no longer exists |
| **New tests** | `tests/state.test.mjs` (117 lines): upsertJob round-trip, merge-patch, recency sort regression, corrupt file handling, atomic writes, pruneJobs, limit enforcement | File exists, tests pass |

---

## Bugs the Original Review Missed

These were discovered and fixed during implementation:

### listJobs Recency Sort Was Broken
The old code subtracted raw ISO-8601 strings, which yields `NaN` — the sort comparator silently failed, returning jobs in filename order (grouped by agent prefix) instead of recency. Fixed with `toEpoch()` that parses timestamps to numeric values before comparison.

### readJob Was Unguarded
`readJob()` had no try/catch on `JSON.parse` at all. A corrupt job file would throw an unhandled exception and crash the caller. Now returns `null` with a stderr warning.

### Torn Writes Were the Real Corruption Risk
The original `writeFileSync` in `upsertJob` was non-atomic — a crash mid-write would leave a half-written JSON file. Fixed with the tmp+rename pattern: write to `<file>.<pid>.tmp`, then `renameSync` to the target path (atomic on all POSIX filesystems).

---

## Remaining Valid Recommendations

### P0 — Hygiene (low effort, no risk)

**H3: Pre-compile keyword regexes in model-routing.mjs**
`keywordHit()` creates a new `RegExp` per keyword per call. Pre-compile `RISK_KEYWORDS` into patterns at module load. Impact is negligible (the call site spawns a CLI child running seconds-to-minutes), but this is clean hygiene.

**M3: Split grok-companion.mjs**
At ~679 lines, it contains 8 subcommands, health checks, and media management. Extract `lib/health-handshake.mjs` and `lib/media-gallery.mjs` to stay well under the 800-line convention.

**M5: Fix `import.meta.url` guard**
Use `pathToFileURL(process.argv[1]).href` instead of string interpolation for cross-platform correctness.

### P1 — Platform Alignment (medium effort)

**Leverage official platform features:**
- Claude `--json-schema` — enforce Pantheon packet format at CLI output level
- Claude `total_cost_usd` — extract from JSON output for cost-aware routing
- Grok ACP protocol (`grok agent stdio`) — richer bidirectional communication via JSON-RPC
- Codex `--output-schema` — enforce structured Codex responses
- Cross-agent session threading — all three CLIs support session resume; could thread context across agents

**Migrate deprecated flags:**
- Codex `--full-auto` → `--sandbox workspace-write`
- Codex `on-failure` → `on-request` or `never`
- Account for Claude's upcoming `--bare` default change (caveat: `--bare` skips OAuth and requires `ANTHROPIC_API_KEY` — Pantheon's OAuth-only design would break)

### P2 — Optional

**Optional `GROK_BRIDGE_DATA_DIR` override for state.mjs**
`DATA_DIR` is already `path.join(process.cwd(), '.grok-bridge')` (per-project isolated). An env var override could be added for users who want a centralized ledger, but the current cwd-scoped behavior is correct by design. ~15 minutes.

---

## Reviewed and Rejected

### Not a Defect — Design Is Correct

#### H7: "Hardcoded Paths"
**Why this was rejected:** The design is already correct as-is. No change needed.
- `MEDIA_ROOT` in grok-companion.mjs is `process.env.GROK_BRIDGE_MEDIA_DIR || <default>` — already env-configurable
- `DATA_DIR` in state.mjs is `path.join(process.cwd(), '.grok-bridge')` — already per-project isolated
- `model-routing.mjs` holding the only model-ID literals is a **deliberate documented invariant** (see CLAUDE.md 2026-07-03 changelog: "model-routing.rjs is genuinely the only place a model string can appear")

### Design Mismatch — Built for Always-On, Pantheon Is Invoke-on-Demand

Pantheon is **invoke-on-demand**, not an always-on daemon. Each invocation shells a CLI binary that performs OAuth cold-start authentication — there is no persistent background process, and no cheap way to run one. The proposals below were designed for always-on autonomous systems and are rejected on that architectural basis, not on safety concerns.

#### H8: Swarm Orchestrator
**Why this was rejected:** This proposal assumed an always-on daemon that can run background tasks for free. Pantheon is invoke-on-demand — every action shells a CLI binary that must perform OAuth cold-start authentication, which takes seconds and consumes subscription quota. There is no persistent process to host autonomous orchestration. Building one would mean either (a) keeping a process alive that constantly re-auths (expensive, fragile) or (b) silently burning OAuth quota on tasks the user never initiated. Neither is acceptable. This is an architectural mismatch, not a safety-rule conflict.

#### H9: Auto-Delegation Router
**Why this was rejected:** Static routing (visual→Grok, code→Codex, reasoning→Claude) is already implemented in `model-routing.mjs` and works well. What the proposal added was **auto-invocation** — making routing decisions that fire without the user pressing a button. In an invoke-on-demand system, every autonomous routing decision means spawning a full CLI invocation with OAuth auth overhead. The `/delegate` command provides the correct pattern: same static heuristic routing, but with mandatory user confirmation before anything executes. The routing logic is fine; the autonomous firing is what doesn't fit the architecture.

The common thread: both proposals solve real problems for always-on agent platforms, but Pantheon's invoke-on-demand model makes them architecturally inapplicable.

### The Safe Alternative: `/delegate` Command
Built as the confirm-first alternative to H8/H9 (`plugins/grok/commands/delegate.md`):
- Static heuristic routing (no ML, no autonomous decisions)
- Always confirms with user via `AskUserQuestion` before execution
- Never auto-routes side-effecting operations
- Explicitly does not read from or write to any Pantheon-local memory store

---

## Module Inventory (Current State)

| Module | Lines | Status |
|--------|-------|--------|
| `lib/model-routing.mjs` | ~316 | Stable, canonical routing table |
| `lib/bridge-guard.mjs` | ~254 | Hardened (SIGKILL escalation added) |
| `lib/pantheon-packet.mjs` | ~131 | Clean (duplicate extractors removed) |
| `lib/compliance.mjs` | ~68 | Unchanged, clean |
| `lib/state.mjs` | ~112 | Hardened (atomic writes, guarded reads, pruneJobs, epoch sort) |
| `lib/companion-common.mjs` | ~63 | **New** — extracted shared infrastructure |
| `grok-companion.mjs` | ~679 | Approaching 800-line limit |
| `claude-companion.mjs` | ~289 | Refactored to use companion-common |
| `codex-companion.mjs` | ~292 | Refactored to use companion-common |

## Test Coverage (Current)

| Test File | Count | Status |
|-----------|-------|--------|
| model-routing.test.mjs | 38 | Passing |
| bridge-guard.test.mjs | 17 | Passing |
| codex-guard.test.mjs | 27 | Passing |
| compliance.test.mjs | 7 | Passing |
| pantheon-packet.test.mjs | 4 | Passing |
| media-extract.test.mjs | 5 | Passing |
| companion-imports.test.mjs | 4 | Passing |
| health-command.test.mjs | 1 | Passing |
| **state.test.mjs** | **14** | **New** — covers atomic writes, corrupt handling, sort, prune |
| **Total** | **117** | All passing |

---

*Review generated by Qoder AI. H7–H9 were reviewed against source code and canonical project rules, and rejected. July 2026.*
