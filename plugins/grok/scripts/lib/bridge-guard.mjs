// bridge-guard.mjs
// Safety layer for the symmetric grok-plugin-cc bridge.
//
// Three concerns, shared by both companions:
//   1. Loop guard  — a hop counter that stops runaway Claude→Grok→Claude→… recursion.
//   2. Write gate  — the reverse (Grok→Claude) leg must not silently run Claude with
//                    permissions bypassed unless the operator explicitly opts in.
//   3. Timeout     — no headless child may hang forever.
//
// All functions are pure / return new values — process.env is never mutated.

export const MAX_HOPS = Number(process.env.GROK_BRIDGE_MAX_HOPS || 2);
export const DEFAULT_TIMEOUT_MS = Number(process.env.GROK_BRIDGE_TIMEOUT_MS || 5 * 60 * 1000);

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

const writesAllowed = () => process.env.GROK_BRIDGE_ALLOW_WRITES === '1';

// Flags that hand Claude autonomous, prompt-free write/exec power.
const DANGEROUS_FLAGS = new Set([
  '--dangerously-skip-permissions',
  '--dangerously-bypass-approvals-and-sandbox',
]);
const UNSAFE_PERMISSION_MODES = new Set(['bypassPermissions', 'acceptEdits']);

/**
 * Filter caller-supplied Claude CLI flags. Unless GROK_BRIDGE_ALLOW_WRITES=1,
 * strip anything that would let Grok drive Claude with writes/exec and pin a
 * read-only tool set. Returns { args, gated, notes } — never mutates input.
 */
export function sanitizeClaudeArgs(extraArgs = []) {
  if (writesAllowed()) {
    return { args: [...extraArgs], gated: false, notes: ['writes ALLOWED (GROK_BRIDGE_ALLOW_WRITES=1)'] };
  }

  const out = [];
  const notes = [];
  for (let i = 0; i < extraArgs.length; i++) {
    const a = extraArgs[i];
    if (DANGEROUS_FLAGS.has(a)) {
      notes.push(`stripped ${a}`);
      continue;
    }
    if (a === '--permission-mode' && UNSAFE_PERMISSION_MODES.has(extraArgs[i + 1])) {
      notes.push(`stripped --permission-mode ${extraArgs[i + 1]}`);
      i++; // skip its value
      continue;
    }
    if (a === '--allowedTools' || a === '--allowed-tools') {
      notes.push(`stripped caller ${a} (read-only enforced)`);
      i++; // drop caller's tool grant; we enforce our own below
      continue;
    }
    out.push(a);
  }
  // Pin a read-only tool set so a delegated task can inspect but not change the machine.
  out.unshift('--allowedTools', 'Read,Glob,Grep');
  notes.push('enforced read-only --allowedTools Read,Glob,Grep (set GROK_BRIDGE_ALLOW_WRITES=1 to allow writes)');
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
