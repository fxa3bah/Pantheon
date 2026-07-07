---
description: Route a task to the right Pantheon agent (Grok / Codex / Claude) using static heuristics, then ALWAYS confirm before executing. Confirm-first, opt-in, no autonomy — the safe alternative to auto-delegation.
argument-hint: '<task to route to another agent>'
disable-model-invocation: true
allowed-tools: Read, Glob, Grep, Bash(node:*), AskUserQuestion
---
Route a task to the best-fit Pantheon agent — but never silently. This command
picks a suggested target with transparent static heuristics and then **requires
explicit user confirmation before anything runs**. It is the deliberate, opt-in
counterpart to auto-delegation: no background loops, no learning, no autonomy.

Raw slash-command arguments (the task to route):
`$ARGUMENTS`

## Hard safety rules (do not violate)
- **Confirm before every execution.** You MUST call `AskUserQuestion` and get an
  explicit choice before forwarding anything to any companion. There is no
  "just run it" path, even if the routing seems obvious.
- **Never auto-route a side-effecting action.** If the task involves sending
  (email/message/post), publishing, pushing, deleting, a financial action, a
  migration, or editing another agent's config home, STOP. Do not route it.
  Surface it to the user and let them drive that action themselves.
- **Read-only by default.** Delegated legs run read-only unless the operator has
  set `GROK_BRIDGE_ALLOW_WRITES=1`. If the task clearly needs writes, say so up
  front rather than expecting them silently.
- **No new memory.** Do not read from or write to any Pantheon-local memory
  store. OneBrain/the vault is the single source of truth; this command does not
  touch it and does not build a parallel one.
- **Respect the loop guard.** These are one-shot delegations; the existing
  `MAX_HOPS` / write-gate protections in `lib/bridge-guard.mjs` still apply.

## Step 1 — classify with static heuristics
Read `$ARGUMENTS` and pick a suggested target + lane by keyword/intent. These
rules are fixed and transparent (no scoring model, no history):

| If the task is mainly about… | Suggest | Lane |
|---|---|---|
| images, video, visual assets, design direction, creative options | **Grok** | `imagine` / `review` |
| writing/changing code, builds, tests, reproducing a failure, verifying it works | **Codex** | `implement` / `verify` |
| architecture, reasoning, analysis, planning, reviewing a design or diff, a second opinion | **Claude** | `review` / `task` |

If the task is ambiguous or spans lanes, pick the closest fit as the *default*
but make the alternatives available in the confirmation prompt.

## Step 2 — confirm (mandatory)
Call `AskUserQuestion` with:
- A one-line restatement of what you understood the task to be.
- The suggested target agent as the **first / recommended** option, with the
  inferred lane and "runs read-only" noted in its description.
- The other two agents as alternatives (so the user can override the heuristic).
- Make clear that choosing an option is what authorizes execution.

If the task tripped a safety rule in Step 1, do NOT present a run option —
instead tell the user why it can't be auto-routed and stop.

## Step 3 — forward the confirmed choice, verbatim
Only after the user picks an agent, forward to that companion using a Pantheon
packet. Keep the user's intent verbatim in `objective` (JSON-escaped); do not
paraphrase or narrow it. Model/effort are chosen by the router — never pick them
yourself.

Grok:
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/grok-companion.mjs" task '{"pantheon_packet":true,"from":"claude","to":"grok","lane":"<review|imagine>","objective":"<task, JSON-escaped>","provenance":"Routed via /delegate (user-confirmed)."}'
```

Codex:
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" '{"pantheon_packet":true,"from":"claude","to":"codex","lane":"<implement|verify|review>","objective":"<task, JSON-escaped>","provenance":"Routed via /delegate (user-confirmed)."}'
```

Claude (for a second opinion / reasoning from the local Claude CLI):
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/claude-companion.mjs" '{"pantheon_packet":true,"from":"grok","to":"claude","lane":"<review|task>","objective":"<task, JSON-escaped>","provenance":"Routed via /delegate (user-confirmed)."}'
```

Return the companion stdout **verbatim**. Do not paraphrase, summarize, or add
commentary before or after. If the user declined at Step 2, do nothing and say so.
