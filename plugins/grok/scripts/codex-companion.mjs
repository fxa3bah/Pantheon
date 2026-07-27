#!/usr/bin/env node
/**
 * codex-companion.mjs
 * Codex leg of Pantheon (Claude → Codex, Grok → Codex).
 *
 * Shells the already-authenticated local `codex` CLI in headless mode:
 *   codex exec -m <model> -c model_reasoning_effort=<effort> --sandbox read-only
 *     --skip-git-repo-check -C <cwd> --json -o <last-message-file> "<prompt>"
 *
 * No API keys — this only ever spawns the local `codex` binary that the
 * operator already logged in via `codex login`.
 *
 * CLI-probe finding (2026-07-03, codex-cli 0.142.5): `codex exec --help`
 * exposes NO `--effort` flag. Reasoning effort is a config override:
 * `-c model_reasoning_effort=<minimal|low|medium|high|xhigh>`.
 * `resolveModel('codex', …)` in model-routing.mjs now emits CLI-correct
 * `routed.args` directly (`['-m', model, '-c', 'model_reasoning_effort=…']`),
 * so this file just splices them in — see `codexModelArgs()` below, which
 * only decides whether to use them (skipped if the caller already passed an
 * explicit `-m`/`--model`).
 *
 * `codex exec --json` streams JSONL events (thread.started, turn.started,
 * item.*, turn.completed/turn.failed, error) rather than one parseable JSON
 * blob, and carries no cost field. The result is reconstructed by joining every
 * `agent_message` item from that stream, in order. `-o/--output-last-message`
 * is a FALLBACK only: it holds just the LAST assistant message, so using it as
 * the primary source silently truncated any multi-part answer (see
 * parseCodexOutput for the measured case).
 */

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { resolveModel, classifyTask, ROUTING_TABLE } from './lib/model-routing.mjs';
import { parsePantheonInput, packetJobFields } from './lib/pantheon-packet.mjs';
import { upsertJob } from './lib/state.mjs';
import { assertHopAllowed, childEnv, armTimeout, startHeartbeat, currentHop, sanitizeCodexArgs , GUARDED_SPAWN_OPTS} from './lib/bridge-guard.mjs';
import { withCompliance } from './lib/compliance.mjs';
import { makeJobId, splitRequestAndExtra, saveJob, extractCompanionFlags, buildPayload } from './lib/companion-common.mjs';

export function resolveCodexBinary() {
  const which = process.platform === 'win32' ? 'where' : 'which';
  try {
    const res = spawnSync(which, ['codex'], { encoding: 'utf8' });
    if (res.status === 0 && res.stdout && res.stdout.trim()) {
      return res.stdout.trim().split(/\r?\n/)[0];
    }
  } catch {}

  const candidates = [
    path.join(process.env.HOME || '', '.local', 'bin', 'codex'),
    '/usr/local/bin/codex',
    '/opt/homebrew/bin/codex',
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return 'codex'; // assume PATH after `codex` install
}

// Public wrapper preserved for API compatibility; delegates to the shared core.
export function generateJobId() {
  return makeJobId('codex');
}

const VALUE_FLAGS = new Set([
  '-m', '--model', '-c', '--config', '-s', '--sandbox', '-C', '--cd',
  '-i', '--image', '-p', '--profile', '--add-dir', '--local-provider',
  '--output-schema', '--color', '-o', '--output-last-message', '--enable', '--disable',
  '--lane', '--from',
]);

// Allowlist of flag names the argv splitter may lift out of the request text.
// Codex uses single-dash flags, so the old "any token starting with '-' is a
// flag" rule was especially leaky against untrusted delegated prose. Anything
// not listed stays in the prompt. Dangerous names are listed on purpose so the
// write gate still gets to see and strip them.
const KNOWN_FLAGS = new Set([
  ...VALUE_FLAGS,
  '--skip-git-repo-check',
  '--json',
  '--full-auto',
  '--yolo',
  '--dangerously-bypass-approvals-and-sandbox',
  '-a', '--ask-for-approval',
  '--oss',
  // companion-level, consumed by extractCompanionFlags and never forwarded
  '--lane', '--from',
]);

export function hasFlag(args, flagName) {
  return args.some(tok => (tok.includes('=') ? tok.slice(0, tok.indexOf('=')) : tok) === flagName);
}

// Trusts model-routing.mjs's routed.args wholesale (it is now CLI-correct:
// `-m <model> -c model_reasoning_effort=<effort>`) rather than re-deriving
// Codex-native flags here. Explicit caller -m/--model wins — no routed model
// args are spliced in if the caller already supplied one. `safeExtra` MUST
// already be the sanitizeCodexArgs() output: this trusted `-c` is layered on
// top of a caller arg list that has had every caller `-c`/`--config` and
// `--profile`/`-p` stripped, so the routed effort can never be clobbered by
// (or accidentally combined with) an untrusted config override.
export function codexModelArgs(routed, safeExtra = []) {
  if (!routed?.args?.length || hasFlag(safeExtra, '-m') || hasFlag(safeExtra, '--model')) return [];
  return [...routed.args];
}

// Bundles the ledger-facing fields for a resolveModel() result so every
// saveJob call carries the same routing shape (mirrors grok-companion.mjs /
// claude-companion.mjs so the ledger schema never drifts mid-job).
export function routingFieldsFor(routed) {
  return {
    model: routed.model,
    effort: routed.effort ?? null,
    bestOfN: routed.bestOfN ?? null,
    routing: { taskClass: routed.taskClass, source: routed.source, escalated: routed.escalated }
  };
}

// Mines thread_id (Codex's session-id analogue) and any fatal error message
// out of the `--json` JSONL stream. Tolerant of unknown/future event shapes.
export function parseCodexEvents(stdoutText) {
  let sessionId = null;
  let errorMessage = null;
  const agentMessages = [];
  const itemErrors = [];
  for (const line of String(stdoutText || '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed[0] !== '{') continue;
    let evt;
    try { evt = JSON.parse(trimmed); } catch { continue; }
    if (!evt || typeof evt !== 'object') continue;
    if (evt.type === 'thread.started' && evt.thread_id) sessionId = evt.thread_id;
    if (evt.type === 'error' && evt.message) errorMessage = evt.message;
    if (evt.type === 'turn.failed' && evt.error?.message) errorMessage = evt.error.message;

    // Every assistant message Codex emits during the turn, in order. A long
    // task (an audit, a multi-part review) produces MANY of these; only
    // harvesting the last one throws the rest away. See parseCodexOutput.
    if (evt.type === 'item.completed') {
      const item = evt.item || {};
      const kind = item.item_type || item.type;
      if (kind === 'agent_message' || kind === 'assistant_message') {
        const text = item.text ?? item.content ?? '';
        if (typeof text === 'string' && text.trim()) agentMessages.push(text);
      }
      if (kind === 'error' && (item.message || item.text)) {
        itemErrors.push(item.message || item.text);
      }
    }
  }
  return { sessionId, errorMessage, agentMessages, itemErrors };
}

// Reconstructs Codex's FULL answer from the --json event stream.
//
// This used to return `lastMessage` (the `-o/--output-last-message` file)
// unconditionally, but that file holds only Codex's LAST assistant message. A
// long task emits many: one real audit run produced 15 agent_message items
// totalling 7382 chars, and the bridge returned the final 4308 — 41% silently
// discarded. When Codex ends with a short sign-off ("Done — see findings
// above") the caller gets a few hundred bytes and no indication anything was
// lost. Short answers hid this completely, because there the last message IS
// the whole answer.
//
// So: join every agent_message in order, and keep lastMessage only as a
// fallback for a stream we could not parse.
export function parseCodexOutput(stdout, lastMessage) {
  const { sessionId, errorMessage, agentMessages, itemErrors } = parseCodexEvents(stdout);
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    parsed = { result: lastMessage || stdout };
  }

  const joined = agentMessages.join('\n\n').trim();
  const result = joined || lastMessage || parsed.result || parsed.text || stdout;

  return {
    parsed,
    result,
    messageCount: agentMessages.length,
    // Truncation is now impossible to hit silently: if the last message alone
    // would have been the answer, say how much more the full stream carried.
    droppedByLastMessageOnly: joined && lastMessage
      ? Math.max(0, joined.length - lastMessage.length)
      : 0,
    session_id: parsed.session_id || parsed.sessionId || sessionId || null,
    cost: parsed.total_cost_usd ?? parsed.cost ?? null,
    errorMessage: errorMessage || (itemErrors.length ? itemErrors.join('; ') : null),
    itemErrors,
  };
}

async function runCodexHeadless(prompt, extraArgs = [], jobId, options = {}) {
  const bin = resolveCodexBinary();

  // Loop guard: refuse if the mesh has already hopped too many times.
  assertHopAllowed('delegate to Codex');

  // Write gate: unless GROK_BRIDGE_ALLOW_WRITES=1, strip sandbox-bypass flags
  // and pin --sandbox read-only. See lib/bridge-guard.mjs#sanitizeCodexArgs.
  const routed = options.routed;
  // Security reviews are force-pinned by the router; the gate strips a caller
  // -m/--model so the pin can't be undone below it.
  const pinnedModel = routed?.taskClass === 'security-review' ? routed.model : null;
  const { args: safeExtra, notes } = sanitizeCodexArgs(extraArgs, { pinnedModel });
  if (notes.length) console.error('[pantheon] permission gate:', notes.join('; '));

  const modelArgs = codexModelArgs(routed, safeExtra);
  const lastMessageFile = path.join(os.tmpdir(), `pantheon-${jobId || generateJobId()}.txt`);

  // Prompt is a single positional arg (injection-safe: no shell is used).
  const args = [
    'exec',
    ...modelArgs,
    ...safeExtra,
    '--skip-git-repo-check',
    '-C', process.cwd(),
    '--json',
    '-o', lastMessageFile,
    withCompliance('codex', prompt),
  ];

  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { ...GUARDED_SPAWN_OPTS, env: childEnv() });
    if (jobId) upsertJob(jobId, { pid: child.pid, status: 'running', hop: currentHop() });
    const stopBeat = startHeartbeat('Codex');
    armTimeout(child, reject, undefined, {
      onTimedOut: () => {
        stopBeat();
        if (jobId) upsertJob(jobId, { status: 'timed_out' });
      }
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });

    child.on('close', (code) => {
      stopBeat();
      let lastMessage = '';
      try { lastMessage = fs.readFileSync(lastMessageFile, 'utf8').trim(); } catch {}
      try { fs.unlinkSync(lastMessageFile); } catch {}

      if (code === 0) {
        resolve({ stdout: stdout.trim(), stderr: stderr.trim(), lastMessage, code, notes });
      } else {
        reject(new Error(`codex exited with code ${code}\nstdout: ${stdout}\nstderr: ${stderr}`));
      }
    });

    child.on('error', (err) => { stopBeat(); reject(err); });
  });
}


export async function delegateToCodex(request, extraCliArgs = []) {
  const jobId = generateJobId();
  console.log(`[pantheon] Delegating to local Codex CLI (job ${jobId})...`);
  const parsedInput = parsePantheonInput(request);
  const prompt = parsedInput.prompt;
  const packet = parsedInput.packet;

  // `to` is fixed by which companion is running; only `from` is the packet's to
  // declare. Accepting a spoofed `…-to-grok`/`…-to-claude` here made
  // resolveModel() resolve a different agent's flag shape onto the codex binary
  // and mislabeled the ledger.
  const claimed = packet ? `${packet.from}-to-${packet.to}` : null;
  const direction = claimed && claimed.endsWith('-to-codex') && ROUTING_TABLE[claimed]
    ? claimed
    : 'claude-to-codex';
  const taskClass = classifyTask(direction, 'task', packet);
  const routed = resolveModel({ direction, taskClass, packet, promptText: prompt });
  const routingFields = routingFieldsFor(routed);

  saveJob(jobId, direction, {
    type: 'codex-delegate', request, status: 'running',
    ...routingFields,
    ...packetJobFields(parsedInput),
  });

  try {
    const { stdout, lastMessage, notes } =
      await runCodexHeadless(prompt, extraCliArgs, jobId, { routed });
    const { result, session_id, cost, errorMessage } = parseCodexOutput(stdout, lastMessage);
    if (errorMessage) throw new Error(`codex reported an error: ${errorMessage}`);

    const warningNotes = notes.filter(note =>
      note.startsWith('stripped ') || note.includes('read-only') || note.includes('workspace-write'));
    const pantheon_warning = warningNotes.length ? warningNotes.join('; ') : null;

    saveJob(jobId, direction, {
      type: 'codex-delegate', request, extraCliArgs, raw: stdout,
      result, session_id, cost,
      ...routingFields,
      pantheon_warning, ...packetJobFields(parsedInput), status: 'complete',
    });

    return { jobId, output: result, session_id, pantheon_warning, raw: stdout };
  } catch (e) {
    saveJob(jobId, direction, { status: 'failed', error: e.message });
    console.error('[pantheon] Codex delegate failed:', e.message);
    throw e;
  }
}

// ---- CLI entry (testable helpers stay pure/exported above) -----------------


if (import.meta.url === `file://${process.argv[1]}`) {
  const { request, extra } = splitRequestAndExtra(process.argv.slice(2), VALUE_FLAGS, '-', KNOWN_FLAGS);
  const { lane, from, rest } = extractCompanionFlags(extra);

  if (!request) {
    console.log('Usage: node codex-companion.mjs "task for Codex" [--lane implement|verify|review] [--from claude|grok]');
    console.log('  --lane builds the Pantheon packet for you; without it the task is sent as a plain prompt.');
    console.log('  Shells local-OAuth codex: codex exec -m ... -c model_reasoning_effort=... --sandbox read-only ...');
    process.exit(1);
  }

  delegateToCodex(buildPayload(request, { lane, from, to: 'codex' }), rest).then(r => {
    console.log(r.output);
    if (r.pantheon_warning) console.log(`\n[pantheon_warning] ${r.pantheon_warning}`);
    if (r.session_id) console.log(`\n[pantheon] Session ID: ${r.session_id}`);
    console.log(`\n[pantheon] Job stored as ${r.jobId} in .grok-bridge/`);
  }).catch(() => process.exit(1));
}
