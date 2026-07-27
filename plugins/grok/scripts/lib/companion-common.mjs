// Shared companion helpers — the pieces that were copy-pasted across
// grok-/claude-/codex-companion. Pure functions plus the single ledger-writer
// wrapper. Extracting them here keeps the three companions from drifting.
//
// NOT here (deliberately): each companion's binary resolver. Those carry
// agent-specific fallback lists and are part of each companion's public API, so
// they stay local. Only genuinely identical logic lives in this module.
import { upsertJob } from './state.mjs';

// Job id: `<prefix>-<base36 time>-<base36 rand>`. Prefix is the only thing that
// differed between companions (grok- / claude- / codex-), so it's a parameter.
export function makeJobId(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

// Split a raw argument STRING (a single shell-ish token blob) into argv,
// honoring single/double quotes. Used when a caller passes one big string
// instead of a pre-split argv array.
export function splitRawArgumentString(raw) {
  return String(raw || '').match(/"([^"\\]|\\.)*"|'([^'\\]|\\.)*'|\S+/g)?.map(part => {
    if ((part.startsWith('"') && part.endsWith('"')) || (part.startsWith("'") && part.endsWith("'"))) {
      return part.slice(1, -1);
    }
    return part;
  }) || [];
}

// If argv arrived as a single whitespace-bearing string, re-split it; otherwise
// pass the array through untouched.
export function normalizeArgv(args) {
  if (args.length === 1 && /\s/.test(args[0])) return splitRawArgumentString(args[0]);
  return args;
}

const flagName = (tok) => (tok.includes('=') ? tok.slice(0, tok.indexOf('=')) : tok);

// Try to read tokens[start..] as nothing but a run of recognized flags (and
// their values). Returns the parsed flag list, or null if anything in the range
// isn't a known flag or its value.
function parseFlagRun(tokens, start, valueFlags, knownFlags, flagPrefix) {
  const out = [];
  for (let i = start; i < tokens.length; i++) {
    const tok = tokens[i];
    if (!tok.startsWith(flagPrefix)) return null;
    const name = flagName(tok);
    if (!knownFlags.has(name)) return null;
    out.push(tok);
    if (!tok.includes('=') && valueFlags.has(name)) {
      if (tokens[i + 1] == null) return null;
      out.push(tokens[++i]);
    }
  }
  return out;
}

// Separate the free-text request from pass-through flags.
//
// SECURITY: a delegated prompt is untrusted text from another agent, and
// normalizeArgv() word-splits it. The old rule — "any token starting with the
// flag prefix is a flag" — meant prose could smuggle real flags into the child
// CLI: a prompt merely *mentioning* `--add-dir /Users/faadi` had those tokens
// silently removed from the request and appended to the spawn argv. The write
// gates only strip a short denylist, so anything else (`--model`, `--add-dir`,
// `--mcp-config`, `--settings`, …) got through. It also corrupted honest
// prompts — asking Claude about `--best-of-n` made the child exit on an
// unknown option.
//
// Two rules now bound extraction, and a token must satisfy both:
//  1. ALLOWLIST — the flag name must be in `knownFlags`. Unrecognized
//     dash-tokens stay in the request as ordinary words.
//  2. TRAILING RUN — flags are only honored as an unbroken run at the END of
//     argv, which is how a real invocation looks (`"<prompt>" --model X`).
//     A known flag name buried mid-prose stays prose.
//
// Per-agent parameters:
//  - `valueFlags`: flags that consume the following token as a value.
//  - `flagPrefix`: what marks a flag. Claude's CLI uses long flags only ('--'),
//    so a bare '-x' stays in the request; Codex uses short flags too ('-m','-C'),
//    so it passes '-'. Defaulting to '--' preserves the stricter (claude) behavior.
//  - `knownFlags`: every flag name the agent accepts, value-taking or boolean.
//    Defaults to `valueFlags` — the safe subset — so a caller that forgets to
//    pass it under-recognizes rather than letting prose through as argv.
export function splitRequestAndExtra(args, valueFlags, flagPrefix = '--', knownFlags = valueFlags) {
  const tokens = normalizeArgv(args);
  // Smallest start index whose suffix parses as flags-only == longest flag tail.
  for (let start = 0; start < tokens.length; start++) {
    if (!tokens[start].startsWith(flagPrefix)) continue;
    const extra = parseFlagRun(tokens, start, valueFlags, knownFlags, flagPrefix);
    if (extra) return { request: tokens.slice(0, start).join(' ').trim(), extra };
  }
  return { request: tokens.join(' ').trim(), extra: [] };
}

// Flags the COMPANION consumes itself. They are never forwarded to the child
// CLI — `--lane` and `--from` exist so a caller can say what kind of work this
// is without hand-building a JSON packet. The slash commands used to embed a
// full `{"pantheon_packet":true,…}` blob with a JSON-escaped objective inline,
// which is both unreadable and one bad quote away from a malformed packet.
const COMPANION_FLAGS = new Set(['--lane', '--from']);

export const COMPANION_FLAG_NAMES = COMPANION_FLAGS;

/**
 * Pull companion-level flags out of the pass-through arg list.
 * Returns { lane, from, rest } — `rest` is what the CLI write gate then sees.
 */
export function extractCompanionFlags(extra = []) {
  const rest = [];
  let lane = null;
  let from = null;
  for (let i = 0; i < extra.length; i++) {
    const tok = extra[i];
    const eq = tok.indexOf('=');
    const name = eq === -1 ? tok : tok.slice(0, eq);
    if (!COMPANION_FLAGS.has(name)) { rest.push(tok); continue; }
    const value = eq === -1 ? extra[++i] : tok.slice(eq + 1);
    if (name === '--lane') lane = value ?? null;
    else from = value ?? null;
  }
  return { lane, from, rest };
}

/**
 * Turn a plain request plus optional lane/from into the payload a companion
 * expects: a Pantheon packet JSON string when a lane was given, otherwise the
 * request untouched (plain prompts stay plain — no packet ceremony for
 * `/grok:task "look at this"`).
 */
export function buildPayload(request, { lane, from, to, provenance }) {
  if (!lane) return request;
  return JSON.stringify({
    pantheon_packet: true,
    from: from || 'claude',
    to,
    lane,
    objective: request,
    provenance: provenance || `Delegated via Pantheon to ${to}.`
  });
}

// The single ledger writer both delegation directions go through. All job state
// mutation funnels here → upsertJob → state.mjs, preserving the one-writer invariant.
export const saveJob = (jobId, direction, data) => upsertJob(jobId, { direction, ...data });
