import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePantheonInput, packetJobFields, packetModel } from '../plugins/grok/scripts/lib/pantheon-packet.mjs';

test('plain prompts remain backward-compatible', () => {
  const parsed = parsePantheonInput('review this change via Pantheon');
  assert.equal(parsed.isPacket, false);
  assert.equal(parsed.prompt, 'review this change via Pantheon');
  assert.equal(parsed.packet, null);
});

test('valid Pantheon packet becomes a handoff prompt', () => {
  const parsed = parsePantheonInput(JSON.stringify({
    pantheon_packet: true,
    from: 'codex',
    to: 'grok',
    lane: 'visual',
    objective: 'Create a campaign image.',
    context: 'Spring launch',
    constraints: { format: 'png' },
    permissions: { mode: 'read-only' },
    budget: { timeout_ms: 300000 },
    return_format: 'paths and concise notes',
    provenance: 'Codex request',
    model: 'grok-build'
  }));
  assert.equal(parsed.isPacket, true);
  assert.match(parsed.prompt, /Pantheon handoff packet/);
  assert.match(parsed.prompt, /Objective:\nCreate a campaign image/);
  assert.equal(packetModel(parsed.packet), 'grok-build');
});

test('Pantheon packet requires core routing fields', () => {
  assert.throws(() => parsePantheonInput(JSON.stringify({
    pantheon_packet: true,
    from: 'grok',
    to: 'claude',
    objective: 'Review architecture.'
  })), /missing required field\(s\): lane/);
});

test('media entries are preserved in packet job fields', () => {
  const parsed = parsePantheonInput(JSON.stringify({
    pantheon_packet: true,
    from: 'grok',
    to: 'codex',
    lane: 'implementation',
    objective: 'Wire generated media into the UI.',
    media: [
      { path: '/tmp/hero.png', type: 'image/png', label: 'hero' },
      { url: 'file:///tmp/clip.mp4', kind: 'video/mp4' }
    ]
  }));
  const fields = packetJobFields(parsed);
  assert.equal(fields.pantheon_packet, true);
  assert.deepEqual(fields.pantheon.media, [
    { path: '/tmp/hero.png', type: 'image/png', label: 'hero' },
    { path: 'file:///tmp/clip.mp4', type: 'video/mp4', label: '' }
  ]);
});
