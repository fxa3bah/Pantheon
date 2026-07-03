import { test } from 'node:test';
import assert from 'node:assert/strict';
import { complianceHeader, withCompliance, complianceEnabled } from '../plugins/grok/scripts/lib/compliance.mjs';

test('compliance: claude header names its standing sources + DESIGN.md', () => {
  const h = complianceHeader('claude');
  assert.match(h, /MEMORY\.md/);
  assert.match(h, /CLAUDE\.md/);
  assert.match(h, /~\/\.claude\/DESIGN\.md/);
});

test('compliance: codex header points at AGENTS.md + project CLAUDE.md + DESIGN.md', () => {
  const h = complianceHeader('codex');
  assert.match(h, /~\/\.codex\/AGENTS\.md/);
  assert.match(h, /\.\/CLAUDE\.md/);       // codex does not auto-load CLAUDE.md
  assert.match(h, /~\/\.claude\/DESIGN\.md/);
});

test('compliance: grok header points at AGENTS.md + KNOWLEDGE.md memory + DESIGN.md', () => {
  const h = complianceHeader('grok');
  assert.match(h, /~\/\.grok\/AGENTS\.md/);
  assert.match(h, /~\/\.grok\/KNOWLEDGE\.md/);   // grok does not auto-load its memory
  assert.match(h, /~\/\.claude\/DESIGN\.md/);
});

test('compliance: unknown agent yields an empty header (safe to concatenate)', () => {
  assert.equal(complianceHeader('nobody'), '');
});

test('compliance: withCompliance prepends the header and preserves the task', () => {
  const out = withCompliance('claude', 'DO THE TASK', {});
  assert.match(out, /operating context/i);
  assert.match(out, /DO THE TASK$/);
  assert.notEqual(out, 'DO THE TASK');
});

test('compliance: GROK_BRIDGE_NO_COMPLIANCE=1 returns the prompt unchanged', () => {
  const out = withCompliance('claude', 'RAW', { GROK_BRIDGE_NO_COMPLIANCE: '1' });
  assert.equal(out, 'RAW');
  assert.equal(complianceEnabled({ GROK_BRIDGE_NO_COMPLIANCE: '1' }), false);
  assert.equal(complianceEnabled({}), true);
});

test('compliance: unknown agent passes the prompt through unchanged', () => {
  assert.equal(withCompliance('nobody', 'RAW', {}), 'RAW');
});
