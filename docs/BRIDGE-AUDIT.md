# grok-plugin-cc — Bridge Audit & Fix Spec

Audited 2026-06-07 on the live machine (grok 0.2.22, claude at `~/.local/bin/claude`, node v24).
This is a punch-list for Grok to implement. Each item: **current behavior → desired behavior → fix location**.

---

## 0. Status summary

| Leg | State |
|-----|-------|
| Claude → Grok (`/grok-imagine`, `/grok-review`) | ✅ Installed & verified working (generated a real 1248×832 image). |
| Grok → Claude (`claude-delegate` skill, `claude-second-opinion` agent) | ❌ **Files exist in repo but NOT installed into `~/.grok/`.** Reverse leg is dead until deployed. |

---

## 1. Bugs (must-fix)

### 1.1 `require()` used inside ESM modules — dead code path
- **Where:** `plugins/grok/scripts/grok-companion.mjs` → `spawnSyncSafe()`; `plugins/grok/scripts/claude-companion.mjs` → `resolveClaudeBinary()`.
- **Problem:** Both call `require('node:child_process')` / `require('child_process')`. These files are ESM (`.mjs`, `import` syntax). `require` is **not defined** in ESM → throws every time. It's wrapped in try/catch, so the PATH-resolution step silently always fails and falls through to hardcoded fallbacks.
- **Verified:** `node --input-type=module -e "require('child_process')"` → `require is not defined`.
- **Fix:** Add a top-level `import { spawnSync } from 'node:child_process';` and use it directly. Remove the `require` shim entirely.

### 1.2 Reverse leg can't find the real `claude` binary
- **Where:** `claude-companion.mjs` → `resolveClaudeBinary()` candidate list.
- **Problem:** Because of 1.1, PATH detection never runs. The fallback candidate list is `~/.claude/bin/claude`, `/usr/local/bin/claude`, `/opt/homebrew/bin/claude`, then bare `'claude'`. The **actual** binary on this machine is `~/.local/bin/claude` — not in the list. It only works by luck if `~/.local/bin` is on `spawn`'s inherited PATH.
- **Fix:** After fixing 1.1, real `which claude` works. Also add `~/.local/bin/claude` to the candidate list as a belt-and-suspenders fallback. Note: there is a shell **function** named `claude` (model-alias wrapper) — `spawn` execs the binary directly so the function is correctly bypassed; no action needed there.

### 1.3 `--yolo` is undocumented in grok 0.2.22
- **Where:** `grok-companion.mjs` → `runGrokHeadless()` args.
- **Problem:** `--yolo` is not in `grok --help` (the documented flag is `--always-approve`). It currently works as an undocumented alias, but it's a version-fragility landmine.
- **Fix:** Switch to `--always-approve`. Keep `--output-format json --cwd <dir>`.

### 1.4 Raw JSON (incl. full chain-of-thought) dumped to the user
- **Where:** `cmdImagine`/`cmdReview`/`cmdTask` do `console.log(stdout)` where stdout is the full grok JSON object.
- **Problem:** The user sees `{ "text": ..., "thought": "<entire reasoning trace>", "sessionId": ... }`. The `thought` field leaks the whole CoT and buries the actual answer. (Confirmed in the demo run.)
- **Fix:** `JSON.parse(stdout)`, print **only** `parsed.text` (fallback to raw if parse fails). Append normalized media paths/links (see §2). Store the full JSON in `.grok-bridge/<job>.json` for `/grok:result --json`.

### 1.5 `/grok:cancel` is a no-op
- **Where:** `cmdCancel`.
- **Problem:** Prints a note, never kills anything. No child PID tracking.
- **Fix:** Track child PID in the job file on spawn; `cancel` sends SIGTERM to it. Low priority but currently misleading.

### 1.6 No timeout on headless children
- **Where:** both `runGrokHeadless` / `runClaudeHeadless`.
- **Problem:** A hung grok/claude process blocks forever.
- **Fix:** Add a configurable timeout (e.g. `GROK_BRIDGE_TIMEOUT_MS`, default ~5 min for stills, higher for video) that kills the child and rejects.

---

## 2. Image storage (your Q2: "store where I can easily view / clickable inline")

### Current behavior (broken vs. promise)
- README claims media is normalized to `./grok-media/<job>/...`. **The code never creates that folder.** Grok is just told "materialize in the current workspace," so it copies to **cwd root** with a Grok-chosen filename (e.g. `dramatic-low-angle-linen-napkin.jpg`).
- `findRecentMedia()` then scans cwd for files modified in the last **30 seconds** and prints **relative** paths.

### Problems
1. **Clutters cwd / repo root.** Running from inside a real project dumps images at the top level.
2. **30s window is fragile** — video generation can exceed it (missed), and unrelated recent media gets swept in (false positives).
3. **Relative paths aren't clickable** and aren't where you'd "easily view" them.
4. **Filename collisions** — no job scoping; a second run with a similar prompt can overwrite.

### Desired behavior — pick one storage policy and make it real
**Recommended:** a single, predictable, viewable gallery folder + clickable absolute links.

- Save every artifact to a **dedicated dir**, default `~/Pictures/grok-imagine/<YYYY-MM-DD>/<job-id>/` (override via `GROK_BRIDGE_MEDIA_DIR`). This is Finder/Quick-Look friendly and outside any repo.
  - Rationale for Fahd's setup: `~/Pictures/` is instantly viewable in Finder/Photos; never pollutes OneDrive/work repos. (If you'd rather keep assets next to the project, make it `./.grok-media/<job-id>/` — but default to `~/Pictures`.)
- **Don't rely on a time-window scan.** Have the companion parse the explicit image path grok reports (grok writes to `~/.grok/sessions/<enc-cwd>/<session>/images/N.jpg` — visible in the JSON/thought), then **copy** it into the gallery dir with a deterministic name `<job-id>-<n>.<ext>`. Return that path. (Better: instruct grok in the prompt to print a machine-parseable `BRIDGE_MEDIA: <abspath>` line per asset, then the companion copies those exact files — no guessing.)
- **Print clickable output.** For each asset emit:
  - an absolute `file://` URI (clickable in Claude Code's terminal and most modern terminals), and
  - a ready markdown embed `![alt](file:///abs/path.jpg)`.
- **Optional convenience:** `--open` flag → `open <file>` (macOS Quick Look / Preview) after generation. Off by default.

### Net result for you
After `/grok-imagine ...` you get: a one-line clickable `file://` link + a markdown embed, and the file lives in a dated gallery you can browse in Finder — no repo clutter, nothing to hunt for.

---

## 3. Two-way completeness (your Q3: "Grok reaches back to me too?")

### Current state: only half-wired
- The Claude→Grok half is a real installed plugin (`grok@grok-plugin-cc`).
- The Grok→Claude half is **just files in the repo**. `~/.grok/skills/` has no `claude-delegate`; `~/.grok/agents/` has no `claude-second-opinion`. Nothing invokes `claude-companion.mjs`.

### To make it genuinely two-way
1. **Install the Grok side.** Either:
   - `grok plugin install /Users/faadi/Code/grok-plugin-cc --trust` (if grok's plugin system reads `skills/` + `agents/` at repo root), **or**
   - symlink/copy `skills/claude-delegate/` → `~/.grok/skills/claude-delegate/` and `agents/claude-second-opinion.md` → `~/.grok/agents/claude-second-opinion.md`.
   - Verify with: a grok session can list `claude-delegate` as a skill.
2. **Fix the path in the skill.** `claude-delegate/SKILL.md` references the companion as "in the bridge repo" without an absolute path. After install, `~/.grok/skills/claude-delegate/` won't contain `claude-companion.mjs` (that lives in `plugins/grok/scripts/`). Either copy the script alongside the skill or hardcode/env the absolute path `/Users/faadi/Code/grok-plugin-cc/plugins/grok/scripts/claude-companion.mjs`.
3. **Smoke test the reverse leg** end-to-end: from grok, "ask Claude Code to summarize X" → confirm `.grok-bridge/claude-*.json` is written and Claude's text comes back.

### Loop-guard (important for a symmetric bridge)
A two-way bridge can ping-pong: Claude→Grok→Claude→… Add a **hop counter** in the spawned child's env (e.g. `BRIDGE_HOP=1`, incremented each cross), and refuse to delegate when `BRIDGE_HOP >= 2`. Without this, a bad prompt can cause runaway recursion (each hop = a full paid agent run).

---

## 4. Security / safety

- **`claude-companion` forwards arbitrary `--` flags from Grok**, including `--permission-mode bypassPermissions` / `--dangerously-skip-permissions`. That lets Grok drive Claude with **no permission prompts** (autonomous edits + Bash) on this machine. Gate this: default to read-only/`--allowedTools "Read,Glob,Grep"` unless an explicit, separate opt-in env (`GROK_BRIDGE_ALLOW_WRITES=1`) is set.
- **Shell quoting / injection:** commands run `node ... imagine "$ARGUMENTS"`. A request containing `"`, backticks, or `$()` can break the quoting or inject shell. Harden by passing the prompt via stdin or a temp file (`--prompt-file`) instead of interpolating into the command line.
- **No secrets** in either direction — good. Keep it that way (both legs are OAuth-only; don't add API-key paths).

---

## 5. Optimization recommendations

1. **Stream progress.** Both legs block silently for 30–120s. Use `--output-format streaming-json` and surface incremental status (or at least a spinner/"grok is generating…") so a hand-off doesn't look hung.
2. **Single dedicated media dir + manifest.** Maintain `~/Pictures/grok-imagine/index.json` (job id, prompt, paths, ts) so `/grok:status` and a future gallery can list everything without rescanning disk.
3. **Skip the second-LLM tax on trivial routing.** The `grok-delegate` subagent + the command both wrap the same call; for the common path, let the slash command shell the script directly (it already does) and reserve the subagent for proactive auto-delegation only.
4. **Reuse sessions for iteration.** `image_edit`/"make the previous one more dramatic" should pass grok's `--continue`/session id (the JSON returns `sessionId`) so references and context persist instead of starting cold each time. Wire `/grok-imagine --continue`.
5. **Unify the job ledger.** Both directions already write to `.grok-bridge/` — good. Standardize one schema (`id, direction, type, prompt, media[], session_id, cost, hop, ts, status`) and have `state.mjs` be the single writer for both companions (currently `grok-companion` has its own inline `saveJob` and ignores `lib/state.mjs`).
6. **Surface cost.** grok/claude JSON returns cost/usage — store and optionally print it; useful given your Haiku-only/cost-control posture.
7. **Make paths absolute everywhere.** `--cwd process.cwd()` + relative media reporting breaks when the user is in a different dir than where files land. Always report absolute paths.

---

## 6. Prioritized punch-list for Grok

1. **(P0)** Fix ESM `require` bug in both companions (§1.1) + add `~/.local/bin/claude` fallback (§1.2).
2. **(P0)** Install + smoke-test the Grok→Claude leg so the bridge is actually two-way (§3.1–3.3).
3. **(P0)** Image storage redesign: dedicated `~/Pictures/grok-imagine/<date>/<job>/`, copy by explicit path not time-window, print `file://` + markdown embed (§2).
4. **(P1)** Print parsed `.text` only, not raw JSON + CoT (§1.4).
5. **(P1)** Loop-guard hop counter (§3) + gate `bypassPermissions` behind opt-in env (§4).
6. **(P1)** Switch `--yolo` → `--always-approve` (§1.3); add child timeout (§1.6).
7. **(P2)** Streaming progress, session reuse for edits, unified ledger via `state.mjs`, cost surfacing, real cancel (§5, §1.5).

> Note: README also overstates current behavior (`grok-media/<job>/`, "normalized media folder"). Update README to match whatever storage policy is implemented.
