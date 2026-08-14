// extra-harness.mjs
// Spawn detected non-mesh harnesses (omp / opencode / agy / hermes / ultracode)
// under the same hop / timeout / heartbeat contract as the three companions.
// Read-only by default. Writes require GROK_BRIDGE_ALLOW_WRITES=1.
import { spawn } from 'node:child_process';
import {
  assertHopAllowed,
  childEnv,
  armTimeout,
  startHeartbeat,
  writesAllowed,
  GUARDED_SPAWN_OPTS
} from './bridge-guard.mjs';
import { withCompliance } from './compliance.mjs';

function stripDangerous(args) {
  const deny = new Set([
    '--auto', '--yolo', '--always-approve', '--dangerously-skip-permissions',
    '--dangerously-bypass-approvals-and-sandbox', '--plan-yolo'
  ]);
  const out = [];
  for (const tok of args) {
    const name = tok.includes('=') ? tok.slice(0, tok.indexOf('=')) : tok;
    if (deny.has(name)) continue;
    out.push(tok);
  }
  return out;
}

export function buildHarnessArgv(route, prompt) {
  const spawnPlan = route.spawn || { extra: [] };
  const extra = writesAllowed() ? [...(spawnPlan.extra || [])] : stripDangerous(spawnPlan.extra || []);
  const complianceAgent = ['claude', 'codex', 'grok'].includes(route.companion) ? route.companion : 'claude';
  const body = withCompliance(complianceAgent, prompt);
  if (route.companion === 'hermes') {
    return [...extra, body];
  }
  if (route.companion === 'opencode') {
    return [...extra, body];
  }
  if (route.companion === 'omp' || route.companion === 'agy') {
    return [...extra, body];
  }
  return [...extra, body];
}

export function runExtraHarness(bin, route, prompt, { jobId, label } = {}) {
  if (!bin) {
    return Promise.reject(new Error(`${route.companion} binary not found`));
  }
  assertHopAllowed(`hand off to ${route.companion}`);
  const args = buildHarnessArgv(route, prompt);
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { ...GUARDED_SPAWN_OPTS, env: childEnv() });
    const stopBeat = startHeartbeat(label || route.companion);
    armTimeout(child, reject, undefined, { onTimedOut: stopBeat });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (code) => {
      stopBeat();
      if (code === 0) resolve({ stdout: stdout.trim(), stderr: stderr.trim(), code, jobId });
      else reject(new Error(`${route.companion} exited ${code}\nstdout: ${stdout}\nstderr: ${stderr}`));
    });
    child.on('error', (err) => { stopBeat(); reject(err); });
  });
}
