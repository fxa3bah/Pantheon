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

/** Env for a spawned child agent, with the hop counter incremented. */
export function childEnv(extra = {}) {
  return { ...process.env, BRIDGE_HOP: String(currentHop() + 1), ...extra };
}

// ---- Write gate (reverse leg: Grok → Claude) -------------------------------

export const writesAllowed = () => process.env.GROK_BRIDGE_ALLOW_WRITES === '1';

// Flags that hand Claude autonomous, prompt-free write/exec power.
const DANGEROUS_FLAGS = new Set([
  '--dangerously-skip-permissions',
  '--dangerously-bypass-approvals-and-sandbox',
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
export function sanitizeClaudeArgs(extraArgs = []) {
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
export function sanitizeCodexArgs(extraArgs = []) {
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

// ---- Timeout ---------------------------------------------------------------

/**
 * Arm a kill-timer on a spawned child. On expiry, SIGTERM the child and call
 * onTimeout(err). Auto-clears on close/error. Returns the timer handle.
 */
export function armTimeout(child, onTimeout, ms = DEFAULT_TIMEOUT_MS) {
  const timer = setTimeout(() => {
    try { child.kill('SIGTERM'); } catch {}
    onTimeout(new Error(`[bridge] child timed out after ${ms}ms (override GROK_BRIDGE_TIMEOUT_MS).`));
  }, ms);
  const clear = () => clearTimeout(timer);
  child.on('close', clear);
  child.on('error', clear);
  return timer;
}

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
