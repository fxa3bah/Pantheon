// Ultra-light job state (shared spirit with codex tracked-jobs / state)
import fs from 'node:fs';
import path from 'node:path';

const DATA_DIR = path.join(process.cwd(), '.grok-bridge');

export function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

export function upsertJob(id, patch) {
  ensureDataDir();
  const file = path.join(DATA_DIR, `${id}.json`);
  let current = {};
  if (fs.existsSync(file)) {
    try { current = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
  }
  const now = new Date().toISOString();
  // Preserve original creation timestamp across merges; `updated` always advances.
  const ts = current.ts || patch.ts || now;
  const next = { ...current, ...patch, id, ts, updated: now };
  fs.writeFileSync(file, JSON.stringify(next, null, 2));
  return next;
}

export function readJob(id) {
  const file = path.join(DATA_DIR, `${id}.json`);
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

export function listJobs(limit = 10) {
  ensureDataDir();
  return fs.readdirSync(DATA_DIR)
    .filter(f => f.endsWith('.json'))
    .map(f => {
      try {
        const j = JSON.parse(fs.readFileSync(path.join(DATA_DIR, f), 'utf8'));
        return { ...j, file: f };
      } catch { return null; }
    })
    .filter(Boolean)
    .sort((a, b) => (b.updated || b.ts || 0) - (a.updated || a.ts || 0))
    .slice(0, limit);
}
