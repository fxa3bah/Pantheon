// Tests for media-path extraction — the part that decides whether generated
// images/videos make it into the gallery. Covers both observed Grok behaviors:
// (a) emits explicit BRIDGE_MEDIA lines, (b) emits only a file:// markdown embed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractMediaPaths } from '../plugins/grok/scripts/grok-companion.mjs';

test('extracts explicit BRIDGE_MEDIA lines', () => {
  const text = [
    'BRIDGE_MEDIA: /Users/x/.grok/sessions/%2Fp%2Ft/abc/images/1.jpg',
    'BRIDGE_MEDIA: /Users/x/.grok/sessions/%2Fp%2Ft/abc/videos/1.mp4',
    '![img](file:///Users/x/.grok/sessions/%2Fp%2Ft/abc/images/1.jpg)',
  ].join('\n');
  const got = extractMediaPaths(text);
  assert.ok(got.includes('/Users/x/.grok/sessions/%2Fp%2Ft/abc/images/1.jpg'));
  assert.ok(got.includes('/Users/x/.grok/sessions/%2Fp%2Ft/abc/videos/1.mp4'));
});

test('falls back to file:// link when no BRIDGE_MEDIA line (literal %2F kept)', () => {
  // Reproduces the final-smoke run: only a markdown embed, no BRIDGE_MEDIA.
  const text = '![Towel](file:///Users/faadi/.grok/sessions/%2Fprivate%2Ftmp%2Fx/019e/images/1.jpg)';
  const got = extractMediaPaths(text);
  assert.deepEqual(got, ['/Users/faadi/.grok/sessions/%2Fprivate%2Ftmp%2Fx/019e/images/1.jpg']);
  // %2F must NOT be decoded to '/', or the on-disk path breaks.
  assert.ok(!got[0].includes('/private/tmp'));
});

test('harvests a bare "saved to:" session path from reasoning text', () => {
  const text = 'The image was generated and saved to: /Users/f/.grok/sessions/%2Fa/sess/images/2.png\nDone.';
  const got = extractMediaPaths(text);
  assert.ok(got.includes('/Users/f/.grok/sessions/%2Fa/sess/images/2.png'));
});

test('dedupes paths seen via multiple signals', () => {
  const p = '/Users/x/.grok/sessions/%2Fa/s/images/1.jpg';
  const text = `BRIDGE_MEDIA: ${p}\n![i](file://${p})\nsaved to: ${p}`;
  assert.equal(extractMediaPaths(text).length, 1);
});

test('ignores non-media and empty input', () => {
  assert.deepEqual(extractMediaPaths(''), []);
  assert.deepEqual(extractMediaPaths('no paths here, just prose.'), []);
});
