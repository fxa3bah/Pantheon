#!/usr/bin/env node
/**
 * claude-companion.mjs
 * Symmetric reverse companion for the Grok side of the grok-plugin-cc bridge.
 *
 * When Grok wants to delegate work to the local Claude Code CLI (https://code.claude.com/docs/en/cli-reference),
 * this shells the authenticated `claude` binary using its official headless mode.
 *
 * Recommended invocation for bridge use (from the official docs):
 *   claude --bare -p "task..." --output-format json
 *
 * Key flags supported:
 * - --bare : Skip loading hooks/skills/plugins/MCP for speed & determinism (highly recommended for scripts/bridges)
 * - --output-format json
 * - --allowedTools / --permission-mode bypassPermissions (or --dangerously-skip-permissions)
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
import { upsertJob } from './lib/state.mjs';

function generateJobId() {
  return 'claude-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
}

function resolveClaudeBinary() {
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

async function runClaudeHeadless(prompt, extraArgs = [], jobId) {
  const bin = resolveClaudeBinary();

  // Loop guard: refuse if Grok→Claude→Grok→… has already gone too deep.
  assertHopAllowed('delegate to Claude');

  // Write gate: unless GROK_BRIDGE_ALLOW_WRITES=1, strip bypass/skip-permission
  // flags from the caller and pin a read-only tool set. Grok must not be able to
  // silently drive Claude with autonomous edits + Bash on this machine.
  const { args: safeExtra, notes } = sanitizeClaudeArgs(extraArgs);
  if (notes.length) console.error('[grok-bridge] permission gate:', notes.join('; '));

  // Base recommended flags for a bridge/scripted delegation:
  // --bare for speed and to avoid picking up random local plugins/skills/hooks
  // --output-format json so we can parse session_id, result, cost, etc.
  const args = [
    '--bare',
    '-p', prompt,
    '--output-format', 'json',
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
        resolve({ stdout: stdout.trim(), stderr: stderr.trim(), code });
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
  console.log(`[grok-bridge] Delegating to local Claude Code CLI (job ${jobId})...`);
  saveJob(jobId, { type: 'claude-delegate', request, status: 'running' });

  try {
    const { stdout } = await runClaudeHeadless(request, extraCliArgs, jobId);
    let parsed;
    try {
      parsed = JSON.parse(stdout);
    } catch {
      parsed = { result: stdout };
    }

    saveJob(jobId, {
      type: 'claude-delegate',
      request,
      extraCliArgs,
      raw: stdout,
      result: parsed.result || parsed,
      session_id: parsed.session_id || parsed.sessionId || null,
      cost: parsed.total_cost_usd || null,
      status: 'complete'
    });

    return {
      jobId,
      output: parsed.result || stdout,
      session_id: parsed.session_id || parsed.sessionId || null,
      raw: stdout
    };
  } catch (e) {
    saveJob(jobId, { status: 'failed', error: e.message });
    console.error('[grok-bridge] Claude delegate failed:', e.message);
    throw e;
  }
}

// Direct CLI usage (for testing the reverse bridge from a Grok skill or terminal)
if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const request = args.filter(a => !a.startsWith('--')).join(' ');
  const extra = args.filter(a => a.startsWith('--'));

  if (!request) {
    console.log('Usage: node claude-companion.mjs "task for Claude" [--allowedTools "Read,Edit" --permission-mode bypassPermissions]');
    console.log('Recommended for bridge: the script automatically adds --bare -p ... --output-format json');
    process.exit(1);
  }

  delegateToClaude(request, extra).then(r => {
    console.log(r.output);
    if (r.session_id) {
      console.log(`\n[bridge] Session ID: ${r.session_id}`);
      console.log(`You can continue with: claude -c -p "follow up..."`);
    }
    console.log(`\n[bridge] Job stored as ${r.jobId} in .grok-bridge/`);
  }).catch(() => process.exit(1));
}
