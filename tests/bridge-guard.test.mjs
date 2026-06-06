// Unit tests for the bridge safety layer (loop guard + write gate).
// Run: node --test tests/bridge-guard.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';

const MOD = '../plugins/grok/scripts/lib/bridge-guard.mjs';

// Helper: load the module fresh with a given env so module-level constants
// (MAX_HOPS, etc.) and env reads reflect the scenario.
async function freshLoad(env) {
  for (const k of ['BRIDGE_HOP', 'GROK_BRIDGE_MAX_HOPS', 'GROK_BRIDGE_ALLOW_WRITES']) delete process.env[k];
  Object.assign(process.env, env);
  return import(`${MOD}?t=${Math.random()}`);
}

test('hop counter starts at 0 when unset', async () => {
  const g = await freshLoad({});
  assert.equal(g.currentHop(), 0);
  assert.doesNotThrow(() => g.assertHopAllowed('test'));
});

test('loop guard trips at MAX_HOPS', async () => {
  const g = await freshLoad({ BRIDGE_HOP: '2', GROK_BRIDGE_MAX_HOPS: '2' });
  assert.throws(() => g.assertHopAllowed('hand off'), /Loop guard tripped/);
});

test('childEnv increments BRIDGE_HOP without mutating process.env', async () => {
  const g = await freshLoad({ BRIDGE_HOP: '1' });
  const env = g.childEnv();
  assert.equal(env.BRIDGE_HOP, '2');
  assert.equal(process.env.BRIDGE_HOP, '1'); // original untouched
});

test('write gate strips dangerous flags by default', async () => {
  const g = await freshLoad({});
  const { args, gated } = g.sanitizeClaudeArgs([
    '--dangerously-skip-permissions',
    '--permission-mode', 'bypassPermissions',
    '--allowedTools', 'Read,Edit,Bash',
    '--model', 'haiku',
  ]);
  assert.equal(gated, true);
  assert.ok(!args.includes('--dangerously-skip-permissions'));
  assert.ok(!args.includes('bypassPermissions'));
  assert.ok(!args.includes('Read,Edit,Bash'));
  assert.ok(args.includes('--model') && args.includes('haiku')); // benign flags survive
  assert.ok(args.join(' ').includes('--allowedTools Read,Glob,Grep')); // read-only pinned
});

test('write gate passes flags through when opted in', async () => {
  const g = await freshLoad({ GROK_BRIDGE_ALLOW_WRITES: '1' });
  const input = ['--permission-mode', 'bypassPermissions'];
  const { args, gated } = g.sanitizeClaudeArgs(input);
  assert.equal(gated, false);
  assert.deepEqual(args, input);
});
