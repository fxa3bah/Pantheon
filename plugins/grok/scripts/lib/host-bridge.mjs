// host-bridge.mjs
// SSH is the pipe between machines. OAuth stays on the remote host.
// No API keys. Packet + hop travel; the ledger stays local to the runner.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assertHopAllowed, childEnv, armTimeout, startHeartbeat, GUARDED_SPAWN_OPTS } from './bridge-guard.mjs';

export function hostsPath(env = process.env) {
  return env.PANTHEON_HOSTS || path.join(env.HOME || os.homedir() || '', '.pantheon', 'hosts.json');
}

function normalizeHost(row) {
  if (!row || typeof row !== 'object' || !row.id) {
    throw new Error('host entry requires id');
  }
  const ssh = typeof row.ssh === 'string' && row.ssh.trim() ? row.ssh.trim() : null;
  return Object.freeze({
    id: String(row.id),
    local: row.local === true || !ssh,
    ssh,
    cwd: row.cwd || '.',
    companion: row.companion || 'plugins/grok/scripts/grok-companion.mjs',
    identity: row.identity || null
  });
}

export function loadHosts(filePath, { readFile = (p) => fs.readFileSync(p, 'utf8') } = {}) {
  let raw;
  try {
    raw = readFile(filePath);
  } catch (e) {
    if (e && e.code === 'ENOENT') return [];
    throw e;
  }
  const parsed = JSON.parse(raw);
  const list = Array.isArray(parsed) ? parsed : parsed.hosts;
  if (!Array.isArray(list)) throw new Error('hosts.json must be an array or { "hosts": [...] }');
  return list.map(normalizeHost);
}

export function findHost(id, filePath = hostsPath()) {
  if (!id) return null;
  return loadHosts(filePath).find((h) => h.id === id) || null;
}

export function sshArgv(host, remoteCmd, { controlDir = path.join(os.tmpdir(), 'pantheon-ssh') } = {}) {
  if (!host?.ssh) throw new Error(`host ${host?.id || '?'} has no ssh target`);
  const sock = path.join(controlDir, `${host.id}.sock`);
  const args = [
    '-o', 'BatchMode=yes',
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', 'ControlMaster=auto',
    '-o', `ControlPath=${sock}`,
    '-o', 'ControlPersist=10m',
    '-o', 'ConnectTimeout=10'
  ];
  if (host.identity) args.push('-i', host.identity);
  args.push(host.ssh, remoteCmd);
  return args;
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

export function remoteCommand(host, subcommand, payload, extra = []) {
  const parts = [
    'cd', shellQuote(host.cwd),
    '&&', 'node', shellQuote(host.companion),
    subcommand,
    shellQuote(payload),
    ...extra.map(shellQuote)
  ];
  return parts.join(' ');
}

export function runRemoteCompanion(host, subcommand, payload, { extra = [], spawnFn = spawn } = {}) {
  assertHopAllowed(`ssh hop to ${host.id}`);
  const remote = remoteCommand(host, subcommand, payload, extra);
  const args = sshArgv(host, remote);
  return new Promise((resolve, reject) => {
    const child = spawnFn('ssh', args, { ...GUARDED_SPAWN_OPTS, env: childEnv() });
    const stopBeat = startHeartbeat(`ssh:${host.id}`);
    armTimeout(child, reject, undefined, { onTimedOut: stopBeat });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (d) => { stdout += d; });
    child.stderr?.on('data', (d) => { stderr += d; });
    child.on('close', (code) => {
      stopBeat();
      if (code === 0) resolve({ stdout: stdout.trim(), stderr: stderr.trim(), code, host: host.id });
      else reject(new Error(`ssh ${host.id} exited ${code}\nstdout: ${stdout}\nstderr: ${stderr}`));
    });
    child.on('error', (err) => { stopBeat(); reject(err); });
  });
}
