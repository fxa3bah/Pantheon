# CLAUDE.md — grok-plugin-cc

Project memory for Claude Code sessions working on this repo. Read before editing.

## Current state (2026-06-07) — read this first

- **Installed & enabled.** `grok@grok-plugin-cc` is installed at **user scope** (via
  `claude plugin marketplace add` + `claude plugin install`) and shows enabled in `claude plugin list`.
  Components: 6 commands + the `grok-delegate` agent. Slash commands load on session restart.
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
  fired the **write gate** correctly (`enforced read-only --allowedTools Read,Glob,Grep`). One headless
  `-p --bare` auth hiccup in the isolated tool shell is a known environment quirk, not a bridge bug.
- **What changed this session:** see the Change log at the bottom. New files: `lib/bridge-guard.mjs`,
  `tests/bridge-guard.test.mjs`, `tests/media-extract.test.mjs`, `CLAUDE.md`. Heavily edited:
  `grok-companion.mjs`, `claude-companion.mjs`, `lib/state.mjs`, `README.md`.

## What this is

A **two-way, local, OAuth-only bridge** between **Claude Code** and **Grok Build**, both
installed and logged in on the **same machine**. No API keys — the bridge only ever shells
the already-authenticated local `grok` / `claude` binaries in headless mode.

- **Claude → Grok** (the rich surface): `/grok-imagine` hands off all image/video work to
  Grok's Imagine models; `/grok-review` delegates multi-agent reviews. Installed as the
  Claude Code plugin `grok@grok-plugin-cc`.
- **Grok → Claude** (symmetric leg): the `claude-delegate` skill + `claude-second-opinion`
  agent let Grok hand non-visual work back to the local Claude Code CLI.

## Repo layout

```
.claude-plugin/marketplace.json      # local marketplace manifest (name: grok-plugin-cc)
plugins/grok/
  .claude-plugin/plugin.json         # the installable plugin (name: grok); commands/agents auto-discovered
  commands/                          # slash commands: imagine, review, setup, status, result, cancel (.md)
  agents/grok-delegate.md            # proactive forwarder subagent
  prompts/imagine-system.md
  scripts/
    grok-companion.mjs               # FORWARD leg (Claude→Grok). Main entry for imagine/review/task/status/result/cancel/setup
    claude-companion.mjs             # REVERSE leg (Grok→Claude). Shells `claude --bare -p … --output-format json`
    lib/
      bridge-guard.mjs               # SAFETY layer: loop guard, write gate, timeout, heartbeat
      state.mjs                      # canonical job ledger (single writer for BOTH directions)
      args.mjs                       # tiny arg helpers
skills/                              # GROK-SIDE pieces (installed into ~/.grok, not the Claude plugin)
  claude-delegate/SKILL.md
  grok-imagine-from-claude-feedback/SKILL.md
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
`node …/claude-companion.mjs "task" [flags]` → `runClaudeHeadless` spawns
`claude --bare -p <task> --output-format json [sanitized flags]` → result + cost + session_id
recorded in the same ledger.

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
  Claude with autonomous edits + Bash.
- `armTimeout(child, reject, ms)` — SIGTERMs a hung child.
- `startHeartbeat(label)` — elapsed ticks to **stderr** every 15s (never pollutes parsed stdout).

## Testing

```bash
node --test tests/*.test.mjs        # unit tests (guard logic + media extraction)
node --check plugins/grok/scripts/*.mjs   # syntax/parse check
node plugins/grok/scripts/grok-companion.mjs setup   # live smoke (spawns grok)
```

## Install (local, non-interactive)

```bash
claude plugin validate .
claude plugin marketplace add /Users/faadi/Code/grok-plugin-cc
claude plugin install grok@grok-plugin-cc
# Grok side (reverse leg):
grok plugin install /Users/faadi/Code/grok-plugin-cc --trust
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
- Reverse leg (Grok→Claude): write gate + binary/skill presence confirmed live from a Grok session
  (2026-06-07); the full headless `--bare -p` round-trip still needs a clean run (an auth hiccup hit
  the isolated tool shell). Re-test and capture a returned result.
- True token-level streaming (`--output-format streaming-json`) if the heartbeat isn't enough.
- Session reuse (`--continue` + stored `session_id`) so "edit the previous image" keeps context.
- README/docs polish (the audit references some behavior that predates these fixes).

**Audit correction:** the original audit flagged shell-quoting/injection via `"$ARGUMENTS"`. This is
**not** a real vulnerability — bash does not re-scan a double-quoted parameter expansion, and `spawn`
runs without a shell, so embedded quotes/backticks/`$()` are inert. No fix needed.
