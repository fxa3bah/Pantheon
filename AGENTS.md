# AGENTS.md — Pantheon

Instructions for any agent (Codex, Grok, or others that read `AGENTS.md`) working in this repo.
Codex does not auto-load `CLAUDE.md`, so the essential project rules are mirrored here.

**Full project memory lives in [`CLAUDE.md`](./CLAUDE.md) — read it for the complete picture.**

## What this is
Pantheon is a local, OAuth-only delegation mesh across three coding agents on one machine (Claude Code,
Grok, Codex). Every leg shells the already-authenticated local `claude`/`grok`/`codex` binary in
headless mode. No API keys, no daemons.

## Hard invariants (do not break)
- **ESM only** (`.mjs`, top-level `import`). Never `require()` — it throws in these modules.
- **Immutable**: create new objects, never mutate shared ones. Router tables/results are frozen.
- **Model IDs live in exactly one file**: `plugins/grok/scripts/lib/model-routing.mjs`. Do not hardcode
  a model string anywhere else — call `resolveModel()`/`classifyTask()`.
- **One ledger writer**: all job state goes through `lib/state.mjs`.
- **No API keys**; both binaries resolved from PATH first, then explicit fallbacks.
- Small, focused files (<800 lines). Handle errors explicitly; never leave a job stuck `running`.

## Design system
Before producing ANY UI/visual/design/dashboard/HTML-email output, read and apply `~/.claude/DESIGN.md`.

## Testing
`node --test tests/*.test.mjs` and `node --check plugins/grok/scripts/**/*.mjs` before calling work done.

See `docs/PANTHEON-OPTIMIZATION-PLAN.md` for the canonical routing + safety spec.
