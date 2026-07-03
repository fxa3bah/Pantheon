// Unit tests for the Codex leg's write gate (sanitizeCodexArgs, bridge-guard.mjs)
// and codex-companion.mjs's pure helpers. Run: node --test tests/codex-guard.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeCodexArgs } from '../plugins/grok/scripts/lib/bridge-guard.mjs';
import {
  codexModelArgs,
  routingFieldsFor,
  parseCodexEvents,
  parseCodexOutput,
} from '../plugins/grok/scripts/codex-companion.mjs';

// ---- sanitizeCodexArgs: gated (default, read-only) path --------------------

function withEnv(patch, fn) {
  const prior = {};
  for (const k of Object.keys(patch)) prior[k] = process.env[k];
  Object.assign(process.env, patch);
  try {
    return fn();
  } finally {
    for (const k of Object.keys(patch)) {
      if (prior[k] === undefined) delete process.env[k];
      else process.env[k] = prior[k];
    }
  }
}

function assertGatedClean(args) {
  // No caller-supplied unsandboxed/config-override token may survive.
  const joined = args.join(' ');
  assert.ok(!joined.includes('danger-full-access'), `danger-full-access survived: ${joined}`);
  assert.ok(!joined.includes('--dangerously-bypass-approvals-and-sandbox'), `bypass flag survived: ${joined}`);
  assert.ok(!joined.includes('--full-auto'), `--full-auto survived: ${joined}`);
  assert.ok(!joined.includes('--yolo'), `--yolo survived: ${joined}`);
  assert.ok(!joined.includes('sandbox_mode'), `sandbox_mode config override survived: ${joined}`);
  assert.ok(!joined.includes('approval_policy'), `approval_policy config override survived: ${joined}`);
  assert.ok(!joined.includes('shell_environment_policy'), `shell_environment_policy override survived: ${joined}`);
  assert.ok(!joined.includes('--profile'), `--profile survived: ${joined}`);
  assert.ok(!args.includes('-a') && !args.includes('--ask-for-approval'), `approval flag survived: ${joined}`);
  assert.ok(!args.includes('never'), `bare "never" approval-policy value survived: ${joined}`);
  assert.ok(!args.includes('danger'), `bare "danger" profile value survived: ${joined}`);
  // Exactly one pinned read-only sandbox.
  const sandboxCount = (joined.match(/--sandbox read-only/g) || []).length;
  assert.equal(sandboxCount, 1, `expected exactly one pinned --sandbox read-only, got: ${joined}`);
}

const GATED_BYPASS_CASES = [
  ['--dangerously-bypass-approvals-and-sandbox'],
  ['--full-auto'],
  ['--yolo'],
  ['-s', 'danger-full-access'],
  ['-s=danger-full-access'],
  ['--sandbox', 'danger-full-access'],
  ['--sandbox=workspace-write'],
  ['-a', 'never'],
  ['--ask-for-approval', 'never'],
  ['-c', 'sandbox_mode=danger-full-access'],
  ['-c', 'approval_policy=never'],
  ['--config', 'shell_environment_policy.inherit=all'],
  ['--profile', 'danger'],
  ['-p', 'danger'],
];

for (const input of GATED_BYPASS_CASES) {
  test(`sanitizeCodexArgs gated path strips: ${input.join(' ')}`, () => {
    withEnv({ GROK_BRIDGE_ALLOW_WRITES: undefined }, () => {
      delete process.env.GROK_BRIDGE_ALLOW_WRITES;
      const { args, gated } = sanitizeCodexArgs(input);
      assert.equal(gated, true);
      assertGatedClean(args);
    });
  });
}

test('sanitizeCodexArgs gated path leaves benign flags intact', () => {
  delete process.env.GROK_BRIDGE_ALLOW_WRITES;
  const input = ['do the thing', '-C', '/some/dir'];
  const { args, gated, notes } = sanitizeCodexArgs(input);
  assert.equal(gated, true);
  assert.ok(args.includes('do the thing'));
  assert.ok(args.includes('-C') && args.includes('/some/dir'));
  assert.ok(args.includes('--sandbox') && args.includes('read-only'));
  assert.ok(notes.some(n => n.includes('read-only')));
});

test('sanitizeCodexArgs gated path strips every caller -c/--config and --profile/-p, noting each', () => {
  delete process.env.GROK_BRIDGE_ALLOW_WRITES;
  const input = [
    '-c', 'sandbox_mode=danger-full-access',
    '--config', 'approval_policy=never',
    '--profile', 'danger',
    'do the thing',
  ];
  const { args, gated, notes } = sanitizeCodexArgs(input);
  assert.equal(gated, true);
  assert.ok(!args.includes('-c'));
  assert.ok(!args.includes('--config'));
  assert.ok(!args.includes('--profile'));
  assert.ok(args.includes('do the thing'));
  const configNotes = notes.filter(n => n.includes('config-override gate'));
  assert.equal(configNotes.length, 3, `expected 3 config-override strip notes, got: ${JSON.stringify(notes)}`);
});

// ---- sanitizeCodexArgs: writes-allowed (opt-in) path -----------------------

test('sanitizeCodexArgs writes-allowed path normalizes --sandbox when none given', () => {
  withEnv({ GROK_BRIDGE_ALLOW_WRITES: '1' }, () => {
    const { args, gated } = sanitizeCodexArgs(['do the thing']);
    assert.equal(gated, false);
    assert.ok(args.includes('--sandbox') && args.includes('workspace-write'));
    // sandbox appears exactly once
    const idxs = args.reduce((acc, tok, i) => (tok === '--sandbox' ? [...acc, i] : acc), []);
    assert.equal(idxs.length, 1);
  });
});

test('sanitizeCodexArgs writes-allowed path does not double-add sandbox when caller supplied one', () => {
  withEnv({ GROK_BRIDGE_ALLOW_WRITES: '1' }, () => {
    const input = ['--sandbox', 'workspace-write', 'do the thing'];
    const { args, gated } = sanitizeCodexArgs(input);
    assert.equal(gated, false);
    const idxs = args.reduce((acc, tok, i) => (tok === '--sandbox' ? [...acc, i] : acc), []);
    assert.equal(idxs.length, 1);
  });
});

test('sanitizeCodexArgs writes-allowed path leaves -c/--profile intact (operator opted in)', () => {
  withEnv({ GROK_BRIDGE_ALLOW_WRITES: '1' }, () => {
    const input = ['-c', 'shell_environment_policy.inherit=all', '--profile', 'trusted-profile'];
    const { args, gated } = sanitizeCodexArgs(input);
    assert.equal(gated, false);
    assert.ok(args.includes('-c') && args.includes('shell_environment_policy.inherit=all'));
    assert.ok(args.includes('--profile') && args.includes('trusted-profile'));
  });
});

// ---- codex-companion.mjs pure helpers --------------------------------------

test('codexModelArgs splices routed.args when caller supplied no explicit model', () => {
  const routed = { model: 'gpt-5.5', effort: 'medium', args: ['-m', 'gpt-5.5', '-c', 'model_reasoning_effort=medium'] };
  const args = codexModelArgs(routed, ['--sandbox', 'read-only']);
  assert.deepEqual(args, ['-m', 'gpt-5.5', '-c', 'model_reasoning_effort=medium']);
});

test('codexModelArgs yields nothing when caller already passed -m/--model', () => {
  const routed = { model: 'gpt-5.5', effort: 'medium', args: ['-m', 'gpt-5.5', '-c', 'model_reasoning_effort=medium'] };
  assert.deepEqual(codexModelArgs(routed, ['-m', 'gpt-5.3-codex-spark']), []);
  assert.deepEqual(codexModelArgs(routed, ['--model', 'gpt-5.3-codex-spark']), []);
});

test('codexModelArgs is a no-op for a routed result with no args', () => {
  assert.deepEqual(codexModelArgs(null, []), []);
  assert.deepEqual(codexModelArgs({ model: null, args: [] }, []), []);
});

test('routingFieldsFor mirrors the shared ledger shape', () => {
  const routed = { model: 'gpt-5.5', effort: 'medium', bestOfN: null, taskClass: 'implement', source: 'table', escalated: false };
  assert.deepEqual(routingFieldsFor(routed), {
    model: 'gpt-5.5',
    effort: 'medium',
    bestOfN: null,
    routing: { taskClass: 'implement', source: 'table', escalated: false },
  });
});

test('parseCodexEvents extracts thread_id and tolerates a malformed JSONL line', () => {
  const stdout = [
    '{"type":"thread.started","thread_id":"th_123"}',
    'not json at all {{{',
    '{"type":"turn.completed"}',
  ].join('\n');
  const { sessionId, errorMessage } = parseCodexEvents(stdout);
  assert.equal(sessionId, 'th_123');
  assert.equal(errorMessage, null);
});

test('parseCodexEvents surfaces turn.failed / error messages', () => {
  const stdout = [
    '{"type":"thread.started","thread_id":"th_1"}',
    '{"type":"turn.failed","error":{"message":"boom"}}',
  ].join('\n');
  const { errorMessage } = parseCodexEvents(stdout);
  assert.equal(errorMessage, 'boom');
});

test('parseCodexOutput falls back cleanly when stdout is JSONL (not one JSON blob)', () => {
  // This is the normal codex exec --json shape: multiple JSON lines, not a
  // single parseable object. JSON.parse(stdout) must fail and fall back to
  // { result: lastMessage } without throwing.
  const stdout = [
    '{"type":"thread.started","thread_id":"th_9"}',
    '{"type":"turn.completed"}',
  ].join('\n');
  const out = parseCodexOutput(stdout, 'the clean final answer');
  assert.equal(out.result, 'the clean final answer');
  assert.equal(out.session_id, 'th_9');
  assert.equal(out.cost, null);
  assert.equal(out.errorMessage, null);
});

test('parseCodexOutput never throws on garbage stdout with no lastMessage', () => {
  assert.doesNotThrow(() => {
    const out = parseCodexOutput('{{{ not json, not jsonl, just garbage', '');
    assert.equal(out.result, '{{{ not json, not jsonl, just garbage');
  });
});
