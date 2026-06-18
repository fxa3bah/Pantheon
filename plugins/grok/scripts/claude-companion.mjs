#!/usr/bin/env node
/**
 * claude-companion.mjs
 * Symmetric reverse companion for the Grok side of Pantheon.
 *
 * When Grok wants to delegate work to the local Claude Code CLI (https://code.claude.com/docs/en/cli-reference),
 * this shells the authenticated `claude` binary using its official headless mode.
 *
 * Recommended invocation for this local OAuth bridge:
 *   claude --model claude-sonnet-4-6 -p "task..." --output-format json --permission-mode plan
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
import { assertHopAllowed, childEnv, armTimeout, sanitizeClaudeArgs, startHeartbeat, currentHop } from './lib/bridge-guard.mjs';
import { parsePantheonInput, packetJobFields, packetModel } from './lib/pantheon-packet.mjs';
import { upsertJob } from './lib/state.mjs';

function generateJobId() {
  return 'claude-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
}

const DEFAULT_CLAUDE_MODEL = process.env.GROK_BRIDGE_CLAUDE_MODEL || 'claude-sonnet-4-6';
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

function splitRawArgumentString(raw) {
  return String(raw || '').match(/"([^"\\]|\\.)*"|'([^'\\]|\\.)*'|\S+/g)?.map(part => {
    if ((part.startsWith('"') && part.endsWith('"')) || (part.startsWith("'") && part.endsWith("'"))) {
      return part.slice(1, -1);
    }
    return part;
  }) || [];
}

function normalizeArgv(args) {
  if (args.length === 1 && /\s/.test(args[0])) return splitRawArgumentString(args[0]);
  return args;
}

function splitRequestAndExtra(args) {
  const tokens = normalizeArgv(args);
  const request = [];
  const extra = [];
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (tok.startsWith('--')) {
      extra.push(tok);
      const name = tok.includes('=') ? tok.slice(0, tok.indexOf('=')) : tok;
      if (!tok.includes('=') && VALUE_FLAGS.has(name) && tokens[i + 1] != null) {
        extra.push(tokens[++i]);
      }
    } else {
      request.push(tok);
    }
  }
  return { request: request.join(' ').trim(), extra };
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
  const { args: safeExtra, notes } = sanitizeClaudeArgs(withoutBare.args);
  if (withoutBare.present && !useBare) {
    notes.push('ignored --bare because local OAuth/keychain auth requires non-bare Claude mode');
  }
  if (notes.length) console.error('[pantheon] permission gate:', notes.join('; '));

  const model = options.model || DEFAULT_CLAUDE_MODEL;
  const modelArgs = hasFlag(safeExtra, '--model') ? [] : ['--model', model];
  const permissionArgs = hasFlag(safeExtra, '--permission-mode') ? [] : ['--permission-mode', 'plan'];

  // Base flags for local OAuth bridge delegation. `--bare` is only safe when
  // API-key/settings auth is configured because it intentionally skips keychain reads.
  const args = [
    ...(useBare ? ['--bare'] : []),
    ...modelArgs,
    '-p', prompt,
    '--output-format', 'json',
    ...permissionArgs,
    ...safeExtra
  ];

  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: childEnv()
    });
    if (jobId) upsertJob(jobId, { pid: child.pid, status: 'running', hop: currentHop() });
    const stopBeat = startHeartbeat('Claude');
    armTimeout(child, reject);

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });

    child.on('close', (code) => {
      stopBeat();
      if (code === 0) {
        resolve({ stdout: stdout.trim(), stderr: stderr.trim(), code, notes, model, bare: useBare });
      } else {
        reject(new Error(`claude exited with code ${code}\nstdout: ${stdout}\nstderr: ${stderr}`));
      }
    });

    child.on('error', (err) => { stopBeat(); reject(err); });
  });
}

// Persistence delegated to the shared ledger (lib/state.mjs); direction tags
// this leg so a unified `/grok:status` can show both directions.
const saveJob = (jobId, data) => upsertJob(jobId, { direction: 'grok-to-claude', ...data });

export async function delegateToClaude(request, extraCliArgs = []) {
  const jobId = generateJobId();
  console.log(`[pantheon] Delegating to local Claude Code CLI (job ${jobId})...`);
  const parsedInput = parsePantheonInput(request);
  const prompt = parsedInput.prompt;
  const requestedModel = packetModel(parsedInput.packet);
  saveJob(jobId, { type: 'claude-delegate', request, status: 'running', ...packetJobFields(parsedInput) });

  try {
    const { stdout, notes, model, bare } = await runClaudeHeadless(prompt, extraCliArgs, jobId, { model: requestedModel });
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
    saveJob(jobId, {
      type: 'claude-delegate',
      request,
      extraCliArgs,
      raw: stdout,
      result: parsed.result || parsed,
      session_id: parsed.session_id || parsed.sessionId || null,
      cost: parsed.total_cost_usd || null,
      model,
      bare,
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
    saveJob(jobId, { status: 'failed', error: e.message });
    console.error('[pantheon] Claude delegate failed:', e.message);
    throw e;
  }
}

// Direct CLI usage (for testing the reverse bridge from a Grok skill or terminal)
if (import.meta.url === `file://${process.argv[1]}`) {
  const { request, extra } = splitRequestAndExtra(process.argv.slice(2));

  if (!request) {
    console.log('Usage: node claude-companion.mjs "task for Claude" [--model claude-sonnet-4-6 --permission-mode plan]');
    console.log('Default bridge mode uses local OAuth/keychain auth: claude --model claude-sonnet-4-6 -p ... --output-format json --permission-mode plan');
    process.exit(1);
  }

  delegateToClaude(request, extra).then(r => {
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
