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

// --- Bypass-class coverage (regression for the C1 write-gate hole) ----------

// No dangerous token may survive in the FINAL assembled argv, in any flag form.
const DANGEROUS_SUBSTRINGS = ['bypassPermissions', 'acceptEdits', 'Edit', 'Bash',
  'dangerously-skip-permissions', 'dangerously-bypass-approvals-and-sandbox'];

function assertClean(args) {
  const joined = args.join(' ');
  for (const bad of DANGEROUS_SUBSTRINGS) {
    assert.ok(!joined.includes(bad), `dangerous token "${bad}" survived in: ${joined}`);
  }
  // read-only set is always pinned exactly once at the front
  assert.ok(joined.includes('--allowedTools Read,Glob,Grep'), `read-only not pinned: ${joined}`);
}

const BYPASS_INPUTS = [
  ['--permission-mode=bypassPermissions'],
  ['--permission-mode=acceptEdits'],
  ['--allowedTools=Read,Edit,Bash'],
  ['--allowed-tools=Bash'],
  ['--permission-mode', 'bypassPermissions'],
  ['--allowedTools', 'Read,Edit,Bash'],
  ['--dangerously-skip-permissions'],
  ['--dangerously-bypass-approvals-and-sandbox'],
  // duplicate / mixed forms — attacker tries to slip a second grant past the pin
  ['--allowedTools', 'Read,Glob,Grep', '--allowedTools=Read,Edit,Bash'],
  ['--permission-mode=default', '--permission-mode=bypassPermissions'],
];

for (const input of BYPASS_INPUTS) {
  test(`write gate blocks bypass: ${input.join(' ')}`, async () => {
    const g = await freshLoad({});
    const { args, gated } = g.sanitizeClaudeArgs(input);
    assert.equal(gated, true);
    assertClean(args);
  });
}

test('write gate allows safe --permission-mode values (allowlist)', async () => {
  const g = await freshLoad({});
  for (const safe of ['default', 'plan']) {
    const { args } = g.sanitizeClaudeArgs([`--permission-mode=${safe}`]);
    assert.ok(args.includes('--permission-mode') && args.includes(safe));
  }
});

test('loop guard is NOT disabled by garbage MAX_HOPS (NaN guard)', async () => {
  const g = await freshLoad({ BRIDGE_HOP: '5', GROK_BRIDGE_MAX_HOPS: 'abc' });
  assert.equal(g.MAX_HOPS, 2); // falls back, not NaN
  assert.throws(() => g.assertHopAllowed('hand off'), /Loop guard tripped/);
});
