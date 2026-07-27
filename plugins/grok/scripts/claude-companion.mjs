#!/usr/bin/env node
/**
 * claude-companion.mjs
 * Symmetric reverse companion for the Grok side of Pantheon.
 *
 * When Grok wants to delegate work to the local Claude Code CLI (https://code.claude.com/docs/en/cli-reference),
 * this shells the authenticated `claude` binary using its official headless mode.
 *
 * Recommended invocation for this local OAuth bridge:
 *   claude --model claude-opus-4-8 -p "task..." --output-format json --permission-mode plan
 *
 * Key flags supported:
 * - --bare : Only when API-key/settings auth is explicitly configured. Bare mode skips keychain/OAuth.
 * - --output-format json
 * - --allowedTools / --permission-mode plan/default (write/exec grants are gated by env opt-in)
 * - -c / --continue , -r <id> for session control
 * - --max-turns, --model, etc.
 *
 * The bridge always uses the locally authenticated Claude Code (via `claude auth login` etc.).
 * No API keys are used by the bridge itself.
 */

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { assertHopAllowed, childEnv, armTimeout, sanitizeClaudeArgs, startHeartbeat, currentHop , GUARDED_SPAWN_OPTS} from './lib/bridge-guard.mjs';
import { parsePantheonInput, packetJobFields } from './lib/pantheon-packet.mjs';
import { upsertJob } from './lib/state.mjs';
import { withCompliance } from './lib/compliance.mjs';
import { resolveModel, classifyTask, ROUTING_TABLE } from './lib/model-routing.mjs';
import { makeJobId, splitRequestAndExtra, saveJob, extractCompanionFlags, buildPayload } from './lib/companion-common.mjs';


const VALUE_FLAGS = new Set([
  '--allowedTools',
  '--allowed-tools',
  '--permission-mode',
  '--model',
  '--max-turns',
  '--fallback-model',
  '--settings',
  '--system-prompt',
  '--system-prompt-file',
  '--append-system-prompt',
  '--append-system-prompt-file',
  '--add-dir',
  '--mcp-config',
  '--json-schema',
  '--lane', '--from',
]);

// Every flag name the argv splitter is allowed to lift OUT of the request text.
// A delegated prompt is untrusted prose that gets word-split, so anything not
// listed here stays part of the prompt instead of becoming a real CLI flag.
// The dangerous/boolean ones are listed precisely so the write gate still sees
// and strips them rather than passing them along as prose.
const KNOWN_FLAGS = new Set([
  ...VALUE_FLAGS,
  '--bare',
  '--verbose',
  '--dangerously-skip-permissions',
  '--dangerously-bypass-approvals-and-sandbox',
  '--plugin-dir',
  '--agents',
  // companion-level, consumed by extractCompanionFlags and never forwarded
  '--lane', '--from',
]);

export function resolveClaudeBinary() {
  // Try PATH first
  const which = process.platform === 'win32' ? 'where' : 'which';
  try {
    const res = spawnSync(which, ['claude'], { encoding: 'utf8' });
    if (res.status === 0 && res.stdout && res.stdout.trim()) {
      return res.stdout.trim().split(/\r?\n/)[0];
    }
  } catch {}

  // Common explicit locations (including the actual one on this machine)
  const candidates = [
    path.join(process.env.HOME || '', '.local', 'bin', 'claude'),
    path.join(process.env.HOME || '', '.claude', 'bin', 'claude'),
    '/usr/local/bin/claude',
    '/opt/homebrew/bin/claude',
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }

  // Final fallback — assume it's on PATH (most common after `claude install`)
  return 'claude';
}


function stripFlag(args, flagName) {
  const out = [];
  let present = false;
  for (let i = 0; i < args.length; i++) {
    const tok = args[i];
    const name = tok.includes('=') ? tok.slice(0, tok.indexOf('=')) : tok;
    if (name === flagName) {
      present = true;
      if (!tok.includes('=') && VALUE_FLAGS.has(name)) i++;
      continue;
    }
    out.push(tok);
  }
  return { args: out, present };
}

function hasFlag(args, flagName) {
  return args.some(tok => (tok.includes('=') ? tok.slice(0, tok.indexOf('=')) : tok) === flagName);
}

// Value of `--flag value` or `--flag=value`, or null if absent. Used to record
// the model that actually reached the CLI when a caller flag beat the router.
export function flagValue(args, flagName) {
  for (let i = 0; i < args.length; i++) {
    const tok = args[i];
    const eq = tok.indexOf('=');
    if (eq !== -1 && tok.slice(0, eq) === flagName) return tok.slice(eq + 1);
    if (tok === flagName) return args[i + 1] ?? null;
  }
  return null;
}

function hasApiKeyAuth() {
  return Boolean(process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_API_KEY);
}

function shouldUseBareClaude(requestedBare) {
  return process.env.GROK_BRIDGE_CLAUDE_BARE === '1' || (requestedBare && hasApiKeyAuth());
}

async function runClaudeHeadless(prompt, extraArgs = [], jobId, options = {}) {
  const bin = resolveClaudeBinary();

  // Loop guard: refuse if Grok→Claude→Grok→… has already gone too deep.
  assertHopAllowed('delegate to Claude');

  // Write gate: unless GROK_BRIDGE_ALLOW_WRITES=1, strip bypass/skip-permission
  // flags from the caller and pin a read-only tool set. Grok must not be able to
  // silently drive Claude with autonomous edits + Bash on this machine.
  const withoutBare = stripFlag(extraArgs, '--bare');
  const useBare = shouldUseBareClaude(withoutBare.present);
  const routed = options.routed;
  // A security review is force-pinned in the router; tell the gate so a caller
  // --model can't undo the pin one layer below it.
  const pinnedModel = routed?.taskClass === 'security-review' ? routed.model : null;
  const { args: safeExtra, notes } = sanitizeClaudeArgs(withoutBare.args, { pinnedModel });
  if (withoutBare.present && !useBare) {
    notes.push('ignored --bare because local OAuth/keychain auth requires non-bare Claude mode');
  }
  if (notes.length) console.error('[pantheon] permission gate:', notes.join('; '));

  const callerModelWins = hasFlag(safeExtra, '--model');
  const modelArgs = callerModelWins ? [] : (routed?.args ?? []);
  const permissionArgs = hasFlag(safeExtra, '--permission-mode') ? [] : ['--permission-mode', 'plan'];
  // Report the model that actually ran, not the one the router picked. When a
  // caller --model suppressed routed.args the ledger used to record the routed
  // model anyway — the audit trail lied in exactly the override case you'd most
  // want audited.
  const effectiveModel = callerModelWins ? flagValue(safeExtra, '--model') : (routed?.model ?? null);

  // Base flags for local OAuth bridge delegation. `--bare` is only safe when
  // API-key/settings auth is configured because it intentionally skips keychain reads.
  const args = [
    ...(useBare ? ['--bare'] : []),
    ...modelArgs,
    '-p', withCompliance('claude', prompt),
    '--output-format', 'json',
    ...permissionArgs,
    ...safeExtra
  ];

  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      ...GUARDED_SPAWN_OPTS,
      env: childEnv()
    });
    if (jobId) upsertJob(jobId, { pid: child.pid, status: 'running', hop: currentHop() });
    const stopBeat = startHeartbeat('Claude');
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
      if (code === 0) {
        resolve({ stdout: stdout.trim(), stderr: stderr.trim(), code, notes, model: effectiveModel, bare: useBare });
      } else {
        reject(new Error(`claude exited with code ${code}\nstdout: ${stdout}\nstderr: ${stderr}`));
      }
    });

    child.on('error', (err) => { stopBeat(); reject(err); });
  });
}

// Persistence delegated to the shared ledger (lib/state.mjs); direction tags
// this leg so a unified `/grok:status` can show both directions.

export async function delegateToClaude(request, extraCliArgs = []) {
  const jobId = makeJobId('claude');
  console.log(`[pantheon] Delegating to local Claude Code CLI (job ${jobId})...`);
  const parsedInput = parsePantheonInput(request);
  const prompt = parsedInput.prompt;
  const packet = parsedInput.packet;
  // The packet names its own direction, but the packet is untrusted input from
  // the delegating agent. Only the `from` half is theirs to declare — `to` is
  // fixed by which companion is running. Accepting a spoofed `…-to-codex` here
  // made resolveModel() pick the codex agent and emit codex-shaped `-m`/`-c`
  // args for the `claude` binary, and falsified the ledger's provenance.
  const claimed = packet ? `${packet.from}-to-${packet.to}` : null;
  const direction = claimed && claimed.endsWith('-to-claude') && ROUTING_TABLE[claimed]
    ? claimed
    : 'grok-to-claude';
  const taskClass = classifyTask(direction, 'task', packet);
  const routed = resolveModel({ direction, taskClass, packet, promptText: prompt, contextChars: prompt.length });
  const routingFields = {
    model: routed.model,
    effort: routed.effort ?? null,
    bestOfN: routed.bestOfN ?? null,
    routing: { taskClass: routed.taskClass, source: routed.source, escalated: routed.escalated }
  };
  saveJob(jobId, direction, { type: 'claude-delegate', request, status: 'running', ...routingFields, ...packetJobFields(parsedInput) });

  try {
    const { stdout, notes, model, bare } = await runClaudeHeadless(prompt, extraCliArgs, jobId, { routed });
    let parsed;
    try {
      parsed = JSON.parse(stdout);
    } catch {
      parsed = { result: stdout };
    }

    const warningNotes = notes.filter(note =>
      note.startsWith('stripped ') ||
      note.startsWith('ignored ') ||
      note.includes('read-only enforced')
    );
    const pantheon_warning = warningNotes.length ? warningNotes.join('; ') : null;
    saveJob(jobId, direction, {
      type: 'claude-delegate',
      request,
      extraCliArgs,
      raw: stdout,
      result: parsed.result || parsed,
      session_id: parsed.session_id || parsed.sessionId || null,
      cost: parsed.total_cost_usd || null,
      model,
      bare,
      ...routingFields,
      pantheon_warning,
      ...packetJobFields(parsedInput),
      status: 'complete'
    });

    return {
      jobId,
      output: parsed.result || stdout,
      session_id: parsed.session_id || parsed.sessionId || null,
      pantheon_warning,
      raw: stdout
    };
  } catch (e) {
    saveJob(jobId, direction, { status: 'failed', error: e.message });
    console.error('[pantheon] Claude delegate failed:', e.message);
    throw e;
  }
}

// Direct CLI usage (for testing the reverse bridge from a Grok skill or terminal)
if (import.meta.url === `file://${process.argv[1]}`) {
  const { request, extra } = splitRequestAndExtra(process.argv.slice(2), VALUE_FLAGS, '--', KNOWN_FLAGS);
  const { lane, from, rest } = extractCompanionFlags(extra);

  if (!request) {
    console.log('Usage: node claude-companion.mjs "task for Claude" [--lane architecture|security|review|task] [--from grok|codex]');
    console.log('  --lane builds the Pantheon packet for you; without it the task is sent as a plain prompt.');
    console.log('  Uses local OAuth/keychain auth: claude --model ... -p ... --output-format json --permission-mode plan');
    process.exit(1);
  }

  delegateToClaude(buildPayload(request, { lane, from: from || 'grok', to: 'claude' }), rest).then(r => {
    console.log(r.output);
    if (r.pantheon_warning) {
      console.log(`\n[pantheon_warning] ${r.pantheon_warning}`);
    }
    if (r.session_id) {
    console.log(`\n[pantheon] Session ID: ${r.session_id}`);
    console.log(`You can continue with: claude -c -p "follow up..."`);
  }
    console.log(`\n[pantheon] Job stored as ${r.jobId} in .grok-bridge/`);
  }).catch(() => process.exit(1));
}
