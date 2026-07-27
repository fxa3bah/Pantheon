// bridge-guard.mjs
// Safety layer for Pantheon.
//
// Three concerns, shared by both companions:
//   1. Loop guard  — a hop counter that stops runaway Claude→Grok→Claude→… recursion.
//   2. Write gate  — the reverse (Grok→Claude) leg must not silently run Claude with
//                    permissions bypassed unless the operator explicitly opts in.
//   3. Timeout     — no headless child may hang forever.
//
// All functions are pure / return new values — process.env is never mutated.

/** Parse a positive-number env var, falling back when missing/NaN/<=0. */
function posNum(raw, fallback) {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

// NaN/garbage must never silently disable the guard or zero the timeout.
export const MAX_HOPS = posNum(process.env.GROK_BRIDGE_MAX_HOPS, 2);
export const DEFAULT_TIMEOUT_MS = posNum(process.env.GROK_BRIDGE_TIMEOUT_MS, 5 * 60 * 1000);
// Grace period after SIGTERM before escalating to SIGKILL, for a child that
// ignores the polite signal (stuck in uninterruptible work / signal-swallowing).
export const SIGKILL_GRACE_MS = posNum(process.env.GROK_BRIDGE_SIGKILL_GRACE_MS, 5000);

/** Current bridge depth (0 when invoked directly by a human). */
export function currentHop() {
  const h = Number(process.env.BRIDGE_HOP || 0);
  return Number.isFinite(h) && h >= 0 ? Math.floor(h) : 0;
}

/**
 * Throw if we've already crossed the bridge too many times.
 * `direction` is a human phrase for the error, e.g. "hand off to Grok".
 */
export function assertHopAllowed(direction) {
  const hop = currentHop();
  if (hop >= MAX_HOPS) {
    throw new Error(
      `[bridge] Loop guard tripped: BRIDGE_HOP=${hop} >= MAX_HOPS=${MAX_HOPS}. ` +
      `Refusing to ${direction} again to prevent runaway cross-delegation. ` +
      `Override with GROK_BRIDGE_MAX_HOPS=<n> if this is intentional.`
    );
  }
  return hop;
}

/**
 * Env for a spawned child agent, with the hop counter incremented.
 * BRIDGE_HOP is applied AFTER `extra` on purpose: spreading `extra` last let a
 * caller pass `{ BRIDGE_HOP: '0' }` and silently reset the loop guard, which is
 * the one value in this env that must never be caller-controlled.
 */
export function childEnv(extra = {}) {
  return { ...process.env, ...extra, BRIDGE_HOP: String(currentHop() + 1) };
}

// ---- Write gate (reverse leg: Grok → Claude) -------------------------------

export const writesAllowed = () => process.env.GROK_BRIDGE_ALLOW_WRITES === '1';

// Flags that hand Claude autonomous, prompt-free write/exec power.
const DANGEROUS_FLAGS = new Set([
  '--dangerously-skip-permissions',
  '--dangerously-bypass-approvals-and-sandbox',
]);
// Flags that reintroduce capability *around* the --allowedTools pin instead of
// through it: a settings file or MCP/plugin/agent definition can register Bash,
// Edit or an arbitrary MCP server, and --add-dir widens the readable filesystem.
// Pinning Read,Glob,Grep is meaningless if the caller can also hand Claude a
// config that adds tools back. Each takes a value, so the value token is
// consumed too (see CONFIG_FLAGS handling below).
const CONFIG_FLAGS = new Set([
  '--settings',
  '--mcp-config',
  '--plugin-dir',
  '--agents',
  '--add-dir',
]);
// Only these permission modes are safe for a non-human (Grok) delegator. Allowlist,
// not denylist — anything unknown/future is rejected by default.
const SAFE_PERMISSION_MODES = new Set(['default', 'plan']);

/**
 * Split a token into {name, value} handling both `--flag value` / `--flag=value`
 * and the single-dash short-flag equivalents (`-f value` / `-f=value`) that
 * Codex's CLI uses (`-s`, `-a`, `-m`, ...). Without the single-dash case, a
 * short `=`-joined flag like `-s=danger-full-access` would fail name matching
 * entirely and slip through a gate meant to strip it.
 */
function splitFlag(tok) {
  if (typeof tok === 'string' && tok.startsWith('-')) {
    const eq = tok.indexOf('=');
    if (eq !== -1) return { name: tok.slice(0, eq), value: tok.slice(eq + 1), joined: true };
    return { name: tok, value: undefined, joined: false };
  }
  return { name: tok, value: undefined, joined: false };
}

/**
 * Filter caller-supplied Claude CLI flags. Unless GROK_BRIDGE_ALLOW_WRITES=1,
 * strip anything that would let Grok drive Claude with writes/exec and pin a
 * read-only tool set. Returns { args, gated, notes } — never mutates input.
 *
 * Hardened: matches dangerous flags by NAME regardless of `=`-joined vs spaced
 * form, drops caller --allowedTools in both forms, and permits --permission-mode
 * only for an explicit safe allowlist. (Fixes the bypass where
 * `--permission-mode=bypassPermissions` was a single token that escaped matching.)
 */
export function sanitizeClaudeArgs(extraArgs = [], { pinnedModel = null } = {}) {
  if (writesAllowed()) {
    return { args: [...extraArgs], gated: false, notes: ['writes ALLOWED (GROK_BRIDGE_ALLOW_WRITES=1)'] };
  }

  const out = [];
  const notes = [];
  for (let i = 0; i < extraArgs.length; i++) {
    const { name, value, joined } = splitFlag(extraArgs[i]);

    if (DANGEROUS_FLAGS.has(name)) {
      notes.push(`stripped ${name}`);
      continue;
    }

    if (CONFIG_FLAGS.has(name)) {
      if (!joined) i++; // drop the value token too
      notes.push(`stripped ${name} (would re-add tools past the read-only pin)`);
      continue;
    }

    // The router force-pins security-review to Opus so an untrusted delegator
    // can't downgrade it, but the companion lets a caller --model win over
    // routed.args — which put the bypass one layer below the pin. Strip it.
    if (pinnedModel && (name === '--model' || name === '-m')) {
      if (!joined) i++;
      notes.push(`stripped caller ${name} (security-review is pinned to ${pinnedModel})`);
      continue;
    }

    if (name === '--permission-mode') {
      let mode = value;
      if (!joined) { mode = extraArgs[i + 1]; i++; } // consume the value token either way
      if (!SAFE_PERMISSION_MODES.has(mode)) {
        notes.push(`stripped --permission-mode ${mode}`);
        continue;
      }
      out.push('--permission-mode', mode);
      continue;
    }

    if (name === '--allowedTools' || name === '--allowed-tools') {
      if (!joined) i++; // also drop the separate value token
      notes.push(`stripped caller ${name} (read-only enforced)`);
      continue;
    }

    out.push(extraArgs[i]);
  }
  // Pin a read-only tool set so a delegated task can inspect but not change the machine.
  out.unshift('--allowedTools', 'Read,Glob,Grep');
  notes.push('enforced read-only --allowedTools Read,Glob,Grep (set GROK_BRIDGE_ALLOW_WRITES=1 to allow writes)');
  return { args: out, gated: true, notes };
}

// ---- Write gate (Codex leg: Claude/Grok → Codex) ---------------------------

// Flags that hand Codex autonomous, sandbox-free execution power.
const CODEX_DANGEROUS_FLAGS = new Set([
  '--dangerously-bypass-approvals-and-sandbox',
  '--full-auto',
  '--yolo',
]);
// Flags that widen scope around the `--sandbox read-only` pin rather than
// through it. Each takes a value, so its value token is consumed on strip.
const CODEX_SCOPE_FLAGS = new Set([
  '--add-dir',
  '--enable',
  '--disable',
]);

/** True if `tok` is either form of the sandbox flag (`-s` or `--sandbox`). */
function isSandboxFlag(name) {
  return name === '--sandbox' || name === '-s';
}

// `-c/--config` lets a caller override arbitrary `~/.codex/config.toml`
// values (e.g. `-c sandbox_mode="danger-full-access"`,
// `-c approval_policy="never"`, `-c shell_environment_policy.inherit="all"`
// for secret exfil via env). `--profile/-p` layers a whole config profile on
// top, which can smuggle the same overrides indirectly. Both are pure
// config-escape vectors for a read-only-gated delegator and must be stripped
// wholesale in the gated path — the companion re-adds its own trusted
// `-c model_reasoning_effort=…` from the router AFTER this function runs, so
// stripping every caller `-c` here cannot lose legitimate routing info.
function isConfigOverrideFlag(name) {
  return name === '-c' || name === '--config';
}
function isProfileFlag(name) {
  return name === '--profile' || name === '-p';
}

/**
 * Filter caller-supplied Codex CLI flags. Unless GROK_BRIDGE_ALLOW_WRITES=1,
 * strip anything that would let a delegator drive `codex exec` with
 * unsandboxed writes/exec — including indirect config-override escapes via
 * `-c`/`--config` and `--profile`/`-p` — and pin `--sandbox read-only`.
 * Returns { args, gated, notes } — never mutates input. Uses the same
 * `splitFlag` `=`-joined-vs-spaced robustness as sanitizeClaudeArgs.
 *
 * In the writes-allowed path, `-c`/`--profile` are left intact (the operator
 * explicitly opted in via GROK_BRIDGE_ALLOW_WRITES=1); only the sandbox
 * normalization applies there.
 */
export function sanitizeCodexArgs(extraArgs = [], { pinnedModel = null } = {}) {
  if (writesAllowed()) {
    const out = [...extraArgs];
    const notes = ['writes ALLOWED (GROK_BRIDGE_ALLOW_WRITES=1)'];
    if (!out.some(tok => isSandboxFlag(splitFlag(tok).name))) {
      out.push('--sandbox', 'workspace-write');
      notes.push('normalized --sandbox workspace-write (no explicit --sandbox supplied)');
    }
    return { args: out, gated: false, notes };
  }

  const out = [];
  const notes = [];
  for (let i = 0; i < extraArgs.length; i++) {
    const { name, value, joined } = splitFlag(extraArgs[i]);

    if (CODEX_DANGEROUS_FLAGS.has(name)) {
      notes.push(`stripped ${name}`);
      continue;
    }

    // Same class as the claude gate's CONFIG_FLAGS: --add-dir widens the
    // read-only sandbox's reachable filesystem, and --enable/--disable toggle
    // feature/tool sets out from under the pin.
    if (CODEX_SCOPE_FLAGS.has(name)) {
      if (!joined) i++;
      notes.push(`stripped ${name} (widens the read-only sandbox)`);
      continue;
    }

    if (pinnedModel && (name === '-m' || name === '--model')) {
      if (!joined) i++;
      notes.push(`stripped caller ${name} (security-review is pinned to ${pinnedModel})`);
      continue;
    }

    if (isSandboxFlag(name)) {
      const stripped = joined ? value : extraArgs[i + 1];
      if (!joined) i++; // consume the value token either way
      notes.push(`stripped caller ${name}${stripped ? ` ${stripped}` : ''}`);
      continue;
    }

    if (name === '--ask-for-approval' || name === '-a') {
      const stripped = joined ? value : extraArgs[i + 1];
      if (!joined) i++; // also drop the separate value token
      notes.push(`stripped caller ${name}${stripped ? ` ${stripped}` : ''}`);
      continue;
    }

    if (isConfigOverrideFlag(name) || isProfileFlag(name)) {
      const stripped = joined ? value : extraArgs[i + 1];
      if (!joined) i++; // consume the value token either way
      notes.push(`stripped caller ${name}${stripped ? ` ${stripped}` : ''} (config-override gate)`);
      continue;
    }

    out.push(extraArgs[i]);
  }
  // Pin read-only so a delegated task can inspect but not change the machine.
  out.push('--sandbox', 'read-only');
  notes.push('enforced --sandbox read-only (set GROK_BRIDGE_ALLOW_WRITES=1 to allow writes)');
  return { args: out, gated: true, notes };
}

// ---- Write gate (forward leg: Claude/Codex → Grok) -------------------------

// Grok was the one unsandboxed leg in the mesh: runGrokHeadless hardcoded
// `--always-approve` and never sanitized caller flags, so any hop into Grok had
// full write/exec on the host while the Claude and Codex legs were pinned
// read-only. Closing that took finding a mechanism that actually works —
// verified against grok CLI 0.2.112 on 2026-07-27:
//   --permission-mode plan  → does NOT block writes (the model still wrote a file)
//   --deny / --disallowed-tools → silently ignored, write still succeeded
//   --tools <allowlist>     → WORKS ("No write/shell tool available in this session")
// So the gate is an allowlist, exactly like claude's --allowedTools pin.
const GROK_READONLY_TOOLS = 'read_file,list_dir,grep';

// Caller flags that would undo the pin: re-widen the tool set, auto-approve
// execution, swap the sandbox, or replace the system prompt/agents wholesale.
const GROK_STRIPPED_FLAGS = new Set([
  '--tools',
  '--allow', '--allowedTools',
  '--deny', '--disallowed-tools',
  '--permission-mode',
  '--sandbox',
  '--system-prompt-override', '--system-prompt',
  '--agents', '--agent',
  '--rules',
]);
const GROK_STRIPPED_BOOLEANS = new Set(['--always-approve']);

/**
 * Filter caller-supplied Grok CLI flags and decide whether this hop may execute
 * tools. Media generation (`/grok-imagine`, `assets`) genuinely needs to run
 * image tools and write files, so it keeps `--always-approve`; every analysis
 * lane (task, review, health) is pinned to a read-only tool allowlist.
 * Returns { args, gated, notes } — never mutates input.
 */
export function sanitizeGrokArgs(extraArgs = [], { needsMedia = false } = {}) {
  if (writesAllowed()) {
    return {
      args: [...extraArgs, '--always-approve'],
      gated: false,
      notes: ['writes ALLOWED (GROK_BRIDGE_ALLOW_WRITES=1)']
    };
  }

  const out = [];
  const notes = [];
  for (let i = 0; i < extraArgs.length; i++) {
    const { name, value, joined } = splitFlag(extraArgs[i]);

    if (GROK_STRIPPED_BOOLEANS.has(name)) {
      notes.push(`stripped ${name}`);
      continue;
    }
    if (GROK_STRIPPED_FLAGS.has(name)) {
      const stripped = joined ? value : extraArgs[i + 1];
      if (!joined) i++; // consume the value token too
      notes.push(`stripped caller ${name}${stripped ? ` ${stripped}` : ''}`);
      continue;
    }
    out.push(extraArgs[i]);
  }

  if (needsMedia) {
    // Image/video generation cannot run under a read-only tool set. This lane
    // is still gated in the sense that caller flags were stripped above, but it
    // does execute tools — that is the whole point of /grok-imagine.
    out.push('--always-approve');
    notes.push('media lane: tool execution allowed (image/video generation)');
    return { args: out, gated: false, notes };
  }

  out.push('--tools', GROK_READONLY_TOOLS);
  notes.push(`enforced read-only --tools ${GROK_READONLY_TOOLS} (set GROK_BRIDGE_ALLOW_WRITES=1 to allow writes)`);
  return { args: out, gated: true, notes };
}

// ---- Timeout ---------------------------------------------------------------

/**
 * Signal a child and, when it was spawned detached, its whole process group.
 * All three agent CLIs spawn subagents and shell commands of their own; killing
 * only the direct PID left those grandchildren running after a bridge timeout,
 * still holding the model session and the CPU. `-pid` targets the group.
 */
function killTree(child, signal) {
  try { process.kill(-child.pid, signal); return; } catch {}
  try { child.kill(signal); } catch {}
}

/**
 * Arm a kill-timer on a spawned child. On expiry, terminate the child's process
 * group and call onTimeout(err) exactly once. Auto-clears on close/error.
 *
 * `onTimeout` is usually a promise `reject`, and the child's own `close`
 * handler settles the same promise. A settled promise ignores later calls, so
 * the double-settle was benign — but it also meant a timed-out job could be
 * reported by whichever path ran second. `fired` makes the timeout the single
 * authority once it triggers, and `onTimedOut` lets the caller mark the ledger
 * and stop its heartbeat from the timeout path too.
 */
export function armTimeout(child, onTimeout, ms = DEFAULT_TIMEOUT_MS, { onTimedOut = null } = {}) {
  let killTimer = null;
  let fired = false;
  const timer = setTimeout(() => {
    fired = true;
    killTree(child, 'SIGTERM');
    // Escalate: if the group hasn't exited SIGKILL_GRACE_MS after SIGTERM,
    // force-kill so a signal-ignoring child can't hang the bridge past its
    // timeout. unref() so this timer never keeps the event loop alive alone.
    killTimer = setTimeout(() => killTree(child, 'SIGKILL'), SIGKILL_GRACE_MS);
    if (killTimer.unref) killTimer.unref();
    try { onTimedOut?.(); } catch {}
    onTimeout(new Error(`[bridge] child timed out after ${ms}ms (override GROK_BRIDGE_TIMEOUT_MS).`));
  }, ms);
  // Detaching the child (required for group-kill) means it no longer receives
  // the terminal's SIGINT, so a parent that dies would orphan a running agent.
  // Reap the group on parent exit to keep that from happening.
  const reap = () => killTree(child, 'SIGTERM');
  process.once('exit', reap);

  const clear = () => {
    clearTimeout(timer);
    if (killTimer) clearTimeout(killTimer);
    process.removeListener('exit', reap);
  };
  child.on('close', clear);
  child.on('error', clear);
  return { timer, clear, timedOut: () => fired };
}

/**
 * Spawn options every companion uses for its agent child. `detached` puts the
 * child in its own process group so armTimeout can kill the agent AND the
 * subagents/shells it spawned, instead of just the direct PID.
 */
export const GUARDED_SPAWN_OPTS = Object.freeze({ stdio: ['ignore', 'pipe', 'pipe'], detached: true });

// ---- Progress heartbeat ----------------------------------------------------

/**
 * Print an elapsed-time heartbeat to stderr every `everyMs` so a foreground
 * hand-off doesn't look hung. Returns a stop() fn. stderr is used so it never
 * pollutes the parsed stdout the bridge returns. Disable with GROK_BRIDGE_QUIET=1.
 */
export function startHeartbeat(label, everyMs = 15000) {
  if (process.env.GROK_BRIDGE_QUIET === '1') return () => {};
  let elapsed = 0;
  const timer = setInterval(() => {
    elapsed += everyMs;
    process.stderr.write(`[bridge] ${label} — still working (${Math.round(elapsed / 1000)}s)…\n`);
  }, everyMs);
  if (typeof timer.unref === 'function') timer.unref();
  return () => clearInterval(timer);
}
