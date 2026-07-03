# Pantheon

**A local, OAuth-only delegation mesh for your AI coding agents.** Pantheon lets **Claude Code**, **Grok Build**, and **Codex**, all installed and logged in on the same machine, hand work to each other. No API keys, no remote services, no daemons. Each leg simply shells the CLI you are already logged into through its normal headless mode.

The headline use is **image and video generation**: from inside Claude Code you type `/grok-imagine` and Grok's Imagine models do the work, with the finished assets dropped back into your session as clickable links. On top of that, any agent can ask another for a second opinion, an implementation pass, or a multi-agent review.

```
You in Claude Code:  /grok-imagine a cinematic product shot of a linen napkin on marble, 3:2
Pantheon:            (shells your logged-in Grok, generates, copies the file to your gallery)
                     -> file:///Users/you/Pictures/grok-imagine/2026-06-18/<job>/<job>-1.png
                        ![napkin](file://...)   <- ready to paste
```

> **Why "OAuth-only" matters:** Pantheon never asks for `ANTHROPIC_API_KEY`, `XAI_API_KEY`, or any token. It runs the `claude`, `grok`, and `codex` binaries you already use, under the logins you already have. Nothing leaves your machine, and there is no extra billing to set up.

---

## What is actually wired

Pantheon is a mesh of six directions. Be honest about maturity before you install:

| Direction | Maturity | How you use it |
|---|---|---|
| **Claude -> Grok** | Polished | `/grok-imagine`, `/grok-review` slash commands |
| **Grok -> Claude** | Polished | `claude-delegate` skill + `claude-second-opinion` agent |
| **Claude -> Codex** | Real | `node plugins/grok/scripts/codex-companion.mjs "task"` spawns `codex exec` directly |
| **Grok -> Codex** | Real | `codex-delegate` skill → the same `codex-companion.mjs` |
| **Codex -> Claude** | Working | Codex shells `claude-companion.mjs` with a `packet.from: "codex"` handoff |
| **Codex -> Grok** | Working | Codex shells `grok-companion.mjs` with a `packet.from: "codex"` handoff |

The Claude and Grok legs are the most built-out (dedicated commands, a media gallery, a job ledger). The Codex legs share the same companions, ledger, and safety layer — `codex-companion.mjs` makes Claude/Grok → Codex a real spawned `codex exec`, not a stub — and are verified by the live health check below. Dedicated `/grok:*`-style slash commands for the Codex legs are still on the roadmap; for now they're invoked via `node` directly or through the skills above. The canonical routing rules live in [`docs/PANTHEON-OPTIMIZATION-PLAN.md`](./docs/PANTHEON-OPTIMIZATION-PLAN.md).

You do not need all three agents. If you only have Claude Code and Grok, the headline image and review flows work fully on their own.

---

## Model routing

Every model choice in Pantheon flows through one file, `plugins/grok/scripts/lib/model-routing.mjs` — the **only** place in the repo allowed to contain a literal model ID. Every companion calls `classifyTask()` then `resolveModel()` instead of hardcoding a model string, so a model rename or retirement is a one-file edit. For a plain-English walkthrough, see [`docs/PANTHEON-EXPLAINED.md`](./docs/PANTHEON-EXPLAINED.md).

### Routing matrix

| Direction | Task | Model @ effort |
|---|---|---|
| claude → grok | imagine | `grok-build` @ high |
| claude → grok | creative-review | `grok-build` @ xhigh, best-of-3 |
| claude → grok | task | `grok-build` @ medium |
| claude → grok | health | `grok-composer-2.5-fast` @ low |
| claude → codex | implement | `gpt-5.3-codex-spark` @ high |
| claude → codex | review | `codex-auto-review` @ high |
| claude → codex | verify | `gpt-5.3-codex-spark` @ high |
| claude → codex | health | `gpt-5.4-mini` @ minimal |
| grok → claude | architecture / second-opinion / data-model | `claude-opus-4-8` |
| grok → claude | security-review | `claude-opus-4-8` |
| grok → claude | summarize / health | `claude-haiku-4-5` |
| grok → codex | implement | `gpt-5.3-codex-spark` @ high |
| grok → codex | review | `codex-auto-review` @ high |
| grok → codex | verify | `gpt-5.3-codex-spark` @ high |
| codex → claude | second-opinion / reasoning / architecture | `claude-opus-4-8` |
| codex → claude | security-review | `claude-opus-4-8` |
| codex → grok | imagine / assets | `grok-build` @ high |
| codex → grok | creative-review | `grok-build` @ xhigh, best-of-3 |
| codex → grok | task | `grok-build` @ medium |
| codex → grok | draft | `grok-composer-2.5-fast` @ medium |

### Precedence

For every hop, `resolveModel()` picks the model in this order — first match wins:

1. An explicit `--model` (a human at the CLI always wins).
2. `packet.model` on a structured Pantheon packet.
3. An environment override: `GROK_BRIDGE_CLAUDE_MODEL`, `GROK_BRIDGE_CODEX_MODEL`, `GROK_BRIDGE_GROK_MODEL`.
4. The routing table above.
5. The target binary's own default, if nothing else applies.

### Escalation and caps

- **Auto-escalates to the deep tier** on risk keywords (`security`, `auth`, `payment`, `credential`, `secret`, `data-loss`, `migration`, `destructive`, `production` — stem-matched, so "authentication" and "migrations" both hit) in a packet's `objective`/`constraints`, or on `packet.escalate: true`, `packet.budget.cost: "high"`, or a retry.
- **Caps to the cheap tier** when `packet.budget.cost: "low"`.
- **`security-review` is force-pinned to `claude-opus-4-8`** and cannot be downgraded by an untrusted packet or env override — only an explicit human `--model` beats it.
- **Long-context suffix:** Claude legs get a `[1m]` context-window model when the prompt plus context exceeds ~600k characters.

---

## Requirements

- **Claude Code** installed and logged in (the real binary is usually `~/.local/bin/claude`).
- **Grok Build CLI** installed and logged in (`grok` on your PATH, or `~/.grok/bin/grok`).
- **Codex** installed and logged in (optional, only for the Codex legs).
- **Node.js 18.18 or newer** (the plugin scripts are ESM `.mjs`).

No API keys are read or required. Pantheon uses your existing CLI logins.

---

## Install

### 1. Clone the repo

```bash
git clone https://github.com/fxa3bah/Pantheon.git
cd Pantheon
```

(From here on, commands assume you are inside the cloned `Pantheon` folder. Where a command needs an absolute path, swap in the full path to your clone.)

### Fast path: run the setup wizard

The quickest way to get going. The script checks your tools, tells you exactly what to install or log into (it never installs software behind your back), wires up the plugins, and finishes with a **live walkthrough where you watch each agent answer**:

```bash
./pantheon-setup.sh
```

```
== 4/5  Live walkthrough ==
  [live] claude -> grok      replied PANTHEON-GROK-42 ok
  [live] grok -> claude      replied PANTHEON-CLAUDE-42 ok
  [live] grok -> codex       replied PANTHEON-CODEX-42 ok
  ...
  All available directions are live.
```

Flags: `--yes` (skip the wiring prompts), `--no-live` (skip the agent calls). Re-running is safe.

If you prefer to do it by hand, the manual steps are below.

### 2. Claude Code side (the `/grok-*` commands)

```bash
claude plugin validate .
claude plugin marketplace add "$(pwd)"
claude plugin install grok@pantheon
```

Or, from inside a running Claude Code session:

```
/plugin marketplace add /full/path/to/Pantheon
/plugin install grok@pantheon
```

**Restart Claude Code** so the slash commands load, then confirm it sees Grok:

```
/grok:setup
```

### 3. Grok Build side (the reverse leg, optional)

```bash
grok plugin install "$(pwd)" --trust
```

This exposes the `claude-delegate` and `grok-imagine-from-claude-feedback` skills and the `claude-second-opinion` agent inside Grok. They are symlinked from this repo into `~/.grok/`, so edit them here, not there.

### 4. Verify everything

```bash
# Fast, no agent calls:
node plugins/grok/scripts/grok-companion.mjs health --json

# Full live handshake (spawns each real CLI once, so it uses your normal usage):
node plugins/grok/scripts/grok-companion.mjs health --json --live
```

A passing `--live` run means every available direction actually answered. The health check uses a compute-challenge token (each agent must reply with a value it has to calculate), so a CLI that merely echoes the prompt or returns nothing can never produce a false "green."

---

## Quick start

```
/grok-imagine a dramatic low-angle product shot of a folded heavy linen napkin on cool marble, soft window light, 3:2
/grok-imagine turn the previous image into a 6-second slow push-in with subtle fabric movement
/grok-review the auth flow and state-machine changes on this branch --background
/grok:status
/grok:result
```

For anything slow (video, a multi-agent review), add `--background`, then poll `/grok:status` and fetch with `/grok:result`.

---

## Commands (in Claude Code)

| Command | What it does |
|---|---|
| `/grok-imagine <request> [--background\|--wait]` | Hand off any image or video task (stills, edits, variations, references, short video). Grok uses its Imagine models. |
| `/grok-review [focus] [--background]` | Delegate a review or investigation. Grok runs multiple perspectives and returns one synthesized report. |
| `/grok:setup [--json]` | Check that the local `grok` binary and login are ready. |
| `/grok:health [--json] [--live]` | Show Pantheon health across Grok, Claude, and Codex. `--live` runs the read-only handshakes. |
| `/grok:status [job-id] [--json]` | List recent jobs (status, media count, cost) or show one. |
| `/grok:result [job-id] [--json]` | Print a job's output and media paths. |
| `/grok:cancel [job-id]` | Send a real SIGTERM to a running job and mark it cancelled. |

---

## Where images and videos go

Every generated asset is copied into a dated gallery, never dumped into your working directory:

```
~/Pictures/grok-imagine/<YYYY-MM-DD>/<job-id>/<job-id>-<n>.<ext>
```

- Change the root with `GROK_BRIDGE_MEDIA_DIR`.
- For each file you get a clickable `file://` link plus a ready-to-paste `![alt](file://...)` markdown embed.
- Asset paths are detected from Grok's output through several signals, so capture works even when Grok's output format varies.

---

## How the handoff works

**Claude -> Grok.** The slash command shells `node .../grok-companion.mjs imagine "$ARGUMENTS"`, which spawns your local `grok` in headless mode (`grok -p <prompt> --always-approve --output-format json`). Grok generates into its session directory; the companion copies the assets into the gallery and returns Grok's text and links verbatim.

**Grok -> Claude.** The `claude-delegate` skill shells `node .../claude-companion.mjs "task" [flags]`, which runs `claude --model claude-opus-4-8 -p <task> --output-format json --permission-mode plan`. This uses your local login. (`--bare` is only used when you have explicitly configured API-key auth, because bare mode skips the keychain and OAuth.)

**Claude/Grok -> Codex.** `node .../codex-companion.mjs "task" [flags]` shells `codex exec -m <model> -c model_reasoning_effort=<effort> --sandbox read-only --skip-git-repo-check -C <cwd> <prompt>`. It shares the same loop guard, write gate, timeout, heartbeat, and job ledger as the other two companions.

**Structured packets.** Companions accept plain prompt strings. If the input is JSON with `pantheon_packet: true`, the bridge treats it as a structured handoff and records the metadata (`from`, `to`, `lane`, `objective`, `model`, `media[]`, provenance) in the job ledger. Every job also records the model actually used (`model`, `effort`, `routing: {taskClass, source, escalated}`) and a `direction` derived from the packet's `from`/`to` (e.g. `codex-to-claude`).

All three companions share one job ledger at `./.grok-bridge/<job>.json` in the active workspace.

---

## Configuration

| Variable | Default | Effect |
|---|---|---|
| `GROK_BRIDGE_MEDIA_DIR` | `~/Pictures/grok-imagine` | Gallery root for generated assets. |
| `GROK_BRIDGE_MAX_HOPS` | `2` | Loop-guard ceiling. Stops runaway cross-delegation. |
| `GROK_BRIDGE_TIMEOUT_MS` | `300000` | Kill a headless child after this long (raise it for long video). |
| `GROK_BRIDGE_ALLOW_WRITES` | unset | `=1` lets the reverse leg run Claude with write and exec tools. |
| `GROK_BRIDGE_QUIET` | unset | `=1` silences the progress heartbeat. |

### Safety, by default

Pantheon is built so one agent driving another cannot quietly run away or do damage:

- **Loop guard.** Each crossed hop increments a counter. Once it reaches `GROK_BRIDGE_MAX_HOPS` (default 2), further delegation is refused. No infinite Claude -> Grok -> Claude recursion.
- **Write gate.** By default the reverse leg runs Claude **read-only** (`Read,Glob,Grep`). Dangerous flags like `--dangerously-skip-permissions` and `--permission-mode bypassPermissions` are stripped and surfaced as a warning. You opt into writes explicitly with `GROK_BRIDGE_ALLOW_WRITES=1`.
- **Timeouts** kill hung children, and `/grok:cancel` sends a real SIGTERM.

---

## Troubleshooting

**The `/grok-*` commands do not show up.** Restart Claude Code after installing. Slash commands load on session start. Then run `/grok:setup`.

**`/grok:setup` says Grok is not found.** Make sure `grok` is on your PATH (`which grok`) or present at `~/.grok/bin/grok`, and that you are logged in (`grok` opens without asking you to authenticate).

**A reverse-leg call says "Not logged in."** That usually means `--bare` was forced. Pantheon defaults to non-bare local OAuth for exactly this reason. Do not pass `--bare` unless you have configured API-key auth.

**`health --live` shows a direction as skipped.** That agent's binary was not found. Skipped is not failed: it just means you do not have that CLI installed, which is fine if you do not need that leg.

**Generated images do not appear.** Check `~/Pictures/grok-imagine/<today>/`, or wherever `GROK_BRIDGE_MEDIA_DIR` points. The terminal also prints the exact `file://` path.

---

## Development and testing

```bash
# Unit tests (loop guard, write gate, media extraction, packets, health)
npm test

# Parse / syntax check
node --check plugins/grok/scripts/grok-companion.mjs
node --check plugins/grok/scripts/claude-companion.mjs
```

Architecture, invariants, and the full change log are in [`CLAUDE.md`](./CLAUDE.md). The original design audit is in [`docs/BRIDGE-AUDIT.md`](./docs/BRIDGE-AUDIT.md).

---

## Roadmap

None of these block daily use; the mesh is functional today.

1. More dedicated Codex commands to match the Claude and Grok surface.
2. Session reuse, so "edit the previous image" keeps Grok's full context instead of starting cold.
3. A gallery `index.json` manifest so status and a future viewer do not have to rescan disk.
4. True token streaming if the current stderr heartbeat is not enough live feedback.

---

## Contributing

Issues and pull requests are welcome. The repo is small and well-commented. Two ground rules:

- Keep it OAuth-only. No code path should read an API key or require one.
- Do not weaken the safety layer (loop guard, write gate) without an explicit opt-in flag.

---

## License

MIT. See [LICENSE](./LICENSE).
