// Unit tests for the job ledger (state.mjs) — the single writer both delegation
// directions depend on. Covers the hardening pass: recency sort (was a NaN no-op),
// corrupt-file handling in both read paths, atomic writes, and pruning.
// Run: node --test tests/state.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// state.mjs pins DATA_DIR = path.join(process.cwd(), '.grok-bridge') at import
// time, so we chdir into an isolated temp dir BEFORE importing it. `node --test`
// runs each test file in its own process, so this cwd change is local to this file.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pantheon-state-'));
process.chdir(TMP);
const DATA_DIR = path.join(TMP, '.grok-bridge');
const state = await import('../plugins/grok/scripts/lib/state.mjs');

function seed(id, fields) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(path.join(DATA_DIR, `${id}.json`), JSON.stringify({ id, ...fields }));
}

function clear() {
  if (fs.existsSync(DATA_DIR)) fs.rmSync(DATA_DIR, { recursive: true, force: true });
}

test('upsertJob creates a file and readJob round-trips it', () => {
  clear();
  const w = state.upsertJob('grok-abc', { status: 'running', type: 'imagine' });
  assert.equal(w.id, 'grok-abc');
  assert.equal(w.status, 'running');
  const r = state.readJob('grok-abc');
  assert.equal(r.status, 'running');
  assert.equal(r.type, 'imagine');
});

test('upsertJob merges patches, preserves ts, advances updated', () => {
  clear();
  const first = state.upsertJob('grok-x', { status: 'running' });
  const second = state.upsertJob('grok-x', { status: 'done', cost: 0.01 });
  assert.equal(second.status, 'done');
  assert.equal(second.cost, 0.01);
  assert.equal(second.ts, first.ts, 'creation ts preserved across merges');
  assert.ok(second.updated >= first.updated, 'updated advances');
});

test('listJobs returns recency order, not filename order (NaN-sort regression)', () => {
  clear();
  // Filename/alphabetical order would be [aaa-old, zzz-new]; recency order is the
  // reverse. The old string-subtraction sort produced NaN and left readdir order.
  seed('aaa-old', { updated: '2020-01-01T00:00:00.000Z' });
  seed('zzz-new', { updated: '2026-01-01T00:00:00.000Z' });
  const jobs = state.listJobs();
  assert.equal(jobs.length, 2);
  assert.equal(jobs[0].id, 'zzz-new', 'most recent first');
  assert.equal(jobs[1].id, 'aaa-old');
});

test('listJobs falls back to ts when updated is absent', () => {
  clear();
  seed('a', { ts: '2021-01-01T00:00:00.000Z' });
  seed('b', { ts: '2025-01-01T00:00:00.000Z' });
  const jobs = state.listJobs();
  assert.equal(jobs[0].id, 'b');
});

test('listJobs honors the limit', () => {
  clear();
  for (let i = 0; i < 5; i++) seed(`job-${i}`, { updated: `202${i}-01-01T00:00:00.000Z` });
  assert.equal(state.listJobs(3).length, 3);
});

test('readJob returns null for a missing job', () => {
  clear();
  assert.equal(state.readJob('nope'), null);
});

test('readJob returns null (not throw) on a corrupt file', () => {
  clear();
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(path.join(DATA_DIR, 'bad.json'), '{ not valid json ');
  assert.doesNotThrow(() => state.readJob('bad'));
  assert.equal(state.readJob('bad'), null);
});

test('upsertJob heals a corrupt existing file instead of throwing', () => {
  clear();
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(path.join(DATA_DIR, 'grok-heal.json'), 'garbage{');
  const out = state.upsertJob('grok-heal', { status: 'recovered' });
  assert.equal(out.status, 'recovered');
  assert.deepEqual(state.readJob('grok-heal').status, 'recovered');
});

test('atomic write leaves no leftover .tmp files', () => {
  clear();
  state.upsertJob('grok-atomic', { status: 'ok' });
  const leftovers = fs.readdirSync(DATA_DIR).filter(f => f.endsWith('.tmp'));
  assert.deepEqual(leftovers, []);
});

test('pruneJobs keeps the N most recent and removes the rest', () => {
  clear();
  for (let i = 0; i < 5; i++) seed(`job-${i}`, { updated: `202${i}-06-01T00:00:00.000Z` });
  const removed = state.pruneJobs(2);
  assert.equal(removed, 3);
  const remaining = fs.readdirSync(DATA_DIR).filter(f => f.endsWith('.json')).sort();
  assert.deepEqual(remaining, ['job-3.json', 'job-4.json'], 'newest two survive');
});

test('pruneJobs is a no-op when under the keep threshold', () => {
  clear();
  seed('only', { updated: '2026-01-01T00:00:00.000Z' });
  assert.equal(state.pruneJobs(200), 0);
});
