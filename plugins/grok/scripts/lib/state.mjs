// Ultra-light job state (shared spirit with codex tracked-jobs / state)
import fs from 'node:fs';
import path from 'node:path';

const DATA_DIR = path.join(process.cwd(), '.grok-bridge');

// Warnings go to stderr so they never contaminate parsed stdout (the ledger is
// read by tooling that parses the companions' stdout as JSON).
function warn(msg) {
  try { process.stderr.write(`[state] ${msg}\n`); } catch {}
}

// ISO-8601 timestamps sort chronologically, but ONLY as parsed epochs — the old
// code subtracted the raw strings, which yields NaN and left listJobs unsorted
// (filename order, i.e. grouped by agent prefix instead of by recency).
function toEpoch(v) {
  const t = Date.parse(v);
  return Number.isNaN(t) ? 0 : t;
}

// Job ids are built by makeJobId() as `<prefix>-<base36>-<base36>`, but they
// also arrive from outside — `/grok:status <id>`, `/grok:cancel <id>`, and
// delegated packets — and go straight into path.join(DATA_DIR, `${id}.json`).
// Without this check an id like `../../../../tmp/pwned` escapes .grok-bridge and
// writes (or reads) an arbitrary file. Fail closed on anything unexpected.
// Charset rule, not a shape rule: what matters is that no id can contain a path
// separator, a dot, or a null byte. Any alphanumeric/dash/underscore name is
// safe inside DATA_DIR regardless of how a future prefix scheme is shaped.
const JOB_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

export function isValidJobId(id) {
  return typeof id === 'string' && id.length <= 64 && JOB_ID_RE.test(id);
}

function jobPath(id) {
  if (!isValidJobId(id)) throw new Error(`[state] refusing unsafe job id: ${JSON.stringify(id)}`);
  return path.join(DATA_DIR, `${id}.json`);
}

// Atomic write: write a per-process temp file, then rename into place. rename is
// atomic on the same filesystem, so a concurrent reader or a mid-write crash can
// never observe a half-written (corrupt) ledger file.
function atomicWrite(file, data) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

export function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

// atomicWrite makes each individual write safe, but upsertJob is a
// read-modify-write: two processes touching the same job (a companion writing
// `status` while `/grok:cancel` writes `cancelled`, or two hops of one mesh
// run) could both read the old state and the second write would silently drop
// the first patch. mkdir is atomic on every POSIX filesystem, so an empty
// directory is the lock. Stale locks (a killed process) are reclaimed by age.
const LOCK_STALE_MS = 10_000;
const LOCK_WAIT_MS = 2_000;

function withJobLock(file, fn) {
  const lock = `${file}.lock`;
  const deadline = Date.now() + LOCK_WAIT_MS;
  let held = false;
  while (Date.now() < deadline) {
    try {
      fs.mkdirSync(lock);
      held = true;
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') break;   // unexpected: proceed unlocked
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > LOCK_STALE_MS) {
          warn(`reclaiming stale lock ${path.basename(lock)}`);
          fs.rmdirSync(lock);
          continue;
        }
      } catch {}
      // Busy-wait briefly. This path is rare and the critical section is a
      // single small file read+write, so a short spin beats pulling in a dep.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
    }
  }
  try {
    return fn();
  } finally {
    if (held) { try { fs.rmdirSync(lock); } catch {} }
  }
}

export function upsertJob(id, patch) {
  ensureDataDir();
  const file = jobPath(id);
  return withJobLock(file, () => {
    let current = {};
    if (fs.existsSync(file)) {
      try {
        current = JSON.parse(fs.readFileSync(file, 'utf8'));
      } catch (e) {
        // Corrupt existing file: surface it, then heal by rewriting fresh state
        // rather than silently discarding the error (the old behavior).
        warn(`upsertJob: corrupt ${id}.json (${e.message}); rewriting`);
        current = {};
      }
    }
    const now = new Date().toISOString();
    // Preserve original creation timestamp across merges; `updated` always advances.
    const ts = current.ts || patch.ts || now;
    const next = { ...current, ...patch, id, ts, updated: now };
    atomicWrite(file, JSON.stringify(next, null, 2));
    return next;
  });
}

export function readJob(id) {
  // Reads stay non-throwing (callers treat null as "no such job"), so an unsafe
  // id is simply a miss rather than an exception on the delegation path.
  if (!isValidJobId(id)) {
    warn(`readJob: refusing unsafe job id ${JSON.stringify(id)}; treating as missing`);
    return null;
  }
  const file = jobPath(id);
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    // A corrupt file previously threw raw here (the opposite failure mode of
    // upsertJob's silent swallow). Warn and return null so callers see a clean
    // "not found" instead of an unhandled exception on the delegation path.
    warn(`readJob: corrupt ${id}.json (${e.message}); treating as missing`);
    return null;
  }
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
    .sort((a, b) => toEpoch(b.updated || b.ts) - toEpoch(a.updated || a.ts))
    .slice(0, limit);
}

// Housekeeping: keep the most-recent `keep` job files, delete the rest. Returns
// the number of files removed. Ordering reuses the same recency logic as listJobs.
export function pruneJobs(keep = 200) {
  ensureDataDir();
  const entries = fs.readdirSync(DATA_DIR)
    .filter(f => f.endsWith('.json'))
    .map(f => {
      try {
        const j = JSON.parse(fs.readFileSync(path.join(DATA_DIR, f), 'utf8'));
        return { file: f, sort: toEpoch(j.updated || j.ts) };
      } catch {
        // Unparseable files sort oldest so they get pruned first.
        return { file: f, sort: 0 };
      }
    })
    .sort((a, b) => b.sort - a.sort);

  let removed = 0;
  for (const { file } of entries.slice(keep)) {
    try {
      fs.unlinkSync(path.join(DATA_DIR, file));
      removed += 1;
    } catch (e) {
      warn(`pruneJobs: could not remove ${file} (${e.message})`);
    }
  }
  return removed;
}
