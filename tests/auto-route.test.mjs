import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyJob, normalizeQuality, pickRoute, requestedHarnessFromText } from '../plugins/grok/scripts/lib/auto-route.mjs';
import { MODEL_TIERS } from '../plugins/grok/scripts/lib/model-routing.mjs';

function inventoryWith(ids) {
  const byId = {};
  for (const id of ['claude', 'grok', 'codex', 'omp', 'opencode', 'agy', 'hermes', 'ultracode', 'qoder']) {
    byId[id] = { id, present: ids.includes(id), path: ids.includes(id) ? `/bin/${id}` : null };
  }
  return { found: ids.map((id) => byId[id]), missing: [], byId };
}

test('classifyJob maps image and ultracode plan phrasing', () => {
  assert.equal(classifyJob('generate a hero product shot'), 'imagine');
  assert.equal(classifyJob('plan this using ultracode'), 'plan');
  assert.equal(classifyJob('implement the failing auth test'), 'verify');
  assert.equal(classifyJob('rename a helper'), 'reasoning');
});

test('logo/thumbnail in a review or fix never select Imagine', () => {
  assert.equal(classifyJob('review the logo upload handler for path traversal'), 'review');
  assert.equal(classifyJob('fix the thumbnail cache bug'), 'implement');
});

test('requestedHarnessFromText reads "using ultracode"', () => {
  assert.equal(requestedHarnessFromText('plan this using ultracode'), 'ultracode');
  assert.equal(requestedHarnessFromText('review via omp'), 'omp');
});

test('normalizeQuality defaults unknown values to better', () => {
  assert.equal(normalizeQuality('BEST'), 'best');
  assert.equal(normalizeQuality('nope'), 'better');
});

test('imagine always stays on Grok when Grok is present', () => {
  const route = pickRoute({
    text: 'make a linen napkin hero shot',
    quality: 'best',
    inventory: inventoryWith(['claude', 'grok', 'codex', 'omp'])
  });
  assert.equal(route.kind, 'imagine');
  assert.equal(route.harness, 'grok');
  assert.equal(route.model, MODEL_TIERS.grok.deepCreative.model);
});

test('Good Better Best walks the preference list', () => {
  const inventory = inventoryWith(['agy', 'omp', 'codex']);
  assert.equal(pickRoute({ text: 'implement the helper', quality: 'good', inventory }).harness, 'agy');
  assert.equal(pickRoute({ text: 'implement the helper', quality: 'better', inventory }).harness, 'omp');
  assert.equal(pickRoute({ text: 'implement the helper', quality: 'best', inventory }).harness, 'codex');
});

test('missing requested harness falls back and records fallbackFrom', () => {
  const route = pickRoute({
    text: 'plan this using ultracode',
    inventory: inventoryWith(['claude', 'omp'])
  });
  assert.equal(route.kind, 'plan');
  assert.equal(route.fallbackFrom, 'ultracode');
  assert.ok(['omp', 'claude'].includes(route.harness));
});

test('plan on best quality prefers Claude when present', () => {
  const route = pickRoute({
    text: 'plan this architecture',
    quality: 'best',
    inventory: inventoryWith(['agy', 'hermes', 'omp', 'claude'])
  });
  assert.equal(route.harness, 'claude');
  assert.equal(route.model, MODEL_TIERS.claude.deep);
});

test('pickRoute records the requesting host, not grok-by-default', () => {
  const route = pickRoute({
    text: 'plan this architecture',
    quality: 'best',
    inventory: inventoryWith(['agy', 'hermes', 'omp', 'claude']),
    host: 'omp'
  });
  assert.equal(route.host, 'omp');
  assert.equal(route.harness, 'claude');
  assert.equal(route.direction, 'omp-to-claude');
});

test('extra harnesses without a verified read-only pin are refused', async () => {
  const { assertReadOnlyCapable } = await import('../plugins/grok/scripts/lib/extra-harness.mjs');
  const inventory = inventoryWith(['opencode', 'agy', 'hermes']);
  const open = pickRoute({ text: 'implement the helper', quality: 'better', inventory });
  assert.equal(open.harness, 'opencode');
  assert.equal(open.spawn.readOnly, false);
  assert.throws(() => assertReadOnlyCapable(open), /no verified read-only mode/);
  const agy = pickRoute({ text: 'implement the helper', quality: 'good', inventory });
  assert.equal(agy.harness, 'agy');
  assert.doesNotThrow(() => assertReadOnlyCapable(agy));
});
