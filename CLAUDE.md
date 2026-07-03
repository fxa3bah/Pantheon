# CLAUDE.md — Pantheon

Project memory for Claude Code sessions working on this repo. Read before editing.

## Current state — read this first

- **2026-06-18 — renamed `grok-plugin-cc` → Pantheon** (folder, marketplace name `pantheon`, GitHub
  `fxa3bah/Pantheon`). Plugin name stays `grok` and the `/grok:*` commands are unchanged. Added the
  Codex legs, structured Pantheon packets (`lib/pantheon-packet.mjs`), and `/grok:health`. Fixed the
  Grok→Claude `--bare` OAuth defect (now non-bare local OAuth by default) and the live-health
  false-green (compute-challenge sentinels). **27/27 tests pass; live six-direction handshake green.**

### Earlier state (2026-06-07)

- **Installed & enabled.** `grok@pantheon` is installed at **user scope** (via
  `claude plugin marketplace add` + `claude plugin install`) and shows enabled in `claude plugin list`.
  Components: 7 commands + the `grok-delegate` agent. Slash commands load on session restart.
- **Reverse leg is live.** `claude-delegate` + `grok-imagine-from-claude-feedback` skills and the
  `claude-second-opinion` agent are **symlinked into `~/.grok/`** (`grok plugin install … --trust`).
  Not yet live-smoke-tested from a Grok session — see "Still open".
- **Verified working.** Forward leg (`/grok-imagine`) confirmed end-to-end across 3 live generations:
  gallery is populated, `file://` links resolve, ledger records status/pid/media/cost. `/grok:setup`
  passes. Loop guard + cancel + status verified functionally. **10 unit tests pass.**
- **Sample assets** from the build sessions: `~/Pictures/grok-imagine/_session-samples/`
  (linen napkin, waffle towels + a 6s push-in `.mp4`, charcoal spa towels) plus dated job folders.
- **Git:** initialized; first commit `5f41774` (by Grok). Doc/.gitignore reconciliation committed on top.
- **Two-way confirmed live (2026-06-07):** from a Grok session, `claude` was reachable (`claude auth status` OK),
  the Grok-side skills/agent were present in `~/.grok/`, and a reverse-leg demo via `claude-companion.mjs`
  fired the **write gate** correctly (`enforced read-only --allowedTools Read,Glob,Grep`). Later evidence
  showed `--bare` skips local OAuth/keychain auth and can produce `Not logged in`; the bridge now defaults
  to non-bare local OAuth mode for Grok→Claude.
- **What changed this session:** see the Change log at the bottom. New files: `lib/bridge-guard.mjs`,
  `tests/bridge-guard.test.mjs`, `tests/media-extract.test.mjs`, `CLAUDE.md`. Heavily edited:
  `grok-companion.mjs`, `claude-companion.mjs`, `lib/state.mjs`, `README.md`.

## What this is

**Pantheon** is a **local, OAuth-only delegation mesh** across three coding agents installed and
logged in on the **same machine**: **Claude Code**, **Grok Build**, and **Codex**. No API keys —
every leg only ever shells the already-authenticated local `claude` / `grok` / `codex` binaries in
headless mode. The Claude↔Grok bridge is the most built-out surface; the Codex legs and the
remaining directions share the same companions, ledger, and safety layer.

Six directions (see `docs/PANTHEON-OPTIMIZATION-PLAN.md` for the canonical routing spec):

- **Claude → Grok** (rich surface): `/grok-imagine` hands all image/video work to Grok Imagine;
  `/grok-review` delegates multi-agent reviews. Installed as the Claude Code plugin `grok@pantheon`.
- **Grok → Claude**: `claude-delegate` skill + `claude-second-opinion` agent hand non-visual work
  (architecture, reasoning, second opinions) back to the local Claude Code CLI.
- **Grok ↔ Codex / Codex ↔ Claude / Claude → Codex**: implementation, build/test verification, and
  cross-agent second opinions, routed through the same companions.

`/grok:health --json --live` runs a real six-direction handshake (compute-challenge sentinels, so an
echoed prompt or empty reply can never produce a false green).

## Repo layout

```
.claude-plugin/marketplace.json      # local marketplace manifest (name: pantheon)
plugins/grok/
  .claude-plugin/plugin.json         # the installable plugin (name: grok); commands/agents auto-discovered
  commands/                          # slash commands: imagine, review, task, codex, setup, health, status, result, cancel (.md)
  agents/grok-delegate.md            # proactive forwarder subagent
  prompts/imagine-system.md
  scripts/
    grok-companion.mjs               # FORWARD leg (Claude→Grok). Main entry for imagine/review/task/status/result/cancel/setup
    claude-companion.mjs             # REVERSE leg (Grok→Claude, Codex→Claude). Shells local-OAuth-safe `claude --model … -p … --output-format json`
    codex-companion.mjs              # CODEX leg (Claude→Codex, Grok→Codex). Shells `codex exec -m … -c model_reasoning_effort=… --sandbox read-only`
    lib/
      bridge-guard.mjs               # SAFETY layer: loop guard, write gate, timeout, heartbeat
      model-routing.mjs              # SINGLE SOURCE OF TRUTH for model IDs: ROUTING_TABLE, MODEL_TIERS, classifyTask(), resolveModel()
      state.mjs                      # canonical job ledger (single writer for BOTH directions)
      args.mjs                       # tiny arg helpers
skills/                              # GROK-SIDE + CODEX-SIDE pieces (source only here; installed into ~/.grok or ~/.codex on explicit install)
  claude-delegate/SKILL.md           # Grok-initiated: Grok → Claude
  codex-delegate/SKILL.md            # Grok-initiated: Grok → Codex
  grok-imagine-from-claude-feedback/SKILL.md
  codex-to-claude/SKILL.md           # Codex-initiated: Codex → Claude
  codex-to-grok/SKILL.md             # Codex-initiated: Codex → Grok
agents/claude-second-opinion.md      # GROK-SIDE agent
tests/*.test.mjs                     # node --test unit tests
docs/BRIDGE-AUDIT.md                 # the independent audit + punch-list this work came from
```

## How it runs (data flow)

**Forward (`/grok-imagine "…"`):** command `.md` shells
`node ${CLAUDE_PLUGIN_ROOT}/scripts/grok-companion.mjs imagine "$ARGUMENTS"` →
`cmdImagine` builds a prompt → `runGrokHeadless` spawns `grok -p <prompt> --always-approve
--output-format json --cwd <cwd>` (no shell, so user text is injection-safe) → Grok generates
into `~/.grok/sessions/<urlencoded-cwd>/<session>/{images,videos}/` → companion extracts the
asset paths, **copies them into the gallery**, prints clean text + clickable links, records the job.

**Reverse (`claude-delegate …` from Grok):** Grok skill shells
`node …/claude-companion.mjs "task" [flags]` → `runClaudeHeadless` spawns local-OAuth-safe
`claude --model claude-opus-4-8 -p <task> --output-format json --permission-mode plan [sanitized flags]`
→ result + cost + session_id recorded in the same ledger. `--bare` is reserved for explicit API-key/settings auth.

**Pantheon packets:** companions accept plain prompt strings by default. If the input is JSON with
`pantheon_packet: true`, `lib/pantheon-packet.mjs` turns it into a structured handoff prompt and stores
packet metadata in the ledger.

## Key conventions & invariants (do not break these)

- **No API keys, no daemons.** Headless one-shots only. Both binaries resolved from PATH first,
  then explicit fallbacks (`~/.grok/bin/grok`; `~/.local/bin/claude` is the real claude here).
- **ESM only** (`.mjs`, top-level `import`). Never use `require()` — it throws in these modules.
- **Grok URL-encodes the cwd into one literal directory name** (`…/sessions/%2Fprivate%2Ftmp%2F…/`).
  Those `%2F` are literal characters on disk. NEVER `fileURLToPath`/URL-decode a Grok asset path —
  decoding `%2F`→`/` produces a path that doesn't exist. Strip the `file://` prefix as a string instead.
- **Media goes to the gallery, not the cwd.** `MEDIA_ROOT` = `GROK_BRIDGE_MEDIA_DIR` or
  `~/Pictures/grok-imagine`. Each job → `<MEDIA_ROOT>/<YYYY-MM-DD>/<job-id>/<job-id>-<n>.<ext>`.
  Links are emitted with `pathToFileURL` so they resolve when clicked.
- **Decode JSON before parsing media.** Headless grok returns `{text, thought, …}`. Parse media from
  the **decoded** `text`+`thought` (real newlines), never the raw JSON string (escaped `\n` mashes paths).
- **One ledger writer.** All job state goes through `lib/state.mjs` (`upsertJob/readJob/listJobs`),
  schema: `{id, direction, type, status, pid, hop, cost, media[], gallery, ts, updated}`.
- **`main()` is import-guarded** in both companions (`if (import.meta.url === \`file://${process.argv[1]}\`)`)
  so helpers are unit-testable. Keep new pure helpers exported.
- **Agent-isolation:** the source of truth lives ONLY in this `~/Code` repo. The Grok-side skills/agent
  are *symlinked* into `~/.grok/` at install — edit them here, not there.

## Environment variables

| Var | Default | Effect |
|-----|---------|--------|
| `GROK_BRIDGE_MEDIA_DIR` | `~/Pictures/grok-imagine` | Gallery root for generated assets |
| `GROK_BRIDGE_MAX_HOPS` | `2` | Loop-guard ceiling for cross-delegation |
| `GROK_BRIDGE_TIMEOUT_MS` | `300000` | Kill a headless child after this long |
| `GROK_BRIDGE_ALLOW_WRITES` | unset | `=1` lets the reverse leg run Claude with write/exec perms |
| `GROK_BRIDGE_QUIET` | unset | `=1` silences the progress heartbeat |

## Safety layer (`lib/bridge-guard.mjs`)

- `assertHopAllowed(dir)` / `childEnv()` — **loop guard.** `BRIDGE_HOP` env increments on every
  spawned child; refuses once `>= MAX_HOPS`. Stops runaway Claude→Grok→Claude recursion.
- `sanitizeClaudeArgs(args)` — **write gate** (reverse leg). Unless `GROK_BRIDGE_ALLOW_WRITES=1`,
  strips `--dangerously-skip-permissions`, `--permission-mode bypassPermissions|acceptEdits`, and any
  caller `--allowedTools`, then pins read-only `Read,Glob,Grep`. Prevents Grok from silently driving
  Claude with autonomous edits + Bash. Stripped unsafe flags are surfaced as `pantheon_warning`.
- `armTimeout(child, reject, ms)` — SIGTERMs a hung child.
- `startHeartbeat(label)` — elapsed ticks to **stderr** every 15s (never pollutes parsed stdout).

## Testing

```bash
node --test tests/*.test.mjs        # unit tests (guard logic + media extraction)
node --check plugins/grok/scripts/*.mjs   # syntax/parse check
node plugins/grok/scripts/grok-companion.mjs setup   # live smoke (spawns grok)
node plugins/grok/scripts/grok-companion.mjs health --json   # static Pantheon health
```

## Install (local, non-interactive)

```bash
claude plugin validate .
claude plugin marketplace add /Users/faadi/Code/Pantheon
claude plugin install grok@pantheon
# Grok side (reverse leg):
grok plugin install /Users/faadi/Code/Pantheon --trust
```
Slash commands go live after a Claude Code session restart.

---

## Future Roadmap (P2s + richer scenarios)

See the dedicated section in `README.md` for the current prioritized list (unified ledger, streaming, gallery index.json, session reuse, etc.) and the three richer E2E scenario examples (video+code handoff, feedback loop via the new `grok-imagine-from-claude-feedback` skill, and grounded creative + review).

## Change log — 2026-06-07 (hardening pass)

Work driven by `docs/BRIDGE-AUDIT.md`. P0 fixes were done by Grok; the items below are what this
Claude session verified and added/fixed.

**P0 storage defects found & fixed (Grok's pass shipped these broken):**
1. `BRIDGE_MEDIA` was parsed on the **raw JSON stdout** (escaped newlines) → captured paths were
   contaminated, `existsSync` failed, gallery stayed empty. Now parses the **decoded** text.
2. Extraction was **`BRIDGE_MEDIA`-only and too fragile** (Grok often omits the line). Replaced with
   `extractMediaPaths()` — harvests from `BRIDGE_MEDIA:` lines + `file://` links + bare
   `.grok/sessions/…` paths, across both `text` and `thought`; normalizes (strip `file://`, collapse
   leading slashes), cuts at the extension (drops trailing `**`/`)`), dedupes. Verified on real output.
3. `file://` links pointed into the `%2F`-encoded session dir and broke on click → assets are now
   copied to the clean gallery and linked via `pathToFileURL`.

**P1 items implemented (new `lib/bridge-guard.mjs`):**
- Loop guard (hop counter, `MAX_HOPS`).
- Write gate for the reverse leg (`GROK_BRIDGE_ALLOW_WRITES`).
- Child timeout (`GROK_BRIDGE_TIMEOUT_MS`).
- Real `/grok:cancel` (PID tracked in ledger → SIGTERM → marks `cancelled`, ESRCH-safe).
- Unified ledger: `state.mjs` is the single writer for both directions; richer schema + `/grok:status`
  shows status/media-count/cost.
- Best-effort cost surfacing (`total_cost_usd`; null on the Grok leg, populated on the Claude leg).
- Progress heartbeat to stderr (chosen over full `--output-format streaming-json` to keep the parser stable).
- Import-guarded `main()`; fixed `cmdSetup` silently dropping `--max-turns` after the signature change;
  removed dead `BRIDGE_DATA`/`ensureDir`.
- Tests: `tests/bridge-guard.test.mjs`, `tests/media-extract.test.mjs` (10 passing).

**Verified static fixes from Grok's P0 pass:** ESM `require` removed; `~/.local/bin/claude` fallback;
`--yolo`→`--always-approve`; clean `.text` output; reverse leg symlinked into `~/.grok/`.

**Still open (candidates for Grok / future work):**
- Broaden `/grok:health --live` into complete six-direction checks where every local companion is available.
- True token-level streaming (`--output-format streaming-json`) if the heartbeat isn't enough.
- Session reuse (`--continue` + stored `session_id`) so "edit the previous image" keeps context.
- README/docs polish (the audit references some behavior that predates these fixes).

**Audit correction:** the original audit flagged shell-quoting/injection via `"$ARGUMENTS"`. This is
**not** a real vulnerability — bash does not re-scan a double-quoted parameter expansion, and `spawn`
runs without a shell, so embedded quotes/backticks/`$()` are inert. No fix needed.

## Change log — 2026-07-03 (model-routing brain)

**Central router as single source of truth.** New `plugins/grok/scripts/lib/model-routing.mjs` — the
only file in the repo allowed to contain a model-ID literal. Exports `ROUTING_TABLE`, `MODEL_TIERS`,
`classifyTask()`, `resolveModel()`. `claude-companion.mjs` and `grok-companion.mjs` now call the router
instead of the scattered `DEFAULT_CLAUDE_MODEL`/`DEFAULT_CODEX_MODEL` constants and `packetModelArgs()`
helper they used to hardcode; every leg records `model`/`effort`/`routing{taskClass, source, escalated}`
plus a packet-derived `direction` (`${from}-to-${to}`) in the ledger. Precedence: explicit `--model` >
`packet.model` > env (`GROK_BRIDGE_CLAUDE_MODEL`/`GROK_BRIDGE_CODEX_MODEL`/`GROK_BRIDGE_GROK_MODEL`) >
routing table > binary default.

**The routing matrix** (direction → task → model@effort) covers all six directions — see the table in
`README.md` § Model routing or `docs/PANTHEON-EXPLAINED.md` for the plain-English version. Notable
rules: auto-escalates to the deep tier on risk keywords (security/auth/payment/credential/secret/
data-loss/migration/destructive/production, stem-matched) or `packet.escalate`/`budget.cost:high`/retry;
caps to the cheap tier on `budget.cost:low`; `security-review` is force-pinned to `claude-opus-4-8` and
cannot be downgraded by an untrusted packet or env override; Claude legs get a `[1m]` context-window
model when the prompt plus context exceeds ~600k characters. Health handshakes now use routed cheap
health-tier models instead of a separate hardcoded set.

**Codex leg made real.** New `plugins/grok/scripts/codex-companion.mjs` — Claude→Codex and Grok→Codex
now actually spawn `codex exec -m <model> -c model_reasoning_effort=<effort> --sandbox read-only
--skip-git-repo-check -C <cwd> <prompt>`, sharing the same loop guard, write gate, timeout, heartbeat,
and job ledger as the other two companions. Previously these directions had no real companion.

**Security/write-gate hardening.** New `sanitizeCodexArgs()` in `lib/bridge-guard.mjs` strips
`-c`/`--config` and `--profile`/`-p` (config-override escape vectors — a delegator could otherwise
smuggle `sandbox_mode="danger-full-access"` or an env-inheriting shell policy past the gate) in addition
to the sandbox-bypass flags, then pins `--sandbox read-only` unless `GROK_BRIDGE_ALLOW_WRITES=1`.
`splitFlag()` (shared by both write gates) was widened from double-dash-only to also handle Codex's
single-dash short flags (`-s`, `-a`, `-m`, …) — without this, a joined short flag like
`-s=danger-full-access` matched no known name and slipped through ungated.

**Stale model-ID sweep.** Removed every hardcoded model-ID literal left over from before the router
existed (the old Sonnet-4.6-era default in both companions, the ad hoc `packetModelArgs()` helper) so
`model-routing.mjs` is genuinely the only place a model string can appear; usage/help text updated to
match (`claude-sonnet-5`).

**88 tests pass** (`node --test tests/*.test.mjs`), including new `tests/model-routing.test.mjs` and
`tests/codex-guard.test.mjs`.

**Default tiers updated 2026-07-03:** reasoning→claude-opus-4-8, coding→gpt-5.3-codex-spark/grok-build;
Fable and Sonnet removed from the table (`grok-build` IS Grok 4.3 — xAI's Grok Build CLI exposes no separate `grok-4.3` slug, so grok-build covers the Grok reasoning+coding default).

Sonnet 5 reintroduced as the balanced Claude tier (data-model + second-opinion, auto-escalating to Opus on risk); `[1m]` fallback back to sonnet.

## Change log — 2026-07-03 (first-class triggers for all six directions)

Added first-class commands/skills for all six directions (`/grok:codex`, `/grok:task`, `codex-to-claude`,
`codex-to-grok`). New `plugins/grok/commands/codex.md` (Claude→Codex, builds a Pantheon packet with an
inferred `implement|verify|review` lane and forwards to `codex-companion.mjs`) and
`plugins/grok/commands/task.md` (Claude→Grok generic, forwards to `grok-companion.mjs task`). New
Codex-initiated skill sources `skills/codex-to-claude/SKILL.md` and `skills/codex-to-grok/SKILL.md` —
these are repo-only source definitions; they install into `~/.codex/` only on an explicit Codex-side
install, mirroring how the Grok-side skills are symlinked into `~/.grok/`. No companion `.mjs`,
`model-routing.mjs`, or tests were touched — this was command/skill/doc surface only. `README.md` and
`docs/PANTHEON-EXPLAINED.md` now carry a per-direction first-class-trigger table.
