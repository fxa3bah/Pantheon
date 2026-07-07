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

// Separate the free-text request from pass-through flags. Two things differ per
// agent, so both are parameters:
//  - `valueFlags`: the set of flags that consume the following token as a value.
//  - `flagPrefix`: what marks a flag. Claude's CLI uses long flags only ('--'),
//    so a bare '-x' stays in the request; Codex uses short flags too ('-m','-C'),
//    so it passes '-'. Defaulting to '--' preserves the stricter (claude) behavior.
export function splitRequestAndExtra(args, valueFlags, flagPrefix = '--') {
  const tokens = normalizeArgv(args);
  const request = [];
  const extra = [];
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (tok.startsWith(flagPrefix)) {
      extra.push(tok);
      const name = tok.includes('=') ? tok.slice(0, tok.indexOf('=')) : tok;
      if (!tok.includes('=') && valueFlags.has(name) && tokens[i + 1] != null) {
        extra.push(tokens[++i]);
      }
    } else {
      request.push(tok);
    }
  }
  return { request: request.join(' ').trim(), extra };
}

// The single ledger writer both delegation directions go through. All job state
// mutation funnels here → upsertJob → state.mjs, preserving the one-writer invariant.
export const saveJob = (jobId, direction, data) => upsertJob(jobId, { direction, ...data });
