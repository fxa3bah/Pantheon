// Unit tests for the Pantheon model router (single source of truth for model
// IDs across the delegation mesh).
// Run: node --test tests/model-routing.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ROUTING_TABLE,
  MODEL_TIERS,
  classifyTask,
  resolveModel
} from '../plugins/grok/scripts/lib/model-routing.mjs';

// Use an explicit empty env in every test that isn't specifically exercising
// env-var precedence, so a developer's real shell (GROK_BRIDGE_*_MODEL vars)
// can never leak into an assertion.
const NO_ENV = {};

// -----------------------------------------------------------------------
// 1. Matrix coverage
// -----------------------------------------------------------------------

test('ROUTING_TABLE matrix: every (direction, taskClass) row resolves from the table exactly', () => {
  for (const direction of Object.keys(ROUTING_TABLE)) {
    const row = ROUTING_TABLE[direction];
    for (const taskClass of Object.keys(row)) {
      const expected = row[taskClass];
      const result = resolveModel({ direction, taskClass, env: NO_ENV });
      assert.equal(result.model, expected.model, `${direction}/${taskClass} model`);
      assert.equal(result.effort, expected.effort ?? null, `${direction}/${taskClass} effort`);
      assert.equal(result.bestOfN, expected.bestOfN ?? null, `${direction}/${taskClass} bestOfN`);
      assert.equal(result.source, 'table', `${direction}/${taskClass} source`);
      assert.notEqual(result.source, 'binary-default', `${direction}/${taskClass} must not fall back to binary-default`);
    }
  }
});

test('spot-check literal expected model IDs for representative table rows', () => {
  assert.equal(
    resolveModel({ direction: 'grok-to-claude', taskClass: 'architecture', env: NO_ENV }).model,
    'claude-opus-4-8'
  );
  assert.equal(
    resolveModel({ direction: 'grok-to-claude', taskClass: 'data-model', env: NO_ENV }).model,
    'claude-sonnet-5'
  );
  assert.equal(
    resolveModel({ direction: 'grok-to-claude', taskClass: 'second-opinion', env: NO_ENV }).model,
    'claude-sonnet-5'
  );
  assert.equal(
    resolveModel({ direction: 'grok-to-claude', taskClass: 'security-review', env: NO_ENV }).model,
    'claude-opus-4-8'
  );
  const implement = resolveModel({ direction: 'claude-to-codex', taskClass: 'implement', env: NO_ENV });
  assert.equal(implement.model, 'gpt-5.3-codex-spark');
  assert.equal(implement.effort, 'high');

  const imagine = resolveModel({ direction: 'claude-to-grok', taskClass: 'imagine', env: NO_ENV });
  assert.equal(imagine.model, 'grok-build');
  assert.equal(imagine.effort, 'high');

  const creativeReview = resolveModel({ direction: 'claude-to-grok', taskClass: 'creative-review', env: NO_ENV });
  assert.equal(creativeReview.bestOfN, 3);
});

test('guard: neither the routing table nor the model tiers contain the banned Fable literal', () => {
  const routingTableJson = JSON.stringify(ROUTING_TABLE);
  const modelTiersJson = JSON.stringify(MODEL_TIERS);
  // Built via concatenation (not a literal) so this banned-model check itself
  // doesn't reintroduce the string into the codebase for a naive grep.
  const banned = 'claude-' + 'fable-5';
  assert.ok(!routingTableJson.includes(banned), `ROUTING_TABLE must not contain "${banned}"`);
  assert.ok(!modelTiersJson.includes(banned), `MODEL_TIERS must not contain "${banned}"`);
});

test('guard: claude-sonnet-5 is present (reintroduced as the balanced Claude tier)', () => {
  const routingTableJson = JSON.stringify(ROUTING_TABLE);
  const modelTiersJson = JSON.stringify(MODEL_TIERS);
  assert.ok(routingTableJson.includes('claude-sonnet-5'), 'ROUTING_TABLE must contain "claude-sonnet-5"');
  assert.ok(modelTiersJson.includes('claude-sonnet-5'), 'MODEL_TIERS must contain "claude-sonnet-5"');
});

// -----------------------------------------------------------------------
// 2. Precedence
// -----------------------------------------------------------------------

test('precedence: explicitModel beats packet.model, env var, and the table', () => {
  const result = resolveModel({
    direction: 'grok-to-claude',
    taskClass: 'data-model',
    explicitModel: 'explicit-wins',
    packet: { model: 'packet-model' },
    env: { GROK_BRIDGE_CLAUDE_MODEL: 'env-model' }
  });
  assert.equal(result.model, 'explicit-wins');
  assert.equal(result.source, 'explicit');
});

test('precedence: packet.model (string form) beats env var and the table', () => {
  const result = resolveModel({
    direction: 'grok-to-claude',
    taskClass: 'data-model',
    packet: { model: 'custom-model-string' },
    env: { GROK_BRIDGE_CLAUDE_MODEL: 'claude-opus-4-8' }
  });
  assert.equal(result.model, 'custom-model-string');
  assert.equal(result.source, 'packet');
});

test('precedence: packet.model ({id} object form) beats env var and the table', () => {
  const result = resolveModel({
    direction: 'grok-to-claude',
    taskClass: 'data-model',
    packet: { model: { id: 'custom-model-object' } },
    env: { GROK_BRIDGE_CLAUDE_MODEL: 'claude-opus-4-8' }
  });
  assert.equal(result.model, 'custom-model-object');
  assert.equal(result.source, 'packet');
});

test('precedence: env var beats the table', () => {
  const result = resolveModel({
    direction: 'grok-to-claude',
    taskClass: 'data-model',
    env: { GROK_BRIDGE_CLAUDE_MODEL: 'claude-opus-4-8' }
  });
  assert.equal(result.model, 'claude-opus-4-8');
  assert.equal(result.source, 'env');
});

test('precedence: with explicit + packet + env all present, explicit wins', () => {
  const result = resolveModel({
    direction: 'grok-to-claude',
    taskClass: 'data-model',
    explicitModel: 'explicit-model',
    packet: { model: 'packet-model' },
    env: { GROK_BRIDGE_CLAUDE_MODEL: 'env-model' }
  });
  assert.equal(result.model, 'explicit-model');
  assert.equal(result.source, 'explicit');
});

// -----------------------------------------------------------------------
// 3. Escalation
// -----------------------------------------------------------------------

test('balanced tier: grok-to-claude/data-model resolves to claude-sonnet-5 from the table', () => {
  const result = resolveModel({ direction: 'grok-to-claude', taskClass: 'data-model', env: NO_ENV });
  assert.equal(result.model, 'claude-sonnet-5');
  assert.equal(result.source, 'table');
});

test('balanced tier: grok-to-claude/data-model escalates to claude-opus-4-8 on a risk keyword in packet.objective', () => {
  const result = resolveModel({
    direction: 'grok-to-claude',
    taskClass: 'data-model',
    packet: { objective: 'migrate the production database' },
    env: NO_ENV
  });
  assert.equal(result.model, 'claude-opus-4-8');
  assert.equal(result.escalated, 'keyword');
});

test('escalation: risk keyword in packet.objective escalates to the deep tier', () => {
  const result = resolveModel({
    direction: 'grok-to-claude',
    taskClass: 'second-opinion',
    packet: { objective: 'audit the auth and security flow' },
    env: NO_ENV
  });
  assert.equal(result.model, 'claude-opus-4-8');
  assert.equal(result.escalated, 'keyword');
});

test('escalation: risk keyword stem/prefix match catches morphological variants (plurals, -ation, -ing)', () => {
  for (const direction of ['grok-to-claude', 'codex-to-claude']) {
    for (const taskClass of ['second-opinion']) {
      const rotate = resolveModel({
        direction,
        taskClass,
        packet: { objective: 'rotate the credentials and secrets' },
        env: NO_ENV
      });
      assert.equal(rotate.model, 'claude-opus-4-8', `${direction}/${taskClass} credentials/secrets`);
      assert.equal(rotate.escalated, 'keyword');

      const authFlow = resolveModel({
        direction,
        taskClass,
        packet: { objective: 'review the authentication flow' },
        env: NO_ENV
      });
      assert.equal(authFlow.model, 'claude-opus-4-8', `${direction}/${taskClass} authentication`);
      assert.equal(authFlow.escalated, 'keyword');
    }
  }
});

test('escalation: packet.escalate === true escalates a codex implement row to deep/xhigh', () => {
  const result = resolveModel({
    direction: 'claude-to-codex',
    taskClass: 'implement',
    packet: { escalate: true },
    env: NO_ENV
  });
  assert.equal(result.model, 'gpt-5.5');
  assert.equal(result.effort, 'xhigh');
  assert.equal(result.escalated, 'packet');
});

test('escalation: attempt >= 2 escalates via retry', () => {
  const result = resolveModel({
    direction: 'grok-to-claude',
    taskClass: 'second-opinion',
    attempt: 2,
    env: NO_ENV
  });
  assert.equal(result.model, 'claude-opus-4-8');
  assert.equal(result.escalated, 'retry');
});

test('escalation: budget.cost === "low" pins the cheap tier and blocks keyword escalation', () => {
  const result = resolveModel({
    direction: 'grok-to-claude',
    taskClass: 'second-opinion',
    packet: { objective: 'this needs a security review', budget: { cost: 'low' } },
    env: NO_ENV
  });
  assert.equal(result.model, MODEL_TIERS.claude.cheap);
  assert.equal(result.escalated, false);
});

test('escalation: packet.escalate === true still escalates even under budget.cost "low"', () => {
  const result = resolveModel({
    direction: 'grok-to-claude',
    taskClass: 'second-opinion',
    packet: { escalate: true, budget: { cost: 'low' } },
    env: NO_ENV
  });
  assert.equal(result.model, MODEL_TIERS.claude.deep);
  assert.equal(result.escalated, 'packet');
});

test('escalation: security-review class is auto-deep and ignores a budget.cost "low" cap', () => {
  const result = resolveModel({
    direction: 'grok-to-claude',
    taskClass: 'security-review',
    packet: { budget: { cost: 'low' } },
    env: NO_ENV
  });
  assert.equal(result.model, 'claude-opus-4-8');
});

test('security-review: an untrusted packet.model cannot downgrade a security review', () => {
  const result = resolveModel({
    direction: 'grok-to-claude',
    taskClass: 'security-review',
    packet: { model: 'claude-haiku-4-5-20251001' },
    env: NO_ENV
  });
  assert.equal(result.model, 'claude-opus-4-8');
  assert.equal(result.source, 'table');
});

test('security-review: an env override cannot downgrade a security review', () => {
  const result = resolveModel({
    direction: 'grok-to-claude',
    taskClass: 'security-review',
    env: { GROK_BRIDGE_CLAUDE_MODEL: 'claude-haiku-4-5-20251001' }
  });
  assert.equal(result.model, 'claude-opus-4-8');
  assert.equal(result.source, 'table');
});

test('security-review: an explicit human --model still wins over the forced table tier', () => {
  const result = resolveModel({
    direction: 'grok-to-claude',
    taskClass: 'security-review',
    explicitModel: 'claude-opus-4-8[1m]',
    packet: { model: 'claude-haiku-4-5-20251001' },
    env: { GROK_BRIDGE_CLAUDE_MODEL: 'claude-haiku-4-5-20251001' }
  });
  assert.equal(result.model, 'claude-opus-4-8[1m]');
  assert.equal(result.source, 'explicit');
});

test('escalation: mechanical task classes never escalate, even with a risk keyword and a retry attempt', () => {
  for (const taskClass of ['verify', 'health']) {
    const row = ROUTING_TABLE['claude-to-codex'][taskClass];
    const result = resolveModel({
      direction: 'claude-to-codex',
      taskClass,
      attempt: 3,
      packet: { objective: 'this touches production payment credentials' },
      env: NO_ENV
    });
    assert.equal(result.model, row.model, `${taskClass} model must stay pinned to the table row`);
    assert.equal(result.escalated, false, `${taskClass} must never report an escalation`);
  }
});

// -----------------------------------------------------------------------
// 4. [1m] context suffix
// -----------------------------------------------------------------------

test('[1m] context: claude agent with contextChars > 600000 gets the suffix and escalated "context"', () => {
  const result = resolveModel({
    direction: 'grok-to-claude',
    taskClass: 'architecture',
    contextChars: 700000,
    env: NO_ENV
  });
  assert.ok(result.model.endsWith('[1m]'), `expected [1m] suffix, got ${result.model}`);
  assert.equal(result.escalated, 'context');
});

test('[1m] context: haiku special-case swaps to claude-sonnet-5[1m] under high context', () => {
  const result = resolveModel({
    direction: 'grok-to-claude',
    taskClass: 'summarize',
    contextChars: 700000,
    env: NO_ENV
  });
  assert.equal(result.model, 'claude-sonnet-5[1m]');
  assert.equal(result.escalated, 'context');
});

test('[1m] context: codex and grok legs ignore contextChars — no suffix applied', () => {
  const codexResult = resolveModel({
    direction: 'claude-to-codex',
    taskClass: 'implement',
    contextChars: 700000,
    env: NO_ENV
  });
  assert.equal(codexResult.model, 'gpt-5.3-codex-spark');
  assert.ok(!codexResult.model.includes('[1m]'));

  const grokResult = resolveModel({
    direction: 'claude-to-grok',
    taskClass: 'imagine',
    contextChars: 700000,
    env: NO_ENV
  });
  assert.equal(grokResult.model, 'grok-build');
  assert.ok(!grokResult.model.includes('[1m]'));
});

test('[1m] context: packet.budget.context === "1m" also triggers the suffix on a claude leg', () => {
  const result = resolveModel({
    direction: 'grok-to-claude',
    taskClass: 'architecture',
    packet: { budget: { context: '1m' } },
    env: NO_ENV
  });
  assert.ok(result.model.endsWith('[1m]'), `expected [1m] suffix, got ${result.model}`);
  assert.equal(result.escalated, 'context');
});

// -----------------------------------------------------------------------
// 5. args construction
// -----------------------------------------------------------------------

test('args: a claude row builds ["--model", <model>]', () => {
  const result = resolveModel({ direction: 'grok-to-claude', taskClass: 'architecture', env: NO_ENV });
  assert.deepEqual(result.args, ['--model', 'claude-opus-4-8']);
});

test('args: a codex row builds ["-m", <model>, "-c", "model_reasoning_effort=<effort>"]', () => {
  const result = resolveModel({ direction: 'claude-to-codex', taskClass: 'implement', env: NO_ENV });
  assert.deepEqual(result.args, ['-m', 'gpt-5.3-codex-spark', '-c', 'model_reasoning_effort=high']);
});

test('args: grok creative-review includes ["--best-of-n", "3"]', () => {
  const result = resolveModel({ direction: 'claude-to-grok', taskClass: 'creative-review', env: NO_ENV });
  assert.deepEqual(result.args, ['--model', 'grok-build', '--effort', 'xhigh', '--best-of-n', '3']);
});

// -----------------------------------------------------------------------
// 6. classifyTask
// -----------------------------------------------------------------------

test('classifyTask: lane "visual"/"image"/"video" maps to imagine', () => {
  for (const lane of ['visual', 'image', 'video']) {
    assert.equal(classifyTask('claude-to-grok', 'task', { lane }), 'imagine');
  }
});

test('classifyTask: a lane containing "security" maps to security-review', () => {
  assert.equal(classifyTask('grok-to-claude', 'task', { lane: 'security-audit' }), 'security-review');
});

test('classifyTask: lane "review" resolves per-agent — creative-review on grok, review on codex', () => {
  assert.equal(classifyTask('claude-to-grok', 'task', { lane: 'review' }), 'creative-review');
  assert.equal(classifyTask('codex-to-grok', 'task', { lane: 'review' }), 'creative-review');
  assert.equal(classifyTask('claude-to-codex', 'task', { lane: 'review' }), 'review');
  assert.equal(classifyTask('grok-to-codex', 'task', { lane: 'review' }), 'review');
});

test('classifyTask: subcommand "imagine" maps to imagine', () => {
  assert.equal(classifyTask('claude-to-grok', 'imagine', null), 'imagine');
});

test('classifyTask: codex-to-grok generic "task" resolves to the grok-build task row, not the health tier', () => {
  const taskClass = classifyTask('codex-to-grok', 'task', null);
  assert.equal(taskClass, 'task');
  const result = resolveModel({ direction: 'codex-to-grok', taskClass, env: NO_ENV });
  assert.equal(result.model, 'grok-build');
  assert.equal(result.effort, 'medium');
});

test('classifyTask: unknown subcommand/lane falls back to the direction\'s generic class', () => {
  assert.equal(classifyTask('claude-to-grok', 'nonsense', null), 'task');
  assert.equal(classifyTask('grok-to-claude', 'nonsense', null), 'second-opinion');
  assert.equal(classifyTask('claude-to-codex', 'nonsense', null), 'implement');
});

test('classifyTask: always returns a taskClass that has a row in ROUTING_TABLE, for every direction', () => {
  for (const direction of Object.keys(ROUTING_TABLE)) {
    const taskClass = classifyTask(direction, 'totally-not-a-real-subcommand', null);
    assert.ok(
      Object.prototype.hasOwnProperty.call(ROUTING_TABLE[direction], taskClass),
      `classifyTask(${direction}) returned "${taskClass}" which has no row`
    );
  }
});

// -----------------------------------------------------------------------
// 7. Immutability
// -----------------------------------------------------------------------

test('immutability: ROUTING_TABLE and its nested rows are frozen', () => {
  assert.ok(Object.isFrozen(ROUTING_TABLE));
  assert.ok(Object.isFrozen(ROUTING_TABLE['claude-to-grok']));
  assert.ok(Object.isFrozen(ROUTING_TABLE['claude-to-grok'].imagine));
});

test('immutability: resolveModel returns a frozen object that cannot be mutated', () => {
  const result = resolveModel({ direction: 'grok-to-claude', taskClass: 'architecture', env: NO_ENV });
  assert.ok(Object.isFrozen(result));
  assert.throws(() => { result.model = 'tampered'; }, TypeError);
});
