# Pantheon, Explained

## What is Pantheon?

Pantheon lets three AI coding assistants — **Claude Code**, **Grok Build**, and **Codex** — work as one team on your Mac instead of three separate apps you have to babysit.

Think of it like a small studio with three specialists at the same desk: one is the architect who reasons through hard problems, one is the builder who writes and runs code, one is the artist who makes images and video. Normally, handing the architect's plan to the builder means copying it out of one app and pasting it into another. Pantheon removes that step — ask any one of them for something outside their lane, and they quietly pass the work to whoever's actually good at it, then bring the result back to you.

Nothing about this involves the cloud in a new way. All three assistants are already installed and logged in on your machine. Pantheon just drives them — it shells out to the same `claude`, `grok`, and `codex` commands you'd type yourself. No API keys to manage, nothing new to pay for.

## Why it matters

Each of the three models has a different strength, and it isn't close:

- **Claude** is the strongest at architecture, reasoning through ambiguous problems, and judging risk — the one you want for "does this design make sense" or "is this safe."
- **Codex** is the strongest at writing code and actually running it — builds, tests, verification.
- **Grok** is the strongest at images and video — Grok Imagine is a dedicated visual generation engine the others don't have.

Without Pantheon, using all three well means manually deciding which app to open for each task, then copy-pasting context between them. Pantheon automates that decision — it looks at the request and which two assistants are involved, then picks the right model for that specific handoff, and how hard it should think, every time.

## How it works (simply)

At the center of Pantheon is a **routing table** — a cheat-sheet that says "for this kind of task, going from this assistant to that one, use this model, thinking this hard." A security review always gets the deepest, most careful model available, no exceptions. A quick health check gets the cheapest, fastest one. Creative work gets the model built for it. You never pick the model yourself; Pantheon reads the request and looks it up.

Three safety rails keep this from being reckless: an assistant receiving delegated work runs **read-only** by default (it can look and think, but can't edit files or run destructive commands unless you opt in); delegation is capped so one assistant can't loop into another forever; and security-sensitive work is pinned to the strongest model in a way the request itself can't downgrade.

| From → To | Typical task | Model used |
|---|---|---|
| Claude → Grok | Generate an image | Grok Build (high effort) |
| Claude → Grok | Multi-angle creative review | Grok Build (max effort, 3 takes) |
| Claude → Codex | Implement a feature | GPT-5.3 Codex Spark (high effort) |
| Grok → Claude | Architecture | Claude Opus 4.8 |
| Grok → Claude | Data model / second opinion | Claude Sonnet 5 (auto-escalates to Opus 4.8 on risk) |
| Grok → Claude | Security review | Claude Opus 4.8 (always — never downgraded) |
| Codex → Grok | Generate campaign assets | Grok Build (high effort) |

## How to use it

Install (from inside the cloned repo):

```bash
claude plugin marketplace add "$(pwd)"
claude plugin install grok@pantheon
```

Restart Claude Code so the slash commands load. If you also use Grok Build and want the reverse direction wired up:

```bash
grok plugin install "$(pwd)" --trust
```

The commands you'll actually type, inside Claude Code:

| Command | What it does |
|---|---|
| `/grok-imagine <request>` | Hand an image or video request to Grok |
| `/grok-review <focus>` | Get a multi-perspective review or investigation from Grok |
| `/grok:health --json --live` | Confirm every direction of the mesh is actually working |
| `/grok:status` | See recent jobs and their state |

## Examples you can run

**Generate an image:**
```
/grok-imagine a linen throw pillow on a made bed, soft morning light, 3:2
```
Routes to Grok Build at high effort. Grok's Imagine models do the generation; the finished file lands as a clickable link in your session.

**Ask Grok to delegate an architecture question to Claude** (from a Grok Build session):
```
claude-delegate review this data model for edge cases before I build the UI around it
```
Routes to Claude Sonnet 5, Pantheon's balanced data-model/second-opinion tier — Claude reasons through it read-only and hands the analysis back. A risk keyword (payment, auth, security, etc.) in the objective auto-escalates the same request to Claude Opus 4.8.

**Check that the whole mesh is actually alive:**
```
/grok:health --json --live
```
Runs a real handshake across every direction — each agent has to compute and return a specific value, so a broken connection can't fake a "healthy" result.

**Trigger an automatic security escalation:**
```json
{"pantheon_packet": true, "from": "grok", "to": "claude", "lane": "security",
 "objective": "Review the new payment webhook handler for auth bypass risks."}
```
A structured handoff like this — sent to Claude with "payment"/"auth" in the objective, or a `security` lane — auto-pins to Claude Opus 4.8, Pantheon's deepest tier, and that pin can't be downgraded by the request itself. Plain-text `/grok-review` requests don't carry this scan; it's specific to structured handoffs.
