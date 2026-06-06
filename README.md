# grok-plugin-cc

**A symmetric, local-only "cross-agent bridge" between Claude Code and Grok Build** — with
image/video generation (Grok Imagine) as the killer feature and multi-agent delegation/review
as powerful follow-ons.

Two-way. Same machine. **No API keys** — the bridge only ever shells the `grok` and `claude`
binaries you're already logged into via their normal OAuth. No remote services, no daemons.

- **Claude → Grok:** `/grok-imagine` hands off all image + video work to Grok's Imagine models;
  `/grok-review` delegates multi-agent reviews. Results land back in your session with
  clickable links and ready-to-paste markdown.
- **Grok → Claude:** the `claude-delegate` skill / `claude-second-opinion` agent hand
  complementary (non-visual) work back to the local Claude Code CLI.

> Engineering detail and conventions live in [`CLAUDE.md`](./CLAUDE.md). The original design
> audit + fix punch-list is in [`docs/BRIDGE-AUDIT.md`](./docs/BRIDGE-AUDIT.md).

---

## Requirements

- **Grok Build CLI** installed and OAuth-logged-in (`grok` on PATH or `~/.grok/bin/grok`).
- **Claude Code** on the same machine (real binary typically `~/.local/bin/claude`).
- **Node.js 18.18+** (the plugin scripts are ESM `.mjs`).
- That's it — no `XAI_API_KEY` / `ANTHROPIC_API_KEY` is read or required.

---

## Install

### Claude Code side (forward leg — `/grok-imagine`, `/grok-review`)

Non-interactive (recommended — works from any shell):

```bash
claude plugin validate /Users/faadi/Code/grok-plugin-cc
claude plugin marketplace add /Users/faadi/Code/grok-plugin-cc
claude plugin install grok@grok-plugin-cc
```

Or from inside a Claude Code session:

```
/plugin marketplace add /Users/faadi/Code/grok-plugin-cc
/plugin install grok@grok-plugin-cc
```

**Restart Claude Code** so the slash commands load, then verify:

```
/grok:setup
```

### Grok Build side (reverse leg — `claude-delegate`)

```bash
grok plugin install /Users/faadi/Code/grok-plugin-cc --trust
```

This makes the Grok-side `claude-delegate` + `grok-imagine-from-claude-feedback` skills and the
`claude-second-opinion` agent available inside Grok. (They are symlinked from this repo into
`~/.grok/` — edit them here, not there.)

---

## Quick start

```
/grok-imagine a dramatic low-angle cinematic product shot of a folded heavy linen napkin on cool marble, soft window light, 3:2
/grok-imagine turn the previous image into a 6-second slow push-in with subtle fabric movement
/grok-review the auth flow and state-machine changes on this branch --background
/grok:status
/grok:result
```

After a generation you get the clean output plus, for each asset, a **clickable `file://` link**
and a **markdown embed** — and the file is copied into your gallery (see below).

---

## Commands (Claude Code)

| Command | What it does |
|---------|--------------|
| `/grok-imagine <request> [--background\|--wait]` | Hand off **any** image/video task (stills, edits, variations, references, short video). Grok uses its Imagine models + skill + ffmpeg. |
| `/grok-review [focus] [--background]` | Delegate a review/investigation; Grok is told to run **multiple agents / perspectives** and synthesize one report. |
| `/grok:setup [--json]` | Verify the local `grok` binary + OAuth (no API key). |
| `/grok:status [job-id] [--json]` | List recent jobs (status, media count, cost) or show one. |
| `/grok:result [job-id] [--json]` | Print a job's output + media paths. |
| `/grok:cancel [job-id]` | SIGTERM a running job (tracked by PID) and mark it cancelled. |

Use `--background` for anything long (video, multi-agent review), then poll `/grok:status` and
fetch with `/grok:result`.

---

## Where images & videos go

Every generated asset is **copied into a dated gallery** — never dumped in your working directory:

```
~/Pictures/grok-imagine/<YYYY-MM-DD>/<job-id>/<job-id>-<n>.<ext>
```

- Override the root with `GROK_BRIDGE_MEDIA_DIR`.
- The bridge prints a `file://…` link (clickable in the terminal / Finder / QuickLook) and a
  ready-to-paste `![alt](file://…)` markdown embed for each file.
- Asset paths are detected from Grok's output via multiple signals (`BRIDGE_MEDIA:` lines,
  `file://` links, and bare session paths), so capture works even when Grok's output format varies.

---

## How the hand-off works

**Claude → Grok:** the slash command shells
`node …/grok-companion.mjs imagine "$ARGUMENTS"`, which spawns the local `grok` in headless mode
(`grok -p <prompt> --always-approve --output-format json --cwd <cwd>`). Grok generates into its
session dir; the companion copies the assets into the gallery and returns Grok's text + links
verbatim.

**Grok → Claude:** the `claude-delegate` skill shells
`node …/claude-companion.mjs "task" [flags]`, which runs `claude --bare -p <task>
--output-format json`. `--bare` (per the Claude Code CLI docs) skips unrelated plugins/skills/MCP
for speed and determinism. Output + cost + `session_id` come back into the Grok session.

Both directions share one job ledger in `./.grok-bridge/<job>.json` (in the active workspace).

---

## Configuration (environment variables)

| Var | Default | Effect |
|-----|---------|--------|
| `GROK_BRIDGE_MEDIA_DIR` | `~/Pictures/grok-imagine` | Gallery root for generated assets. |
| `GROK_BRIDGE_MAX_HOPS` | `2` | Loop-guard ceiling. Stops runaway Claude→Grok→Claude recursion. |
| `GROK_BRIDGE_TIMEOUT_MS` | `300000` | Kill a headless child after this long (raise for long video). |
| `GROK_BRIDGE_ALLOW_WRITES` | unset | `=1` lets the **reverse** leg run Claude with write/exec tools. |
| `GROK_BRIDGE_QUIET` | unset | `=1` silences the progress heartbeat. |

### Safety defaults (important)

- **Loop guard.** Each crossed hop increments `BRIDGE_HOP`; the bridge refuses to delegate again
  once `BRIDGE_HOP >= MAX_HOPS`. Prevents infinite cross-delegation (each hop is a full agent run).
- **Write gate (reverse leg).** By default Grok→Claude runs **read-only**
  (`--allowedTools Read,Glob,Grep`); `--dangerously-skip-permissions` and
  `--permission-mode bypassPermissions|acceptEdits` are stripped. Set `GROK_BRIDGE_ALLOW_WRITES=1`
  to opt into letting Grok drive Claude with edits + Bash.
- **Timeouts** kill hung children; **`/grok:cancel`** sends a real SIGTERM.

---

## Typical flows

**Pure visual creation**
```
/grok-imagine a clean minimalist line drawing of a single palm tree against a golden-hour sky, 9:16
/grok:result
# → file:// link + markdown; file is in ~/Pictures/grok-imagine/<date>/<job>/
```

**Iterate using Grok's full strengths** — from a Grok session, translate Claude's feedback into
precise Imagine prompts with the `grok-imagine-from-claude-feedback` skill, then `image_edit`.

**Multi-perspective review**
```
/grok-review the new permission and state-machine changes --background
/grok:status
/grok:result
```

**Reverse leg (from Grok)**
```
claude-delegate review the integration code for the marketing assets and suggest perf improvements
# Read-only by default. To allow edits: GROK_BRIDGE_ALLOW_WRITES=1 in the environment.
```

---

## Development & testing

```bash
# Unit tests (loop guard, write gate, media extraction)
node --test tests/*.test.mjs

# Parse/syntax check
node --check plugins/grok/scripts/grok-companion.mjs
node --check plugins/grok/scripts/claude-companion.mjs

# Live smokes (these spawn the real CLIs)
node plugins/grok/scripts/grok-companion.mjs setup
node plugins/grok/scripts/grok-companion.mjs imagine "a folded white waffle towel on marble, 3:2"
node plugins/grok/scripts/claude-companion.mjs "summarize the README" --allowedTools "Read"
```

Architecture, invariants, and the full change log are in [`CLAUDE.md`](./CLAUDE.md).

---

## FAQ

**Do I need API keys?** No. Only the locally OAuth-authenticated `grok` / `claude` binaries.

**Is it one-way or two-way?** Two-way. Claude → Grok (Imagine + review) is the rich surface;
Grok → Claude uses the same patterns and ledger.

**Where do the images/videos go?** `~/Pictures/grok-imagine/<date>/<job-id>/` (override with
`GROK_BRIDGE_MEDIA_DIR`). Links are printed as clickable `file://` URLs + markdown.

**Can Grok make Claude edit files?** Only if you set `GROK_BRIDGE_ALLOW_WRITES=1`. By default the
reverse leg is read-only.

**Will it loop forever if both sides delegate?** No — the hop counter (`GROK_BRIDGE_MAX_HOPS`,
default 2) refuses further cross-delegation.

**Does it touch `~/.claude`?** No. The Claude plugin is installed via the plugin system. The
Grok-side skills are symlinked into `~/.grok/`; the source of truth stays in this repo.

---

## License

MIT — see [LICENSE](./LICENSE).
