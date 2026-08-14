import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectHarnesses, HARNESS_CATALOG } from '../plugins/grok/scripts/lib/harness-detect.mjs';

test('catalog covers the requested harness set', () => {
  const ids = HARNESS_CATALOG.map((row) => row.id);
  for (const id of ['claude', 'grok', 'codex', 'omp', 'opencode', 'agy', 'hermes', 'ultracode', 'qoder']) {
    assert.ok(ids.includes(id), `catalog missing ${id}`);
  }
});

test('detectHarnesses reports injected present and missing binaries', () => {
  const inventory = detectHarnesses({
    which: (name) => (name === 'claude' ? '/tmp/claude' : null),
    exists: (p) => p === '/tmp/claude' || p.endsWith('/omp'),
    version: (bin) => (bin === '/tmp/claude' ? 'claude 2' : 'omp 1')
  });
  assert.equal(inventory.byId.claude.present, true);
  assert.equal(inventory.byId.claude.path, '/tmp/claude');
  assert.equal(inventory.byId.grok.present, false);
  assert.ok(inventory.found.some((row) => row.id === 'claude'));
  assert.ok(inventory.missing.some((row) => row.id === 'ultracode'));
});

test('detectHarnesses falls back to known home paths when which misses', () => {
  const inventory = detectHarnesses({
    which: () => null,
    exists: (p) => p.includes('/.grok/bin/grok'),
    version: () => 'grok 1.0.3'
  });
  assert.equal(inventory.byId.grok.present, true);
  assert.match(inventory.byId.grok.path, /\.grok\/bin\/grok$/);
});
