// harness-detect.mjs
// Scan the machine for installed coding-agent CLIs / harnesses.
// PATH first, then known home fallbacks. Pure enough to inject exists/which
// in tests. Tables are frozen. No API keys, no network.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze(value[key]);
  }
  return value;
}

const HOME = () => process.env.HOME || process.env.USERPROFILE || os.homedir() || '';

function homeJoin(...parts) {
  return path.join(HOME(), ...parts);
}

// Catalog of harnesses Pantheon knows how to *see*. Spawn support is a
// separate concern (see auto-route.mjs). A missing binary is not an error;
// detect() reports it under `missing`.
export const HARNESS_CATALOG = deepFreeze([
  {
    id: 'claude',
    name: 'Claude Code',
    bin: 'claude',
    family: 'agent',
    strengths: ['architecture', 'reasoning', 'security', 'plan'],
    homes: ['.local/bin/claude', '.claude/bin/claude'],
    system: ['/opt/homebrew/bin/claude', '/usr/local/bin/claude']
  },
  {
    id: 'grok',
    name: 'Grok Build',
    bin: 'grok',
    family: 'agent',
    strengths: ['imagine', 'video', 'creative', 'review'],
    homes: ['.grok/bin/grok', '.local/bin/grok'],
    system: ['/opt/homebrew/bin/grok', '/usr/local/bin/grok']
  },
  {
    id: 'codex',
    name: 'Codex CLI',
    bin: 'codex',
    family: 'agent',
    strengths: ['implement', 'verify', 'review'],
    homes: ['.local/bin/codex'],
    system: ['/opt/homebrew/bin/codex', '/usr/local/bin/codex']
  },
  {
    id: 'omp',
    name: 'Oh My Pi',
    bin: 'omp',
    family: 'harness',
    strengths: ['plan', 'implement', 'review'],
    homes: ['.bun/bin/omp', '.local/bin/omp'],
    system: ['/opt/homebrew/bin/omp']
  },
  {
    id: 'opencode',
    name: 'OpenCode',
    bin: 'opencode',
    family: 'harness',
    strengths: ['implement', 'review'],
    homes: ['.opencode/bin/opencode', '.local/bin/opencode'],
    system: ['/opt/homebrew/bin/opencode']
  },
  {
    id: 'agy',
    name: 'Agy',
    bin: 'agy',
    family: 'harness',
    strengths: ['implement', 'review'],
    homes: ['.local/bin/agy'],
    system: ['/opt/homebrew/bin/agy']
  },
  {
    id: 'hermes',
    name: 'Hermes',
    bin: 'hermes',
    family: 'harness',
    strengths: ['reasoning', 'plan'],
    homes: ['.local/bin/hermes'],
    system: ['/opt/homebrew/bin/hermes']
  },
  {
    id: 'ultracode',
    name: 'UltraCode',
    bin: 'ultracode',
    family: 'harness',
    strengths: ['plan', 'implement'],
    homes: ['.ultracode/bin/ultracode', '.local/bin/ultracode', '.bun/bin/ultracode'],
    system: ['/opt/homebrew/bin/ultracode', '/usr/local/bin/ultracode']
  },
  {
    id: 'qoder',
    name: 'Qoder',
    bin: 'qoder',
    family: 'harness',
    strengths: ['implement'],
    homes: ['.qoder/bin/qoder', '.Qoder/bin/qoder', '.local/bin/qoder'],
    system: ['/opt/homebrew/bin/qoder']
  },
  {
    id: 'pi',
    name: 'Pi',
    bin: 'pi',
    family: 'harness',
    strengths: ['implement'],
    homes: ['.pi/bin/pi', '.local/bin/pi'],
    system: ['/opt/homebrew/bin/pi']
  },
  {
    id: 'gemini',
    name: 'Gemini CLI',
    bin: 'gemini',
    family: 'harness',
    strengths: ['implement', 'review'],
    homes: ['.gemini/bin/gemini', '.local/bin/gemini'],
    system: ['/opt/homebrew/bin/gemini']
  },
  {
    id: 'antigravity',
    name: 'Antigravity',
    bin: 'antigravity',
    family: 'harness',
    strengths: ['implement'],
    homes: [
      '.antigravity/antigravity/bin/antigravity',
      '.antigravity-ide/antigravity-ide/bin/antigravity',
      '.local/bin/antigravity'
    ],
    system: []
  },
  {
    id: 'warp',
    name: 'Warp Oz',
    bin: 'oz',
    family: 'harness',
    strengths: ['implement'],
    homes: [],
    system: ['/Applications/Warp.app/Contents/Resources/bin/oz']
  }
]);

function defaultWhich(name) {
  const cmd = process.platform === 'win32' ? 'where' : 'which';
  try {
    const res = spawnSync(cmd, [name], { encoding: 'utf8', timeout: 3000 });
    if (res.status === 0 && res.stdout && res.stdout.trim()) {
      return res.stdout.trim().split(/\r?\n/)[0];
    }
  } catch {}
  return null;
}

function defaultVersion(bin) {
  if (!bin) return null;
  try {
    const res = spawnSync(bin, ['--version'], { encoding: 'utf8', timeout: 4000 });
    const text = `${res.stdout || ''}${res.stderr || ''}`.trim().split(/\r?\n/)[0];
    return text || null;
  } catch {
    return null;
  }
}

function candidatePaths(entry) {
  const out = [];
  for (const rel of entry.homes || []) out.push(homeJoin(...rel.split('/')));
  for (const abs of entry.system || []) out.push(abs);
  return out;
}

/**
 * Scan every catalogued harness. `io` is injectable for tests.
 * Returns a frozen inventory: found[], missing[], byId.
 */
export function detectHarnesses(io = {}) {
  const which = io.which || defaultWhich;
  const exists = io.exists || ((p) => Boolean(p) && fs.existsSync(p));
  const versionOf = io.version || defaultVersion;

  const found = [];
  const missing = [];
  const byId = {};

  for (const entry of HARNESS_CATALOG) {
    let resolved = which(entry.bin);
    if (!resolved || !exists(resolved)) {
      resolved = null;
      for (const candidate of candidatePaths(entry)) {
        if (exists(candidate)) { resolved = candidate; break; }
      }
    }
    const row = {
      id: entry.id,
      name: entry.name,
      bin: entry.bin,
      family: entry.family,
      strengths: entry.strengths,
      present: Boolean(resolved),
      path: resolved || null,
      version: resolved ? versionOf(resolved) : null
    };
    Object.freeze(row);
    byId[entry.id] = row;
    if (row.present) found.push(row);
    else missing.push(row);
  }

  return Object.freeze({
    scanned: HARNESS_CATALOG.length,
    found: Object.freeze(found),
    missing: Object.freeze(missing),
    byId: Object.freeze(byId)
  });
}

export function presentIds(inventory) {
  return inventory.found.map((row) => row.id);
}
